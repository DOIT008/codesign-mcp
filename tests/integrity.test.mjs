import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectManifest,
  inspectSharingDetail,
  inspectSpec,
  enforceIntegrity,
} from '../dist/codesign/integrity.js';
import { CodesignError } from '../dist/codesign/errors.js';

const spec = JSON.parse(readFileSync(resolve('tests/fixtures/meta-spec-object.json'), 'utf8')).sample.response.body;
const manifest = JSON.parse(readFileSync(resolve('tests/fixtures/meta-slice-manifest.json'), 'utf8')).sample.response.body;
const sharing = JSON.parse(readFileSync(resolve('tests/fixtures/sharing-detail.json'), 'utf8')).sample.response.body;

test('fixture spec passes integrity inspection', () => {
  const result = inspectSpec(spec);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.stats.duplicateIds, 0);
  assert.equal(result.stats.badRects, 0);
});

test('spec with duplicate object ids is incomplete', () => {
  const bad = {
    ...spec,
    layers: [spec.layers[0], spec.layers[0]],
    groups: [],
  };
  const result = inspectSpec(bad);
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.code === 'SPEC_DUPLICATE_OBJECT_ID'));
  assert.throws(() => enforceIntegrity(result, 'META_INCOMPLETE'), (err) => {
    assert.ok(err instanceof CodesignError);
    assert.equal(err.code, 'META_INCOMPLETE');
    return true;
  });
});

test('spec with non-positive width is incomplete', () => {
  const result = inspectSpec({ ...spec, width: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.code === 'SPEC_SIZE_INVALID'));
});

test('spec with an empty layer tree is incomplete', () => {
  const result = inspectSpec({ ...spec, layers: [], groups: [] });
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.code === 'SPEC_EMPTY'));
});

test('orphan parent is a warning, not a hard failure', () => {
  const layer = { ...spec.layers[0], parent_id: 'MISSING_PARENT' };
  const result = inspectSpec({ ...spec, layers: [layer], groups: [] });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === 'WARN_ORPHAN_PARENT'));
  assert.doesNotThrow(() => enforceIntegrity(result, 'META_INCOMPLETE'));
});

test('fixture manifest passes integrity inspection', () => {
  const result = inspectManifest(manifest);
  assert.equal(result.ok, true);
  assert.equal(result.stats.missingUrl, 0);
  assert.equal(result.stats.withByteHint, 1);
});

test('manifest exportable without screenshot.url is incomplete', () => {
  const bad = [{
    ...manifest[0],
    exportables: [{ ...manifest[0].exportables[0], screenshot: { ...manifest[0].exportables[0].screenshot, url: '' } }],
  }];
  const result = inspectManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.code === 'SLICE_URL_MISSING'));
});

test('manifest length is not compared against screen.slices_count', () => {
  const result = inspectManifest(manifest);
  assert.equal(result.stats.items, 1);
  assert.equal(result.ok, true);
  assert.equal(inspectSharingDetail(sharing).stats.screens, 1);
});

test('sharing detail without meta_url is incomplete', () => {
  const bad = {
    ...sharing,
    designs: [{ ...sharing.designs[0], screens: [{ ...sharing.designs[0].screens[0], meta_url: '' }] }],
  };
  const result = inspectSharingDetail(bad);
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.code === 'SHARING_META_URL_MISSING'));
});
