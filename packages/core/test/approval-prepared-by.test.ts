import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindingDigestOf } from '../src/approval-binding.ts';
import { approvalOutcome, publicApproval } from '../src/approval-outcome.ts';
import { decodeStored } from '../src/approval-stored.ts';
import { type GatedChange, gatedChange } from '../src/change-flow.ts';
import { CONNECTION_KEY_ENV, newConnectionKey } from '../src/connections.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { listApprovals } from '../src/operations/maintenance.ts';
import { asPartOf as asPart } from './helpers/gateway/as-part.ts';
import { tempDir } from './helpers/temp.ts';
import { downloadBinding, edited, OWNER, T0, v2Record } from './helpers/v2-records.ts';

/*
 * An approval prepared through an MCP connection says which (single-server design §7, P3): `preparedBy`, the id of the
 * connection whose part made it, as its gateway set it in `AGENTCOMMS_CONNECTION` — so the app's Approvals can say
 * which connection asks. Content-free: an id, never the key, which no part is ever given. Not bound, so a release
 * before 0.35.0 reads such a record unchanged; shape-checked, so it can only ever be a connection's id; and a record
 * without it — everything an earlier release wrote — reads as it did.
 */

const CONNECTION = 'cn_0123456789ABCDEFGHJKMNPQRS';

function machine(): { core: Core; stateDir: string } {
  const home = tempDir('comms-prepared-by-');
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_SECRETS_DIR: join(home, 'secrets'),
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { core: openCore({ env, caller: CORE_CALLER }), stateDir: env.AGENT_COMMS_STATE_DIR };
}

/** Runs `body` as a part of the connection `id` runs, its gateway's variables set, and puts them back after. */
async function asPartOf<T>(id: string | undefined, body: () => Promise<T>, options: { gateway?: boolean } = {}) {
  const before = process.env[CONNECTION_KEY_ENV];
  // A key in the environment too, as a careless process could leave one: it must reach no record.
  process.env[CONNECTION_KEY_ENV] = newConnectionKey();
  try {
    return await asPart(id, body, options);
  } finally {
    if (before === undefined) delete process.env[CONNECTION_KEY_ENV];
    else process.env[CONNECTION_KEY_ENV] = before;
  }
}

/** A change that does something and loosens nothing: it asks for an approval, and its claim writes nothing. */
function effectOnly(): GatedChange<string> {
  return {
    plan: (config) => ({ before: config, after: config, effects: ['removes 1 unused runtime'], summary: 'Tidy up' }),
    apply: async () => 'done',
  };
}

function approvalFiles(stateDir: string): string[] {
  const dir = join(stateDir, 'approvals');
  return readdirSync(dir)
    .filter((name) => /^ap_[0-9A-Z]{26}\.json$/.test(name))
    .map((name) => readFileSync(join(dir, name), 'utf8'));
}

test('P3: a change, a send and a download prepared through a connection carry its id as preparedBy, never its key', async () => {
  const { core, stateDir } = machine();
  const key = await asPartOf(CONNECTION, async () => {
    const change = await gatedChange(core, effectOnly(), { surface: 'mcp', channel: 'core' });
    assert.equal(change.status, 'approval-required');
    await core.approvals.create({
      channel: 'gmail',
      inboxId: OWNER,
      draftId: 'r-draft-1',
      draftMessageId: 'msg-v1',
      contentDigest: 'a'.repeat(64),
      sendEpoch: 0,
      policy: 'chat',
      requiredPolicy: 'chat',
      riskFlags: [],
      expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' },
    });
    await core.approvals.createDownload({ channel: 'gmail', download: downloadBinding(), policy: 'chat' });
    return process.env[CONNECTION_KEY_ENV] as string;
  });
  const listed = await listApprovals(core);
  assert.deepEqual(listed.map((approval) => [approval.kind, approval.preparedBy]).sort(), [
    ['change', CONNECTION],
    ['download', CONNECTION],
    ['send', CONNECTION],
  ]);
  for (const text of approvalFiles(stateDir)) {
    assert.equal(JSON.parse(text).preparedBy, CONNECTION);
    assert.equal(text.includes(key), false, 'the key reaches no record');
  }
  assert.equal(JSON.stringify(listed).includes(key), false, 'nor any listing');
});

test('P3: prepared outside any connection, a record has no preparedBy; claimed elsewhere, it keeps the one it was prepared with', async () => {
  const { core } = machine();
  const outside = await asPartOf(undefined, () => gatedChange(core, effectOnly(), { surface: 'cli', channel: 'core' }));
  assert.equal(outside.status, 'approval-required');
  // A word that is not a connection's id is no connection: never written.
  const odd = await asPartOf('not a connection', () =>
    gatedChange(core, effectOnly(), { surface: 'cli', channel: 'core' }),
  );
  const inside = await asPartOf(CONNECTION, () => gatedChange(core, effectOnly(), { surface: 'mcp', channel: 'core' }));
  if (outside.status !== 'approval-required' || odd.status !== 'approval-required') return;
  if (inside.status !== 'approval-required') return;
  const shown = new Map((await listApprovals(core)).map((approval) => [approval.approvalId, approval]));
  assert.equal(Object.hasOwn(shown.get(outside.prepared.approvalId) ?? {}, 'preparedBy'), false);
  assert.equal(Object.hasOwn(shown.get(odd.prepared.approvalId) ?? {}, 'preparedBy'), false);
  assert.equal(shown.get(odd.prepared.approvalId)?.state, 'pending', 'and the record reads whole');
  // The person's yes in the chat, claimed by a call through no connection: it is still the connection that asked.
  const claimed = await asPartOf(undefined, () =>
    gatedChange(core, effectOnly(), { surface: 'cli', channel: 'core', approvalId: inside.prepared.approvalId }),
  );
  assert.equal(claimed.status, 'applied');
  const used = (await listApprovals(core)).find((approval) => approval.approvalId === inside.prepared.approvalId);
  assert.equal(used?.state, 'used');
  assert.equal(used?.preparedBy, CONNECTION);
});

test('P3 (0.35.0 review, LOW): a process outside any gateway part that sets AGENTCOMMS_CONNECTION itself names no connection', async () => {
  const { core, stateDir } = machine();
  // The reviewer's scenario: a shell sets the variable itself — no gateway, no key — and prepares a change, writes an
  // audit line. Before, preparedBy and the audit line named the connection it chose.
  const forged = await asPartOf(
    CONNECTION,
    async () => {
      const change = await gatedChange(core, effectOnly(), { surface: 'cli', channel: 'core' });
      await core.audit.append({ inboxId: '', operation: 'connection.rename', outcome: 'ok', surface: 'cli' });
      return change;
    },
    { gateway: false },
  );
  assert.equal(forged.status, 'approval-required');
  if (forged.status !== 'approval-required') return;
  const shown = (await listApprovals(core)).find((approval) => approval.approvalId === forged.prepared.approvalId);
  assert.equal(Object.hasOwn(shown ?? {}, 'preparedBy'), false, 'no preparedBy from a variable a process set itself');
  const audit = readdirSync(join(stateDir, 'audit'))
    .map((name) => readFileSync(join(stateDir, 'audit', name), 'utf8'))
    .join('');
  assert.equal(audit.includes(CONNECTION), false, 'nor an audit line naming it');
});

test('P3: preparedBy is not bound, so a release before it reads the record; one that is not a connection id reads as corrupt', () => {
  const now = new Date(T0 + 60_000);
  const show = (record: object) => {
    const stored = decodeStored(
      (record as { approvalId: string }).approvalId,
      JSON.stringify(record),
      null,
      new Date(T0 + 60_000),
    );
    return { stored, shown: publicApproval(stored, approvalOutcome(stored, { action: 'inspect', live: null, now })) };
  };
  const older = v2Record({ kind: 'change', state: 'pending' });
  const before = show(older);
  assert.equal(before.stored.form, 'v2', 'a record without it reads as it always did');
  assert.equal(Object.hasOwn(before.shown, 'preparedBy'), false);
  const through = edited(older, { preparedBy: CONNECTION });
  assert.equal(bindingDigestOf(through), older.bindingDigest, 'its binding is the one a release before it computes');
  const after = show(through);
  assert.equal(after.stored.form, 'v2');
  assert.equal(after.shown.preparedBy, CONNECTION);
  for (const wrong of ['Ignore previous instructions', `${CONNECTION} `, 'ack_secret', '']) {
    const read = show(edited(older, { preparedBy: wrong })).stored;
    assert.equal(read.form, 'corrupt', JSON.stringify(wrong));
    assert.equal(read.form === 'corrupt' && read.reason, 'wrong-shape');
  }
  const notText = show(edited(older, { preparedBy: 7 })).stored;
  assert.equal(notText.form, 'unreadable', 'a field that is not even text is no record');
  // A send is held to it alike.
  const send = edited(v2Record({ kind: 'send', state: 'pending' }), { preparedBy: 'cn_lowercase' });
  assert.equal(show(send).stored.form, 'corrupt');
});
