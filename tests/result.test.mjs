import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toolSuccess,
  toolSuccessFull,
  toolFailure,
  toolError,
  summarizePayload,
  summarizeSpecPayload,
} from '../dist/mcp/result.js';
import { CodesignError } from '../dist/codesign/errors.js';

test('toolSuccess keeps the full payload only in structuredContent', () => {
  const result = toolSuccess({
    sharingId: '123456',
    spec: {
      layers: Array.from({ length: 200 }, (_, index) => ({ object_id: `layer-${index}` })),
      groups: [1, 2, 3],
      css: [],
      slices: [],
    },
  });

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.spec.layers.length, 200);
  assert.match(result.content[0].text, /layers: 200/);
  assert.equal(result.content[0].text.includes('layer-'), false);
  assert.ok(result.content[0].text.length < 400);
});

test('toolSuccess with includeFullText returns unindented full JSON', () => {
  const payload = { sharingId: '123456', count: 2 };
  const result = toolSuccess(payload, true);

  assert.equal(result.content[0].text, JSON.stringify({ ok: true, ...payload }));
  assert.equal(result.content[0].text.includes('\n'), false);
});

test('toolSuccessFull keeps complete records without indentation', () => {
  const payload = { records: [{ url: 'https://codesign.qq.com/a' }, { url: 'https://codesign.qq.com/b' }] };
  const result = toolSuccessFull(payload);

  assert.equal(result.content[0].text, JSON.stringify({ ok: true, ...payload }));
  assert.equal(result.content[0].text.includes('\n  '), false);
});

test('toolError returns a short readable line rather than full JSON', () => {
  const result = toolError(new CodesignError('NEED_PASSWORD', 'this sharing requires a password'));

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'NEED_PASSWORD');
  assert.equal(result.content[0].text, '[NEED_PASSWORD] this sharing requires a password');
});

test('toolFailure marks the result as an error and summarizes the payload', () => {
  const result = toolFailure({ stage: 'no-confirm', profileDir: '/tmp/profile' });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.match(result.content[0].text, /^failed/);
  assert.match(result.content[0].text, /stage: no-confirm/);
});

test('summarizePayload truncates long strings', () => {
  const summary = summarizePayload({ sharingUrl: `https://codesign.qq.com/s/${'x'.repeat(300)}` });

  assert.ok(summary.length < 250);
  assert.match(summary, /\.\.\./);
});

test('summarizeSpecPayload includes artboard, hierarchy skeleton and layer counts', () => {
  const payload = {
    ok: true,
    sharingId: '123',
    integrity: { ok: true },
    spec: {
      artboard: { name: 'Home', width: 1920, height: 1080 },
      hierarchy: [
        {
          name: 'Frame', type: 'group', rect: { width: 1920, height: 1080 },
          children: [
            {
              name: 'Title', type: 'text', rect: { width: 240, height: 32 },
              children: [{ name: 'Glyph', type: 'layer', rect: { width: 10, height: 10 }, children: [] }],
            },
          ],
        },
      ],
      layers: Array.from({ length: 200 }, (_, index) => ({ object_id: `layer-${index}` })),
      groups: [1, 2, 3],
      slices: [],
    },
  };

  const summary = summarizeSpecPayload(payload);
  assert.match(summary, /artboard: Home \(1920x1080\)/);
  assert.match(summary, /- Frame \[group\] 1920x1080/);
  assert.match(summary, /  - Title \[text\] 240x32/);
  assert.equal(summary.includes('Glyph'), false);
  assert.match(summary, /layers: 200, groups: 3, slices: 0/);
  assert.match(summary, /integrity: ok/);
  assert.equal(summary.includes('layer-'), false);
  assert.ok(summary.length < 700);
});

test('summarizeSpecPayload surfaces integrity warnings in text channel', () => {
  const summary = summarizeSpecPayload({
    ok: true,
    integrity: { ok: false, warnings: ['orphan parent_id: node-x', 'slices count differs'] },
    spec: { artboard: { name: 'A', width: 10, height: 10 }, hierarchy: [], layers: [], groups: [], slices: [] },
  });
  assert.match(summary, /integrity: warnings=2 \(orphan parent_id: node-x; slices count differs\)/);
});

test('toolSuccess accepts a custom summarizer and includeFullText still wins', () => {
  const payload = { spec: { layers: [] } };
  const custom = () => 'custom summary';

  assert.equal(toolSuccess(payload, false, custom).content[0].text, 'custom summary');
  assert.equal(toolSuccess(payload, true, custom).content[0].text, JSON.stringify({ ok: true, ...payload }));
});
