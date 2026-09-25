import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type GatedChange, gatedChange, gatedChangeAtTerminal } from '../src/change-flow.ts';
import type { Streams } from '../src/cli-runtime.ts';
import type { AccountConfig, SendPolicy } from '../src/config.ts';
import { openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { tempDir } from './helpers/temp.ts';

const ACME = 'acc_AAAAAAAAAAAAAAAA';

function account(over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: ACME,
    platform: 'slack',
    workspace: 'T_ACME',
    userId: 'U_AAAA',
    tier: 'read',
    mode: 'read',
    grantedScopes: [],
    secretRef: `slack/token/${ACME}`,
    createdAt: '2026-09-20T00:00:00.000Z',
    ...over,
  };
}

/** A config on disk with one account, written directly: the fixture's own settings need no consent. */
function coreWith(sendPolicy: SendPolicy, changePolicy?: 'chat' | 'confirm') {
  const dir = tempDir();
  const body = {
    version: 2,
    ...(changePolicy ? { defaults: { changePolicy } } : {}),
    accounts: { 'acme/slack': account({ sendPolicy }) },
  };
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(body, null, 2)}\n`);
  return openCore({ env: { AGENT_COMMS_CONFIG_DIR: dir, HOME: dir } });
}

/** Moves acme/slack's send policy to `to`, through the store, with whatever consent the flow hands over. */
function setSendPolicy(core: ReturnType<typeof openCore>, to: SendPolicy): GatedChange<SendPolicy> {
  return {
    plan: (config) => {
      const after = structuredClone(config);
      (after.accounts['acme/slack'] as AccountConfig).sendPolicy = to;
      return { account: 'acme/slack', before: config, after, summary: `acme/slack posts under ${to}` };
    },
    apply: async (consent) => {
      const written = await core.config.update(
        (config) => {
          (config.accounts['acme/slack'] as AccountConfig).sendPolicy = to;
          return config;
        },
        consent ? { consent } : {},
      );
      return (written.accounts['acme/slack'] as AccountConfig).sendPolicy as SendPolicy;
    },
  };
}

const policyNow = async (core: ReturnType<typeof openCore>) =>
  ((await core.config.load()).accounts['acme/slack'] as AccountConfig).sendPolicy;

test('a change that loosens nothing is applied at once, with no approval made', async () => {
  const core = coreWith('chat');
  const outcome = await gatedChange(core, setSendPolicy(core, 'never'), { surface: 'mcp' });
  assert.deepEqual(outcome, { status: 'applied', result: 'never' });
  assert.equal(await policyNow(core), 'never');
  assert.deepEqual(await core.approvals.list(), [], 'tightening asked nobody');
});

test('a loosening is prepared the first time and applied once on the second, with its approval', async () => {
  const core = coreWith('never');
  const change = setSendPolicy(core, 'chat');

  const first = await gatedChange(core, change, { surface: 'mcp' });
  assert.equal(first.status, 'approval-required');
  if (first.status !== 'approval-required') return;
  assert.match(first.prepared.preview, /send policy: never → chat/);
  assert.equal(await policyNow(core), 'never', 'preparing changed nothing');

  const second = await gatedChange(core, change, { surface: 'mcp', approvalId: first.prepared.approvalId });
  assert.deepEqual(second, { status: 'applied', result: 'chat' });
  assert.equal(await policyNow(core), 'chat');

  // Single use. Replayed as is, the change now loosens nothing and needs no approval, so it is replayed with an effect
  // — something that always needs one — and the spent approval must not carry it.
  const withEffect: GatedChange<SendPolicy> = {
    ...change,
    plan: async (config) => ({ ...(await change.plan(config)), effects: ['signs in to Slack again'] }),
  };
  await assert.rejects(
    gatedChange(core, withEffect, { surface: 'mcp', approvalId: first.prepared.approvalId }),
    (error: unknown) => error instanceof CommsError,
  );
});

test('a change that is no longer what was approved is refused, and nothing is written', async () => {
  const core = coreWith('never');
  const first = await gatedChange(core, setSendPolicy(core, 'chat'), { surface: 'mcp' });
  assert.equal(first.status, 'approval-required');
  if (first.status !== 'approval-required') return;
  // The same approval, claimed for a looser change than the one shown.
  const looser: GatedChange<SendPolicy> = {
    ...setSendPolicy(core, 'chat'),
    plan: async (config) => {
      const request = await setSendPolicy(core, 'chat').plan(config);
      return { ...request, effects: ['also removes every other workspace'] };
    },
  };
  await assert.rejects(gatedChange(core, looser, { surface: 'mcp', approvalId: first.prepared.approvalId }));
  assert.equal(await policyNow(core), 'never');
});

/** A terminal whose person answers the yes/no question with `answer`. */
function terminal(answer: string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let shown = '';
  stdout.on('data', (chunk) => {
    shown += String(chunk);
  });
  stderr.on('data', (chunk) => {
    if (/to apply this change/.test(String(chunk))) stdin.write(`${answer}\n`);
  });
  return { streams: { stdin, stdout, stderr } as unknown as Streams, shown: () => shown };
}

test('at the CLI an agent gets the preview and the approval id, and exits 10; --approval then applies it', async () => {
  const core = coreWith('never');
  const change = setSendPolicy(core, 'chat');
  const options = {
    env: { CLAUDECODE: '1' },
    output: { color: false },
    command: 'agent-slack workspace policy acme/slack',
  };

  let approvalId = '';
  await assert.rejects(gatedChangeAtTerminal(core, change, options), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'APPROVAL_PENDING');
    assert.equal(error.exitCode, 10);
    approvalId = String((error.details as { approvalId?: string }).approvalId);
    assert.match(error.hint ?? '', new RegExp(`--approval ${approvalId}`));
    return true;
  });
  assert.equal(await policyNow(core), 'never');

  // Without --json the agent still gets the preview it has to show: printed, not only inside the error's details.
  const plain = terminal('yes');
  await assert.rejects(
    gatedChangeAtTerminal(core, change, {
      ...options,
      streams: { ...plain.streams, stdin: new PassThrough() } as unknown as Streams,
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_PENDING',
  );
  assert.match(plain.shown(), /send policy: never → chat/);

  // An agent is refused even where a terminal is attached: the approval is the person's, and a terminal is not one.
  await assert.rejects(
    gatedChangeAtTerminal(core, change, { ...options, streams: terminal('yes').streams }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_PENDING',
  );
  assert.equal(await policyNow(core), 'never', 'the agent did not answer its own question');

  assert.equal(await gatedChangeAtTerminal(core, change, { ...options, approvalId }), 'chat');
});

test('at the CLI a person at a terminal approves there: yes applies, anything else cancels and revokes', async () => {
  const yes = coreWith('never');
  const person = terminal('yes');
  const applied = await gatedChangeAtTerminal(yes, setSendPolicy(yes, 'chat'), {
    env: {},
    output: { color: false },
    command: 'agent-slack workspace policy acme/slack',
    streams: person.streams,
  });
  assert.equal(applied, 'chat');
  assert.match(person.shown(), /send policy: never → chat/, 'the person saw what they agreed to');

  const no = coreWith('never');
  await assert.rejects(
    gatedChangeAtTerminal(no, setSendPolicy(no, 'chat'), {
      env: {},
      output: { color: false },
      command: 'agent-slack workspace policy acme/slack',
      streams: terminal('no').streams,
    }),
    /cancelled: nothing was changed/,
  );
  assert.equal(await policyNow(no), 'never');
  const [record] = await no.approvals.list();
  assert.equal(record?.state, 'revoked', 'a cancelled approval cannot be claimed later');
});

test('importing core never starts the agentcomms CLI, whatever the running program is called', async () => {
  /*
   * core's cli.ts runs `main()` when the running script's name ends in `cli.mjs` — which is also the name of every
   * product's CLI. A library module importing it would start `agentcomms` inside `agent-slack`. So nothing the index
   * reaches may import cli.ts; this runs a program called cli.mjs that imports the index and prints one line.
   */
  const dir = tempDir();
  const index = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const script = join(dir, 'cli.mjs');
  writeFileSync(script, `await import(${JSON.stringify(index)});\nprocess.stdout.write('imported\\n');\n`);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script],
    { env: { ...process.env, AGENT_COMMS_CONFIG_DIR: dir, HOME: dir } },
  );
  assert.equal(stdout, 'imported\n', `something ran on import:\n${stdout}${stderr}`);
});
