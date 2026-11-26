// 还原度静态校验的纯函数部分：锚点解析、代码声明提取、多维度比对、可维护性检查、盲区枚举。
// 不依赖浏览器/网络，便于单测。期望值一律由调用方传入（MCP 工具层重新拉 spec 重建）。
//
// 声明解析遵循两条原则，避免与「可维护代码」规范互相打架：
// 1. 支持 var(--token) / var(--token, fallback)：变量索引跨所有传入的 codeFiles 建立，
//    把全局样式/主题文件一并传入即可校验设计 token，不必把字面量散写进组件。
// 2. 属性锚点（模板里的 <img data-slice-id>）按 class/className 关联到同批文件中的
//    CSS 规则块，scoped 样式写在文件末尾也能被看到，不再只看锚点后 16 行。
// 两者都无法解析时才报 UNVERIFIABLE，由人工复核。

import type { PlatformSpec, SliceManifest, SpecLayer } from './types.js';

export const VERIFY_CHECKS = [
  'size',
  'scale',
  'color',
  'typography',
  'radius',
  'hierarchy',
  'maintainability',
] as const;
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

// 机器统计的可维护性指标：Skill 的回执直接抄这些数字，不由模型自行计数。
export interface FileMetrics {
  path: string;
  lines: number;
  absoluteCount: number;
  importantCount: number;
  consoleLogCount: number;
  duplicatedBlocks: number;
  repeatedLiterals: number;
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
  // 明确无需使用的切图 objectId 白名单（局部还原/确认省略），不计入 SLICE_UNUSED。
  allowUnusedSlices?: string[];
}

export interface VerifyReport {
  ok: boolean;
  summary: { pass: number; fail: number; warn: number };
  issues: VerifyIssue[];
  reviewRequired: ReviewItem[];
  anchors: number;
  checkedSlices: number;
  metrics: { files: FileMetrics[] };
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
  classes: string[];
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
const CLASS_ATTR_RE = /(?:class|className)\s*=\s*["']([^"']+)["']/g;

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

const CSS_VAR_DEF_RE = /(--[\w-]+)\s*:\s*([^;{}]+)/g;
const VAR_REF_RE = /var\(\s*(--[\w-]+)\s*(?:,([^()]+))?\)/g;
const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
const CLASS_IN_SELECTOR_RE = /\.([A-Za-z_][\w-]*)/g;

const ABSOLUTE_RE = /position\s*:\s*absolute/gi;
const IMPORTANT_RE = /!important/g;
const CONSOLE_RE = /console\s*\.\s*(?:log|debug|info)\s*\(/g;
const MEANINGLESS_CLASS_RE = /^(?:box|div|wrap|wrapper|container|item|block|section|view|col|row|main|content)\d+$/;
const HEX_LITERAL_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const FONT_SIZE_LITERAL_RE = /font-size\s*:\s*-?\d+(?:\.\d+)?(?:px|rem|rpx)/gi;

const MAX_FILE_LINES = 400;
const MAX_TEMPLATE_LINES = 300;
const MAX_ABSOLUTE_PER_FILE = 2;
const REPEAT_THRESHOLD = 3;

// 跨文件收集 CSS 自定义属性：--token: value。后出现的定义覆盖先出现的。
export function collectCssVariables(files: CodeFile[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const file of files) {
    CSS_VAR_DEF_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CSS_VAR_DEF_RE.exec(file.text)) !== null) {
      const name = match[1];
      const value = match[2];
      if (name && value) vars.set(name, value.trim());
    }
  }
  return vars;
}

// 解析 var(--token) 与 var(--token, fallback)，最多展开 4 层防止循环引用。
export function resolveCssValue(raw: string, vars: Map<string, string>): string {
  let value = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!value.includes('var(')) break;
    let replaced = false;
    value = value.replace(VAR_REF_RE, (whole: string, name: string, fallback?: string) => {
      const found = vars.get(name);
      if (found != null) {
        replaced = true;
        return found;
      }
      if (fallback != null) {
        replaced = true;
        return fallback.trim();
      }
      return whole;
    });
    if (!replaced) break;
  }
  return value;
}

// 建立「类名 → CSS 规则体」索引，覆盖所有传入文件（含 scoped 样式与独立样式文件）。
export function collectClassRules(files: CodeFile[]): Map<string, string> {
  const rules = new Map<string, string>();
  for (const file of files) {
    RULE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RULE_RE.exec(file.text)) !== null) {
      const selector = match[1] ?? '';
      const body = match[2] ?? '';
      if (!body.trim()) continue;
      CLASS_IN_SELECTOR_RE.lastIndex = 0;
      let cls: RegExpExecArray | null;
      while ((cls = CLASS_IN_SELECTOR_RE.exec(selector)) !== null) {
        const name = cls[1];
        if (!name) continue;
        const existing = rules.get(name);
        rules.set(name, existing ? `${existing}\n${body}` : body);
      }
    }
  }
  return rules;
}

function extractAnchors(files: CodeFile[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const classes = extractClasses(line);
      for (const [pattern, kind] of [
        [ATTR_RE, 'attribute'],
        [COMMENT_RE, 'comment'],
      ] as const) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          const objectId = match[1]!.trim();
          if (!objectId) continue;
          const end = Math.min(lines.length, i + WINDOW_LINES);
          anchors.push({
            objectId,
            kind,
            file: file.path,
            line: i + 1,
            block: lines.slice(i, end).join('\n'),
            classes,
          });
        }
      }
    }
  }
  return anchors;
}

function extractClasses(line: string): string[] {
  const classes = new Set<string>();
  CLASS_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_ATTR_RE.exec(line)) !== null) {
    for (const name of match[1]!.split(/\s+/)) {
      if (name && !name.includes('{') && !name.includes(':')) classes.add(name);
    }
  }
  return [...classes];
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

function extractDeclarations(block: string, vars: Map<string, string>): Declarations {
  const resolved = resolveCssValue(block, vars);
  const declarations: Declarations = {
    width: firstValue(resolved, 'width'),
    height: firstValue(resolved, 'height'),
    fontSize: firstValue(resolved, 'font-size'),
    lineHeight: firstValue(resolved, 'line-height'),
    radius: firstValue(resolved, 'border-radius'),
    colors: [],
    assetRefs: [],
  };
  BG_SIZE_RE.lastIndex = 0;
  const bg = BG_SIZE_RE.exec(resolved);
  if (bg) {
    declarations.backgroundSize = [
      { value: Number(bg[1]), unit: (bg[2] ?? '').toLowerCase() },
      { value: Number(bg[3]), unit: (bg[4] ?? '').toLowerCase() },
    ];
  }
  let match: RegExpExecArray | null;
  COLOR_RE.lastIndex = 0;
  while ((match = COLOR_RE.exec(resolved)) !== null) declarations.colors.push(normalizeColor(match[0]));
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(resolved)) !== null) declarations.assetRefs.push(match[1]!);
  return declarations;
}

function mergeDeclarations(base: Declarations, extra: Declarations): Declarations {
  return {
    width: base.width ?? extra.width,
    height: base.height ?? extra.height,
    backgroundSize: base.backgroundSize ?? extra.backgroundSize,
    fontSize: base.fontSize ?? extra.fontSize,
    lineHeight: base.lineHeight ?? extra.lineHeight,
    radius: base.radius ?? extra.radius,
    colors: [...new Set([...base.colors, ...extra.colors])],
    assetRefs: [...new Set([...base.assetRefs, ...extra.assetRefs])],
  };
}

// 锚点窗口内的声明优先（内联/HTML 属性），class 关联到的 CSS 规则用于补齐缺失字段。
function declarationsForAnchor(
  anchor: Anchor,
  vars: Map<string, string>,
  classRules: Map<string, string>,
): Declarations {
  let declarations = extractDeclarations(anchor.block, vars);
  for (const cls of anchor.classes) {
    const body = classRules.get(cls);
    if (body) declarations = mergeDeclarations(declarations, extractDeclarations(body, vars));
  }
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

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

// 相同连续 4 行非空代码块出现 >=3 次视为复制粘贴（非重叠计数）。
function findDuplicatedBlocks(lines: string[]): { count: number; line: number } {
  const blockSize = 4;
  const normalized = lines.map((line) => line.trim());
  const seen = new Map<string, number[]>();
  for (let i = 0; i + blockSize <= normalized.length; i += 1) {
    const slice = normalized.slice(i, i + blockSize);
    if (slice.some((line) => line === '')) continue;
    const joined = slice.join('\n');
    if (!joined.includes('<') || !/[a-zA-Z]{3,}/.test(joined)) continue;
    const starts = seen.get(joined);
    if (starts) starts.push(i);
    else seen.set(joined, [i]);
  }
  let count = 0;
  let firstLine = 0;
  for (const starts of seen.values()) {
    const nonOverlapping: number[] = [];
    for (const start of starts) {
      const last = nonOverlapping[nonOverlapping.length - 1];
      if (last == null || start - last >= blockSize) nonOverlapping.push(start);
    }
    if (nonOverlapping.length >= REPEAT_THRESHOLD) {
      count += 1;
      if (firstLine === 0) firstLine = nonOverlapping[0]! + 1;
    }
  }
  return { count, line: firstLine };
}

// 已提为 CSS 变量的字面量不算魔法值：统计前先剔除变量定义。
function repeatedLiterals(text: string): { total: number; preview: string[] } {
  const withoutVarDefs = text.replace(CSS_VAR_DEF_RE, '');
  const tally = new Map<string, number>();
  const collect = (pattern: RegExp): void => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(withoutVarDefs)) !== null) {
      const key = match[0].toLowerCase().replace(/\s+/g, '');
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  };
  collect(HEX_LITERAL_RE);
  collect(FONT_SIZE_LITERAL_RE);
  const repeated = [...tally.entries()].filter(([, count]) => count >= REPEAT_THRESHOLD);
  repeated.sort((a, b) => b[1] - a[1]);
  return {
    total: repeated.length,
    preview: repeated.slice(0, 3).map(([value, count]) => `${value}x${count}`),
  };
}

function meaninglessClassNames(text: string): string[] {
  const names = new Set<string>();
  CLASS_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLASS_ATTR_RE.exec(text)) !== null) {
    for (const name of match[1]!.split(/\s+/)) {
      if (MEANINGLESS_CLASS_RE.test(name)) names.add(name);
    }
  }
  return [...names];
}

function analyzeMaintainability(files: CodeFile[]): { issues: VerifyIssue[]; metrics: FileMetrics[] } {
  const issues: VerifyIssue[] = [];
  const metrics: FileMetrics[] = [];
  const add = (file: string, line: number, code: string, message: string, actual?: string): void => {
    issues.push({ code, dimension: 'maintainability', severity: 'warning', file, line, message, actual });
  };

  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    const absoluteCount = countMatches(file.text, ABSOLUTE_RE);
    const importantCount = countMatches(file.text, IMPORTANT_RE);
    const consoleLogCount = countMatches(file.text, CONSOLE_RE);
    const duplicated = findDuplicatedBlocks(lines);
    const literals = repeatedLiterals(file.text);
    metrics.push({
      path: file.path,
      lines: lines.length,
      absoluteCount,
      importantCount,
      consoleLogCount,
      duplicatedBlocks: duplicated.count,
      repeatedLiterals: literals.total,
    });

    if (lines.length > MAX_FILE_LINES) {
      add(file.path, 1, 'FILE_TOO_LARGE', `file has ${lines.length} lines (> ${MAX_FILE_LINES}); split reusable blocks into child components`, String(lines.length));
    }
    const template = file.text.match(/<template>[\s\S]*?<\/template>/);
    if (template && template[0].split(/\r?\n/).length > MAX_TEMPLATE_LINES) {
      add(file.path, 1, 'FILE_TOO_LARGE', `template has more than ${MAX_TEMPLATE_LINES} lines; split it into child components`);
    }
    if (absoluteCount > MAX_ABSOLUTE_PER_FILE) {
      add(file.path, 1, 'ABSOLUTE_OVERUSE', `position:absolute used ${absoluteCount} times; keep document flow (flex/grid) and reserve absolute for overlays/badges`, String(absoluteCount));
    }
    if (importantCount > 0) {
      add(file.path, 1, 'NO_IMPORTANT', `found ${importantCount} !important declaration(s); fix specificity instead`, String(importantCount));
    }
    if (consoleLogCount > 0) {
      add(file.path, 1, 'CONSOLE_LEFT', `found ${consoleLogCount} console log/debug call(s); remove before delivery`, String(consoleLogCount));
    }
    if (duplicated.count > 0) {
      add(file.path, duplicated.line, 'DUPLICATED_BLOCK', `${duplicated.count} repeated template block(s) (>=${REPEAT_THRESHOLD} copies); render with v-for/map and shared data instead`, String(duplicated.count));
    }
    if (literals.total > 0) {
      add(file.path, 1, 'MAGIC_VALUE', `literal color/font-size repeated >=${REPEAT_THRESHOLD} times without a variable: ${literals.preview.join(', ')}; hoist to CSS variables or design tokens`, literals.preview.join(', '));
    }
    const meaningless = meaninglessClassNames(file.text);
    if (meaningless.length > 0) {
      add(file.path, 1, 'MEANINGLESS_NAME', `non-semantic class name(s): ${meaningless.slice(0, 5).join(', ')}`, meaningless.join(','));
    }
  }
  return { issues, metrics };
}

export function verifyRendering(input: VerifyInput): VerifyReport {
  const checks = new Set<VerifyCheck>(input.checks ?? VERIFY_CHECKS);
  const expectedScale = input.scale ?? 2;
  const vars = collectCssVariables(input.files);
  const classRules = collectClassRules(input.files);
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
    const declarations = declarationsForAnchor(anchor, vars, classRules);
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
            message: `${axis} cannot be statically resolved (external class, percentage, or dynamic style); pass the file defining the CSS variable in codeFiles or add an inline width/height`,
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

  const allowedUnused = new Set(input.allowUnusedSlices ?? []);
  const unusedSlices = input.manifest
    .filter((item) => item.exportables.some((e) => e.scale === expectedScale))
    .map((item) => item.object_id)
    .filter((id) => !seen.has(id) && !allowedUnused.has(id));
  for (const objectId of unusedSlices) {
    addIssue({
      code: 'SLICE_UNUSED',
      dimension: 'asset',
      severity: 'error',
      layerObjectId: objectId,
      file: '',
      line: 0,
      message: `design has a ${expectedScale}x slice but no code anchor uses it (pass allowUnusedSlices to exempt intentionally omitted slices)`,
    });
  }

  const maintainability = analyzeMaintainability(input.files);
  if (checks.has('maintainability')) {
    for (const issue of maintainability.issues) addIssue(issue);
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
    metrics: { files: maintainability.metrics },
  };
}
