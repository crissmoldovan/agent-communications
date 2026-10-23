import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { gatedChange, openCore, serverInstallChange } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { registryOf, testReleaseVerifier } from '../../core/test/helpers/provenance-fixture.ts';
import { createWhatsAppMcpServer } from '../src/mcp/server.ts';
import { VERSION } from '../src/version.ts';
import { ALICE, buildFixtureStore } from './support/fixture.ts';
import { assertNoBareCommand } from './support/handoffs.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Registering the server — `agent-whatsapp mcp install`, which is core's `serverInstallChange`, the change
 * `comms_server_install {channel: "whatsapp"}` makes — with the account pin, and the server keeping to it.
 *
 * Nothing here installs from npm or starts a client: `--launcher npx --no-verify` writes an entry and starts nothing,
 * and the client is Cursor, whose configuration is a file under the temporary home.
 */

const ACCOUNT = 'acme/whatsapp';
const OTHER = 'other/whatsapp';

const cursorEntry = (harness: Harness) =>
  JSON.parse(readFileSync(join(harness.home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.whatsapp as {
    command: string;
    args: string[];
  };

function setChangePolicy(harness: Harness, policy: 'chat' | 'confirm'): void {
  const config = harness.coreConfig();
  const defaults = (config.defaults ?? {}) as Record<string, unknown>;
  writeFileSync(
    join(harness.configDir, 'config.json'),
    `${JSON.stringify({ ...config, defaults: { ...defaults, changePolicy: policy } }, null, 2)}\n`,
  );
}

/** The four folder pins a registration is written with (CUE-403), in the order the installer writes them. */
function pinWords(paths: { configDir: string; stateDir: string; dataDir: string; secretsDir: string }): string[] {
  const { configDir, stateDir, dataDir, secretsDir } = paths;
  return ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir];
}

test('mcp install --account prints an entry that starts this release’s server pinned to the account', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const printed = await harness.cli([
    'mcp',
    'install',
    '--client',
    'json',
    '--launcher',
    'npx',
    '--print',
    '--no-verify',
    '--account',
    ACCOUNT,
    '--json',
  ]);
  assert.equal(printed.code, 0, printed.stdout);
  const data = printed.data() as { applied: boolean; entry: { args: string[] } };
  assert.equal(data.applied, false, '--print writes nothing');
  assert.deepEqual(data.entry.args, [
    '-y',
    `@agentcomms/whatsapp@${VERSION}`,
    ...pinWords(openCore({ env: harness.env }).paths),
    'mcp',
    '--account',
    ACCOUNT,
  ]);

  // `mcp --account` before `install` is the same pin: Commander hands a repeated option to the parent.
  const parent = await harness.cli([
    'mcp',
    '--account',
    ACCOUNT,
    'install',
    '--client',
    'json',
    '--launcher',
    'npx',
    '--print',
    '--no-verify',
    '--json',
  ]);
  assert.deepEqual((parent.data().entry as { args: string[] }).args.slice(-2), ['--account', ACCOUNT]);
});

test('registering is a change a person approves; the approval is claimed with --approval, and the entry keeps the pin', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  await harness.ready(ACCOUNT);
  const argv = ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify', '--account', ACCOUNT];
  const asked = await harness.cli([...argv, '--json']);
  assert.equal(asked.code, 10, asked.stdout);
  const error = asked.json().error as { code: string; details: { approvalId: string; preview: string } };
  assert.equal(error.code, 'APPROVAL_PENDING');
  assert.match(
    error.details.preview,
    /registers the WhatsApp MCP server with cursor as "whatsapp", pinned to the account acme\/whatsapp/,
  );
  assert.ok(!existsSync(join(harness.home, '.cursor', 'mcp.json')), 'nothing is written before the approval');

  const applied = await harness.cli([...argv, '--approval', error.details.approvalId, '--json']);
  assert.equal(applied.code, 0, applied.stdout);
  assert.equal(applied.data().applied, true);
  assert.deepEqual(cursorEntry(harness).args.slice(-3), ['mcp', '--account', ACCOUNT]);
});

test('an approval comms_server_install prepared is claimed by WhatsApp’s mcp install: one change on two surfaces', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  await harness.ready(ACCOUNT);
  const core = openCore({ env: harness.env });
  /*
   * What the core server's comms_server_install runs for `{ channel: "whatsapp", account }`: with a verifier, as core's
   * server has one, so the release the npx entry's client fetches is verified before anybody is asked (design
   * 2026-10-22 P5) — here the test's own verifier, and a registry naming this release, under which it verifies.
   */
  const request = {
    channel: 'whatsapp',
    client: 'cursor',
    account: ACCOUNT,
    launcher: 'npx',
    noVerify: true,
  } as const;
  const verifier = testReleaseVerifier();
  const verifiedReleases: string[] = [];
  const verification = {
    registry: registryOf(() => VERSION),
    verifyRelease: (release: Parameters<typeof verifier>[0]) => {
      verifiedReleases.push(`${release.packageName}@${release.version}`);
      return verifier(release);
    },
  };
  const asked = await gatedChange(core, serverInstallChange(core, harness.env, request, undefined, verification), {
    channel: 'whatsapp',
    surface: 'mcp',
  });
  assert.equal(asked.status, 'approval-required');
  assert.deepEqual(verifiedReleases, [`@agentcomms/whatsapp@${VERSION}`], 'verified before anybody was asked');
  const approvalId = asked.status === 'approval-required' ? asked.prepared.approvalId : '';
  const claimed = await harness.cli([
    'mcp',
    'install',
    '--client',
    'cursor',
    '--launcher',
    'npx',
    '--no-verify',
    '--account',
    ACCOUNT,
    '--approval',
    approvalId,
    '--json',
  ]);
  assert.equal(claimed.code, 0, claimed.stdout);
  assert.deepEqual(cursorEntry(harness).args.slice(-2), ['--account', ACCOUNT]);
});

test('a pin to an account that is not there, or is not WhatsApp’s, is refused before anybody is asked', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const install = (account: string) =>
    harness.cli(['mcp', 'install', '--client', 'json', '--print', '--no-verify', '--account', account, '--json']);
  const missing = await install('nobody/whatsapp');
  assert.equal(missing.code, 66, missing.stdout);
  const config = harness.coreConfig();
  writeFileSync(
    join(harness.configDir, 'config.json'),
    `${JSON.stringify({
      ...config,
      accounts: {
        ...config.accounts,
        'acme/slack': {
          id: 'acc_SLACK00000000000',
          platform: 'slack',
          workspace: 'T1',
          userId: 'U1',
          tier: 'read',
          mode: 'read',
          grantedScopes: [],
          secretRef: 'slack:token:acc_SLACK00000000000',
          createdAt: '2026-09-26T00:00:00.000Z',
        },
      },
    })}\n`,
  );
  const slack = await install('acme/slack');
  assert.equal(slack.code, 64, slack.stdout);
  assert.match(String(slack.json().error?.message), /"acme\/slack" is not a WhatsApp account/);
  // And the server itself refuses to start for a pin that names nothing.
  const serve = await harness.cli(['mcp', '--account', 'nobody/whatsapp']);
  assert.equal(serve.code, 66);
  assert.match(serve.stderr, /no WhatsApp account called "nobody\/whatsapp"/);
});

test('under confirm, only a person approves — WhatsApp’s own approve, at a terminal — and then the install applies', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  await harness.ready(ACCOUNT);
  setChangePolicy(harness, 'confirm');
  const argv = ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify', '--account', ACCOUNT];
  const asked = await harness.cli([...argv, '--json']);
  const error = asked.json().error as { details: { approvalId: string; policy: string } };
  assert.equal(error.details.policy, 'confirm');
  const { approvalId } = error.details;

  const byAgent = await harness.cli(['approve', approvalId, '--json']);
  assert.equal(byAgent.code, 10);
  assert.match(String(byAgent.json().error?.message), /only a person can approve a change, not an agent/);
  const noTerminal = await harness.cli(['approve', approvalId, '--json'], { env: harness.personEnv });
  assert.equal(noTerminal.code, 10);
  assert.match(String(noTerminal.json().error?.message), /needs an interactive terminal/);
  const tooEarly = await harness.cli([...argv, '--approval', approvalId, '--json']);
  assert.notEqual(tooEarly.code, 0, 'claiming before the person approved is refused');

  // The person, at a terminal: reads the change, types the code back.
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let shown = '';
  stdout.on('data', (chunk) => {
    shown += String(chunk);
  });
  stderr.on('data', (chunk) => {
    const code = /Type (\S+) to approve this change/.exec(String(chunk))?.[1];
    if (code) stdin.write(`${code}\n`);
  });
  const approved = await harness.cli(['approve', approvalId], {
    env: harness.personEnv,
    streams: { stdin, stdout, stderr } as never,
  });
  assert.equal(approved.code, 0, shown);
  assert.match(
    shown,
    /registers the WhatsApp MCP server with cursor as "whatsapp", pinned to the account acme\/whatsapp/,
  );
  assert.match(shown, /Approved\. This command approves; the change is applied by the command that prepared it\./);
  assert.ok(!existsSync(join(harness.home, '.cursor', 'mcp.json')), 'approving applies nothing');

  const applied = await harness.cli([...argv, '--approval', approvalId, '--json']);
  assert.equal(applied.code, 0, applied.stdout);
  assert.deepEqual(cursorEntry(harness).args.slice(-2), ['--account', ACCOUNT]);
});

test('mcp prune --dry-run removes nothing and asks nobody', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  const dry = await harness.cli(['mcp', 'prune', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.equal((dry.data() as { dryRun: boolean }).dryRun, true);
});

// ── The pinned server ─────────────────────────────────────────────────────────────────────────────────────────

async function twoAccounts(): Promise<Harness> {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const elsewhere = join(harness.home, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  await buildFixtureStore(elsewhere);
  const added = await harness.cli(['add', OTHER, '--source', join(elsewhere, 'ChatStorage.sqlite'), '--json']);
  assert.equal(added.code, 0, added.stdout);
  assert.equal((await harness.cli(['sync', '--account', OTHER])).code, 0);
  return harness;
}

async function pinnedServer(harness: Harness, account: string) {
  const { server } = await createWhatsAppMcpServer({ env: harness.env, account });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent: Record<string, unknown> & { error?: { code: string; message: string } };
    };
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

test('a pinned server acts on its account without being told, refuses any other, and says nothing of the rest', async () => {
  const harness = await twoAccounts();
  const { client, call, close } = await pinnedServer(harness, ACCOUNT);
  try {
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /pinned to acme\/whatsapp/);
    assert.doesNotMatch(instructions, /other\/whatsapp/, 'the greeting names no other account');

    const chats = await call('whatsapp_chats', {});
    assert.ok(!chats.isError, JSON.stringify(chats.structuredContent));
    assert.equal(chats.structuredContent.account, ACCOUNT);
    assert.ok(!(await call('whatsapp_read', { chat: ALICE })).isError);
    assert.ok(!(await call('whatsapp_search', { query: 'invoice' })).isError);
    assert.ok(!(await call('whatsapp_sync', {})).isError);

    const other = await call('whatsapp_chats', { account: OTHER });
    assert.equal(other.isError, true);
    assert.equal(other.structuredContent.error?.code, 'USAGE');
    assert.match(
      String(other.structuredContent.error?.message),
      /pinned to "acme\/whatsapp" and cannot act on "other\/whatsapp"/,
    );
    for (const tool of ['whatsapp_read', 'whatsapp_search', 'whatsapp_sync', 'whatsapp_status', 'whatsapp_draft']) {
      const args: Record<string, unknown> = { account: OTHER, chat: ALICE, query: 'x', to: ALICE, text: 'hi' };
      const allowed = (await client.listTools()).tools.find((t) => t.name === tool)?.inputSchema.properties ?? {};
      const refused = await call(tool, Object.fromEntries(Object.entries(args).filter(([key]) => key in allowed)));
      assert.equal(refused.isError, true, `${tool} refuses another account`);
    }

    const status = await call('whatsapp_status', { check: false });
    assert.deepEqual(
      (status.structuredContent.accounts as { account: string }[]).map((entry) => entry.account),
      [ACCOUNT],
      'status says nothing of the other account',
    );
  } finally {
    await close();
  }
  // Unpinned, the same server names both and needs to be told which.
  const { client: open, close: closeOpen } = await (async () => {
    const { server } = await createWhatsAppMcpServer({ env: harness.env });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'test', version: '0' });
    await Promise.all([c.connect(a), server.connect(b)]);
    return { client: c, close: () => Promise.all([c.close(), server.close()]) };
  })();
  try {
    assert.match(open.getInstructions() ?? '', /Known accounts: acme\/whatsapp, other\/whatsapp\./);
    const unnamed = (await open.callTool({ name: 'whatsapp_chats', arguments: {} })) as { isError?: boolean };
    assert.equal(unnamed.isError, true, 'no default account on an unpinned server');
  } finally {
    await closeOpen();
  }
});

test('a pin follows its account through a rename, and a former name is answered with the current one', async () => {
  const harness = await newHarness();
  await harness.ready('acme/whatsapp-old');
  const { call, close } = await pinnedServer(harness, 'acme/whatsapp-old');
  try {
    // A rename as core makes one: the record under its new name, and the old name kept as a former name.
    const config = harness.coreConfig();
    const record = config.accounts['acme/whatsapp-old'];
    writeFileSync(
      join(harness.configDir, 'config.json'),
      `${JSON.stringify({
        ...config,
        accounts: { [ACCOUNT]: record },
        formerNames: { inboxes: {}, accounts: { 'acme/whatsapp-old': { name: ACCOUNT, id: record?.id } } },
      })}\n`,
    );
    const chats = await call('whatsapp_chats', {});
    assert.ok(!chats.isError, JSON.stringify(chats.structuredContent));
    assert.equal(chats.structuredContent.account, ACCOUNT, 'the pinned server serves the account under its new name');
  } finally {
    await close();
  }
  const byOldName = await harness.cli(['chats', '--account', 'acme/whatsapp-old', '--json']);
  assert.equal(byOldName.code, 66);
  assert.match(String(byOldName.json().error?.message), /"acme\/whatsapp-old" was renamed to "acme\/whatsapp"/);
  const reuse = await harness.cli(['add', 'acme/whatsapp-old', '--json']);
  assert.notEqual(reuse.code, 0, 'a former name is never reused');
  assert.match(String(reuse.json().error?.message), /was the name of another account and cannot be used again/);
});

test('another kind’s approval given to `approve` is D2’s one NOT_FOUND, byte for byte an unknown id’s', async () => {
  const harness = await newHarness({ store: false });
  const core = openCore({ env: harness.personEnv });
  const asPerson = async (approvalId: string) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = new PassThrough();
    let said = '';
    for (const stream of [stdout, stderr]) {
      stream.on('data', (chunk) => {
        said += String(chunk);
      });
    }
    const { code } = await harness.cli(['approve', approvalId], {
      env: harness.personEnv,
      streams: { stdin, stdout, stderr } as never,
    });
    return { code, said };
  };
  // A send approval as a sending channel's prepare writes one, and a download's question as Gmail's asks one.
  const send = await core.approvals.create({
    channel: 'resend',
    inboxId: 'acc_RRRRRRRRRRRRRRRR',
    inboxSub: 'key_12345678',
    draftId: 'rsd_x',
    draftMessageId: 'd',
    contentDigest: 'd'.repeat(64),
    sendEpoch: 0,
    policy: 'confirm',
    requiredPolicy: 'confirm',
    riskFlags: [],
    expect: { to: ['a@b.test'], cc: [], bcc: [], subject: 'x' },
  } as never);
  const question = await core.approvals.createDownload({
    channel: 'gmail',
    policy: 'confirm',
    download: {
      summary: '1 file from jo@partner.test',
      target: { kind: 'inbox', name: 'acme/gmail', id: 'ibx_AAAAAAAAAAAAAAAA' },
      operation: 'gmail.attachments.download',
      request: { messageId: 'm-1' },
      files: ['a.pdf'],
      names: ['a.pdf'],
      folders: { downloads: harness.personEnv.HOME ?? '', current: harness.personEnv.HOME ?? '' },
    },
  });
  const unknownId = `ap_${'0'.repeat(25)}N`;
  const unknown = await asPerson(unknownId);
  assert.equal(unknown.code, 66, unknown.said);
  for (const [what, approvalId] of [
    ['a send', send.approvalId],
    ['a download’s question', question.approvalId],
  ] as const) {
    const file = join(core.paths.stateDir, 'approvals', `${approvalId}.json`);
    const before = readFileSync(file, 'utf8');
    const refused = await asPerson(approvalId);
    assert.equal(refused.code, 66, `${what}: ${refused.said}`);
    // The words an id nobody prepared gets, and nothing of the record in them: its kind, its channel, the commands
    // that could approve it — none of that is this command's to say.
    assert.equal(refused.said, unknown.said.replaceAll(unknownId, approvalId), what);
    assert.doesNotMatch(refused.said, /send|download|resend|gmail/i, what);
    assert.equal(readFileSync(file, 'utf8'), before, `${what}: untouched`);
  }
  assertNoBareCommand(unknown.said);
});
