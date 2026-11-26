import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePng,
  encodePng,
  resizeRgba,
  compareImages,
  scoreVerdict,
  screenExpectationMismatch,
} from '../dist/codesign/visual-diff.js';
import { summarizeVisualDiffPayload } from '../dist/mcp/result.js';

function solidImage(width, height, [r, g, b, a] = [255, 255, 255, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { width, height, data };
}

function paintRect(image, x0, y0, x1, y1, [r, g, b, a] = [0, 0, 0, 255]) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * image.width + x) * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = a;
    }
  }
}

test('encodePng then decodePng round-trips pixel data', () => {
  const img = solidImage(3, 2, [12, 34, 56, 255]);
  const buf = encodePng(img);
  const decoded = decodePng(buf);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.deepEqual(Array.from(decoded.data.slice(0, 4)), [12, 34, 56, 255]);
});

test('identical images score 1 with zero diff', () => {
  const design = solidImage(40, 20, [240, 240, 240, 255]);
  const render = solidImage(40, 20, [240, 240, 240, 255]);
  const report = compareImages(design, render, { width: 40, height: 20 });
  assert.equal(report.diffPixels, 0);
  assert.equal(report.score, 1);
  assert.equal(report.hotspots.length, 0);
  assert.equal(report.alignment.design.scaled, false);
  assert.ok(report.diffImagePng);
});

test('a clearly different region lowers the score and produces hotspots', () => {
  const design = solidImage(80, 40, [255, 255, 255, 255]);
  const render = solidImage(80, 40, [255, 255, 255, 255]);
  paintRect(render, 0, 0, 40, 20, [0, 0, 0, 255]);
  const report = compareImages(design, render, { width: 80, height: 40 });
  assert.ok(report.diffPixels > 0);
  assert.ok(report.score < 1 && report.score > 0);
  assert.ok(report.hotspots.length > 0);
  assert.equal(report.hotspots[0].x, 0);
  assert.equal(report.hotspots[0].y, 0);
  assert.ok(report.hotspots[0].diffRatio > 0);
});

test('2x preview image scales onto the CSS viewport before comparison', () => {
  const design = solidImage(80, 40, [255, 255, 255, 255]);
  const render = solidImage(80, 40, [255, 255, 255, 255]);
  const report = compareImages(design, render, { width: 40, height: 20 });
  assert.equal(report.alignment.design.scaled, true);
  assert.equal(report.alignment.render.scaled, true);
  assert.equal(report.alignment.design.width, 80);
  assert.equal(report.alignment.target.width, 40);
  assert.equal(report.diffPixels, 0);
  assert.equal(report.score, 1);
});

test('aspect-ratio drift beyond tolerance is rejected instead of scoring', () => {
  const design = solidImage(80, 20, [255, 255, 255, 255]);
  const render = solidImage(40, 20, [255, 255, 255, 255]);
  assert.throws(
    () => compareImages(design, render, { width: 40, height: 20 }),
    (err) => err.code === 'VISUAL_DIFF_ALIGNMENT',
  );
});

test('resizeRgba produces the requested dimensions', () => {
  const src = solidImage(4, 4, [10, 20, 30, 255]);
  const resized = resizeRgba(src, 2, 2);
  assert.equal(resized.width, 2);
  assert.equal(resized.height, 2);
  assert.equal(resized.data.length, 2 * 2 * 4);
  assert.deepEqual(Array.from(resized.data.slice(0, 4)), [10, 20, 30, 255]);
});

test('scoreVerdict maps thresholds', () => {
  assert.equal(scoreVerdict(0.97), 'high');
  assert.equal(scoreVerdict(0.9), 'medium');
  assert.equal(scoreVerdict(0.7), 'low');
});

test('screen expectation guard passes when id/name match or are absent', () => {
  const resolved = { id: 8801, name: '首页' };
  assert.equal(screenExpectationMismatch(resolved, {}), null);
  assert.equal(screenExpectationMismatch(resolved, { expectedScreenId: 8801 }), null);
  assert.equal(screenExpectationMismatch(resolved, { expectedScreenId: '8801' }), null);
  assert.equal(screenExpectationMismatch(resolved, { expectedScreenName: '首页' }), null);
  assert.equal(screenExpectationMismatch(resolved, { expectedScreenId: 8801, expectedScreenName: '首页' }), null);
});

test('screen expectation guard detects wrong artboard (multi-artboard mismatch)', () => {
  const resolved = { id: 8801, name: '首页' };
  assert.equal(screenExpectationMismatch(resolved, { expectedScreenId: 8802 }), 'id');
  assert.equal(screenExpectationMismatch(resolved, { expectedScreenName: '详情页' }), 'name');
});

test('summary shows score, verdict and hotspot preview', () => {
  const summary = summarizeVisualDiffPayload({
    ok: true,
    score: 0.9123,
    verdict: 'medium',
    diffPixels: 3500,
    totalPixels: 40000,
    alignment: { target: { width: 200, height: 200 } },
    hotspots: [{ x: 0, y: 0, diffRatio: 0.3 }],
    diffImagePath: '123/diffs/1-1.png',
  });
  assert.match(summary, /score: 0\.9123/);
  assert.match(summary, /verdict medium/);
  assert.match(summary, /200x200/);
  assert.match(summary, /diff image: 123\/diffs\/1-1\.png/);
  assert.match(summary, /regression signal/);
});
