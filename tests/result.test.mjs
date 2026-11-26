import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toolSuccess,
  toolSuccessFull,
  toolFailure,
  toolError,
  summarizePayload,
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
