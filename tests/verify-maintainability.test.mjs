import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyRendering,
  collectCssVariables,
  resolveCssValue,
  collectClassRules,
} from '../dist/codesign/verify.js';
import { summarizeVerifyPayload } from '../dist/mcp/result.js';

function makePlatformSpec() {
  return {
    requested: 'web',
    id: 'web',
    label: 'Web',
    unit: 'px',
    scale: 1,
    conversion: { mode: 'default', sourceWidth: 375 },
    availableUnits: ['px', 'rem'],
    availableScales: [0.5, 1, 2, 3],
    source: { kind: 'codesign-meta-url', note: '' },
    artboard: {
      objectId: 'root',
      name: 'artboard',
      width: 375,
      height: 667,
      unit: 'px',
      rect: { x: 0, y: 0, width: 375, height: 667, unit: 'px' },
    },
    layers: [
      {
        objectId: 'icon-1',
        name: 'icon',
        type: 'shape',
        rect: { x: 10, y: 20, width: 24, height: 24, unit: 'px' },
        css: [],
      },
    ],
    groups: [],
    css: [],
  };
}

function makeManifest(ids = ['icon-1']) {
  return ids.map((id) => ({
    object_id: id,
    name: id,
    rect: { x: 10, y: 20, width: 24, height: 24 },
    exportables: [{ scale: 2, format: 'png', screenshot: { url: `https://example.test/${id}.png` } }],
  }));
}

function baseInput(files, overrides = {}) {
  return {
    files,
    layers: [{
      object_id: 'icon-1',
      parent_id: 'root',
      type: 'shape',
      name: 'icon',
      rect: { x: 10, y: 20, width: 24, height: 24 },
      fills: [{ color: '#1677ff' }],
    }],
    groups: [],
    hierarchy: [{ object_id: 'root', children: [{ object_id: 'icon-1' }] }],
    platformSpec: makePlatformSpec(),
    manifest: makeManifest(),
    scale: 2,
    ...overrides,
  };
}

test('collectCssVariables indexes tokens across files, last definition wins', () => {
  const vars = collectCssVariables([
    { path: 'tokens.css', text: ':root { --icon-size: 24px; --brand: #1677ff; }' },
    { path: 'override.css', text: ':root { --icon-size: 20px; }' },
  ]);
  assert.equal(vars.get('--icon-size'), '20px');
  assert.equal(vars.get('--brand'), '#1677ff');
});

test('resolveCssValue expands var() with fallback and stops on cycles', () => {
  const vars = new Map([['--a', 'var(--b)'], ['--b', 'var(--a)'], ['--brand', '#1677ff']]);
  assert.equal(resolveCssValue('var(--brand)', vars), '#1677ff');
  assert.equal(resolveCssValue('var(--missing, 24px)', vars), '24px');
  assert.match(resolveCssValue('var(--a)', vars), /var\(/);
});

test('CSS variables keep size verifiable instead of UNVERIFIABLE', () => {
  const report = verifyRendering(baseInput([
    { path: 'Page.vue', text: '<img data-slice-id="icon-1" class="icon" src="/icon@2x.png" />' },
    { path: 'tokens.css', text: ':root { --icon-size: 24px; --brand: #1677ff; }\n.icon { width: var(--icon-size); height: var(--icon-size); color: var(--brand); }' },
  ]));
  const unverifiable = report.issues.filter((issue) => issue.code === 'UNVERIFIABLE');
  assert.equal(unverifiable.length, 0, `expected zero UNVERIFIABLE, got ${unverifiable.map((i) => i.message).join('; ')}`);
  assert.equal(report.summary.fail, 0);
});

test('class-linked styles are found beyond the 16-line anchor window', () => {
  const padding = Array.from({ length: 40 }, () => '<div class="filler">x</div>').join('\n');
  const report = verifyRendering(baseInput([
    {
      path: 'Page.vue',
      text: `<template>\n<img data-slice-id="icon-1" class="icon" src="/icon@2x.png" />\n${padding}\n</template>\n<style scoped>\n.icon { width: 24px; height: 24px; }\n</style>`,
    },
  ]));
  const unverifiable = report.issues.filter((issue) => issue.code === 'UNVERIFIABLE');
  assert.equal(unverifiable.length, 0, `class-linked size should be resolved; got ${unverifiable.map((i) => i.message).join('; ')}`);
  assert.equal(report.summary.fail, 0);
});

test('double scale is still caught when size comes from a token', () => {
  const report = verifyRendering(baseInput([
    { path: 'Page.vue', text: '<img data-slice-id="icon-1" class="icon" src="/icon@2x.png" />' },
    { path: 'tokens.css', text: ':root { --icon-size: 48px; }\n.icon { width: var(--icon-size); height: var(--icon-size); }' },
  ]));
  assert.ok(report.issues.some((issue) => issue.code === 'DOUBLE_SCALE'));
  assert.equal(report.ok, false);
});

test('collectClassRules resolves multiple selectors sharing one rule body', () => {
  const rules = collectClassRules([{ path: 'a.css', text: '.icon, .thumb { width: 24px; }' }]);
  assert.match(rules.get('icon') ?? '', /width: 24px/);
  assert.match(rules.get('thumb') ?? '', /width: 24px/);
});

test('maintainability metrics are counted by the tool, not by the model', () => {
  const duplicated = [
    '<div class="card">',
    '  <span class="label">Title</span>',
    '  <img class="thumb" src="/a.png" />',
    '</div>',
  ].join('\n');
  const text = [
    '<template>',
    '  <img data-slice-id="icon-1" width="24" height="24" src="/icon@2x.png" />',
    ...Array.from({ length: 3 }, () => duplicated).flatMap((b) => b.split('\n')),
    '  <div class="box1"></div>',
    '</template>',
    '<style scoped>',
    '.card { position: absolute; }',
    '.card { width: 100px !important; }',
    '.card { color: #ff0000; }',
    '.card { font-size: 14px; }',
    '.thumb { color: #ff0000; }',
    '.label { font-size: 14px; }',
    '.tag { color: #ff0000; font-size: 14px; }',
    '</style>',
    '<script>console.log("debug")</script>',
  ].join('\n');
  const report = verifyRendering(baseInput([{ path: 'Page.vue', text }]));
  const file = report.metrics.files[0];
  assert.equal(file.path, 'Page.vue');
  assert.equal(file.absoluteCount, 1);
  assert.equal(file.importantCount, 1);
  assert.equal(file.consoleLogCount, 1);
  assert.ok(file.duplicatedBlocks >= 1, `expected duplicated blocks, got ${file.duplicatedBlocks}`);
  assert.ok(file.repeatedLiterals >= 1, `expected repeated literals, got ${file.repeatedLiterals}`);
  const codes = report.issues.map((issue) => issue.code);
  for (const code of ['NO_IMPORTANT', 'CONSOLE_LEFT', 'DUPLICATED_BLOCK', 'MAGIC_VALUE', 'MEANINGLESS_NAME']) {
    assert.ok(codes.includes(code), `expected ${code} issue`);
  }
  assert.equal(codes.includes('ABSOLUTE_OVERUSE'), false, 'a single absolute is allowed (overlay/badge)');
  assert.equal(report.ok, true, 'maintainability issues are warnings and must not block ok');
});

test('more than two absolute declarations in one file are flagged', () => {
  const text = [
    '<template>',
    '  <img data-slice-id="icon-1" width="24" height="24" src="/icon@2x.png" />',
    '</template>',
    '<style scoped>',
    '.a { position: absolute; }',
    '.b { position: absolute; }',
    '.c { position: absolute; }',
    '</style>',
  ].join('\n');
  const report = verifyRendering(baseInput([{ path: 'Page.vue', text }]));
  assert.ok(report.issues.some((issue) => issue.code === 'ABSOLUTE_OVERUSE'));
  assert.equal(report.ok, true);
});

test('maintainability can be disabled via checks while metrics still report', () => {
  const report = verifyRendering(baseInput(
    [{ path: 'Page.vue', text: '<div class="box1"></div>\n<script>console.log("x")</script>' }],
    { checks: ['size'] },
  ));
  assert.equal(report.issues.some((issue) => issue.dimension === 'maintainability'), false);
  assert.equal(report.metrics.files.length, 1);
  assert.equal(report.metrics.files[0].consoleLogCount, 1);
});

test('allowUnusedSlices exempts intentionally omitted slices', () => {
  const manifest = makeManifest(['icon-1', 'omitted-2']);
  const without = verifyRendering(baseInput(
    [{ path: 'Page.vue', text: '<img data-slice-id="icon-1" width="24" height="24" src="/icon@2x.png" />' }],
    { manifest },
  ));
  assert.ok(without.issues.some((issue) => issue.code === 'SLICE_UNUSED' && issue.layerObjectId === 'omitted-2'));

  const withAllow = verifyRendering(baseInput(
    [{ path: 'Page.vue', text: '<img data-slice-id="icon-1" width="24" height="24" src="/icon@2x.png" />' }],
    { manifest, allowUnusedSlices: ['omitted-2'] },
  ));
  assert.equal(withAllow.issues.some((issue) => issue.code === 'SLICE_UNUSED'), false);
  assert.equal(withAllow.ok, true);
});

test('summary includes machine-counted maintainability metrics', () => {
  const report = verifyRendering(baseInput([
    { path: 'Page.vue', text: '<img data-slice-id="icon-1" width="24" height="24" src="/icon@2x.png" />\n<script>console.log("x")</script>' },
  ]));
  const text = summarizeVerifyPayload({ ok: report.ok, ...report });
  assert.match(text, /maintainability: files=1 .*console=1/);
  assert.ok(text.length < 700);
});
