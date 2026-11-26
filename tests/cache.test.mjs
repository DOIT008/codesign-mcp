import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CODESIGN_CACHE_TTL_MS = '100';

const { cached, clearCache, cacheStats, hashCredential } = await import('../dist/codesign/cache.js');

test('cached reuses a value within the TTL window', async () => {
  clearCache();
  let calls = 0;
  const loader = async () => ({ version: ++calls });

  const first = await cached('test:reuse', loader);
  const second = await cached('test:reuse', loader);

  assert.deepEqual(first, { version: 1 });
  assert.deepEqual(second, { version: 1 });
  assert.equal(calls, 1);
});

test('cached deduplicates concurrent requests for the same key', async () => {
  clearCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return calls;
  };

  const results = await Promise.all([
    cached('test:dedupe', loader),
    cached('test:dedupe', loader),
    cached('test:dedupe', loader),
  ]);

  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(calls, 1);
});

test('cached reloads after the TTL expires', async () => {
  clearCache();
  let calls = 0;
  const loader = async () => ++calls;

  await cached('test:expiry', loader);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = await cached('test:expiry', loader);

  assert.equal(second, 2);
  assert.equal(calls, 2);
});

test('cached does not retain a failed loader result', async () => {
  clearCache();
  let calls = 0;

  await assert.rejects(
    cached('test:failure', async () => {
      calls += 1;
      throw new Error('boom');
    }),
    /boom/,
  );
  const second = await cached('test:failure', async () => ++calls);

  assert.equal(second, 2);
});

test('in-flight entries are cleared after completion', async () => {
  clearCache();
  await cached('test:inflight', async () => 'ok');
  assert.equal(cacheStats().inflight, 0);
});

test('credential hashes never contain the original secret', () => {
  const secret = 'super-secret-sharing-password';
  const hash = hashCredential(secret);

  assert.equal(hash.length, 16);
  assert.equal(hash.includes(secret), false);
  assert.equal(hash.includes('super-secret'), false);
});

test('different credentials produce different cache keys', () => {
  assert.notEqual(hashCredential('password-a'), hashCredential('password-b'));
});
