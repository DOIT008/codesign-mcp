import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyRendering, VERIFY_CHECKS } from '../dist/codesign/verify.js';
import { summarizeVerifyPayload } from '../dist/mcp/result.js';

function makePlatformSpec(overrides = {}) {
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
    ...overrides,
  };
}

function makeLayer(overrides = {}) {
  return {
    object_id: 'icon-1',
    parent_id: 'root',
    type: 'shape',
    name: 'icon',
    rect: { x: 10, y: 20, width: 24, height: 24 },
    ...overrides,
  };
}

function makeManifest(scale = 2) {
  return [
    {
      object_id: 'icon-1',
      name: 'icon',
      rect: { x: 10, y: 20, width: 24, height: 24 },
      exportables: [{ scale, format: 'png', screenshot: { url: 'https://example.test/icon.png' } }],
    },
  ];
}

function baseInput(files, overrides = {}) {
  return {
    files,
    layers: [makeLayer()],
    groups: [],
    hierarchy: [{ object_id: 'root', children: [{ object_id: 'icon-1' }] }],
    platformSpec: makePlatformSpec(),
    manifest: makeManifest(),
    scale: 2,
    ...overrides,
  };
}

test('VERIFY_CHECKS lists all seven dimensions', () => {
  assert.deepEqual([...VERIFY_CHECKS], ['size', 'scale', 'color', 'typography', 'radius', 'hierarchy', 'maintainability']);
});

test('matching design size passes without errors', () => {
  const report = verifyRendering(
    baseInput([{ path: 'Page.vue', text: '<img data-slice-id="icon-1" width="24" height="24" src="/icon.png" />' }]),
  );
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.anchors, 1);
});

test('2x pixel size written as CSS is reported as DOUBLE_SCALE', () => {
  const report = verifyRendering(
    baseInput([
      {
        path: 'Page.vue',
        text: '<img data-slice-id="icon-1" width="48" height="48" src="/icon@2x.png" />',
      },
    ]),
  );
  const double = report.issues.filter((issue) => issue.code === 'DOUBLE_SCALE');
  assert.ok(double.length >= 2, `expected 2 DOUBLE_SCALE issues, got ${report.issues.length}`);
  assert.equal(report.ok, false);
  assert.equal(double[0].expected, '24px');
  assert.equal(double[0].actual, '48px');
});

test('slice comment anchor is recognized and background-size is checked', () => {
  const report = verifyRendering(
    baseInput([
      {
        path: 'style.css',
        text: '.icon { /* slice:icon-1 */ background-image: url(/icon@2x.png); background-size: 48px 48px; }',
      },
    ]),
  );
  assert.equal(report.anchors, 1);
  const double = report.issues.filter((issue) => issue.code === 'DOUBLE_SCALE');
  assert.ok(double.length >= 2);
});

test('rem units are normalized against remBasePx', () => {
  const platformSpec = makePlatformSpec({
    unit: 'rem',
    conversion: { mode: 'default', sourceWidth: 375, remBasePx: 16 },
    layers: [
      {
        objectId: 'icon-1',
        name: 'icon',
        type: 'shape',
        rect: { x: 0.625, y: 1.25, width: 1.5, height: 1.5, unit: 'rem' },
        css: [],
      },
    ],
  });
  const report = verifyRendering(
    baseInput([{ path: 'Page.vue', text: '<img data-slice-id="icon-1" width="24px" height="24px" />' }], {
      platformSpec,
    }),
  );
  assert.equal(report.summary.fail, 0);
});

test('unverifiable declarations are warnings, not errors', () => {
  const report = verifyRendering(
    baseInput([
      {
        path: 'Page.vue',
        text: '<img data-slice-id="icon-1" class="icon" src="/icon@2x.png" />',
      },
    ]),
  );
  const warn = report.issues.filter((issue) => issue.code === 'UNVERIFIABLE');
  assert.ok(warn.length >= 2);
  assert.equal(report.summary.fail, 0);
});

test('slice with 2x export but no anchor is reported as SLICE_UNUSED', () => {
  const report = verifyRendering(baseInput([{ path: 'Page.vue', text: '<div>no slice here</div>' }]));
  assert.ok(report.issues.some((issue) => issue.code === 'SLICE_UNUSED'));
});

test('non-2x asset reference is reported as WRONG_SCALE_ASSET', () => {
  const report = verifyRendering(
    baseInput([{ path: 'Page.vue', text: '<img data-slice-id="icon-1" width="24" height="24" src="/icon@3x.png" />' }]),
  );
  assert.ok(report.issues.some((issue) => issue.code === 'WRONG_SCALE_ASSET'));
});

test('unsafe anchor id is reported as a warning', () => {
  const report = verifyRendering(
    baseInput([{ path: 'Page.vue', text: '<img data-slice-id="ghost" width="24" height="24" />' }]),
  );
  assert.ok(report.issues.some((issue) => issue.code === 'ANCHOR_UNRESOLVED'));
});

test('reviewRequired lists layers with gradients or effects', () => {
  const layer = makeLayer({ effects: [{ type: 'blur' }], css: ['background: linear-gradient(red, blue)'] });
  const report = verifyRendering(
    baseInput(
      [{ path: 'Page.vue', text: '<img data-slice-id="icon-1" width="24" height="24" />' }],
      { layers: [layer] },
    ),
  );
  assert.ok(report.reviewRequired.length >= 1);
  assert.ok(report.reviewRequired[0].reasons.includes('effect'));
  assert.ok(report.reviewRequired[0].reasons.includes('css-complex'));
});

test('checks filter limits which dimensions are verified', () => {
  const report = verifyRendering(
    baseInput(
      [{ path: 'Page.vue', text: '<img data-slice-id="icon-1" width="48" height="48" src="/icon@3x.png" />' }],
      { checks: ['scale'] },
    ),
  );
  assert.equal(report.issues.some((issue) => issue.dimension === 'size'), false);
  assert.ok(report.issues.some((issue) => issue.dimension === 'scale'));
});

test('summary keeps issues compact and readable', () => {
  const report = verifyRendering(
    baseInput([
      {
        path: 'Page.vue',
        text: '<img data-slice-id="icon-1" width="48" height="48" src="/icon@2x.png" />',
      },
    ]),
  );
  const text = summarizeVerifyPayload({ ok: report.ok, ...report });
  assert.match(text, /checks: pass=/);
  assert.match(text, /DOUBLE_SCALE/);
  assert.ok(text.length < 600);
});
