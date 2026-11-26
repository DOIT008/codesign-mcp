// visual_diff：L3 像素级视觉回归。把「生成页的截图」与「CoDesign 画板预览图」
// 在同一种子尺寸下对齐后做逐像素差分，输出 0..1 相似度分数与差异热区。
// 分数只作为回归信号，不做通过/失败硬判定。

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { McpServer } from '../mcp/server.js';
import { objectSchema } from '../mcp/schema.js';
import { browserManager } from '../browser/manager.js';
import { getCachedSharingDetail } from '../codesign/cache.js';
import { CodesignError } from '../codesign/errors.js';
import { parseSharingId } from '../utils/url.js';
import { downloadToArtifact } from '../utils/download.js';
import { config } from '../config.js';
import { errorResult } from './artboards.js';
import { pickScreen, summarizeScreens } from './spec.js';
import { toolSuccess, summarizeVisualDiffPayload } from '../mcp/result.js';
import {
  decodePng,
  compareImages,
  scoreVerdict,
  VISUAL_DIFF_CAVEATS,
} from '../codesign/visual-diff.js';
import { getLogger } from '../logger.js';
import type { SharingScreen } from '../codesign/types.js';

const log = getLogger();
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_WAIT_MS = 800;

interface VisualDiffInput {
  sharingUrl: string;
  password?: string;
  screenId?: number | string;
  objectId?: string;
  screenName?: string;
  pageUrl?: string;
  screenshotPath?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  waitMs?: number;
  threshold?: number;
  maxAspectRatioDrift?: number;
  includeDiffImage?: boolean;
  includeFullText?: boolean;
}

const inputSchema = objectSchema(
  {
    sharingUrl: { type: 'string', minLength: 1 },
    password: { type: 'string' },
    screenId: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
    objectId: { type: 'string' },
    screenName: { type: 'string' },
    pageUrl: {
      type: 'string',
      description: 'Local dev server URL to screenshot, e.g. http://127.0.0.1:5173/page. Mutually exclusive with screenshotPath.',
    },
    screenshotPath: {
      type: 'string',
      description: 'Path to an existing screenshot (relative to workspace root). Mutually exclusive with pageUrl.',
    },
    viewportWidth: { type: 'integer', minimum: 1, description: 'Override screenshot viewport width in CSS px.' },
    viewportHeight: { type: 'integer', minimum: 1, description: 'Override screenshot viewport height in CSS px.' },
    waitMs: { type: 'integer', minimum: 0, description: 'Milliseconds to wait after page load before screenshotting.' },
    threshold: { type: 'number', minimum: 0, maximum: 1, description: 'pixelmatch color threshold, default 0.1.' },
    maxAspectRatioDrift: {
      type: 'number',
      minimum: 0,
      description: 'Allowed aspect-ratio drift between image and viewport, default 0.05.',
    },
    includeDiffImage: { type: 'boolean', default: true, description: 'Also write a diff heat-map PNG under artifacts.' },
    includeFullText: { type: 'boolean', default: false },
  },
  ['sharingUrl'],
);

export function registerVisualDiffTool(server: McpServer): void {
  server.registerTool(
    'visual_diff',
    {
      title: 'Visual Regression Against Artboard',
      description:
        'Compares a rendered page with the CoDesign artboard preview and reports a 0..1 similarity score plus difference hotspots. ' +
        'Provide either pageUrl (a running local dev server; it will be screenshotted at the artboard viewport) or screenshotPath (an existing screenshot). ' +
        'The score is a regression signal for comparing runs, not a pass/fail verdict; font rasterization can lower it. ' +
        'Never modifies the page or project files; only writes a diff image under <workspaceRoot>/.codesign-mcp/artifacts/.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: VisualDiffInput) => {
      const {
        sharingUrl, password, screenId, objectId, screenName,
        pageUrl, screenshotPath, viewportWidth, viewportHeight,
        waitMs, threshold, maxAspectRatioDrift, includeDiffImage, includeFullText,
      } = args;

      if (!pageUrl && !screenshotPath) {
        return errorResult(
          new CodesignError('VISUAL_DIFF_PAGE_INVALID', 'provide pageUrl or screenshotPath', {}),
        );
      }
      if (pageUrl && screenshotPath) {
        return errorResult(
          new CodesignError('VISUAL_DIFF_PAGE_INVALID', 'pageUrl and screenshotPath are mutually exclusive', {}),
        );
      }

      let sharingId: string;
      try {
        sharingId = parseSharingId(sharingUrl);
      } catch (err) {
        return errorResult(err);
      }

      // 本地截图路径先做存在性与越界校验，避免无谓的远端请求。
      let screenshotBuffer: Buffer | null = null;
      if (screenshotPath) {
        try {
          screenshotBuffer = readScreenshot(screenshotPath);
        } catch (err) {
          return errorResult(err);
        }
      }

      const call = await browserManager.acquireHeadless();
      try {
        const { detail } = await getCachedSharingDetail(call.page, sharingId, password);
        const allScreens: SharingScreen[] = [];
        for (const design of detail.designs ?? []) {
          for (const screen of design.screens ?? []) allScreens.push(screen);
        }
        if (allScreens.length === 0) {
          return errorResult(new CodesignError('SHARING_NOT_FOUND', 'sharing has no screens', { sharingId }));
        }

        const selector = { screenId, objectId, screenName };
        const picked = pickScreen(allScreens, selector);
        if (!picked) {
          const needsSelector = selector.screenId != null || selector.objectId != null || selector.screenName != null;
          return errorResult(
            needsSelector
              ? new CodesignError('SCREEN_NOT_FOUND', 'no screen matches the given selector', {
                  selector,
                  available: summarizeScreens(allScreens),
                })
              : new CodesignError('SCREEN_SELECTOR_REQUIRED', 'multiple screens present; specify a selector', {
                  available: summarizeScreens(allScreens),
                }),
          );
        }

        // viewport 来自画板预览图自身标注的 CSS 逻辑尺寸，可被显式参数覆盖。
        const target = {
          width: viewportWidth ?? Math.max(1, Math.round(picked.width || picked.image?.width || 0)),
          height: viewportHeight ?? Math.max(1, Math.round(picked.height || picked.image?.height || 0)),
        };
        if (!Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height)) {
          return errorResult(
            new CodesignError('VISUAL_DIFF_ALIGNMENT', 'cannot determine a valid artboard viewport', {
              picked: { width: picked.width, height: picked.height },
            }),
          );
        }

        // 取生成页截图：本地 dev server 用独立 headless 页，绝不污染共享 CoDesign 页。
        let renderPng: Buffer;
        let renderSource: Record<string, unknown>;
        if (pageUrl) {
          const captured = await capturePage(pageUrl, target, waitMs ?? DEFAULT_WAIT_MS);
          renderPng = captured.buffer;
          renderSource = { kind: 'pageUrl', url: captured.url, viewport: target };
        } else {
          renderPng = screenshotBuffer!;
          renderSource = { kind: 'screenshotPath', path: screenshotPath };
        }

        // 取设计稿基准图：下载画板 full 预览图到 artifacts。
        const designUrl = picked.image?.url;
        if (!designUrl) {
          return errorResult(
            new CodesignError('SCREEN_NOT_FOUND', 'screen has no preview image url', {
              screen: { id: picked.id, objectId: picked.object_id, name: picked.name },
            }),
          );
        }
        const designDownload = await downloadToArtifact(
          designUrl,
          `${sharingId}/screens`,
          `${picked.id}-visual-diff.png`,
          'META_FETCH_FAILED',
          { request: call.context.request, expectedBytes: picked.image?.size },
        );
        const designPng = await normalizeToPng(
          readFileSync(designDownload.path),
          designDownload.mime,
        );

        const designImage = decodePng(designPng);
        const renderImage = decodePng(renderPng);
        const report = compareImages(designImage, renderImage, target, {
          threshold,
          maxAspectRatioDrift,
          includeDiffImage: includeDiffImage !== false,
        });

        let diffImagePath: string | null = null;
        if (report.diffImagePng) {
          const rel = `${sharingId}/diffs/${picked.id}-${Date.now()}.png`;
          const abs = resolve(config.artifactsDir, rel);
          mkdirSync(resolve(abs, '..'), { recursive: true });
          writeFileSync(abs, report.diffImagePng);
          diffImagePath = rel;
        }

        return toolSuccess({
          sharingId,
          screen: { id: picked.id, objectId: picked.object_id, name: picked.name },
          renderSource,
          score: report.score,
          verdict: scoreVerdict(report.score),
          diffPixels: report.diffPixels,
          totalPixels: report.totalPixels,
          threshold: report.threshold,
          alignment: report.alignment,
          hotspots: report.hotspots,
          diffImagePath,
          caveats: [...VISUAL_DIFF_CAVEATS],
        }, includeFullText, summarizeVisualDiffPayload);
      } catch (err) {
        log.warn({ err: (err as Error).message, sharingId }, 'visual_diff failed');
        return errorResult(err);
      } finally {
        await call.done();
      }
    },
  );
}

// 打开本地 dev server 截图。独立页用完即关，返回 PNG buffer。
async function capturePage(
  pageUrl: string,
  viewport: { width: number; height: number },
  waitMs: number,
): Promise<{ buffer: Buffer; url: string }> {
  validateLocalUrl(pageUrl);
  const call = await browserManager.acquireHeadlessIsolated();
  try {
    await call.page.setViewportSize(viewport);
    const response = await call.page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });
    if (!response) {
      throw new CodesignError('VISUAL_DIFF_PAGE_INVALID', 'pageUrl did not return a response', { pageUrl });
    }
    if (!response.ok() && response.status() !== 0) {
      throw new CodesignError('VISUAL_DIFF_PAGE_INVALID', 'pageUrl returned an error status', {
        pageUrl,
        status: response.status(),
      });
    }
    if (waitMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    }
    await call.page.evaluate(() => (globalThis as { document?: { fonts?: { ready: Promise<unknown> } } }).document?.fonts?.ready);
    const buffer = await call.page.screenshot({ type: 'png', animations: 'disabled' });
    return { buffer, url: call.page.url() };
  } finally {
    await call.done();
  }
}

// 只允许本地回环地址，避免把任意 URL 交给浏览器（SSRF 风险）。
function validateLocalUrl(input: string): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CodesignError('VISUAL_DIFF_PAGE_INVALID', 'pageUrl is not a valid URL', { pageUrl: input });
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname.toLowerCase())) {
    throw new CodesignError('VISUAL_DIFF_PAGE_INVALID', 'pageUrl must be a local http dev server', {
      pageUrl: input,
      protocol: url.protocol,
      hostname: url.hostname,
    });
  }
}

function readScreenshot(entry: string): Buffer {
  const root = resolve(config.workspaceRoot);
  const target = isAbsolute(entry) ? resolve(entry) : resolve(root, entry);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CodesignError('ARTIFACT_PATH_INVALID', 'screenshot path escapes the workspace root', {
      root,
      entry,
      target,
    });
  }
  let stats;
  try {
    stats = statSync(target);
  } catch {
    throw new CodesignError('VISUAL_DIFF_IMAGE_INVALID', 'screenshot does not exist', { entry, target });
  }
  if (!stats.isFile()) {
    throw new CodesignError('VISUAL_DIFF_IMAGE_INVALID', 'screenshot path is not a file', { entry, target });
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new CodesignError('VISUAL_DIFF_IMAGE_INVALID', 'screenshot is too large', {
      entry,
      bytes: stats.size,
      maxBytes: MAX_FILE_BYTES,
    });
  }
  return readFileSync(target);
}

// 设计稿预览图可能是 PNG/JPEG/WEBP，pngjs 只解 PNG。用浏览器 canvas 统一转 PNG。
async function normalizeToPng(buf: Buffer, mime?: string | null): Promise<Buffer> {
  if (looksLikePng(buf)) return buf;
  const mediaType = mime && mime.startsWith('image/') ? mime : 'image/*';
  const dataUrl = `data:${mediaType};base64,${buf.toString('base64')}`;
  const call = await browserManager.acquireHeadlessIsolated();
  try {
    const base64 = await call.page.evaluate(async (src: string) => {
      const browserGlobals = globalThis as unknown as {
        Image: new () => {
          naturalWidth: number;
          naturalHeight: number;
          onload: (() => void) | null;
          onerror: (() => void) | null;
          src: string;
        };
        document: { createElement: (tag: string) => {
          width: number;
          height: number;
          getContext: (kind: string) => { drawImage: (img: unknown, x: number, y: number) => void } | null;
          toDataURL: (kind: string) => string;
        } };
      };
      return await new Promise<string>((resolvePromise, reject) => {
        const img = new browserGlobals.Image();
        img.onload = () => {
          const canvas = browserGlobals.document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('canvas 2d context unavailable'));
            return;
          }
          ctx.drawImage(img, 0, 0);
          resolvePromise(canvas.toDataURL('image/png').split(',')[1] ?? '');
        };
        img.onerror = () => reject(new Error('preview image failed to decode'));
        img.src = src;
      });
    }, dataUrl);
    if (!base64) {
      throw new CodesignError('VISUAL_DIFF_IMAGE_INVALID', 'preview image conversion produced no data', {});
    }
    return Buffer.from(base64, 'base64');
  } finally {
    await call.done();
  }
}

function looksLikePng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
