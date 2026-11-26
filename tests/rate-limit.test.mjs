import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter } from '../dist/utils/rate-limit.js';

test('bucketKeyFor keeps CoDesign hosts in the api bucket', () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.bucketKeyFor('https://codesign.qq.com/api/sharings/1'), 'api');
  assert.equal(limiter.bucketKeyFor('https://cdn4.codesign.qq.com/screen-slices/a.png'), 'api');
  assert.equal(limiter.bucketKeyFor('https://example.test/a.png'), 'cdn');
  assert.equal(limiter.bucketKeyFor('not a url'), 'cdn');
});

test('rate limiter queues callers when the bucket runs dry', async () => {
  let clock = 1000;
  let releaseSleep = null;
  const sleeps = [];
  const limiter = new RateLimiter({
    apiRps: 1,
    cdnRps: 10,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise((resolve) => {
        releaseSleep = () => { clock += ms; resolve(); };
      });
    },
  });
  const url = 'https://codesign.qq.com/api/sharings/1';

  await limiter.acquire(url);
  await limiter.acquire(url);
  const third = limiter.acquire(url);
  let settled = false;
  third.then(() => { settled = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(typeof releaseSleep, 'function');
  assert.ok(sleeps[0] > 0);
  releaseSleep();
  await third;
  assert.equal(settled, true);

  const stats = limiter.stats().find((item) => item.key === 'api');
  assert.equal(stats.acquired, 3);
  assert.equal(stats.throttled, 1);
});

test('rate limiter with rps=0 disables throttling', async () => {
  let slept = false;
  const limiter = new RateLimiter({
    apiRps: 0,
    now: () => 0,
    sleep: async () => { slept = true; },
  });
  await limiter.acquire('https://codesign.qq.com/api/sharings/1');
  await limiter.acquire('https://codesign.qq.com/api/sharings/1');
  assert.equal(slept, false);
});

test('api and cdn buckets are independent', async () => {
  const limiter = new RateLimiter({ apiRps: 1, cdnRps: 100, now: () => 0, sleep: async () => {} });
  await limiter.acquire('https://codesign.qq.com/api/sharings/1');
  await limiter.acquire('https://example.test/a.png');
  const stats = limiter.stats();
  assert.deepEqual(stats.map((item) => item.key), ['api', 'cdn']);
  assert.equal(stats[0].acquired, 1);
  assert.equal(stats[1].acquired, 1);
});
