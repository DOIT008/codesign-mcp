// 浏览器单例 + lazy-launch + idle shutdown + 并发保护。
// headless 工具共享同一个 page，避免每次工具调用都重新打开分享页；
// headed（登录）使用独占 page，用完即关。
// 所有 acquire / shutdown 都经过同一把锁，launch 与模式切换不会互相踩踏。

import type { BrowserContext, Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { getLogger } from '../logger.js';

const log = getLogger();

export type LaunchMode = 'headless' | 'headed';

export interface BrowserLauncher {
  launch(mode: LaunchMode, profileDir: string): Promise<BrowserContext>;
}

const defaultLauncher: BrowserLauncher = {
  async launch(mode, profileDir) {
    mkdirSync(profileDir, { recursive: true });
    log.info({ mode, profileDir }, 'launching persistent context');
    return chromium.launchPersistentContext(profileDir, {
      headless: mode === 'headless',
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  },
};

export interface BrowserCallContext {
  context: BrowserContext;
  page: Page;
  done: () => Promise<void>;
}

export interface BrowserSnapshot {
  running: boolean;
  mode: LaunchMode | null;
  activeCalls: number;
  lastUsedAt: number;
  launchedAt: number | null;
  sharedPage: boolean;
}

export interface BrowserManagerApi {
  acquireHeadless(): Promise<BrowserCallContext>;
  // 独立的 headless 页，用完即关。用于访问任意 URL（如本地 dev server）截图，
  // 避免污染共享的 CoDesign 页（共享页会被 ensureOnOrigin 拉回 codesign.qq.com）。
  acquireHeadlessIsolated(): Promise<BrowserCallContext>;
  acquireHeaded(): Promise<BrowserCallContext>;
  shutdown(reason: string): Promise<void>;
  snapshot(): BrowserSnapshot;
}

function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async (fn) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export function createBrowserManager(launcher: BrowserLauncher = defaultLauncher): BrowserManagerApi {
  interface State {
    context: BrowserContext | null;
    mode: LaunchMode | null;
    activeCalls: number;
    lastUsedAt: number;
    idleTimer: NodeJS.Timeout | null;
    launchedAt: number | null;
    sharedPage: Page | null;
    launchPromise: Promise<BrowserContext> | null;
    drainWaiters: Array<() => void>;
  }

  const state: State = {
    context: null,
    mode: null,
    activeCalls: 0,
    lastUsedAt: 0,
    idleTimer: null,
    launchedAt: null,
    sharedPage: null,
    launchPromise: null,
    drainWaiters: [],
  };
  const runExclusive = createMutex();

  function clearIdle(): void {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  function scheduleIdleShutdown(): void {
    clearIdle();
    if (config.keepBrowser) return;
    if (!state.context) return;
    state.idleTimer = setTimeout(() => {
      if (state.activeCalls > 0) return;
      void shutdown('idle');
    }, config.idleMs);
  }

  function waitForDrain(): Promise<void> {
    if (state.activeCalls === 0) return Promise.resolve();
    return new Promise((resolve) => {
      state.drainWaiters.push(resolve);
    });
  }

  function notifyDrain(): void {
    if (state.activeCalls !== 0 || state.drainWaiters.length === 0) return;
    const waiters = state.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async function ensure(mode: LaunchMode): Promise<BrowserContext> {
    if (state.launchPromise) await state.launchPromise;
    if (state.context && state.mode === mode) return state.context;
    if (state.context && state.mode !== mode) {
      await waitForDrain();
      await shutdownInternal('mode-switch');
    }
    if (!state.context) {
      state.launchPromise = launcher
        .launch(mode, config.profileDir)
        .then((ctx) => {
          state.context = ctx;
          state.mode = mode;
          state.launchedAt = Date.now();
          state.sharedPage = null;
          ctx.on('close', () => {
            if (state.context !== ctx) return;
            state.context = null;
            state.mode = null;
            state.launchedAt = null;
            state.sharedPage = null;
            clearIdle();
          });
          return ctx;
        })
        .finally(() => {
          state.launchPromise = null;
        });
      await state.launchPromise;
    }
    return state.context!;
  }

  async function shutdownInternal(reason: string): Promise<void> {
    clearIdle();
    if (!state.context) return;
    if (state.activeCalls > 0) {
      log.warn({ reason, activeCalls: state.activeCalls }, 'shutdown waiting for active calls');
      await waitForDrain();
    }
    if (!state.context) return;
    log.info({ reason }, 'shutting down context');
    const ctx = state.context;
    state.context = null;
    state.mode = null;
    state.launchedAt = null;
    state.sharedPage = null;
    notifyDrain();
    try {
      await ctx.close();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'context.close failed');
    }
  }

  function shutdown(reason: string): Promise<void> {
    return runExclusive(() => shutdownInternal(reason));
  }

  async function acquireCall(mode: LaunchMode, shared: boolean): Promise<BrowserCallContext> {
    return runExclusive(async () => {
      const ctx = await ensure(mode);
      let page: Page;
      if (shared && state.sharedPage && !state.sharedPage.isClosed()) {
        page = state.sharedPage;
      } else {
        page = await ctx.newPage();
        if (shared) state.sharedPage = page;
      }
      // 只在 newPage 成功之后计数，失败不会造成 activeCalls 泄漏。
      state.activeCalls += 1;
      clearIdle();
      let released = false;
      const done = async () => {
        if (released) return;
        released = true;
        if (!shared) {
          try {
            await page.close({ runBeforeUnload: false });
          } catch (err) {
            log.warn({ err: (err as Error).message }, 'page.close failed');
          }
          if (state.sharedPage === page) state.sharedPage = null;
        }
        state.activeCalls = Math.max(0, state.activeCalls - 1);
        state.lastUsedAt = Date.now();
        notifyDrain();
        if (state.activeCalls === 0) scheduleIdleShutdown();
      };
      return { context: ctx, page, done };
    });
  }

  return {
    acquireHeadless(): Promise<BrowserCallContext> {
      return acquireCall('headless', true);
    },
    acquireHeadlessIsolated(): Promise<BrowserCallContext> {
      return acquireCall('headless', false);
    },
    acquireHeaded(): Promise<BrowserCallContext> {
      return acquireCall('headed', false);
    },
    shutdown,
    snapshot(): BrowserSnapshot {
      return {
        running: state.context != null,
        mode: state.mode,
        activeCalls: state.activeCalls,
        lastUsedAt: state.lastUsedAt,
        launchedAt: state.launchedAt,
        sharedPage: state.sharedPage != null,
      };
    },
  };
}

export const browserManager = createBrowserManager();
export type BrowserManager = typeof browserManager;
