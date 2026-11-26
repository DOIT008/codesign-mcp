import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, extname, basename, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { APIRequestContext } from 'playwright';
import { config } from '../config.js';
import { CodesignError } from '../codesign/errors.js';
import { assertAllowedRemoteUrl, normalizeCodesignAssetUrl } from './url.js';
import { throttle } from './rate-limit.js';
import { assertNotRateLimited, withRetry } from './retry.js';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (CodesignMcp/0.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
};

const FILE_COMMIT_RETRY_DELAYS_MS = [50, 150, 350] as const;

export interface ArtifactVerification {
  bytes: number;
  sha256: string;
  format: string;
  reused: boolean;
  contentLength: string | null;
  contentEncoding: string | null;
}

export interface DownloadResult {
  url: string;
  path: string;
  bytes: number;
  mime: string | null;
  reusedExisting?: boolean;
  writeAttempts?: number;
  verified: ArtifactVerification;
}

export interface DownloadOptions {
  request?: APIRequestContext;
  headers?: Record<string, string>;
  expectedBytes?: number;
  expectedMime?: string;
  expectedFormat?: string;
}

// 把 URL 下载到 data/artifacts/<subdir>/<filename>。filename 为空时根据 URL 推断或哈希。
export async function downloadToArtifact(
  url: string,
  subdir: string,
  filename?: string,
  errorCode: 'SLICE_FETCH_FAILED' | 'META_FETCH_FAILED' = 'SLICE_FETCH_FAILED',
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const remoteUrl = normalizeCodesignAssetUrl(url);
  assertAllowedRemoteUrl(remoteUrl, 'download');
  const targetDir = resolveInside(config.artifactsDir, subdir);
  mkdirSync(targetDir, { recursive: true });

  const finalName = filename ?? deriveFilename(url);
  const finalPath = resolveInside(targetDir, finalName);
  mkdirSync(dirname(finalPath), { recursive: true });

  const existing = getExistingArtifact(finalPath, options.expectedBytes);
  if (existing) {
    const buf = readExistingArtifact(finalPath);
    return {
      url,
      path: finalPath,
      bytes: existing.bytes,
      mime: null,
      reusedExisting: true,
      writeAttempts: 0,
      verified: {
        bytes: existing.bytes,
        sha256: sha256(buf),
        format: detectArtifactFormat(buf),
        reused: true,
        contentLength: null,
        contentEncoding: null,
      },
    };
  }

  try {
    const headers = { ...DEFAULT_HEADERS, ...options.headers };
    const resp = await withRetry(async () => {
      await throttle(remoteUrl);
      if (options.request) {
        const result = await fetchWithBrowserContext(options.request, remoteUrl, headers);
        assertNotRateLimited(result.status, 'artifact download', result.retryAfter);
        return result;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.metaTimeoutMs);
      try {
        const result = await fetchWithNode(remoteUrl, headers, controller.signal);
        assertNotRateLimited(result.status, 'artifact download', result.retryAfter);
        return result;
      } finally {
        clearTimeout(timer);
      }
    });
    if (!resp.ok || resp.status !== 200) {
      throw new CodesignError(errorCode, `download failed: HTTP ${resp.status}`, {
        url: remoteUrl,
        status: resp.status,
      });
    }
    const buf = resp.body;
    const format = assertArtifactIntegrity(buf, remoteUrl, {
      expectedBytes: options.expectedBytes,
      expectedMime: options.expectedMime,
      expectedFormat: options.expectedFormat,
      mime: resp.mime,
      contentLength: resp.contentLength,
      contentEncoding: resp.contentEncoding,
    });
    const writeAttempts = await commitArtifactWithRetry(finalPath, buf);
    const committedBytes = statSync(finalPath).size;
    if (committedBytes !== buf.byteLength) {
      rmSync(finalPath, { force: true });
      throw new CodesignError('ARTIFACT_SIZE_MISMATCH', 'committed artifact size differs from downloaded bytes', {
        url: remoteUrl,
        path: finalPath,
        expected: buf.byteLength,
        actual: committedBytes,
      });
    }
    return {
      url: remoteUrl,
      path: finalPath,
      bytes: buf.byteLength,
      mime: resp.mime,
      writeAttempts,
      verified: {
        bytes: buf.byteLength,
        sha256: sha256(buf),
        format,
        reused: false,
        contentLength: resp.contentLength,
        contentEncoding: resp.contentEncoding,
      },
    };
  } catch (err) {
    if (err instanceof CodesignError) throw err;
    throw new CodesignError(errorCode, `download threw: ${(err as Error).message}`, {
      url: remoteUrl,
      path: finalPath,
    });
  }
}

function resolveInside(root: string, child: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, child);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return resolvedTarget;
  }
  throw new CodesignError('ARTIFACT_PATH_INVALID', 'artifact path escapes artifactsDir', {
    root: resolvedRoot,
    child,
    resolvedTarget,
  });
}

function getExistingArtifact(path: string, expectedBytes: number | undefined): { bytes: number } | undefined {
  if (typeof expectedBytes !== 'number' || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    return undefined;
  }
  try {
    const stat = statSync(path);
    if (stat.isFile() && stat.size === expectedBytes) return { bytes: stat.size };
    return undefined;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return undefined;
    throw err;
  }
}

async function commitArtifactWithRetry(finalPath: string, buf: Buffer): Promise<number> {
  for (let attempt = 0; attempt <= FILE_COMMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      writeFileSync(tempPath, buf);
      renameSync(tempPath, finalPath);
      return attempt + 1;
    } catch (err) {
      rmSync(tempPath, { force: true });
      if (!isRetryableFileCommitError(err) || attempt === FILE_COMMIT_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await delay(FILE_COMMIT_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw new Error('artifact write retry loop exhausted');
}

function isRetryableFileCommitError(err: unknown): boolean {
  if (!isErrnoException(err)) return false;
  return err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

interface FetchResult {
  ok: boolean;
  status: number;
  body: Buffer;
  mime: string | null;
  contentLength: string | null;
  contentEncoding: string | null;
  retryAfter: string | null;
}

async function fetchWithNode(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<FetchResult> {
  const resp = await fetch(url, { headers, signal });
  return {
    ok: resp.ok,
    status: resp.status,
    body: Buffer.from(await resp.arrayBuffer()),
    mime: resp.headers.get('content-type'),
    contentLength: resp.headers.get('content-length'),
    contentEncoding: resp.headers.get('content-encoding'),
    retryAfter: resp.headers.get('retry-after'),
  };
}

async function fetchWithBrowserContext(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
): Promise<FetchResult> {
  const resp = await request.get(url, { headers, timeout: config.metaTimeoutMs });
  const responseHeaders = resp.headers();
  return {
    ok: resp.ok(),
    status: resp.status(),
    body: await resp.body(),
    mime: responseHeaders['content-type'] ?? null,
    contentLength: responseHeaders['content-length'] ?? null,
    contentEncoding: responseHeaders['content-encoding'] ?? null,
    retryAfter: responseHeaders['retry-after'] ?? null,
  };
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readExistingArtifact(path: string): Buffer {
  return readFileSync(path);
}

// 魔数嗅探：识别真实图片格式，同时识别 HTML/XML 错误页。
export function detectArtifactFormat(buf: Buffer): string {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  const head = buf.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '');
  if (/^(?:\s|<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<svg[\s>]/i.test(head)) return 'svg';
  if (/^\s*(?:<\?xml|<!DOCTYPE\s+html|<html)/i.test(head)) return 'error-page';
  return 'unknown';
}

function formatMatches(format: string, expected: string): boolean {
  const normalized = expected.toLowerCase().replace(/^image\//, '');
  if (normalized === 'jpg' || normalized === 'jpeg') return format === 'jpeg';
  if (normalized === 'svg' || normalized === 'svg+xml') return format === 'svg';
  return format === normalized;
}

export function assertArtifactIntegrity(
  buf: Buffer,
  url: string,
  opts: {
    expectedBytes?: number;
    expectedMime?: string;
    expectedFormat?: string;
    mime: string | null;
    contentLength: string | null;
    contentEncoding: string | null;
  },
): string {
  const encoding = opts.contentEncoding?.toLowerCase() ?? '';
  if (opts.expectedBytes != null && Number.isSafeInteger(opts.expectedBytes) && opts.expectedBytes > 0) {
    if (buf.byteLength !== opts.expectedBytes) {
      throw new CodesignError('ARTIFACT_SIZE_MISMATCH', 'downloaded size differs from declared size', {
        url,
        expected: opts.expectedBytes,
        actual: buf.byteLength,
      });
    }
  }
  if (opts.contentLength && !encoding) {
    const declared = Number(opts.contentLength);
    if (Number.isSafeInteger(declared) && declared >= 0 && buf.byteLength !== declared) {
      throw new CodesignError('ARTIFACT_SIZE_MISMATCH', 'downloaded size differs from Content-Length', {
        url,
        expected: declared,
        actual: buf.byteLength,
      });
    }
  }
  const format = detectArtifactFormat(buf);
  if (format === 'error-page') {
    throw new CodesignError('ARTIFACT_MAGIC_MISMATCH', 'downloaded body looks like an HTML/XML error page', {
      url,
      mime: opts.mime,
      bytes: buf.byteLength,
    });
  }
  if (opts.expectedFormat && format !== 'unknown' && !formatMatches(format, opts.expectedFormat)) {
    throw new CodesignError('ARTIFACT_MAGIC_MISMATCH', 'downloaded format differs from manifest format', {
      url,
      expected: opts.expectedFormat,
      actual: format,
    });
  }
  if (opts.expectedMime && format !== 'unknown' && !formatMatches(format, opts.expectedMime)) {
    throw new CodesignError('ARTIFACT_MAGIC_MISMATCH', 'downloaded format differs from declared MIME type', {
      url,
      expected: opts.expectedMime,
      actual: format,
      mime: opts.mime,
    });
  }
  return format;
}

function deriveFilename(url: string): string {
  try {
    const u = new URL(url);
    const last = basename(u.pathname);
    if (last && extname(last)) return last;
    const ext = extname(last) || '';
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
    return `${hash}${ext || '.bin'}`;
  } catch {
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
    return `${hash}.bin`;
  }
}
