// verify_rendering：重新拉取权威 spec，重建 platformSpec，读取生成代码，
// 按 data-slice-id 属性 / `slice:` 注释锚点比对尺寸、倍率、颜色、字号、圆角、层级。
// 期望值不信任 LLM 入参，全部由工具重新拉取重建，防止错误转录。

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { McpServer } from '../mcp/server.js';
import { objectSchema } from '../mcp/schema.js';
import { browserManager } from '../browser/manager.js';
import { getCachedSharingDetail, fetchCachedSpec, fetchCachedSliceManifest } from '../codesign/cache.js';
import { normalizeSpec } from '../codesign/parser.js';
import { buildPlatformSpec } from '../codesign/platform.js';
import { verifyRendering, VERIFY_CHECKS, type CodeFile, type VerifyCheck } from '../codesign/verify.js';
import { screenExpectationMismatch } from '../codesign/visual-diff.js';
import { CodesignError } from '../codesign/errors.js';
import { parseSharingId } from '../utils/url.js';
import { config } from '../config.js';
import { errorResult } from './artboards.js';
import { pickScreen, summarizeScreens } from './spec.js';
import { toolSuccess, summarizeVerifyPayload } from '../mcp/result.js';
import { getLogger } from '../logger.js';
import type { SharingScreen } from '../codesign/types.js';

const log = getLogger();
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface VerifyInput {
  sharingUrl: string;
  password?: string;
  screenId?: number | string;
  objectId?: string;
  screenName?: string;
  expectedScreenId?: number | string;
  expectedScreenName?: string;
  codeFiles: string[];
  targetPlatform: string;
  targetUnit?: string;
  customScale?: number;
  customWidth?: number;
  remBasePx?: number;
  scale?: number;
  checks?: VerifyCheck[];
  allowUnusedSlices?: string[];
  includeFullText?: boolean;
}

const inputSchema = objectSchema(
  {
    sharingUrl: { type: 'string', minLength: 1 },
    password: { type: 'string' },
    screenId: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
    objectId: { type: 'string' },
    screenName: { type: 'string' },
    expectedScreenId: {
      anyOf: [{ type: 'integer' }, { type: 'string' }],
      description: 'Assert the resolved screen id matches this value (multi-artboard guard).',
    },
    expectedScreenName: {
      type: 'string',
      description: 'Assert the resolved screen name matches this value exactly (multi-artboard guard).',
    },
    codeFiles: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Project files to scan, relative to the workspace root.',
    },
    targetPlatform: {
      type: 'string',
      minLength: 1,
      description: 'Same platform used for get_artboard_spec, e.g. web, wechat-miniprogram, raw.',
    },
    targetUnit: { type: 'string' },
    customScale: { type: 'number', minimum: 0 },
    customWidth: { type: 'number', minimum: 0 },
    remBasePx: { type: 'number', minimum: 0 },
    scale: { type: 'number', minimum: 1, default: 2, description: 'Expected slice scale, default 2.' },
    checks: {
      type: 'array',
      items: { type: 'string', enum: [...VERIFY_CHECKS] },
      description: 'Dimensions to verify. Defaults to all (including maintainability).',
    },
    allowUnusedSlices: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Slice objectIds intentionally omitted from this page; exempts them from SLICE_UNUSED.',
    },
    includeFullText: { type: 'boolean', default: false },
  },
  ['sharingUrl', 'codeFiles', 'targetPlatform'],
);

export function registerVerifyRenderingTool(server: McpServer): void {
  server.registerTool(
    'verify_rendering',
    {
      title: 'Verify Rendering Against Design',
      description:
        'Re-fetches the official CoDesign spec (bypassing any LLM-supplied measurements), rebuilds platformSpec, ' +
        'then statically checks generated code against the design for size, slice scale, color, typography, radius, hierarchy, and code maintainability. ' +
        'Anchors are data-slice-id="<layerObjectId>" attributes or /* slice:<layerObjectId> */ comments. ' +
        'CSS custom properties (var(--token)) and class-linked style rules are resolved across the supplied codeFiles, so token-based and scoped styles stay verifiable. ' +
        'Returns per-issue file/line, machine-counted maintainability metrics, a reviewRequired list for unresolvable visual areas, and ok=false when any hard check fails. ' +
        'This tool never modifies files; use its issues to fix code before finishing.',
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: VerifyInput) => {
      const {
        sharingUrl, password, screenId, objectId, screenName,
        expectedScreenId, expectedScreenName, codeFiles,
        targetPlatform, targetUnit, customScale, customWidth, remBasePx,
        scale, checks, allowUnusedSlices, includeFullText,
      } = args;
      let sharingId: string;
      try {
        sharingId = parseSharingId(sharingUrl);
      } catch (err) {
        return errorResult(err);
      }

      // 先做纯本地的文件读取与路径校验，避免无谓地拉取远端数据。
      let files: CodeFile[];
      try {
        files = codeFiles.map((entry) => readCodeFile(entry));
      } catch (err) {
        return errorResult(err);
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

        // 多画板防错配：断言实际解析到的画板与调用方期望一致。
        const mismatch = screenExpectationMismatch(
          { id: picked.id, name: picked.name },
          { expectedScreenId, expectedScreenName },
        );
        if (mismatch) {
          return errorResult(
            new CodesignError('SCREEN_NOT_FOUND', `resolved screen does not match expectedScreen${mismatch}`, {
              expectedScreenId,
              expectedScreenName,
              resolved: { id: picked.id, name: picked.name },
              available: summarizeScreens(allScreens),
            }),
          );
        }

        const spec = await fetchCachedSpec(picked.meta_url);
        const manifest = picked.slices_url ? await fetchCachedSliceManifest(picked.slices_url) : [];
        const platformSpec = buildPlatformSpec(spec, targetPlatform, {
          targetUnit,
          customScale,
          customWidth,
          remBasePx,
        });
        const normalized = normalizeSpec(spec, manifest, platformSpec);

        const report = verifyRendering({
          files,
          layers: normalized.layers,
          groups: normalized.groups,
          hierarchy: normalized.hierarchy,
          platformSpec,
          manifest,
          scale: scale ?? 2,
          checks: checks && checks.length > 0 ? checks : undefined,
          allowUnusedSlices,
        });

        return toolSuccess({
          sharingId,
          screen: {
            id: picked.id,
            objectId: picked.object_id,
            name: picked.name,
            width: picked.width,
            height: picked.height,
          },
          platform: {
            requested: platformSpec.requested,
            id: platformSpec.id,
            unit: platformSpec.unit,
            scale: platformSpec.scale,
          },
          summary: report.summary,
          ok: report.ok,
          issues: report.issues,
          reviewRequired: report.reviewRequired,
          anchors: report.anchors,
          checkedSlices: report.checkedSlices,
          metrics: report.metrics,
          files: files.map((file) => file.path),
        }, includeFullText, summarizeVerifyPayload);
      } catch (err) {
        log.warn({ err: (err as Error).message, sharingId }, 'verify_rendering failed');
        return errorResult(err);
      } finally {
        await call.done();
      }
    },
  );
}

function readCodeFile(entry: string): CodeFile {
  const root = resolve(config.workspaceRoot);
  const target = isAbsolute(entry) ? resolve(entry) : resolve(root, entry);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CodesignError('ARTIFACT_PATH_INVALID', 'code file escapes the workspace root', {
      root,
      entry,
      target,
    });
  }
  let stats;
  try {
    stats = statSync(target);
  } catch {
    throw new CodesignError('CODE_FILE_INVALID', 'code file does not exist', { entry, target });
  }
  if (!stats.isFile()) {
    throw new CodesignError('CODE_FILE_INVALID', 'code path is not a file', { entry, target });
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new CodesignError('CODE_FILE_INVALID', 'code file is too large to verify', {
      entry,
      bytes: stats.size,
      maxBytes: MAX_FILE_BYTES,
    });
  }
  return { path: entry, text: readFileSync(target, 'utf8') };
}
