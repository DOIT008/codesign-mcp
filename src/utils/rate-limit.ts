// 按 host 分组的令牌桶节流。CoDesign API 与 CDN 分别限速，避免批量抓取时
// 自己把远端打到 429。所有出站请求都应先经过 throttle()。

import { config } from '../config.js';

export interface BucketStats {
  key: string;
  capacity: number;
  refillPerSec: number;
  acquired: number;
  throttled: number;
  totalWaitMs: number;
}

export interface RateLimiterOptions {
  apiRps?: number;
  cdnRps?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];
  private draining = false;
  private acquired = 0;
  private throttled = 0;
  private totalWaitMs = 0;

  constructor(
    readonly key: string,
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  acquire(): Promise<void> {
    if (this.refillPerSec <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const now = this.now();
        const elapsedSeconds = Math.max(0, (now - this.lastRefill) / 1000);
        this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSec);
        this.lastRefill = now;

        if (this.tokens >= 1) {
          this.tokens -= 1;
          this.acquired += 1;
          this.queue.shift()?.();
          continue;
        }

        const waitMs = Math.max(1, Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000));
        this.throttled += 1;
        this.totalWaitMs += waitMs;
        await this.sleep(waitMs);
      }
    } finally {
      this.draining = false;
    }
  }

  stats(): BucketStats {
    return {
      key: this.key,
      capacity: this.capacity,
      refillPerSec: this.refillPerSec,
      acquired: this.acquired,
      throttled: this.throttled,
      totalWaitMs: this.totalWaitMs,
    };
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly apiRps: number;
  private readonly cdnRps: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions = {}) {
    this.apiRps = options.apiRps ?? config.apiRps;
    this.cdnRps = options.cdnRps ?? config.cdnRps;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  // 用 URL 的 host 决定用哪一组配额；非 CoDesign 域名走 CDN 桶。
  bucketKeyFor(url: string): 'api' | 'cdn' {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return 'cdn';
    }
    const apiHost = new URL(config.origin).hostname.toLowerCase();
    return host === apiHost || host.endsWith(`.${apiHost}`) ? 'api' : 'cdn';
  }

  acquire(url: string): Promise<void> {
    const key = this.bucketKeyFor(url);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const rps = key === 'api' ? this.apiRps : this.cdnRps;
      bucket = new TokenBucket(key, Math.max(1, rps * 2), rps, this.sleep, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.acquire();
  }

  stats(): BucketStats[] {
    return ['api', 'cdn']
      .filter((key) => this.buckets.has(key))
      .map((key) => this.buckets.get(key)!.stats());
  }
}

const defaultLimiter = new RateLimiter();

export function throttle(url: string): Promise<void> {
  return defaultLimiter.acquire(url);
}

export function rateLimitStats(): BucketStats[] {
  return defaultLimiter.stats();
}
