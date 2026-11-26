// 进程内短 TTL 缓存：避免一条 design-to-code 流程反复拉取同一份
// sharing detail / meta.json / slice manifest。缓存只存在于内存，不落盘。
// 并发相同 key 的请求共享同一个 Promise，避免 LLM 并行调用时重复发包。

import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { config } from '../config.js';
import { getLogger } from '../logger.js';
import { getSharingDetail } from './sharing.js';
import { fetchMetaJson } from './meta.js';
import { fetchSliceManifest } from './slices.js';
import type { SharingDetail, SliceManifest } from './types.js';

const log = getLogger();

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const entries = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

// 密码等凭证只能以摘要形式参与 key，不能把原文留在缓存键里。
export function hashCredential(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

export async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) {
    log.debug({ key }, 'cache hit');
    return hit.value as T;
  }
  const running = inflight.get(key);
  if (running) {
    log.debug({ key }, 'cache request deduplicated');
    return running as Promise<T>;
  }

  const task = Promise.resolve()
    .then(loader)
    .then((value) => {
      entries.set(key, { value, expiresAt: Date.now() + config.cacheTtlMs });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

export function clearCache(): void {
  entries.clear();
}

export function cacheStats(): { entries: number; inflight: number; ttlMs: number } {
  return { entries: entries.size, inflight: inflight.size, ttlMs: config.cacheTtlMs };
}

// stateKey 只保存在内存条目中，工具层仍把它转换成 '<acquired>'，不会回显给 LLM。
export async function getCachedSharingDetail(
  page: Page,
  sharingId: string,
  password?: string,
): Promise<{ detail: SharingDetail; stateKey?: string }> {
  const credential = password ? hashCredential(password) : 'none';
  const key = `sharing:${sharingId}:${credential}`;
  return cached(key, () => getSharingDetail(page, sharingId, password));
}

export async function fetchCachedMetaJson<T = unknown>(url: string): Promise<T> {
  return cached(`meta:${url}`, () => fetchMetaJson<T>(url));
}

export async function fetchCachedSliceManifest(url: string): Promise<SliceManifest> {
  return cached(`slices:${url}`, () => fetchSliceManifest(url));
}
