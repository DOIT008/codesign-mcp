import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRetryableStatus,
  parseRetryAfter,
  withRetry,
  assertNotRateLimited,
  rateLimitError,
} from '../dist/utils/retry.js';
import { CodesignError } from '../dist/codesign/errors.js';

test('isRetryableStatus covers 429 and transient 5xx but not 404', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(403), false);
});

test('parseRetryAfter handles delta seconds, HTTP date and invalid input', () => {
  const now = Date.parse('2026-11-26T10:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('0.5', now), 500);
  assert.equal(parseRetryAfter('Wed, 26 Nov 2026 10:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('not-a-date', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});

test('withRetry retries rate limited failures with exponential backoff', async () => {
  const delays = [];
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw rateLimitError('api', 429);
      return 'ok';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 100,
      sleep: async (ms) => { delays.push(ms); },
      jitter: () => 0,
    },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('withRetry honors Retry-After from the error details', async () => {
  const delays = [];
  let attempts = 0;
  await withRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimitError('api', 429, 1200);
      return 'ok';
    },
    { sleep: async (ms) => { delays.push(ms); }, jitter: () => 0 },
  );

  assert.deepEqual(delays, [1200]);
});

test('withRetry does not retry ordinary 4xx errors', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withRetry(
      async () => {
        attempts += 1;
        throw new CodesignError('NEED_PASSWORD', 'wrong password');
      },
      { sleep: async () => { throw new Error('should not sleep'); } },
    ),
    (err) => err.code === 'NEED_PASSWORD',
  );
  assert.equal(attempts, 1);
});

test('withRetry exhausts attempts and rethrows the last error', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withRetry(
      async () => {
        attempts += 1;
        throw rateLimitError('cdn', 503);
      },
      { maxAttempts: 2, sleep: async () => {}, jitter: () => 0 },
    ),
    (err) => err.code === 'RATE_LIMITED' && err.details.status === 503,
  );
  assert.equal(attempts, 2);
});

test('assertNotRateLimited throws RATE_LIMITED for 429 with retry hint', () => {
  assert.throws(
    () => assertNotRateLimited(429, 'meta request', '3'),
    (err) => {
      assert.ok(err instanceof CodesignError);
      assert.equal(err.code, 'RATE_LIMITED');
      assert.equal(err.details.retryAfterMs, 3000);
      assert.match(err.details.suggestion, /CODESIGN_API_RPS/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertNotRateLimited(200, 'meta request', null));
});
