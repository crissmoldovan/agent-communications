import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { approveChangeAtTerminal, type Core } from '@agentcomms/core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { clientSecretRef, refreshTokenRef } from '../src/auth/session.ts';
import { GmailContext } from '../src/context.ts';
import { clientAdd, clientAddChange, clientRemove } from '../src/operations/clients.ts';
import { completeProbe, startProbe } from '../src/operations/confirm-clients.ts';
import { importLegacy } from '../src/operations/import-legacy.ts';
import { inboxRemove } from '../src/operations/inboxes.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';
import {
  applied,
  approvalAsked,
  approving,
  cli,
  connect,
  pendingApproval,
  toolError,
  wire,
} from './support/surfaces.ts';

/*
 * Every change to an account, from a chat and from a terminal, approved the one way core's change flow asks.
 *
 * The owner's rule since 2026-09-25 is that everything can be done from both surfaces, account management included.
 * What loosens a safety setting, or cannot be taken back, is prepared, shown to a person as a preview, and made only
 * on the call that brings its approval back — whichever surface prepared it and whichever claims it. These tests hold
 * each tool to its command: the same change, the same refusals, and the same result.
 */

const CLAUDE = { CLAUDECODE: '1' };

async function mailbox(options: { tier?: 'read' | 'organize'; contacts?: boolean } = {}): Promise<Harness> {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  const scopes = [
    ...(options.tier === 'read' ? [SCOPES.gmailReadonly] : [SCOPES.gmailModify]),
    ...(options.contacts ? [SCOPES.contacts, SCOPES.otherContacts] : []),
  ];
  await harness.connectInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    scopes,
    tier: options.tier ?? 'organize',
  });
  return harness;
}

/** A person at a terminal approving a change under the `confirm` policy: read the preview, type the code. */
async function approveAtTerminal(core: Core, approvalId: string): Promise<void> {
  let asked = '';
  let answered = false;
  const input = new PassThrough();
  const err = new PassThrough();
  err.on('data', (chunk) => {
    asked += String(chunk);
    const code = /Type (\S+) to approve this change/.exec(asked);
    // Once: a terminal echoes what is typed, and the prompt is still in what was read.
    if (code && !answered) {
      answered = true;
      input.write(`${code[1]}\n`);
    }
  });
  const outcome = await approveChangeAtTerminal(
    core,
    approvalId,
    {},
    { color: false },
    {
      stdout: Object.assign(new PassThrough(), { isTTY: true }),
      stderr: Object.assign(err, { isTTY: true }),
      stdin: Object.assign(input, { isTTY: true }),
    },
  );
  assert.equal(outcome.state, 'approved');
}

// ── inbox policy ────────────────────────────────────────────────────────────────────────────────────────────

test('a loosening asked for in chat is made on the call that brings its approval back, and only once', async () => {
  const harness = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    applied(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' }));

    const asked = approvalAsked(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat' }));
    assert.equal(asked.policy, 'chat');
    assert.match(asked.preview, /work send policy: never → chat — a yes in the chat will be enough to send/);
    assert.match(asked.next, /Show this preview to the user and ask/);
    assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'never', 'asking changed it');

    const made = applied(
      await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.deepEqual(made, {
      alias: 'work',
      sendPolicy: 'chat',
      previous: 'never',
      changePolicy: 'chat',
      previousChangePolicy: 'chat',
    });
    assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'chat');

    // Spent. Tightened again, the same approval does not loosen it a second time.
    applied(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' }));
    const replayed = toolError(
      await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.match(replayed.code, /^APPROVAL_/);
    assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'never');

    const audit = await harness.core.audit.tail();
    for (const operation of ['change.prepare', 'change.claim']) {
      assert.ok(
        audit.some((entry) => entry.operation === operation && entry.surface === 'mcp'),
        `${operation} from chat is not in the audit trail`,
      );
    }
  } finally {
    await close();
  }
});

test('an approval prepared on one surface is claimed on the other, because it is one change', async () => {
  const harness = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    applied(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' }));

    // Prepared by an agent at the CLI, claimed in chat.
    const fromCli = pendingApproval(
      await cli(harness, ['inbox', 'policy', 'work', '--send', 'confirm', '--json'], { env: CLAUDE }),
    );
    applied(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'confirm', approvalId: fromCli }));
    assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'confirm');

    // Prepared in chat, claimed at the CLI — and what the command prints is what the tool would have returned.
    const fromChat = approvalAsked(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat' }));
    const claimed = await cli(
      harness,
      ['inbox', 'policy', 'work', '--send', 'chat', '--approval', fromChat.approvalId, '--json'],
      { env: CLAUDE },
    );
    assert.equal(claimed.code, 0, claimed.stdout);
    assert.deepEqual(claimed.envelope().data, {
      alias: 'work',
      sendPolicy: 'chat',
      previous: 'confirm',
      changePolicy: 'chat',
      previousChangePolicy: 'chat',
    });
  } finally {
    await close();
  }
});

test('an approval is for the change it previewed, and claiming it for another voids it', async () => {
  const harness = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    applied(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' }));
    const asked = approvalAsked(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'confirm' }));
    // Shown `never → confirm`; spent on `never → chat`, which nobody was shown.
    const refused = toolError(
      await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.equal(refused.code, 'APPROVAL_VOID');
    assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'never');
    // And it is gone for the change it was for, too: a mismatch is a reason to ask again, not to try another.
    toolError(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'confirm', approvalId: asked.approvalId }));
  } finally {
    await close();
  }
});

test('moving a mailbox off the confirm change policy is approved at a terminal, not in chat', async () => {
  const harness = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // Tightening the change policy asks nobody.
    assert.equal(
      applied<{ changePolicy: string }>(await call('gmail_inbox_policy', { inbox: 'work', changePolicy: 'confirm' }))
        .changePolicy,
      'confirm',
    );

    // Loosening it back is governed by the policy in force before the change: confirm.
    const asked = approvalAsked(await call('gmail_inbox_policy', { inbox: 'work', changePolicy: 'chat' }));
    assert.equal(asked.policy, 'confirm');
    assert.match(asked.next, new RegExp(`agentcomms approve ${asked.approvalId}`));
    assert.match(asked.preview, /work change policy: confirm → chat/);

    // The agent cannot claim it on the person's behalf: refused, and the approval left for the person.
    const early = toolError(
      await call('gmail_inbox_policy', { inbox: 'work', changePolicy: 'chat', approvalId: asked.approvalId }),
    );
    assert.equal(early.code, 'APPROVAL_PENDING');
    assert.equal((await harness.core.config.load()).inboxes.work?.changePolicy, 'confirm');

    // So is every other loosening of this mailbox while it is under confirm.
    applied(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' }));
    assert.equal(
      approvalAsked(await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'chat' })).policy,
      'confirm',
    );

    await approveAtTerminal(harness.core, asked.approvalId);
    applied(await call('gmail_inbox_policy', { inbox: 'work', changePolicy: 'chat', approvalId: asked.approvalId }));
    assert.equal((await harness.core.config.load()).inboxes.work?.changePolicy, 'chat');
  } finally {
    await close();
  }
});

test('agent-gmail approve approves a change under confirm, so the person needs no other command', async () => {
  const harness = await mailbox();
  // Tightening asks nobody; from here every change to this mailbox needs a person at a terminal.
  assert.equal((await cli(harness, ['inbox', 'policy', 'work', '--change', 'confirm', '--json'])).code, 0);

  const id = pendingApproval(await cli(harness, ['inbox', 'remove', 'work', '--json']));
  const refused = await cli(harness, ['approve', id, '--json'], { tty: true, env: { CLAUDECODE: '1' } });
  assert.notEqual(refused.code, 0, 'an agent approved its own change');

  const approved = await cli(harness, ['approve', id], { tty: true, answer: true });
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /the change is applied by the command that prepared it/);
  assert.ok((await harness.core.config.load()).inboxes.work, 'approving applied nothing');

  const applied = await cli(harness, ['inbox', 'remove', 'work', '--json', '--approval', id]);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal((await harness.core.config.load()).inboxes.work, undefined);
});

test('inbox policy refuses the same things from both surfaces, in the same words', async () => {
  const harness = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const cases: Array<[string[], Record<string, unknown>]> = [
      [['inbox', 'policy', 'nope', '--send', 'never'], { inbox: 'nope', sendPolicy: 'never' }],
      [['inbox', 'policy', 'work'], { inbox: 'work' }],
    ];
    for (const [argv, args] of cases) {
      const byCommand = (await cli(harness, [...argv, '--json'])).envelope().error;
      const byTool = toolError(await call('gmail_inbox_policy', args));
      assert.ok(byCommand, `the CLI accepted ${argv.join(' ')}`);
      assert.equal(byTool.code, byCommand.code, argv.join(' '));
      assert.equal(byTool.message, byCommand.message, argv.join(' '));
    }
    const wrong = (await cli(harness, ['inbox', 'policy', 'work', '--change', 'never', '--json'])).envelope().error;
    assert.equal(wrong?.code, 'USAGE');
    assert.match(wrong?.message ?? '', /"never" is not a change policy/);
  } finally {
    await close();
  }
});

// ── inbox reauth ────────────────────────────────────────────────────────────────────────────────────────────

test('asking Google for more than a mailbox holds is approved before the sign-in link exists', async () => {
  const harness = await mailbox({ tier: 'read' });
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const asked = approvalAsked(await call('gmail_inbox_reauth', { inbox: 'work', tier: 'organize' }));
    assert.match(asked.preview, /Let work do more: read → organize/);
    assert.match(asked.preview, /signs in to Google again as jo@example\.test/);
    assert.match(asked.preview, /label, archive and bin messages/);
    assert.doesNotMatch(JSON.stringify(asked), /accounts\.google|authUrl|flowId/, 'a link was made before approval');

    const link = applied<{ flowId: string; authUrl: string; nextTool: string }>(
      await call('gmail_inbox_reauth', { inbox: 'work', tier: 'organize', approvalId: asked.approvalId }),
    );
    assert.equal(link.nextTool, 'gmail_inbox_finish');
    assert.match(decodeURIComponent(link.authUrl), /gmail\.modify/);

    await fetch(harness.google.consent(link.authUrl, { sub: 'sub-1' }));
    const finished = wire(await call('gmail_inbox_finish', { flowId: link.flowId, waitSeconds: 10 }));
    assert.equal(finished.reauthorised, true);
    assert.equal(finished.tier, 'organize');
    assert.equal((await harness.core.config.load()).inboxes.work?.tier, 'organize');
  } finally {
    await close();
  }
});

test('the address book is a widening too, and renewing or narrowing a grant asks nobody', async () => {
  const harness = await mailbox({ tier: 'organize' });
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const asked = approvalAsked(await call('gmail_inbox_reauth', { inbox: 'work', contacts: true }));
    assert.match(asked.preview, /and the address book/);

    // Narrower than it has: the link at once, and no approval made.
    const before = (await harness.core.approvals.list()).length;
    const link = applied<{ flowId: string; authUrl: string }>(
      await call('gmail_inbox_reauth', { inbox: 'work', tier: 'read' }),
    );
    assert.equal((await harness.core.approvals.list()).length, before, 'narrowing asked somebody');
    // Finished, so the listener it started does not wait out its ten minutes after this test.
    await fetch(harness.google.consent(link.authUrl, { sub: 'sub-1' }));
    assert.equal(wire(await call('gmail_inbox_finish', { flowId: link.flowId, waitSeconds: 10 })).tier, 'read');
  } finally {
    await close();
  }
});

test('inbox reauth --start asks for the same approval, and --approval starts the sign-in it was for', async () => {
  const harness = await mailbox({ tier: 'read' });
  const asked = await cli(harness, ['inbox', 'reauth', 'work', '--tier', 'organize', '--start', '--json'], {
    env: CLAUDE,
  });
  const approvalId = pendingApproval(asked);
  assert.match(String(asked.envelope().error?.details?.preview), /read → organize/);
  assert.match(asked.envelope().error?.hint ?? '', /inbox reauth work --tier organize --start --json --approval/);

  const started = await cli(harness, [
    'inbox',
    'reauth',
    'work',
    '--tier',
    'organize',
    '--start',
    '--approval',
    approvalId,
    '--json',
  ]);
  assert.equal(started.code, 0, started.stdout);
  const flow = started.envelope<{ flowId: string; authUrl: string }>().data;
  assert.ok(flow?.authUrl);
  await fetch(harness.google.consent(flow.authUrl, { sub: 'sub-1' }));
  const finished = await cli(harness, ['inbox', 'reauth', '--finish', flow.flowId, '--wait', '10', '--json']);
  assert.equal(finished.code, 0, finished.stdout);
  assert.equal(finished.envelope<{ inbox: { tier: string } }>().data?.inbox.tier, 'organize');
});

// ── inbox remove ────────────────────────────────────────────────────────────────────────────────────────────

test('removing a mailbox is approved first, and the preview names the account that goes', async () => {
  const harness = await mailbox();
  const id = (await harness.core.config.load()).inboxes.work?.id ?? '';
  const secrets = await harness.core.secrets('file');
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const asked = approvalAsked(await call('gmail_inbox_remove', { inbox: 'work' }));
    assert.match(asked.preview, /Remove the mailbox work/);
    assert.match(asked.preview, /disconnects work \(jo@example\.test\) and deletes its token from this machine/);
    assert.match(asked.preview, /It loosens no safety setting/);
    assert.ok((await harness.core.config.load()).inboxes.work, 'asking removed it');
    assert.ok(await secrets.get(refreshTokenRef(id)), 'asking deleted its token');

    const removed = applied(await call('gmail_inbox_remove', { inbox: 'work', approvalId: asked.approvalId }));
    assert.deepEqual(removed, { alias: 'work', id, email: 'jo@example.test', revoked: false });
    assert.equal((await harness.core.config.load()).inboxes.work, undefined);
    secrets.invalidate(refreshTokenRef(id));
    assert.equal(await secrets.get(refreshTokenRef(id)), null);
  } finally {
    await close();
  }
});

test('inbox remove at the CLI asks the same way and prints what the tool returns', async () => {
  const viaCli = await mailbox();
  const viaTool = await mailbox();
  const byCommand = await approving(viaCli, ['inbox', 'remove', 'work']);
  assert.equal(byCommand.code, 0, byCommand.stdout);
  const { call, close } = await connect({ core: viaTool.core, env: viaTool.env });
  try {
    const asked = approvalAsked(await call('gmail_inbox_remove', { inbox: 'work' }));
    const byTool = applied(await call('gmail_inbox_remove', { inbox: 'work', approvalId: asked.approvalId }));
    // The ids are minted per harness; everything else is the same result.
    assert.deepEqual({ ...byTool, id: 'x' }, { ...byCommand.envelope<Record<string, unknown>>().data, id: 'x' });
    // A name with nothing behind it is refused before anything is prepared, in the same words.
    const missing = (await cli(viaTool, ['inbox', 'remove', 'work', '--json'])).envelope().error;
    const refused = toolError(await call('gmail_inbox_remove', { inbox: 'work' }));
    assert.equal(refused.message, missing?.message);
  } finally {
    await close();
  }
});

test('an approval to remove one mailbox does not remove another that took its name', async () => {
  const harness = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const asked = approvalAsked(await call('gmail_inbox_remove', { inbox: 'work' }));
    // Removed some other way, and a different account connected under the same name.
    await inboxRemove(new GmailContext({ core: harness.core, env: harness.env }), 'work');
    await harness.connectInbox({ alias: 'work', email: 'sam@example.test', sub: 'sub-2' });
    toolError(await call('gmail_inbox_remove', { inbox: 'work', approvalId: asked.approvalId }));
    assert.equal((await harness.core.config.load()).inboxes.work?.email, 'sam@example.test');
  } finally {
    await close();
  }
});

test('the removal itself refuses a mailbox that is not the one approved', async () => {
  // The last line of the same guard: the claim above proves the name still means the approved mailbox, and the
  // removal proves it again, by id, in case it moved between the two.
  const harness = await mailbox();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await assert.rejects(inboxRemove(context, 'work', { expectedId: 'ibx_AAAAAAAAAAAAAAAA' }), (error: Error) => {
    assert.match(error.message, /no longer the mailbox this removal was approved for/);
    return true;
  });
  assert.ok((await harness.core.config.load()).inboxes.work, 'the wrong mailbox was removed');
});

// ── client add and remove ───────────────────────────────────────────────────────────────────────────────────

async function clientJson(content: Record<string, unknown> = {}): Promise<string> {
  const path = join(tempDir(), 'client_secret_desktop.json');
  await writeFile(
    path,
    JSON.stringify({
      installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET, project_id: 'proj-1', ...content },
    }),
  );
  return path;
}

test('an OAuth client is registered from a path in chat, approved first, and its secret never comes back', async () => {
  const harness = await newHarness();
  const path = await clientJson();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const first = await call('gmail_client_add', { path, name: 'desktop' });
    const asked = approvalAsked(first);
    assert.match(asked.preview, new RegExp(`registers the OAuth client ${TEST_CLIENT_ID.replaceAll('.', '\\.')}`));
    assert.match(asked.preview, /Google Cloud project proj-1 as "desktop"/);
    assert.deepEqual((await harness.core.config.load()).clients, {}, 'asking registered it');

    const second = await call('gmail_client_add', { path, name: 'desktop', approvalId: asked.approvalId });
    const added = applied<Record<string, unknown>>(second);
    assert.equal(added.clientId, TEST_CLIENT_ID);
    assert.equal(added.store, 'file');
    assert.equal(added.probed, true);
    assert.equal((await harness.core.config.load()).clients.desktop?.clientId, TEST_CLIENT_ID);
    assert.equal(await (await harness.core.secrets('file')).get(clientSecretRef('desktop')), TEST_CLIENT_SECRET);

    for (const said of [JSON.stringify(first), JSON.stringify(second)]) {
      assert.doesNotMatch(said, new RegExp(TEST_CLIENT_SECRET), 'the client secret reached a result');
      assert.doesNotMatch(said, /secretRef|client_secret"/, 'where the secret is kept reached a result');
    }
  } finally {
    await close();
  }
});

test('a registration that would be refused is refused before anybody is asked to approve it', async () => {
  const harness = await newHarness();
  const path = await clientJson();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    await clientAdd(new GmailContext({ core: harness.core, env: harness.env }), { path, name: 'desktop' });
    const web = join(tempDir(), 'web.json');
    await writeFile(web, JSON.stringify({ web: { client_id: TEST_CLIENT_ID, client_secret: 'x' } }));
    for (const [args, argv] of [
      [{ path, name: 'desktop' }, ['client', 'add', path, '--name', 'desktop']],
      [{ path: join(tempDir(), 'missing.json') }, ['client', 'add', join(tempDir(), 'missing.json')]],
      [{ path: web }, ['client', 'add', web]],
    ] as const) {
      const before = (await harness.core.approvals.list()).length;
      const byTool = toolError(await call('gmail_client_add', { ...args }));
      const byCommand = (await cli(harness, [...argv, '--json'])).envelope().error;
      assert.equal(byTool.code, byCommand?.code, argv.join(' '));
      assert.equal(
        byTool.message.replace(/\/[^ ]+missing\.json/, 'X'),
        byCommand?.message.replace(/\/[^ ]+missing\.json/, 'X'),
      );
      assert.equal((await harness.core.approvals.list()).length, before, `${argv.join(' ')} prepared an approval`);
    }
  } finally {
    await close();
  }
});

test('the file registered is the file approved: one changed after the preview is refused', async () => {
  const harness = await newHarness();
  const path = await clientJson();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const asked = approvalAsked(await call('gmail_client_add', { path }));
    // Another project's client, written over the file the person was shown.
    await writeFile(
      path,
      JSON.stringify({
        installed: { client_id: 'other.apps.googleusercontent.com', client_secret: 'not-a-real-secret' },
      }),
    );
    toolError(await call('gmail_client_add', { path, approvalId: asked.approvalId }));
    assert.deepEqual((await harness.core.config.load()).clients, {});
  } finally {
    await close();
  }
});

test('what is registered is what the plan read, even when the file changes before it is applied', async () => {
  /*
   * The claim reads the file again and refuses a different one (above). This is the moment after: the change keeps
   * what its plan read, and registers that, rather than reading the path a third time after the approval was spent.
   */
  const harness = await newHarness();
  const path = await clientJson();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const change = clientAddChange(context, { path, name: 'desktop', noProbe: true });
  const request = await change.plan(await harness.core.config.load());
  await writeFile(
    path,
    JSON.stringify({
      installed: { client_id: 'other.apps.googleusercontent.com', client_secret: 'not-a-real-secret' },
    }),
  );
  await change.apply({ kind: 'loosening-consent', paths: [], changes: [] }, request);
  assert.equal((await harness.core.config.load()).clients.desktop?.clientId, TEST_CLIENT_ID);
});

test('--move and move delete the downloaded file only once the change is approved and made', async () => {
  const harness = await newHarness();
  const path = await clientJson();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const asked = approvalAsked(await call('gmail_client_add', { path, move: true }));
    assert.match(asked.preview, /deletes .*client_secret_desktop\.json once the secret is stored/);
    await readFile(path, 'utf8');
    assert.equal(
      applied<{ sourceRemoved: boolean }>(
        await call('gmail_client_add', { path, move: true, approvalId: asked.approvalId }),
      ).sourceRemoved,
      true,
    );
    await assert.rejects(readFile(path, 'utf8'), /ENOENT/);
  } finally {
    await close();
  }
});

test('setup --client-json registers the client the same way client add does: approved first', async () => {
  const harness = await newHarness();
  const path = await clientJson();
  const asked = await cli(harness, ['setup', '--client-json', path, '--json']);
  pendingApproval(asked);
  assert.deepEqual((await harness.core.config.load()).clients, {}, 'setup registered a client nobody approved');
  assert.match(asked.envelope().error?.hint ?? '', /agent-gmail setup --client-json \S+ --json --approval/);
});

test('removing an OAuth client is approved first, and refused while a mailbox signs in through it', async () => {
  const harness = await mailbox();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await clientAdd(context, { path: await clientJson(), name: 'spare' });
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const inUse = toolError(await call('gmail_client_remove', { name: 'default' }));
    const byCommand = (await cli(harness, ['client', 'remove', 'default', '--json'])).envelope().error;
    assert.equal(inUse.code, 'CONFIG');
    assert.equal(inUse.message, byCommand?.message);

    const asked = approvalAsked(await call('gmail_client_remove', { name: 'spare' }));
    assert.match(asked.preview, /deletes its secret from this machine/);
    assert.ok((await harness.core.config.load()).clients.spare, 'asking removed it');
    assert.deepEqual(applied(await call('gmail_client_remove', { name: 'spare', approvalId: asked.approvalId })), {
      name: 'spare',
    });
    assert.equal((await harness.core.config.load()).clients.spare, undefined);
    const secrets = await harness.core.secrets('file');
    secrets.invalidate(clientSecretRef('spare'));
    assert.equal(await secrets.get(clientSecretRef('spare')), null);
  } finally {
    await close();
  }
});

test('the client removal itself refuses a client that is not the one approved', async () => {
  const harness = await newHarness();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await clientAdd(context, { path: await clientJson(), name: 'spare' });
  await assert.rejects(
    clientRemove(context, 'spare', { expectedClientId: 'other.apps.googleusercontent.com' }),
    /no longer the OAuth client this removal was approved for/,
  );
  assert.ok((await harness.core.config.load()).clients.spare, 'the wrong client was removed');
});

// ── inbox import ────────────────────────────────────────────────────────────────────────────────────────────

/** A refresh token the fake Google will renew, as the other server's files hold one. */
async function mintToken(harness: Harness, sub: string): Promise<string> {
  const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: [SCOPES.gmailModify],
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl, { sub })).searchParams.get('code') ?? '';
  const tokens = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  return tokens.refreshToken;
}

async function legacyDirectory(harness: Harness, mailboxes: Record<string, string>): Promise<string> {
  const directory = join(tempDir(), '.gmail-mcp');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'gcp-oauth.keys.json'),
    JSON.stringify({ installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET } }),
  );
  for (const [name, sub] of Object.entries(mailboxes)) {
    await writeFile(
      join(directory, `creds-${name}.json`),
      JSON.stringify({ tokens: { refresh_token: await mintToken(harness, sub) }, scopes: [SCOPES.gmailModify] }),
    );
  }
  return directory;
}

test('an import from chat names every mailbox it will connect, and connects them once approved', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  const dir = await legacyDirectory(harness, { work: 'sub-1', home: 'sub-2' });
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // A dry run is a read: applied at once, and nothing written.
    const dry = applied<{ dryRun: boolean; imported: Array<{ alias: string }> }>(
      await call('gmail_inbox_import', { dir, dryRun: true }),
    );
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.imported.map((candidate) => candidate.alias).sort(), ['home', 'work']);

    const asked = approvalAsked(await call('gmail_inbox_import', { dir }));
    assert.match(asked.preview, /Import 2 mailboxes from/);
    assert.match(asked.preview, /connects home \(sam@example\.test\) with organize access/);
    assert.match(asked.preview, /connects work \(jo@example\.test\) with organize access/);
    assert.match(asked.preview, /registers the OAuth client .* as "imported"/);
    const config = await harness.core.config.load();
    assert.deepEqual([config.inboxes, config.clients], [{}, {}], 'asking imported something');

    const done = applied<{ imported: Array<{ alias: string }> }>(
      await call('gmail_inbox_import', { dir, approvalId: asked.approvalId }),
    );
    assert.deepEqual(done.imported.map((candidate) => candidate.alias).sort(), ['home', 'work']);
    assert.deepEqual(Object.keys((await harness.core.config.load()).inboxes).sort(), ['home', 'work']);
  } finally {
    await close();
  }
});

test('a mailbox that appears after the import was approved is not imported on that approval', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  const dir = await legacyDirectory(harness, { work: 'sub-1' });
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const asked = approvalAsked(await call('gmail_inbox_import', { dir }));
    await writeFile(
      join(dir, 'creds-home.json'),
      JSON.stringify({ tokens: { refresh_token: await mintToken(harness, 'sub-2') }, scopes: [SCOPES.gmailModify] }),
    );
    // The claim measures the import again, finds a mailbox the preview did not name, and refuses.
    toolError(await call('gmail_inbox_import', { dir, approvalId: asked.approvalId }));
    assert.deepEqual((await harness.core.config.load()).inboxes, {});
  } finally {
    await close();
  }
});

test('the import itself connects only what was approved, under the names and addresses shown', async () => {
  // The last line of the same guard, for a file that appears between the claim and the import: the import is given
  // the list the claim approved, and anything else is skipped with its reason.
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@example.test' },
    ],
  });
  const dir = await legacyDirectory(harness, { work: 'sub-1', home: 'sub-2', spare: 'sub-2' });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const result = await importLegacy(context, {
    dir,
    approved: {
      registersClient: true,
      mailboxes: [
        { file: join(dir, 'creds-work.json'), alias: 'work', email: 'jo@example.test' },
        // The token in this file is sam's, not the address the preview showed.
        { file: join(dir, 'creds-home.json'), alias: 'home', email: 'someone-else@example.test' },
      ],
    },
  });
  assert.deepEqual(
    result.imported.map((candidate) => candidate.alias),
    ['work'],
  );
  const reasons = Object.fromEntries(result.skipped.map((candidate) => [candidate.alias, candidate.problem]));
  assert.match(reasons.home ?? '', /not the someone-else@example\.test that was approved/);
  assert.match(reasons.spare ?? '', /not in the import that was approved/);
  assert.deepEqual(Object.keys((await harness.core.config.load()).inboxes), ['work']);
});

test('an import approved to use a client that is there is refused when that client has gone', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const dir = await legacyDirectory(harness, { work: 'sub-1' });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  // Approved with no client registration in it, because the client was registered then; it is not now.
  await assert.rejects(
    importLegacy(context, {
      dir,
      approved: {
        registersClient: false,
        mailboxes: [{ file: join(dir, 'creds-work.json'), alias: 'work', email: 'jo@example.test' }],
      },
    }),
    /the OAuth client this import was approved to use is no longer registered/,
  );
  const config = await harness.core.config.load();
  assert.deepEqual([config.inboxes, config.clients], [{}, {}]);
});

test('inbox import at the CLI asks the same way, and --dry-run asks nobody', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const dir = await legacyDirectory(harness, { work: 'sub-1' });
  const dry = await cli(harness, ['inbox', 'import', '--dir', dir, '--dry-run', '--json'], { env: CLAUDE });
  assert.equal(dry.code, 0, dry.stdout);
  const asked = await cli(harness, ['inbox', 'import', '--dir', dir, '--json'], { env: CLAUDE });
  pendingApproval(asked);
  assert.match(String(asked.envelope().error?.details?.preview), /connects work \(jo@example\.test\)/);
  const done = await approving(harness, ['inbox', 'import', '--dir', dir]);
  assert.equal(done.code, 0, done.stdout);
  assert.deepEqual(Object.keys((await harness.core.config.load()).inboxes), ['work']);
});

// ── confirm-clients add ─────────────────────────────────────────────────────────────────────────────────────

test('trusting a client needs its probe first and a change approval second, from either surface', async () => {
  const harness = await newHarness();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    // No probe: refused before anybody is asked, in the same words on both surfaces.
    const byTool = toolError(await call('gmail_confirm_client_add', { name: 'desk-client' }));
    const byCommand = (await cli(harness, ['confirm-clients', 'add', 'desk-client', '--json'])).envelope().error;
    assert.equal(byTool.code, 'APPROVAL_REQUIRED');
    assert.equal(byTool.message, byCommand?.message);
    assert.deepEqual(await harness.core.approvals.list(), []);

    await completeProbe(context, (await startProbe(context, 'desk-client')).probeId);
    const asked = approvalAsked(await call('gmail_confirm_client_add', { name: 'desk-client' }));
    assert.match(asked.preview, /clients trusted to ask for a send approval: none → desk-client/);
    assert.deepEqual((await harness.core.config.load()).defaults.confirm.elicitationClients, []);

    assert.deepEqual(
      applied(await call('gmail_confirm_client_add', { name: 'desk-client', approvalId: asked.approvalId })),
      ['desk-client'],
    );
    // Already trusted: nothing loosens, so nothing is asked.
    assert.deepEqual(applied(await call('gmail_confirm_client_add', { name: 'desk-client' })), ['desk-client']);

    // And at the CLI, for a second client, the same two steps.
    await completeProbe(context, (await startProbe(context, 'term-client')).probeId);
    const added = await approving(harness, ['confirm-clients', 'add', 'term-client']);
    assert.equal(added.code, 0, added.stdout);
    assert.deepEqual(added.envelope().data, ['desk-client', 'term-client']);
  } finally {
    await close();
  }
});

// ── The CLI, as a whole ─────────────────────────────────────────────────────────────────────────────────────

test('every changing command stops for approval when an agent runs it, and changes nothing', async () => {
  /*
   * One table, so a command that forgot to go through the change flow is caught here rather than trusted: each is run
   * as an agent would run it, must exit 10 with an approval id, and must leave the configuration exactly as it was.
   */
  const harness = await mailbox({ tier: 'read' });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  applied(
    await (async () => {
      const { call, close } = await connect({ core: harness.core, env: harness.env });
      try {
        return await call('gmail_inbox_policy', { inbox: 'work', sendPolicy: 'never' });
      } finally {
        await close();
      }
    })(),
  );
  await clientAdd(context, { path: await clientJson(), name: 'spare', noProbe: true });
  await completeProbe(context, (await startProbe(context, 'desk-client')).probeId);
  const dir = await legacyDirectory(harness, { home: 'sub-2' });

  const commands = [
    ['inbox', 'policy', 'work', '--send', 'chat'],
    ['inbox', 'reauth', 'work', '--tier', 'organize', '--start'],
    ['inbox', 'remove', 'work'],
    ['inbox', 'import', '--dir', dir],
    ['client', 'add', await clientJson(), '--name', 'third'],
    ['client', 'remove', 'spare'],
    ['confirm-clients', 'add', 'desk-client'],
  ];
  const before = JSON.stringify(await harness.core.config.load());
  for (const argv of commands) {
    const asked = await cli(harness, [...argv, '--json'], { env: CLAUDE });
    pendingApproval(asked);
    assert.equal(JSON.stringify(await harness.core.config.load()), before, `${argv.join(' ')} changed something`);
  }
});

test('--no-input on a terminal asks nothing: the change waits for approval as it does for an agent', async () => {
  const harness = await mailbox();
  await cli(harness, ['inbox', 'policy', 'work', '--send', 'never', '--json']);
  // Enter is waiting on stdin, so a question asked by mistake is answered and fails here rather than hanging.
  const asked = await cli(harness, ['inbox', 'policy', 'work', '--send', 'chat', '--no-input'], {
    tty: true,
    stdin: '\n',
  });
  assert.equal(asked.code, 10, asked.stderr);
  assert.match(asked.stderr, /this change needs approval first/);
  assert.doesNotMatch(asked.stderr, /Type \S+ to/);
  assert.equal((await harness.core.config.load()).inboxes.work?.sendPolicy, 'never');
});
