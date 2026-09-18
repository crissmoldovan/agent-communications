import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '@cloudpixel/comms-core';
import { run } from '../src/cli/program.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  json: <T>() => T;
}

/** Runs the CLI in-process with captured streams, which is what a caller sees minus the process boundary. */
async function cli(
  harness: Harness,
  argv: string[],
  options: { tty?: boolean; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  err.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const input = new PassThrough();
  if (options.stdin !== undefined) input.end(options.stdin);
  const streams = {
    stdout: Object.assign(out, { isTTY: options.tty ?? false }),
    stderr: Object.assign(err, { isTTY: options.tty ?? false }),
    stdin: Object.assign(input, { isTTY: options.tty ?? false }),
  };
  const code = await run(argv, {
    core: harness.core,
    env: { ...harness.env, ...options.env },
    streams,
    listenerCommand: {
      command: process.execPath,
      args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI_ENTRY],
    },
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

/** An ANSI colour sequence, built rather than written as a literal control character. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[`);

interface Envelope<T> {
  ok: boolean;
  schemaVersion: number;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

test('--json prints the versioned envelope, and human output goes to stdout without it', async () => {
  const harness = await newHarness();
  const json = await cli(harness, ['inbox', 'list', '--json']);
  assert.equal(json.code, 0);
  const envelope = json.json<Envelope<unknown[]>>();
  assert.equal(envelope.ok, true);
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(envelope.data, []);
  assert.equal(json.stderr, '');

  const human = await cli(harness, ['inbox', 'list']);
  assert.match(human.stdout, /No mailbox connected yet/);
  assert.doesNotMatch(human.stdout, /^\{/);
});

test('failures carry the documented code and exit status, in the envelope and on stderr', async () => {
  const harness = await newHarness();
  const missing = await cli(harness, ['inbox', 'show', 'nope', '--json']);
  assert.equal(missing.code, EXIT_CODES.NOT_FOUND);
  const envelope = missing.json<Envelope<never>>();
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, 'NOT_FOUND');

  const human = await cli(harness, ['inbox', 'show', 'nope']);
  assert.equal(human.code, 66);
  assert.match(human.stderr, /error: no inbox called "nope"/);
  assert.equal(human.stdout, '');

  const usage = await cli(harness, ['nonsense', '--json']);
  assert.equal(usage.code, EXIT_CODES.USAGE);
  assert.equal(usage.json<Envelope<never>>().error?.code, 'USAGE');
});

test('--version and --help print and exit 0', async () => {
  const harness = await newHarness();
  const version = await cli(harness, ['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  const help = await cli(harness, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Exit codes: 0 ok/);
});

test('colour is off unless a terminal asked for it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const plain = await cli(harness, ['inbox', 'list'], { tty: true, env: { NO_COLOR: '1' } });
  assert.match(plain.stdout, /work/);
  assert.doesNotMatch(plain.stdout, COLOUR);
  const coloured = await cli(harness, ['inbox', 'list'], { tty: true, env: { NO_COLOR: '', FORCE_COLOR: '1' } });
  assert.match(coloured.stdout, COLOUR);
});

test('client add stores the secret out of sight and reports what it did', async () => {
  const harness = await newHarness();
  const path = join(tempDir(), 'client_secret_123.json');
  await writeFile(
    path,
    JSON.stringify({
      installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET, project_id: 'proj-1' },
    }),
  );
  const added = await cli(harness, ['client', 'add', path, '--store', 'file', '--json']);
  assert.equal(added.code, 0);
  const data = dataOf(added.json<Envelope<{ clientId: string; store: string; probed: boolean }>>());
  assert.equal(data.clientId, TEST_CLIENT_ID);
  assert.equal(data.store, 'file');
  assert.equal(data.probed, true, 'the credentials were checked with Google');
  assert.doesNotMatch(added.stdout, new RegExp(TEST_CLIENT_SECRET), 'the secret never appears in output');

  const config = JSON.parse(await readFile(join(harness.configDir, 'config.json'), 'utf8')) as {
    clients: Record<string, unknown>;
  };
  assert.doesNotMatch(JSON.stringify(config), new RegExp(TEST_CLIENT_SECRET), 'the secret never reaches config.json');

  // A second client under the same name is refused, with the way to rotate it.
  const again = await cli(harness, ['client', 'add', path, '--json']);
  assert.equal(again.code, 78);
  assert.match(again.json<Envelope<never>>().error?.hint ?? '', /--replace/);

  const listed = await cli(harness, ['client', 'list', '--json']);
  assert.equal(listed.json<Envelope<Array<{ name: string }>>>().data?.[0]?.name, 'default');
});

test('the two-step sign-in works end to end through the CLI', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const path = join(tempDir(), 'client_secret.json');
  await writeFile(
    path,
    JSON.stringify({ installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET } }),
  );
  await cli(harness, ['client', 'add', path, '--store', 'file', '--json']);

  const started = await cli(harness, ['inbox', 'add', 'work', '--start', '--email', 'jo@example.test', '--json']);
  assert.equal(started.code, 0);
  const flow = dataOf(started.json<Envelope<{ flowId: string; authUrl: string }>>());
  await fetch(harness.google.consent(flow.authUrl));

  const finished = await cli(harness, ['inbox', 'add', '--finish', flow.flowId, '--wait', '10', '--json']);
  assert.equal(finished.code, 0);
  assert.equal(finished.json<Envelope<{ inbox: { email: string } }>>().data?.inbox.email, 'jo@example.test');

  const listed = await cli(harness, ['inbox', 'list', '--json']);
  assert.equal(listed.json<Envelope<Array<{ alias: string }>>>().data?.[0]?.alias, 'work');

  const shown = await cli(harness, ['inbox', 'show', 'work']);
  assert.match(shown.stdout, /work — jo@example\.test/);
  assert.match(shown.stdout, /sending: {5}chat/);

  const renamed = await cli(harness, ['inbox', 'rename', 'work', 'main', '--json']);
  assert.equal(renamed.code, 0);
  const removed = await cli(harness, ['inbox', 'remove', 'main', '--json']);
  assert.equal(removed.code, 0);
  assert.deepEqual(await cli(harness, ['inbox', 'list', '--json']).then((r) => r.json<Envelope<unknown[]>>().data), []);
});

test('tightening how sending is approved is free; loosening it is refused for an agent', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });

  const tightened = await cli(harness, ['inbox', 'policy', 'work', '--send', 'never', '--json']);
  assert.equal(tightened.code, 0);
  assert.equal(tightened.json<Envelope<{ sendPolicy: string }>>().data?.sendPolicy, 'never');

  // An agent may not loosen it, whatever it passes.
  const agent = await cli(harness, ['inbox', 'policy', 'work', '--send', 'chat', '--json'], {
    env: { CLAUDECODE: '1' },
  });
  assert.equal(agent.code, 10);
  assert.equal(agent.json<Envelope<never>>().error?.code, 'LOOSENING_REFUSED');

  // And not without a terminal either.
  const headless = await cli(harness, ['inbox', 'policy', 'work', '--send', 'chat', '--json']);
  assert.equal(headless.code, 10);
  assert.match(headless.json<Envelope<never>>().error?.hint ?? '', /in a terminal/);

  const unchanged = await cli(harness, ['inbox', 'show', 'work', '--json']);
  assert.equal(unchanged.json<Envelope<{ sendPolicy: string }>>().data?.sendPolicy, 'never');
});

test('mcp install writes an entry that really starts the server', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const home = tempDir();

  const result = await cli(harness, ['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--json'], {
    env: { HOME: home },
  });
  assert.equal(result.code, 0);
  const data = dataOf(
    result.json<
      Envelope<{
        entry: { command: string; args: string[]; env: Record<string, string> };
        configPath: string;
        applied: boolean;
        verified: boolean;
        verifyDetail: string;
      }>
    >(),
  );

  assert.equal(data.applied, true);
  assert.equal(data.configPath, join(home, '.cursor', 'mcp.json'));
  // The entry must not rely on the client's PATH, which is minimal when it starts a server.
  assert.ok(data.entry.command.includes('/'), 'an absolute interpreter path');
  assert.equal(data.entry.env.AGENT_COMMS_CONFIG_DIR, harness.configDir);
  assert.ok((data.entry.env.PATH ?? '').length > 0);
  assert.ok(data.entry.args.includes('mcp'));
  assert.equal(data.verified, true, data.verifyDetail);
  assert.match(data.verifyDetail, /offered \d+ tools/);

  const written = JSON.parse(await readFile(data.configPath, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.ok(written.mcpServers.gmail);
});

test('mcp install warns when another Gmail server is registered with that client', async () => {
  const harness = await newHarness();
  const home = tempDir();
  await writeFile(join(home, '.cursor-config-placeholder'), '');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { old: { command: 'npx', args: ['-y', '@artymclabin/gmail-mcp'] } } }),
  );

  const result = await cli(
    harness,
    ['mcp', 'install', '--client', 'cursor', '--launcher', 'local', '--no-verify', '--json'],
    { env: { HOME: home } },
  );
  const data = dataOf(result.json<Envelope<{ warnings: string[] }>>());
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0] ?? '', /@artymclabin\/gmail-mcp/);
  assert.match(data.warnings[0] ?? '', /no approval step gates/);

  // The existing entry is kept: installing ours must not quietly remove someone else's server.
  const written = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(written.mcpServers).sort(), ['gmail', 'old']);
});

test('mcp install --print changes nothing and shows the snippet', async () => {
  const harness = await newHarness();
  const home = tempDir();
  const result = await cli(
    harness,
    ['mcp', 'install', '--client', 'claude-desktop', '--launcher', 'local', '--no-verify', '--print'],
    { env: { HOME: home } },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /"mcpServers"/);
  await assert.rejects(readFile(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')));
});

/** The data of a successful envelope; a test that gets an error envelope should say so, not assert non-null. */
function dataOf<T>(envelope: Envelope<T>): T {
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(`expected a successful result, got ${JSON.stringify(envelope.error)}`);
  }
  return envelope.data;
}

test('drafting from the CLI writes to Drafts, shows a preview, and sends nothing', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });

  const written = await cli(harness, [
    'draft',
    'new',
    '--inbox',
    'work',
    '--to',
    'sam@partner.test',
    '--subject',
    'Tuesday',
    '--text',
    'Tuesday works for me.',
  ]);
  assert.equal(written.code, 0, `${written.stdout}${written.stderr}`);
  // The preview is what a person approves, so it must be on screen, fenced, and unmistakably not sent.
  assert.match(written.stdout, /MESSAGE PREVIEW/);
  assert.match(written.stdout, /```text/);
  assert.match(written.stdout, /Tuesday works for me\./);
  assert.match(written.stdout, /Nothing has been sent\./);

  const listed = await cli(harness, ['draft', 'list', '--inbox', 'work', '--json']);
  const drafts = dataOf(listed.json<Envelope<Array<{ draftId: string; subject: string }>>>());
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.subject, 'Tuesday');

  const deleted = await cli(harness, ['draft', 'delete', String(drafts[0]?.draftId), '--inbox', 'work']);
  assert.equal(deleted.code, 0);
  assert.deepEqual(
    dataOf((await cli(harness, ['draft', 'list', '--inbox', 'work', '--json'])).json<Envelope<unknown[]>>()),
    [],
  );
});

test('the body can be piped in, which is the only way prose survives a shell intact', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });

  const piped = await cli(
    harness,
    ['draft', 'new', '--inbox', 'work', '--to', 'sam@partner.test', '--subject', 'Notes', '--json'],
    { stdin: 'Line one.\n\nLine "two" — with punctuation.\n' },
  );
  assert.equal(piped.code, 0);
  assert.match(dataOf(piped.json<Envelope<{ preview: string }>>()).preview, /Line "two" — with punctuation\./);

  // On a terminal with nothing piped there is no body to read, and the error says where one comes from.
  const empty = await cli(harness, ['draft', 'new', '--inbox', 'work', '--to', 'sam@partner.test', '--json'], {
    tty: true,
  });
  assert.equal(empty.code, EXIT_CODES.USAGE);
  assert.match(empty.json<Envelope<never>>().error?.hint ?? '', /--text|--file|standard input/);
});

test('organising previews before it acts, and says how to put it back', async () => {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: {
          m1: {
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX', 'UNREAD'],
            internalDate: String(Date.parse('2026-09-17T09:00:00Z')),
            payload: {
              partId: '',
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'sam@partner.test' },
                { name: 'Subject', value: 'Invoice' },
              ],
              body: { size: 2, data: Buffer.from('hi', 'utf8').toString('base64url') },
            },
          },
        },
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'UNREAD', name: 'UNREAD', type: 'system' },
        ],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });

  const planned = await cli(harness, ['organise', '--inbox', 'work', '--message', 'm1', '--archive', '--dry-run']);
  assert.equal(planned.code, 0);
  assert.match(planned.stdout, /Would change 1 message/);
  assert.match(planned.stdout, /Nothing was changed\./);
  assert.deepEqual(harness.google.accounts.get('sub-1')?.messages?.m1?.labelIds, ['INBOX', 'UNREAD']);

  const done = await cli(harness, ['organise', '--inbox', 'work', '--message', 'm1', '--archive', '--read']);
  assert.match(done.stdout, /Changed 1 message/);
  assert.match(done.stdout, /To put it back: agent-gmail organise/);
  assert.deepEqual(harness.google.accounts.get('sub-1')?.messages?.m1?.labelIds, []);

  // The American spelling reaches the same command, because half the world types it.
  const spelled = await cli(harness, ['organize', '--inbox', 'work', '--message', 'm1', '--star', '--json']);
  assert.equal(spelled.code, 0);

  const binned = await cli(harness, ['trash', '--inbox', 'work', '--message', 'm1']);
  assert.match(binned.stdout, /thirty days/);
  assert.ok(harness.google.accounts.get('sub-1')?.messages?.m1?.labelIds?.includes('TRASH'));
});

test('the CLI sends only what was prepared, and says so at every step', async () => {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo', isDefault: true, isPrimary: true }],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );

  const drafted = await cli(harness, [
    'draft',
    'new',
    '--inbox',
    'work',
    '--to',
    'sam@partner.test',
    '--subject',
    'Tuesday',
    '--text',
    'Tuesday works.',
    '--json',
  ]);
  const draftId = dataOf(drafted.json<Envelope<{ draftId: string }>>()).draftId;

  const prepared = await cli(harness, ['send', 'prepare', draftId, '--inbox', 'work']);
  assert.equal(prepared.code, 0, `${prepared.stdout}${prepared.stderr}`);
  assert.match(prepared.stdout, /SEND PREVIEW/);
  assert.match(prepared.stdout, /Show the preview to the user verbatim/);
  const approvalId = /\b(ap_[A-Za-z0-9]+)\b/.exec(prepared.stdout)?.[1] ?? '';
  assert.ok(approvalId, 'the preview names the approval to send with');

  // An agent that guesses the recipients gets nothing sent — and burns that approval: naming recipients the draft
  // does not have is not a typo to retry, it is a claim that did not hold, so the approval is voided.
  const wrong = await cli(harness, [
    'send',
    'execute',
    draftId,
    '--inbox',
    'work',
    '--approval',
    approvalId,
    '--expect-to',
    'someone@else.test',
    '--expect-subject',
    'Tuesday',
    '--json',
  ]);
  assert.equal(wrong.code, EXIT_CODES.APPROVAL);
  assert.equal(wrong.json<Envelope<never>>().error?.code, 'APPROVAL_VOID');
  const reused = await cli(harness, [
    'send',
    'execute',
    draftId,
    '--inbox',
    'work',
    '--approval',
    approvalId,
    '--expect-to',
    'sam@partner.test',
    '--expect-subject',
    'Tuesday',
    '--json',
  ]);
  assert.equal(reused.code, EXIT_CODES.APPROVAL, 'the voided approval is not usable afterwards');

  // So the user is shown the message again, and approves it again.
  const again = await cli(harness, ['send', 'prepare', draftId, '--inbox', 'work']);
  const secondApproval = /\b(ap_[A-Za-z0-9]+)\b/.exec(again.stdout)?.[1] ?? '';
  assert.ok(secondApproval && secondApproval !== approvalId);

  const sent = await cli(harness, [
    'send',
    'execute',
    draftId,
    '--inbox',
    'work',
    '--approval',
    secondApproval,
    '--expect-to',
    'sam@partner.test',
    '--expect-cc',
    'none',
    '--expect-bcc',
    'none',
    '--expect-subject',
    'Tuesday',
  ]);
  assert.equal(sent.code, 0, `${sent.stdout}${sent.stderr}`);
  assert.match(sent.stdout, /Sent to sam@partner\.test/);
  assert.match(sent.stdout, /Read back from the mailbox/);
});

test('approving a send refuses an agent, and refuses a pipe', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });

  // The marker check runs before anything else: an agent is told to hand this to a person, whatever the id.
  const agent = await cli(harness, ['approve', 'ap_whatever', '--json'], { env: { CLAUDECODE: '1' } });
  assert.equal(agent.code, EXIT_CODES.APPROVAL);
  assert.match(agent.json<Envelope<never>>().error?.hint ?? '', /their own terminal/);

  // And without a terminal there is nobody to ask.
  const piped = await cli(harness, ['approve', 'ap_whatever', '--json']);
  assert.equal(piped.code, EXIT_CODES.APPROVAL);
  assert.match(piped.json<Envelope<never>>().error?.message ?? '', /interactive terminal/);
});
