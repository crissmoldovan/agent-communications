import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEventOwner } from '../../../../packages/events-daemon/src/runtime/owner.ts';
import { openEventDatabase } from '../../../../packages/events-daemon/src/store/database.ts';
import { selectEventSecretStore } from '../../../../packages/events-daemon/src/store/event-secrets.ts';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';

// Uses the real owner's database, secret store, dispatcher, and audit. Only the socket listener is replaced:
// the sandbox forbids listen(2). The separate compiled-Rust harness exercises the authenticated wire on CI.
export async function fixture(work, withKey = true) {
  assertLoopbackSeal();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'd-sc-')));
  const key = Buffer.alloc(32, 17);
  let dispatch;
  let closeSession;
  let owner;
  try {
    const seeded = await openEventDatabase({ stateDir: join(root, 'state') });
    await selectEventSecretStore(seeded.database, 'file');
    const judge = JSON.stringify({
      judgeId: 'judge-capability',
      version: 1,
      kind: 'typesafe',
      provider: 'typesafe',
      model: 'jev',
    });
    seeded.database
      .prepare('INSERT INTO judge_versions (id, judge_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
      .run('judge-capability@1', 'judge-capability', 1, judge, createHash('sha256').update(judge).digest('hex'));
    seeded.close();
    owner = await startEventOwner({
      stateDir: join(root, 'state'),
      configDir: join(root, 'config'),
      tickMs: 60_000,
      ...(withKey ? { desktopCapabilityKey: key } : {}),
      startControlServer: async ({ handle, onSessionClosed }) => {
        dispatch = handle;
        closeSession = onSessionClosed;
        return { close: async () => {} };
      },
    });
    let ordinal = 0;
    const request = (operation, args = {}, session = 'session-a', origin = 'secrets') =>
      dispatch({
        version: 1,
        requestId: `capability-${++ordinal}`,
        operation,
        args,
        session,
        origin,
      });
    await request('target-add', {
      document: { targetId: 'target-capability', version: 1, kind: 'dry-run', retentionMs: 60_000 },
    });
    const issue = async (operation = 'targetSecretCreate', session = 'session-a') => {
      const issued = await request('desktopSecretNonce', { operation }, session);
      assert.equal(typeof issued.nonce, 'string', 'owner must issue a one-use nonce');
      return {
        nonce: issued.nonce,
        mac: createHmac('sha256', key)
          .update(session + operation + issued.nonce)
          .digest('hex'),
      };
    };
    await work({ request, issue, root, closeSession });
  } finally {
    key.fill(0);
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
}
