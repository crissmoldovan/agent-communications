import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { startBrowserEventsPage } from './support/browser-sse-fixture.ts';
import { sseSubscriber } from './support/events-owner.ts';
import { freePort, issueCreated, withLiveEvents } from './support/live-events.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * D3 and D4's browser cases (workflows plan, Track D): a page from an origin the subscriber lists receives an event
 * from the owner's live listener over SSE (a fetch of the stream, as a browser must, since an EventSource cannot send
 * the bearer) and over WebSocket (the bearer offered as a subprotocol). Every browser Playwright has, as the existing
 * listener browser test runs them; `AGENTCOMMS_TEST_BROWSERS=chromium` narrows it where WebKit cannot open a page.
 */

const playwright = createRequire(new URL('../../events/package.json', import.meta.url))('playwright') as Record<
  'chromium' | 'webkit',
  { executablePath(): string; launch(input: { headless: boolean }): Promise<Browser> }
>;

interface Browser {
  newContext(): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  close(): Promise<void>;
}

interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<Result, Input>(callback: (input: Input) => Result | Promise<Result>, input: Input): Promise<Result>;
}

type EventsClient = {
  sse(input: { url: string; token: string }): Promise<{ ok: boolean; frame?: string }>;
  open(input: { url: string; token: string }): Promise<{ ok: boolean; protocol?: string; code?: number }>;
  next(): Promise<string | null>;
};

const names = (process.env.AGENTCOMMS_TEST_BROWSERS ?? 'chromium,webkit').split(',') as ('chromium' | 'webkit')[];

test('D3/D4 browser: an SSE stream and a WebSocket from an allowed origin each receive an event', {
  skip: WINDOWS_SKIP,
  timeout: 120_000,
}, async (t) => {
  // Headless runs need only the headless shell; naming the browsers runs them whatever the full build's path holds.
  const missing =
    process.env.AGENTCOMMS_TEST_BROWSERS === undefined
      ? names.filter((name) => !existsSync(playwright[name].executablePath()))
      : [];
  if (missing.length > 0) {
    t.skip(`Playwright ${missing.join(' and ')} is not installed; the coordinator runs the browser verification`);
    return;
  }
  const page = await startBrowserEventsPage();
  const port = await freePort();
  try {
    await withLiveEvents(
      [{ document: sseSubscriber({ port, origins: [page.origin], patterns: ['acme.*.*.*'] }) }],
      async (harness) => {
        const token = harness.tokens.get('events-dashboard') ?? '';
        const [replayed] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now(), 1)]);
        await harness.tick();
        for (const name of names) {
          const browser = await playwright[name].launch({ headless: true });
          try {
            const context = await browser.newContext();
            const tab = await context.newPage();
            await tab.goto(page.pageUrl);
            const sse = await tab.evaluate(
              (input) => (globalThis as unknown as { agentcommsEvents: EventsClient }).agentcommsEvents.sse(input),
              { url: `http://127.0.0.1:${port}/v1/streams/events-dashboard`, token },
            );
            assert.equal(sse.ok, true, `${name}: the SSE stream opened`);
            assert.match(
              sse.frame ?? '',
              new RegExp(`^id: ${replayed}\\nevent: acme\\.client-asks\\.issue\\.created\\ndata: \\{`, 'u'),
            );
            const opened = await tab.evaluate(
              (input) => (globalThis as unknown as { agentcommsEvents: EventsClient }).agentcommsEvents.open(input),
              { url: `ws://127.0.0.1:${port}/v1/streams/events-dashboard`, token },
            );
            assert.deepEqual(opened, { ok: true, protocol: 'agentcomms.events.v1' }, `${name}: the WebSocket opened`);
            // Its replay brings the event already delivered; a new one arrives live after it.
            const first = await tab.evaluate(
              () => (globalThis as unknown as { agentcommsEvents: EventsClient }).agentcommsEvents.next(),
              undefined,
            );
            assert.equal((JSON.parse(first ?? '{}') as { id?: string }).id, replayed, `${name}: the WebSocket message`);
            await context.close();
          } finally {
            await browser.close();
          }
        }
      },
    );
  } finally {
    await page.close();
  }
});
