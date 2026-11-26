import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSpec } from '../dist/codesign/parser.js';
import { CodesignError } from '../dist/codesign/errors.js';

function layer(objectId, parentId, name, rect, type = 'layer') {
  return { object_id: objectId, parent_id: parentId, name, type, rect };
}

function specWith(layers, groups = []) {
  return {
    object_id: 'board',
    name: 'Board',
    width: 1000,
    height: 500,
    rect: { x: 0, y: 0, width: 1000, height: 500 },
    layers,
    groups,
    css: [],
  };
}

test('normalizeSpec exposes a full hierarchy with parent-relative rects', () => {
  const normalized = normalizeSpec(specWith(
    [
      layer('b', 'a', 'Title', { x: 20, y: 30, width: 50, height: 20 }, 'text'),
      layer('c', 'board', 'Icon', { x: 300, y: 40, width: 80, height: 60 }, 'image'),
    ],
    [layer('a', 'board', 'Frame', { x: 10, y: 20, width: 200, height: 100 }, 'group')],
  ));

  assert.equal(normalized.hierarchy.length, 2);
  const frame = normalized.hierarchy.find((node) => node.objectId === 'a');
  assert.equal(frame.kind, 'group');
  assert.deepEqual(frame.relativeRect, { x: 10, y: 20, width: 200, height: 100 });
  assert.equal(frame.children.length, 1);

  const title = frame.children[0];
  assert.equal(title.objectId, 'b');
  assert.deepEqual(title.relativeRect, { x: 20, y: 30, width: 50, height: 20 });
  assert.deepEqual(title.relativeToParent, { x: 10, y: 10, width: 50, height: 20 });
});

test('groups appear in the hierarchy with their own kind', () => {
  const normalized = normalizeSpec(
    specWith(
      [layer('text', 'grp', 'Text', { x: 5, y: 5, width: 10, height: 10 }, 'text')],
      [layer('grp', 'board', 'Group', { x: 0, y: 0, width: 100, height: 100 }, 'group')],
    ),
  );

  assert.equal(normalized.hierarchy.length, 1);
  assert.equal(normalized.hierarchy[0].kind, 'group');
  assert.equal(normalized.hierarchy[0].children[0].objectId, 'text');
});

test('duplicate ids across layers and groups are rejected', () => {
  assert.throws(
    () => normalizeSpec(specWith(
      [layer('dup', 'board', 'A', { x: 0, y: 0, width: 1, height: 1 })],
      [layer('dup', 'board', 'B', { x: 0, y: 0, width: 1, height: 1 }, 'group')],
    )),
    (err) => err instanceof CodesignError
      && err.code === 'META_SCHEMA_MISMATCH'
      && /duplicate layer object_id/.test(err.message),
  );
});

test('hierarchy with no reachable root is rejected', () => {
  assert.throws(
    () => normalizeSpec(specWith([
      layer('a', 'b', 'A', { x: 0, y: 0, width: 1, height: 1 }),
      layer('b', 'a', 'B', { x: 0, y: 0, width: 1, height: 1 }),
    ])),
    (err) => err instanceof CodesignError && /no valid root/.test(err.message),
  );
});

test('empty spec yields an empty hierarchy', () => {
  assert.deepEqual(normalizeSpec(specWith([])).hierarchy, []);
});
