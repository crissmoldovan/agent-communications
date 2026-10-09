import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';
import { shortTempDir } from './short-temp.ts';

assertLoopbackSeal();

const accountId = 'account-browser-sse';
const bearer = 'browser-sse-token';

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('the browser fixture did not bind literal loopback');
  }
  return address.port;
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

export interface BrowserSseFixture {
  readonly pageUrl: string;
  readonly unlistedPageUrl: string;
  readonly sseUrl: string;
  readonly bearer: string;
  preflightCount(): number;
  close(): Promise<void>;
}

/** A sealed test-only browser/page plus persisted daemon SSE boundary; every listener uses literal IPv4 loopback. */
export async function startBrowserSseFixture(): Promise<BrowserSseFixture> {
  const [{ startSseServer }, { openEventDatabase }] = await Promise.all([
    import('../../src/runtime/sse-server.ts'),
    import('../../src/store/database.ts'),
  ]);
  const html = await readFile(
    fileURLToPath(new URL('../../../events/test/browser/sse-client.html', import.meta.url)),
    'utf8',
  );
  const client = await readFile(
    fileURLToPath(new URL('../../../events/test/browser/sse-client.js', import.meta.url)),
    'utf8',
  );
  const pageHandler = (setCookie: boolean) => (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...(setCookie ? { 'Set-Cookie': 'browser-sse=present; SameSite=Lax' } : {}),
      });
      response.end(html);
      return;
    }
    if (path === '/sse-client.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(client);
      return;
    }
    response.writeHead(404).end();
  };
  const pageServer = createServer(pageHandler(true));
  const unlistedPageServer = createServer(pageHandler(false));
  const pagePort = await listen(pageServer);
  const unlistedPagePort = await listen(unlistedPageServer);
  const ssePort = await freeLoopbackPort();
  const stateDir = await shortTempDir('events-browser-sse-');
  const store = await openEventDatabase({ stateDir });
  const subscriber = {
    subscriberId: 'subscriber-browser-sse',
    version: 1,
    kind: 'sse' as const,
    authority: { host: '127.0.0.1' as const, port: ssePort },
    origins: [`http://127.0.0.1:${pagePort}`],
    retentionMs: 60_000,
  };
  const target = {
    targetId: 'target-browser-sse',
    version: 1,
    kind: 'sse' as const,
    subscriberId: subscriber.subscriberId,
    subscriberVersion: subscriber.version,
    representation: 'plain' as const,
  };
  try {
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 1');
    const rule = {
      ruleId: 'rule-browser-sse',
      version: 1,
      targets: [target],
      subscribers: [subscriber],
      deliveryRateCap: 20,
      retention: { sseReplayMs: 60_000 },
    };
    const ruleDocument = canonicalJson(rule);
    const targetDocument = canonicalJson(target);
    const subscriberDocument = canonicalJson(subscriber);
    store.database
      .prepare(
        `INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
         VALUES ('rule-browser-sse@1', 'rule-browser-sse', 1, ?, ?, 'active', 'approval', 'activation', 1)`,
      )
      .run(ruleDocument, sha256Hex(ruleDocument));
    store.database
      .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('target-browser-sse@1', target.targetId, targetDocument, sha256Hex(targetDocument));
    store.database
      .prepare('INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
      .run(
        'subscriber-browser-sse@1',
        subscriber.subscriberId,
        subscriber.version,
        subscriberDocument,
        sha256Hex(subscriberDocument),
      );
    // Frames are retained within the subscriber's 60-second replay window (stream_log allows at most seven days).
    const deliveredAt = Date.now();
    // Each retained frame names a real delivery, which names a decision on a real ingest record (stream_log's keys).
    for (const [eventId, offset] of [
      ['cursor', 0],
      ['replay', 1],
    ] as const) {
      store.database
        .prepare(
          `INSERT INTO ingest
           (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
           VALUES (?, ?, 'example.event', 1, ?, ?, ?, ?, ?)`,
        )
        .run(eventId, store.installationId, accountId, `dedupe-${eventId}`, deliveredAt, deliveredAt, deliveredAt);
      store.database
        .prepare(
          `INSERT INTO decisions
           (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
           VALUES (?, ?, ?, 'rule-browser-sse', 1, 'matched', ?, 'retained')`,
        )
        .run(`decision-${eventId}`, eventId, accountId, deliveredAt + 60_000);
      store.database
        .prepare(
          `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
            target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at, state, switch_generation)
           VALUES (?, ?, ?, 'rule-browser-sse', 1, 'sse:target-browser-sse:1:subscriber-browser-sse:1',
                   'target-browser-sse', 1, 'sse', 'plain', 'subscriber-browser-sse', 1, NULL, ?, 'delivered', 1)`,
        )
        .run(`delivery-${eventId}`, `decision-${eventId}`, accountId, deliveredAt + 60_000 + offset);
    }
    store.database.exec(`
      INSERT INTO stream_log
        (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
         event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
         expires_at, switch_generation)
      VALUES
        ('stream-cursor', 'delivery-cursor', 'rule-browser-sse', 1, 'target-browser-sse', 1, 'subscriber-browser-sse', 1,
         'cursor', '${accountId}', NULL, NULL, X'7B226964223A22637572736F72227D', ${deliveredAt}, ${deliveredAt + 60_000}, 1),
        ('stream-replay', 'delivery-replay', 'rule-browser-sse', 1, 'target-browser-sse', 1, 'subscriber-browser-sse', 1,
         'replay', '${accountId}', NULL, NULL, X'7B226964223A227265706C6179227D', ${deliveredAt + 1}, ${deliveredAt + 60_001}, 1);
    `);
    const listener = await startSseServer({
      store,
      subscriberId: subscriber.subscriberId,
      subscriberVersion: subscriber.version,
      cipher: {
        encrypt: async (_location, bytes) => Buffer.from(bytes),
        decrypt: async (_location, bytes) => {
          if (!(bytes instanceof Uint8Array)) throw new Error('the fixture stream record must be bytes');
          return Buffer.from(bytes);
        },
      },
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { inbox: { id: accountId, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      readBearerGenerations: async () => [{ generation: 1, lifecycle: 'current', material: bearer }],
    });
    return {
      pageUrl: `http://127.0.0.1:${pagePort}/`,
      unlistedPageUrl: `http://127.0.0.1:${unlistedPagePort}/`,
      sseUrl: `http://127.0.0.1:${ssePort}/v1/streams/${subscriber.subscriberId}`,
      bearer,
      preflightCount: () => listener.preflightCount(),
      close: async () => {
        await listener.close();
        await close(pageServer);
        await close(unlistedPageServer);
        store.close();
        await rm(stateDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    store.close();
    await close(pageServer).catch(() => undefined);
    await close(unlistedPageServer).catch(() => undefined);
    await rm(stateDir, { recursive: true, force: true });
    throw error;
  }
}
