// visual_diff 的核心纯函数：图片解码、按比例对齐、像素差分、相似度分数与差异热区。
// 不接触浏览器和文件系统，便于单测。所有期望尺寸由调用方（MCP 工具）从 platformSpec 重建后传入。

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { CodesignError } from './errors.js';

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface DiffAlignment {
  target: { width: number; height: number };
  design: { width: number; height: number; scaled: boolean };
  render: { width: number; height: number; scaled: boolean };
}

export interface DiffHotspot {
  x: number;
  y: number;
  width: number;
  height: number;
  diffRatio: number;
}

export interface VisualDiffReport {
  score: number;
  diffPixels: number;
  totalPixels: number;
  threshold: number;
  alignment: DiffAlignment;
  hotspots: DiffHotspot[];
  diffImagePng: Buffer | null;
}

export interface CompareOptions {
  threshold?: number;
  maxAspectRatioDrift?: number;
  gridCols?: number;
  gridRows?: number;
  maxHotspots?: number;
  includeDiffImage?: boolean;
}

const DIFF_COLOR = [255, 0, 0] as const;

export function decodePng(buf: Buffer): DecodedImage {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: Uint8Array.from(png.data) };
}

export function encodePng(image: DecodedImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

// 双线性缩放，保证 2x 预览图缩到 CSS 尺寸后仍可做逐像素比对。
export function resizeRgba(src: DecodedImage, targetWidth: number, targetHeight: number): DecodedImage {
  const sw = src.width;
  const sh = src.height;
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sy = ((y + 0.5) * sh) / targetHeight - 0.5;
    const y0 = clampIndex(Math.floor(sy), sh);
    const y1 = clampIndex(y0 + 1, sh);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = ((x + 0.5) * sw) / targetWidth - 0.5;
      const x0 = clampIndex(Math.floor(sx), sw);
      const x1 = clampIndex(x0 + 1, sw);
      const fx = Math.min(1, Math.max(0, sx - x0));
      for (let c = 0; c < 4; c += 1) {
        const top = lerp(src.data[(y0 * sw + x0) * 4 + c]!, src.data[(y0 * sw + x1) * 4 + c]!, fx);
        const bottom = lerp(src.data[(y1 * sw + x0) * 4 + c]!, src.data[(y1 * sw + x1) * 4 + c]!, fx);
        out[(y * targetWidth + x) * 4 + c] = Math.round(lerp(top, bottom, fy));
      }
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

function clampIndex(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function aspect(width: number, height: number): number {
  return width / height;
}

// 对齐失败必须显式报错，不能用缩放后看似合理的低分误导用户。
function assertAligned(
  design: DecodedImage,
  render: DecodedImage,
  target: { width: number; height: number },
  drift: number,
): void {
  const targetAr = aspect(target.width, target.height);
  const candidates: Array<[string, DecodedImage]> = [
    ['design preview', design],
    ['rendered screenshot', render],
  ];
  for (const [label, image] of candidates) {
    const actualAr = aspect(image.width, image.height);
    const relativeDrift = Math.abs(actualAr - targetAr) / targetAr;
    if (relativeDrift > drift) {
      throw new CodesignError('VISUAL_DIFF_ALIGNMENT', 'image aspect ratio differs from the artboard viewport', {
        target,
        relativeDrift: Number(relativeDrift.toFixed(4)),
        image: { label, width: image.width, height: image.height },
        hint: 'Make sure the screenshot uses the artboard viewport and the correct screen is selected.',
      });
    }
  }
}

export function compareImages(
  design: DecodedImage,
  render: DecodedImage,
  target: { width: number; height: number },
  options: CompareOptions = {},
): VisualDiffReport {
  const threshold = options.threshold ?? 0.1;
  const drift = options.maxAspectRatioDrift ?? 0.05;
  const gridCols = options.gridCols ?? 8;
  const gridRows = options.gridRows ?? 8;
  const maxHotspots = options.maxHotspots ?? 6;

  assertAligned(design, render, target, drift);

  const designScaled = design.width !== target.width || design.height !== target.height;
  const renderScaled = render.width !== target.width || render.height !== target.height;
  const designAligned = designScaled ? resizeRgba(design, target.width, target.height) : design;
  const renderAligned = renderScaled ? resizeRgba(render, target.width, target.height) : render;

  const includeDiffImage = options.includeDiffImage !== false;
  const diffData = includeDiffImage ? new Uint8Array(target.width * target.height * 4) : null;
  const diffPixels = pixelmatch(
    designAligned.data,
    renderAligned.data,
    diffData,
    target.width,
    target.height,
    { threshold, diffColor: [...DIFF_COLOR], includeAA: false },
  );
  const totalPixels = target.width * target.height;
  const hotspots = diffData
    ? collectHotspots(diffData, target.width, target.height, gridCols, gridRows, maxHotspots)
    : [];

  return {
    score: Number((1 - diffPixels / totalPixels).toFixed(4)),
    diffPixels,
    totalPixels,
    threshold,
    alignment: {
      target,
      design: { width: design.width, height: design.height, scaled: designScaled },
      render: { width: render.width, height: render.height, scaled: renderScaled },
    },
    hotspots,
    diffImagePng: diffData
      ? encodePng({ width: target.width, height: target.height, data: diffData })
      : null,
  };
}

function isDiffPixel(data: Uint8Array, offset: number): boolean {
  return data[offset]! >= 250 && data[offset + 1]! <= 8 && data[offset + 2]! <= 8;
}

function collectHotspots(
  diffData: Uint8Array,
  width: number,
  height: number,
  cols: number,
  rows: number,
  maxHotspots: number,
): DiffHotspot[] {
  const cellWidth = Math.ceil(width / cols);
  const cellHeight = Math.ceil(height / rows);
  const cells: DiffHotspot[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y0 = row * cellHeight;
    const y1 = Math.min(height, y0 + cellHeight);
    for (let col = 0; col < cols; col += 1) {
      const x0 = col * cellWidth;
      const x1 = Math.min(width, x0 + cellWidth);
      let diff = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          total += 1;
          if (isDiffPixel(diffData, (y * width + x) * 4)) diff += 1;
        }
      }
      if (total > 0 && diff > 0) {
        cells.push({
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
          diffRatio: Number((diff / total).toFixed(4)),
        });
      }
    }
  }
  cells.sort((a, b) => b.diffRatio - a.diffRatio);
  return cells.slice(0, maxHotspots);
}

export function scoreVerdict(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.95) return 'high';
  if (score >= 0.85) return 'medium';
  return 'low';
}

export const VISUAL_DIFF_CAVEATS = [
  'Font rasterization differs across OS and DPI; text areas may lower the score even when code is correct.',
  'Scores are regression signals for comparing runs, not a pass/fail gate.',
  'Dynamic states (hover, loading, animation) are captured only if visible at screenshot time.',
] as const;
