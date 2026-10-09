import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { assertLoopbackSeal, loopbackSealAttempts } from '../../../test/helpers/loopback-seal-preload.mjs';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const playwright = createRequire(new URL('../../events/package.json', import.meta.url))('playwright') as {
  chromium: { executablePath(): string; launch(input: { headless: boolean }): Promise<Browser> };
  webkit: { executablePath(): string; launch(input: { headless: boolean }): Promise<Browser> };
};

interface Browser {
  newContext(): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface BrowserContext {
  route(
    pattern: string,
    handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

interface BrowserPage {
  goto(url: string): Promise<unknown>;
  evaluate<Result>(
    callback: (input: { url: string; token: string }) => Result | Promise<Result>,
    input: { url: string; token: string },
  ): Promise<Result>;
}

type BrowserSseResult = { readonly ok: boolean; readonly frame?: string };
type BrowserSseClient = {
  open(input: {
    readonly url: string;
    readonly token: string;
    readonly after?: string;
    readonly credentials?: 'omit' | 'include';
  }): Promise<BrowserSseResult>;
};

const browsers = [
  ['chromium', playwright.chromium],
  ['webkit', playwright.webkit],
] as const;

test('B2-T9: real Chromium and WebKit preflight exact CORS and stream an authorised replay without credentials', {
  skip: WINDOWS_SKIP,
  // A listener that gets CORS or credentials wrong leaves the page waiting for a stream that never opens: fail within
  // a bounded time rather than hang the suite.
  timeout: 60_000,
}, async (t) => {
  const missing = browsers.filter(([, browser]) => !existsSync(browser.executablePath())).map(([name]) => name);
  if (missing.length > 0) {
    t.skip(`Playwright ${missing.join(' and ')} is not installed; the coordinator runs the browser verification`);
    return;
  }
  const { startBrowserSseFixture } = await import('./support/browser-sse-fixture.ts');
  let fixture: Awaited<ReturnType<typeof startBrowserSseFixture>>;
  try {
    fixture = await startBrowserSseFixture();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('the development sandbox blocks loopback listeners; the coordinator runs this browser proof outside it');
      return;
    }
    throw error;
  }
  try {
    for (const [name, browserType] of browsers) {
      const browser = await browserType.launch({ headless: true });
      try {
        const context = await browser.newContext();
        const permitted = new Set([
          fixture.pageUrl,
          fixture.pageUrl.replace(/\/$/, '/sse-client.js'),
          fixture.unlistedPageUrl,
          fixture.unlistedPageUrl.replace(/\/$/, '/sse-client.js'),
          fixture.sseUrl,
        ]);
        await context.route('**/*', (route) =>
          permitted.has(route.request().url()) ? route.continue() : route.abort(),
        );
        const page = await context.newPage();
        await page.goto(fixture.pageUrl);
        const replay = await page.evaluate(
          ({ url, token }) =>
            (globalThis as unknown as { agentcommsSseClient: BrowserSseClient }).agentcommsSseClient.open({
              url,
              token,
              after: 'stream-cursor',
            }),
          { url: fixture.sseUrl, token: fixture.bearer },
        );
        assert.deepEqual(replay, { ok: true, frame: 'id: stream-replay\ndata: {"id":"replay"}\n\n' }, name);
        const omitted = await page.evaluate(
          ({ url, token }) =>
            (globalThis as unknown as { agentcommsSseClient: BrowserSseClient }).agentcommsSseClient.open({
              url,
              token,
              credentials: 'omit',
            }),
          { url: fixture.sseUrl, token: fixture.bearer },
        );
        assert.equal(omitted.ok, true, `${name} sent a credential-omitting authorised stream request`);
        const credentialed = await page.evaluate(
          ({ url, token }) =>
            (globalThis as unknown as { agentcommsSseClient: BrowserSseClient }).agentcommsSseClient.open({
              url,
              token,
              credentials: 'include',
            }),
          { url: fixture.sseUrl, token: fixture.bearer },
        );
        assert.deepEqual(credentialed, { ok: false }, `${name} must not expose a credentialed stream frame`);
        const unlistedContext = await browser.newContext();
        await unlistedContext.route('**/*', (route) =>
          permitted.has(route.request().url()) ? route.continue() : route.abort(),
        );
        const unlisted = await unlistedContext.newPage();
        await unlisted.goto(fixture.unlistedPageUrl);
        const unlistedOrigin = await unlisted.evaluate(
          ({ url, token }) =>
            (globalThis as unknown as { agentcommsSseClient: BrowserSseClient }).agentcommsSseClient.open({
              url,
              token,
              credentials: 'omit',
            }),
          { url: fixture.sseUrl, token: fixture.bearer },
        );
        assert.deepEqual(unlistedOrigin, { ok: false }, `${name} must not expose a frame to an unlisted Origin`);
        await unlistedContext.close();
        await context.close();
      } finally {
        await browser.close();
      }
    }
    assert.ok(fixture.preflightCount() > 0, 'the real browsers issued the required Authorization preflight');
    assert.deepEqual(loopbackSealAttempts(), [], 'the sealed fixture made no DNS or non-loopback attempt');
  } finally {
    await fixture.close();
  }
});
