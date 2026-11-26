import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CODESIGN_KEEP_BROWSER = '1';

const { createBrowserManager } = await import('../dist/browser/manager.js');
const { ensureOnOrigin } = await import('../dist/codesign/sharing.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePage() {
  let closed = false;
  return {
    async close() {
      closed = true;
    },
    isClosed() {
      return closed;
    },
  };
}

function makeContext() {
  let closed = false;
  const closeListeners = [];
  const context = {
    newPageCalls: 0,
    pages: [],
    async newPage() {
      context.newPageCalls += 1;
      const page = makePage();
      context.pages.push(page);
      return page;
    },
    on(event, listener) {
      if (event === 'close') closeListeners.push(listener);
    },
    async close() {
      closed = true;
      for (const listener of closeListeners) listener();
    },
    isClosed() {
      return closed;
    },
  };
  return context;
}

function makeLauncher({ failFirstNewPage = false } = {}) {
  const contexts = [];
  let launches = 0;
  let firstNewPageFailed = false;
  const launcher = {
    get launches() {
      return launches;
    },
    get contexts() {
      return contexts;
    },
    async launch() {
      launches += 1;
      await delay(10);
      const context = makeContext();
      if (failFirstNewPage && !firstNewPageFailed) {
        firstNewPageFailed = true;
        const original = context.newPage.bind(context);
        context.newPage = async () => {
          throw new Error('newPage failed');
        };
        context.restoreNewPage = original;
      }
      contexts.push(context);
      return context;
    },
  };
  return launcher;
}

test('concurrent headless calls launch once and share the same page', async () => {
  const launcher = makeLauncher();
  const manager = createBrowserManager(launcher);

  const [first, second] = await Promise.all([
    manager.acquireHeadless(),
    manager.acquireHeadless(),
  ]);

  assert.equal(launcher.launches, 1);
  assert.equal(launcher.contexts[0].newPageCalls, 1);
  assert.equal(first.page, second.page);
  assert.equal(manager.snapshot().activeCalls, 2);

  await first.done();
  await second.done();
  assert.equal(manager.snapshot().activeCalls, 0);
});

test('done keeps the shared page open for later calls', async () => {
  const launcher = makeLauncher();
  const manager = createBrowserManager(launcher);

  const first = await manager.acquireHeadless();
  await first.done();

  assert.equal(first.page.isClosed(), false);
  assert.equal(manager.snapshot().sharedPage, true);

  const second = await manager.acquireHeadless();
  assert.equal(second.page, first.page);
  assert.equal(launcher.contexts[0].newPageCalls, 1);
  await second.done();
});

test('a failed newPage does not leak activeCalls', async () => {
  const launcher = makeLauncher({ failFirstNewPage: true });
  const manager = createBrowserManager(launcher);

  await assert.rejects(manager.acquireHeadless(), /newPage failed/);
  assert.equal(manager.snapshot().activeCalls, 0);
});

test('mode switch waits for active calls to drain', async () => {
  const launcher = makeLauncher();
  const manager = createBrowserManager(launcher);

  const headless = await manager.acquireHeadless();
  let headedAcquired = false;
  const headedPromise = manager.acquireHeaded().then((call) => {
    headedAcquired = true;
    return call;
  });

  await delay(40);
  assert.equal(headedAcquired, false);
  assert.equal(launcher.launches, 1);
  assert.equal(headless.page.isClosed(), false);

  await headless.done();
  const headed = await headedPromise;

  assert.equal(headedAcquired, true);
  assert.equal(launcher.launches, 2);
  assert.equal(manager.snapshot().mode, 'headed');
  await headed.done();
});

test('headed calls use an exclusive page that is closed on done', async () => {
  const launcher = makeLauncher();
  const manager = createBrowserManager(launcher);

  const headed = await manager.acquireHeaded();
  const page = headed.page;
  await headed.done();

  assert.equal(page.isClosed(), true);
  assert.equal(manager.snapshot().sharedPage, false);
});

test('shutdown waits for active calls before closing the context', async () => {
  const launcher = makeLauncher();
  const manager = createBrowserManager(launcher);

  const call = await manager.acquireHeadless();
  let shutdownDone = false;
  const shutdownPromise = manager.shutdown('test').then(() => {
    shutdownDone = true;
  });

  await delay(40);
  assert.equal(shutdownDone, false);
  assert.equal(manager.snapshot().running, true);

  await call.done();
  await shutdownPromise;

  assert.equal(shutdownDone, true);
  assert.equal(manager.snapshot().running, false);
});

test('concurrent origin checks share one navigation', async () => {
  let gotoCalls = 0;
  const page = {
    url: () => 'about:blank',
    async goto() {
      gotoCalls += 1;
      await delay(20);
      return null;
    },
  };

  await Promise.all([
    ensureOnOrigin(page, '123456'),
    ensureOnOrigin(page, '123456'),
    ensureOnOrigin(page, '123456'),
  ]);

  assert.equal(gotoCalls, 1);
});

test('an already-origin page does not navigate', async () => {
  let gotoCalls = 0;
  const page = {
    url: () => 'https://codesign.qq.com/app/s/123456',
    async goto() {
      gotoCalls += 1;
      return null;
    },
  };

  await ensureOnOrigin(page, '123456');
  assert.equal(gotoCalls, 0);
});
