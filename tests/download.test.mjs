import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../dist/config.js';
import { CodesignError } from '../dist/codesign/errors.js';
import { assertArtifactIntegrity, detectArtifactFormat, downloadToArtifact } from '../dist/utils/download.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const testSubdir = `download-test-${process.pid}`;
const testRoot = resolve(config.artifactsDir, testSubdir);

after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test('downloadToArtifact reuses an existing artifact when expectedBytes matches', async () => {
  const subdir = `${testSubdir}/reuse`;
  const dir = resolve(config.artifactsDir, subdir);
  const target = resolve(dir, 'asset.bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, 'keep');

  const request = fakeRequest('must-not-fetch');
  const result = await downloadToArtifact(
    'https://cdn4.codesign.qq.com/asset.bin',
    subdir,
    'asset.bin',
    'SLICE_FETCH_FAILED',
    { request, expectedBytes: 4 },
  );

  assert.equal(request.calls(), 0);
  assert.equal(result.path, target);
  assert.equal(result.bytes, 4);
  assert.equal(result.reusedExisting, true);
  assert.equal(result.writeAttempts, 0);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('downloadToArtifact overwrites an existing artifact when expectedBytes differs', async () => {
  const subdir = `${testSubdir}/overwrite`;
  const dir = resolve(config.artifactsDir, subdir);
  const target = resolve(dir, 'asset.bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, 'old');

  const request = fakeRequest('new!');
  const result = await downloadToArtifact(
    'https://cdn4.codesign.qq.com/asset.bin',
    subdir,
    'asset.bin',
    'SLICE_FETCH_FAILED',
    { request, expectedBytes: 4 },
  );

  assert.equal(request.calls(), 1);
  assert.equal(result.path, target);
  assert.equal(result.bytes, 4);
  assert.equal(result.reusedExisting, undefined);
  assert.equal(result.writeAttempts, 1);
  assert.equal(readFileSync(target, 'utf8'), 'new!');
});

test('downloadToArtifact rejects a subdir that escapes artifactsDir', async () => {
  const request = fakeRequest('must-not-fetch');
  await assert.rejects(
    () => downloadToArtifact(
      'https://cdn4.codesign.qq.com/asset.bin',
      '../outside-artifacts',
      'asset.bin',
      'SLICE_FETCH_FAILED',
      { request },
    ),
    (err) => {
      assert.ok(err instanceof CodesignError);
      assert.equal(err.code, 'ARTIFACT_PATH_INVALID');
      return true;
    },
  );
  assert.equal(request.calls(), 0);
});

test('downloadToArtifact rejects a filename that escapes its artifact subdir', async () => {
  const request = fakeRequest('must-not-fetch');
  await assert.rejects(
    () => downloadToArtifact(
      'https://cdn4.codesign.qq.com/asset.bin',
      `${testSubdir}/escape`,
      '../asset.bin',
      'SLICE_FETCH_FAILED',
      { request },
    ),
    (err) => {
      assert.ok(err instanceof CodesignError);
      assert.equal(err.code, 'ARTIFACT_PATH_INVALID');
      return true;
    },
  );
  assert.equal(request.calls(), 0);
});

test('downloadToArtifact derives fallback filenames with SHA-256', async () => {
  const subdir = `${testSubdir}/derived-name`;
  const request = fakeRequest('new!');
  const result = await downloadToArtifact(
    'https://cdn4.codesign.qq.com/assets/download',
    subdir,
    undefined,
    'SLICE_FETCH_FAILED',
    { request },
  );

  assert.equal(request.calls(), 1);
  assert.equal(result.path, resolve(config.artifactsDir, subdir, '0e397c6af95c.bin'));
  assert.equal(readFileSync(result.path, 'utf8'), 'new!');
});

function fakeRequest(body, opts = {}) {
  let callCount = 0;
  const headers = { 'content-type': 'application/octet-stream', ...(opts.headers ?? {}) };
  return {
    calls() {
      return callCount;
    },
    async get() {
      callCount += 1;
      return {
        ok: () => (opts.status ?? 200) < 400,
        status: () => opts.status ?? 200,
        headers: () => headers,
        body: async () => Buffer.isBuffer(body) ? body : Buffer.from(body),
      };
    },
  };
}

test('downloadToArtifact rejects a body whose size differs from Content-Length', async () => {
  const request = fakeRequest('ab', { headers: { 'content-length': '10' } });
  await assert.rejects(
    () => downloadToArtifact(
      'https://cdn4.codesign.qq.com/a.png',
      `${testSubdir}/content-length`,
      'a.png',
      'SLICE_FETCH_FAILED',
      { request },
    ),
    (err) => {
      assert.ok(err instanceof CodesignError);
      assert.equal(err.code, 'ARTIFACT_SIZE_MISMATCH');
      return true;
    },
  );
});

test('downloadToArtifact rejects an HTML error page saved as an image', async () => {
  const request = fakeRequest('<html><body>403 Forbidden</body></html>');
  await assert.rejects(
    () => downloadToArtifact(
      'https://cdn4.codesign.qq.com/b.png',
      `${testSubdir}/html`,
      'b.png',
      'SLICE_FETCH_FAILED',
      { request, expectedFormat: 'png' },
    ),
    (err) => {
      assert.ok(err instanceof CodesignError);
      assert.equal(err.code, 'ARTIFACT_MAGIC_MISMATCH');
      return true;
    },
  );
});

test('downloadToArtifact rejects a PNG body when the manifest declares svg', async () => {
  const request = fakeRequest(PNG, { headers: { 'content-type': 'image/png' } });
  await assert.rejects(
    () => downloadToArtifact(
      'https://cdn4.codesign.qq.com/c.svg',
      `${testSubdir}/wrong-format`,
      'c.svg',
      'SLICE_FETCH_FAILED',
      { request, expectedFormat: 'svg' },
    ),
    (err) => {
      assert.ok(err instanceof CodesignError);
      assert.equal(err.code, 'ARTIFACT_MAGIC_MISMATCH');
      return true;
    },
  );
});

test('downloadToArtifact skips Content-Length check for gzip responses', async () => {
  const request = fakeRequest(PNG, {
    headers: { 'content-type': 'image/png', 'content-length': '9999', 'content-encoding': 'gzip' },
  });
  const result = await downloadToArtifact(
    'https://cdn4.codesign.qq.com/d.png',
    `${testSubdir}/gzip`,
    'd.png',
    'SLICE_FETCH_FAILED',
    { request, expectedFormat: 'png' },
  );
  assert.equal(result.verified.format, 'png');
  assert.equal(result.verified.reused, false);
  assert.equal(result.verified.contentEncoding, 'gzip');
});

test('downloadToArtifact returns sha256 and detected format on success', async () => {
  const request = fakeRequest(PNG, { headers: { 'content-type': 'image/png' } });
  const result = await downloadToArtifact(
    'https://cdn4.codesign.qq.com/e.png',
    `${testSubdir}/ok`,
    'e.png',
    'SLICE_FETCH_FAILED',
    { request, expectedFormat: 'png', expectedMime: 'image/png' },
  );
  assert.equal(result.verified.format, 'png');
  assert.equal(result.verified.bytes, PNG.length);
  assert.match(result.verified.sha256, /^[0-9a-f]{64}$/);
});

test('detectArtifactFormat recognizes svg with an XML declaration', () => {
  const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(detectArtifactFormat(svg), 'svg');
});

test('assertArtifactIntegrity rejects a declared byte mismatch', () => {
  assert.throws(
    () => assertArtifactIntegrity(PNG, 'https://cdn4.codesign.qq.com/x.png', {
      expectedBytes: 999,
      mime: 'image/png',
      contentLength: null,
      contentEncoding: null,
    }),
    (err) => err instanceof CodesignError && err.code === 'ARTIFACT_SIZE_MISMATCH',
  );
});
