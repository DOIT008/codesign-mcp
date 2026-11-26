// 还原度静态校验的纯函数部分：锚点解析、代码声明提取、六维度比对、盲区枚举。
// 不依赖浏览器/网络，便于单测。期望值一律由调用方传入（MCP 工具层重新拉 spec 重建）。

import type { PlatformSpec, SliceManifest, SpecLayer } from './types.js';

export const VERIFY_CHECKS = ['size', 'scale', 'color', 'typography', 'radius', 'hierarchy'] as const;
export type VerifyCheck = (typeof VERIFY_CHECKS)[number];

export interface CodeFile {
  path: string;
  text: string;
}

export interface VerifyIssue {
  code: string;
  dimension: VerifyCheck | 'asset' | 'parse';
  severity: 'error' | 'warning';
  layerObjectId?: string;
  file: string;
  line: number;
  expected?: string;
  actual?: string | null;
  message: string;
}

export interface ReviewItem {
  layerObjectId: string;
  name: string;
  reasons: string[];
  file?: string;
  line?: number;
}

export interface VerifyInput {
  files: CodeFile[];
  layers: SpecLayer[];
  groups: SpecLayer[];
  hierarchy: unknown[];
  platformSpec: PlatformSpec;
  manifest: SliceManifest;
  scale?: number;
  checks?: VerifyCheck[];
}

export interface VerifyReport {
  ok: boolean;
  summary: { pass: number; fail: number; warn: number };
  issues: VerifyIssue[];
  reviewRequired: ReviewItem[];
  anchors: number;
  checkedSlices: number;
}

interface NumericValue {
  value: number;
  unit: string;
}

interface Anchor {
  objectId: string;
  kind: 'attribute' | 'comment';
  file: string;
  line: number;
  block: string;
}

interface Declarations {
  width?: NumericValue;
  height?: NumericValue;
  backgroundSize?: [NumericValue, NumericValue];
  fontSize?: NumericValue;
  lineHeight?: NumericValue;
  radius?: NumericValue;
  colors: string[];
  assetRefs: string[];
}

const WINDOW_LINES = 16;
const ATTR_RE = /data-slice-id\s*=\s*["'`]([^"'`]+)["'`]/gi;
const COMMENT_RE = /\/\*\s*slice\s*[:：]\s*([^*]+?)\s*\*\//gi;

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const UNIT = '(px|rem|rpx|dp|pt|%)?';

function cssProp(prop: string): RegExp {
  return new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*${NUM}\\s*${UNIT}`, 'gi');
}

function htmlAttr(prop: string): RegExp {
  return new RegExp(`${prop}\\s*=\\s*["']${NUM}${UNIT}["']`, 'gi');
}

const BG_SIZE_RE = new RegExp(`background-size\\s*:\\s*${NUM}\\s*${UNIT}[\\s,]+${NUM}\\s*${UNIT}`, 'gi');
const URL_RE = /(?:url\(\s*["']?|src\s*=\s*["'])([^"')>\s]+)/gi;
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/g;

function extractAnchors(files: CodeFile[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const [pattern, kind] of [
        [ATTR_RE, 'attribute'],
        [COMMENT_RE, 'comment'],
      ] as const) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          const objectId = match[1].trim();
          if (!objectId) continue;
          const end = Math.min(lines.length, i + WINDOW_LINES);
          anchors.push({
            objectId,
            kind,
            file: file.path,
            line: i + 1,
            block: lines.slice(i, end).join('\n'),
          });
        }
      }
    }
  }
  return anchors;
}

function firstValue(block: string, prop: string): NumericValue | undefined {
  const css = cssProp(prop);
  const match = css.exec(block);
  if (match) return { value: Number(match[1]), unit: (match[2] ?? '').toLowerCase() };
  const attr = htmlAttr(prop);
  const attrMatch = attr.exec(block);
  if (attrMatch) return { value: Number(attrMatch[1]), unit: (attrMatch[2] ?? '').toLowerCase() };
  return undefined;
}

function extractDeclarations(block: string): Declarations {
  const declarations: Declarations = {
    width: firstValue(block, 'width'),
    height: firstValue(block, 'height'),
    fontSize: firstValue(block, 'font-size'),
    lineHeight: firstValue(block, 'line-height'),
    radius: firstValue(block, 'border-radius'),
    colors: [],
    assetRefs: [],
  };
  BG_SIZE_RE.lastIndex = 0;
  const bg = BG_SIZE_RE.exec(block);
  if (bg) {
    declarations.backgroundSize = [
      { value: Number(bg[1]), unit: (bg[2] ?? '').toLowerCase() },
      { value: Number(bg[3]), unit: (bg[4] ?? '').toLowerCase() },
    ];
  }
  let match: RegExpExecArray | null;
  COLOR_RE.lastIndex = 0;
  while ((match = COLOR_RE.exec(block)) !== null) declarations.colors.push(normalizeColor(match[0]));
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(block)) !== null) declarations.assetRefs.push(match[1]);
  return declarations;
}

function normalizeColor(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) return `#${hex.split('').map((c) => c + c).join('')}`;
    return `#${hex}`;
  }
  const numbers = value.match(/\d+(?:\.\d+)?/g) ?? [];
  return `rgba(${numbers.slice(0, 4).join(',')})`;
}

// 统一以 px 为基准：rem 用 remBasePx 换算，px 原值，
// rpx/dp/pt 只在与目标平台同单位时按数值直接比较（跨单位无法静态换算）。
function toPixels(value: NumericValue, platform: PlatformSpec): number | undefined {
  const unit = value.unit || platform.unit;
  if (unit === 'rem') return value.value * remBase(platform);
  if (unit === 'px') return value.value;
  if (unit === platform.unit) return value.value;
  return undefined;
}

function remBase(platform: PlatformSpec): number {
  const base = platform.conversion.remBasePx;
  return typeof base === 'number' && base > 0 ? base : 16;
}

function expectedPixels(value: number, platform: PlatformSpec): number {
  return platform.unit === 'rem' ? value * remBase(platform) : value;
}

type SizeStatus = 'pass' | 'double' | 'mismatch' | 'unverifiable';

function compareSize(expected: number, platform: PlatformSpec, actual: NumericValue | undefined): {
  status: SizeStatus;
  actualPx?: number;
} {
  if (!actual || actual.unit === '%') return { status: 'unverifiable' };
  const actualPx = toPixels(actual, platform);
  const expectedPx = expectedPixels(expected, platform);
  if (actualPx == null || !Number.isFinite(expectedPx) || expectedPx <= 0) return { status: 'unverifiable' };
  const ratio = actualPx / expectedPx;
  if (Math.abs(ratio - 1) <= 0.02 || Math.abs(actualPx - expectedPx) <= 1) {
    return { status: 'pass', actualPx };
  }
  if (Math.abs(ratio - 2) <= 0.02) return { status: 'double', actualPx };
  return { status: 'mismatch', actualPx };
}

function detectScaleRefs(refs: string[]): number[] {
  const scales = new Set<number>();
  for (const ref of refs) {
    const match = ref.match(/@(\d)x|[-_](\d)x\.|scale[=_-]?(\d)/i);
    if (!match) continue;
    const value = Number(match[1] ?? match[2] ?? match[3]);
    if ([1, 2, 3, 4].includes(value)) scales.add(value);
  }
  return [...scales];
}

function expectedColors(layer: SpecLayer): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || found.length > 8) return;
    if (typeof value === 'string') {
      let match: RegExpExecArray | null;
      COLOR_RE.lastIndex = 0;
      while ((match = COLOR_RE.exec(value)) !== null) found.push(normalizeColor(match[0]));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (/color|fill|stroke|background/i.test(key)) visit(item, depth + 1);
      }
    }
  };
  if (layer.fills) visit(layer.fills, 0);
  if (layer.color) visit(layer.color, 0);
  return [...new Set(found)];
}

function reviewReasons(layer: SpecLayer): string[] {
  const reasons: string[] = [];
  const extra = layer as unknown as Record<string, unknown>;
  if (Array.isArray(extra.masks) && extra.masks.length > 0) reasons.push('mask');
  if (Array.isArray(layer.effects) && layer.effects.length > 0) reasons.push('effect');
  if (Array.isArray(layer.shadows) && layer.shadows.length > 0) reasons.push('shadow');
  const css = Array.isArray(layer.css) ? layer.css.join(' ') : (layer.css ?? '');
  if (/gradient|mask|filter|backdrop-filter|blur|mix-blend/i.test(css)) reasons.push('css-complex');
  if (layer.type === 'text' && !layer.content) reasons.push('text-content-missing');
  return reasons;
}

function collectOrder(nodes: unknown[], output: string[] = []): string[] {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const id = record.object_id ?? record.objectId ?? record.id;
    if (typeof id === 'string' && id && !output.includes(id)) output.push(id);
    for (const key of ['children', 'layers', 'groups']) {
      const child = record[key];
      if (Array.isArray(child)) collectOrder(child, output);
    }
  }
  return output;
}

function scaleFromManifest(manifest: SliceManifest, objectId: string): number[] {
  const item = manifest.find((entry) => entry.object_id === objectId);
  if (!item) return [];
  return [...new Set(item.exportables.map((e) => e.scale).filter((s): s is number => typeof s === 'number'))];
}

export function verifyRendering(input: VerifyInput): VerifyReport {
  const checks = new Set<VerifyCheck>(input.checks ?? VERIFY_CHECKS);
  const expectedScale = input.scale ?? 2;
  const anchors = extractAnchors(input.files);
  const allLayers = [...input.layers, ...input.groups];
  const layerByObjectId = new Map(allLayers.map((layer) => [layer.object_id, layer]));
  const platformByObjectId = new Map(
    [...input.platformSpec.layers, ...input.platformSpec.groups].map((layer) => [layer.objectId, layer]),
  );
  const issues: VerifyIssue[] = [];
  const seen = new Set<string>();
  let pass = 0;

  const addIssue = (issue: VerifyIssue): void => {
    issues.push(issue);
  };

  for (const anchor of anchors) {
    const layer = layerByObjectId.get(anchor.objectId);
    if (!layer) {
      addIssue({
        code: 'ANCHOR_UNRESOLVED',
        dimension: 'parse',
        severity: 'warning',
        layerObjectId: anchor.objectId,
        file: anchor.file,
        line: anchor.line,
        message: `anchor ${anchor.objectId} does not match any spec layer`,
      });
      continue;
    }
    seen.add(anchor.objectId);
    const declarations = extractDeclarations(anchor.block);
    const platformLayer = platformByObjectId.get(anchor.objectId);

    if (checks.has('size') && platformLayer) {
      for (const [axis, actual] of [
        ['width', declarations.width],
        ['height', declarations.height],
      ] as const) {
        const result = compareSize(platformLayer.rect[axis], input.platformSpec, actual);
        const expectedText = `${platformLayer.rect[axis]}${platformLayer.rect.unit}`;
        const actualText = actual ? `${actual.value}${actual.unit || input.platformSpec.unit}` : null;
        if (result.status === 'pass') {
          pass += 1;
        } else if (result.status === 'double') {
          addIssue({
            code: 'DOUBLE_SCALE',
            dimension: 'size',
            severity: 'error',
            layerObjectId: anchor.objectId,
            file: anchor.file,
            line: anchor.line,
            expected: expectedText,
            actual: actualText,
            message: `${axis} is about 2x the design size (2x asset must be displayed at design size)`,
          });
        } else if (result.status === 'mismatch') {
          addIssue({
            code: 'SIZE_MISMATCH',
            dimension: 'size',
            severity: 'error',
            layerObjectId: anchor.objectId,
            file: anchor.file,
            line: anchor.line,
            expected: expectedText,
            actual: actualText,
            message: `${axis} does not match the design size`,
          });
        } else {
          addIssue({
            code: 'UNVERIFIABLE',
            dimension: 'size',
            severity: 'warning',
            layerObjectId: anchor.objectId,
            file: anchor.file,
            line: anchor.line,
            expected: expectedText,
            actual: actualText,
            message: `${axis} cannot be statically resolved (external class, percentage, or dynamic style)`,
          });
        }
      }

      if (declarations.backgroundSize) {
        const [bgWidth, bgHeight] = declarations.backgroundSize;
        for (const [axis, actual] of [
          ['width', bgWidth],
          ['height', bgHeight],
        ] as const) {
          const result = compareSize(platformLayer.rect[axis], input.platformSpec, actual);
          if (result.status === 'pass') pass += 1;
          else if (result.status !== 'unverifiable') {
            addIssue({
              code: result.status === 'double' ? 'DOUBLE_SCALE' : 'SIZE_MISMATCH',
              dimension: 'size',
              severity: 'error',
              layerObjectId: anchor.objectId,
              file: anchor.file,
              line: anchor.line,
              expected: `${platformLayer.rect[axis]}${platformLayer.rect.unit}`,
              actual: `${actual.value}${actual.unit || input.platformSpec.unit}`,
              message: `background-size ${axis} does not match the design size`,
            });
          }
        }
      }
    }

    if (checks.has('scale')) {
      const assetScales = detectScaleRefs(declarations.assetRefs);
      const wrong = assetScales.filter((scale) => scale !== expectedScale);
      if (wrong.length > 0) {
        addIssue({
          code: 'WRONG_SCALE_ASSET',
          dimension: 'scale',
          severity: 'error',
          layerObjectId: anchor.objectId,
          file: anchor.file,
          line: anchor.line,
          expected: `${expectedScale}x`,
          actual: wrong.map((s) => `${s}x`).join(','),
          message: `code references a non-${expectedScale}x slice asset`,
        });
      } else if (assetScales.includes(expectedScale)) {
        pass += 1;
      }
      const available = scaleFromManifest(input.manifest, anchor.objectId);
      if (available.length > 0 && !available.includes(expectedScale)) {
        addIssue({
          code: 'SCALE_UNAVAILABLE',
          dimension: 'scale',
          severity: 'error',
          layerObjectId: anchor.objectId,
          file: anchor.file,
          line: anchor.line,
          expected: `${expectedScale}x`,
          actual: available.map((s) => `${s}x`).join(','),
          message: `design manifest has no ${expectedScale}x export for this layer`,
        });
      }
    }

    if (checks.has('typography')) {
      if (layer.fontSize != null && declarations.fontSize) {
        const expectedFont = expectedPixels(layer.fontSize * input.platformSpec.scale, input.platformSpec);
        const result = compareSize(expectedFont, input.platformSpec, declarations.fontSize);
        if (result.status === 'pass') pass += 1;
        else if (result.status !== 'unverifiable') {
          addIssue({
            code: 'FONT_SIZE_MISMATCH',
            dimension: 'typography',
            severity: 'warning',
            layerObjectId: anchor.objectId,
            file: anchor.file,
            line: anchor.line,
            expected: `${expectedFont}${input.platformSpec.unit}`,
            actual: `${declarations.fontSize.value}${declarations.fontSize.unit || input.platformSpec.unit}`,
            message: 'font-size does not match the design annotation',
          });
        }
      }
      if (layer.lineHeight != null && declarations.lineHeight) {
        const expectedLine = expectedPixels(layer.lineHeight * input.platformSpec.scale, input.platformSpec);
        const result = compareSize(expectedLine, input.platformSpec, declarations.lineHeight);
        if (result.status === 'pass') pass += 1;
        else if (result.status !== 'unverifiable') {
          addIssue({
            code: 'LINE_HEIGHT_MISMATCH',
            dimension: 'typography',
            severity: 'warning',
            layerObjectId: anchor.objectId,
            file: anchor.file,
            line: anchor.line,
            expected: `${expectedLine}${input.platformSpec.unit}`,
            actual: `${declarations.lineHeight.value}${declarations.lineHeight.unit || input.platformSpec.unit}`,
            message: 'line-height does not match the design annotation',
          });
        }
      }
    }

    if (checks.has('radius')) {
      const radius = Array.isArray(layer.radius) ? layer.radius[0] : layer.radius;
      if (typeof radius === 'number' && declarations.radius) {
        const expectedRadius = expectedPixels(radius * input.platformSpec.scale, input.platformSpec);
        const result = compareSize(expectedRadius, input.platformSpec, declarations.radius);
        if (result.status === 'pass') pass += 1;
        else if (result.status !== 'unverifiable') {
          addIssue({
            code: 'RADIUS_MISMATCH',
            dimension: 'radius',
            severity: 'warning',
            layerObjectId: anchor.objectId,
            file: anchor.file,
            line: anchor.line,
            expected: `${expectedRadius}${input.platformSpec.unit}`,
            actual: `${declarations.radius.value}${declarations.radius.unit || input.platformSpec.unit}`,
            message: 'border-radius does not match the design annotation',
          });
        }
      }
    }

    if (checks.has('color') && declarations.colors.length > 0) {
      const expected = expectedColors(layer);
      if (expected.length > 0 && !expected.some((color) => declarations.colors.includes(color))) {
        addIssue({
          code: 'COLOR_MISMATCH',
          dimension: 'color',
          severity: 'warning',
          layerObjectId: anchor.objectId,
          file: anchor.file,
          line: anchor.line,
          expected: expected.slice(0, 3).join(','),
          actual: declarations.colors.slice(0, 3).join(','),
          message: 'no code color matches the design fills (CSS variables may need mapping)',
        });
      } else if (expected.length > 0) {
        pass += 1;
      }
    }
  }

  if (checks.has('hierarchy')) {
    const expectedOrder = collectOrder(input.hierarchy).filter((id) => seen.has(id));
    const actualOrder = anchors.map((anchor) => anchor.objectId).filter((id, index, list) => seen.has(id) && list.indexOf(id) === index);
    for (let i = 0; i < Math.min(expectedOrder.length, actualOrder.length); i += 1) {
      if (expectedOrder[i] === actualOrder[i]) pass += 1;
      else {
        const first = anchors.find((anchor) => anchor.objectId === actualOrder[i]);
        addIssue({
          code: 'HIERARCHY_ORDER',
          dimension: 'hierarchy',
          severity: 'warning',
          layerObjectId: actualOrder[i],
          file: first?.file ?? '',
          line: first?.line ?? 0,
          expected: expectedOrder[i],
          actual: actualOrder[i],
          message: 'anchor order differs from the design hierarchy',
        });
        break;
      }
    }
  }

  const unusedSlices = input.manifest
    .filter((item) => item.exportables.some((e) => e.scale === expectedScale))
    .map((item) => item.object_id)
    .filter((id) => !seen.has(id));
  for (const objectId of unusedSlices) {
    addIssue({
      code: 'SLICE_UNUSED',
      dimension: 'asset',
      severity: 'error',
      layerObjectId: objectId,
      file: '',
      line: 0,
      message: `design has a ${expectedScale}x slice but no code anchor uses it`,
    });
  }

  const reviewRequired: ReviewItem[] = [];
  for (const layer of allLayers) {
    const reasons = reviewReasons(layer);
    if (reasons.length === 0) continue;
    const anchor = anchors.find((item) => item.objectId === layer.object_id);
    reviewRequired.push({
      layerObjectId: layer.object_id,
      name: layer.name,
      reasons,
      file: anchor?.file,
      line: anchor?.line,
    });
  }

  const fail = issues.filter((issue) => issue.severity === 'error').length;
  const warn = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    ok: fail === 0,
    summary: { pass, fail, warn },
    issues,
    reviewRequired,
    anchors: anchors.length,
    checkedSlices: input.manifest.filter((item) => item.exportables.some((e) => e.scale === expectedScale)).length,
  };
}
