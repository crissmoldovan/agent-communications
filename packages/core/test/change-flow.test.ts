import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { stateOf } from '../src/approval-stored.ts';
import { changeToolResult, type GatedChange, gatedChange, gatedChangeAtTerminal } from '../src/change-flow.ts';
import { inlineCommand, type Streams } from '../src/cli-runtime.ts';
import type { AccountConfig, SendPolicy } from '../src/config.ts';
import { openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER, isCommand } from '../src/handoffs.ts';
import { ensureSendEpochConfig } from '../src/send-epoch.ts';
import { coreHandoffs } from './helpers/handoffs.ts';
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
  return openCore({ env: { AGENT_COMMS_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir }, caller: CORE_CALLER });
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
      // A send-policy writer converts first, as every one does: the policy moves with its send epoch, on version 3.
      await ensureSendEpochConfig(core);
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
  const outcome = await gatedChange(core, setSendPolicy(core, 'never'), { channel: 'core', surface: 'mcp' });
  assert.deepEqual(outcome, { status: 'applied', result: 'never' });
  assert.deepEqual(changeToolResult(outcome), { applied: true, result: 'never' }, 'no approval, so none to say');
  assert.equal(await policyNow(core), 'never');
  assert.deepEqual(await core.approvals.list(), [], 'tightening asked nobody');
});

test('a loosening is prepared the first time and applied once on the second, with its approval', async () => {
  const core = coreWith('never');
  const change = setSendPolicy(core, 'chat');

  const first = await gatedChange(core, change, { channel: 'core', surface: 'mcp' });
  assert.equal(first.status, 'approval-required');
  if (first.status !== 'approval-required') return;
  assert.match(first.prepared.preview, /send policy: never → chat/);
  // From a chat, the yes is the person's in the chat.
  assert.match(first.prepared.preview, /^CHANGE PREVIEW · approval ap_\w+ · approved by a yes in the chat · /);
  assert.equal(await policyNow(core), 'never', 'preparing changed nothing');

  const second = await gatedChange(core, change, {
    channel: 'core',
    surface: 'mcp',
    approvalId: first.prepared.approvalId,
  });
  assert.equal(second.status, 'applied');
  if (second.status !== 'applied') return;
  assert.equal(second.result, 'chat');
  assert.equal(await policyNow(core), 'chat');
  // Where the approval it spent stands (design 2026-10-05 §D8): used, when, and never claimable again — and the tool's
  // result carries it, as every result that spends an approval does (CUE-404).
  assert.equal(second.approval?.id, first.prepared.approvalId);
  assert.equal(second.approval?.kind, 'change');
  assert.equal(second.approval?.state, 'used');
  assert.equal(second.approval?.claimable, false);
  assert.ok(second.approval?.usedAt, 'when it was used');
  const tool = changeToolResult(second);
  assert.deepEqual(tool, { applied: true, result: 'chat', approval: second.approval });

  // Single use. Replayed as is, the change now loosens nothing and needs no approval, so it is replayed with an effect
  // — something that always needs one — and the spent approval must not carry it.
  const withEffect: GatedChange<SendPolicy> = {
    ...change,
    plan: async (config) => ({ ...(await change.plan(config)), effects: ['signs in to Slack again'] }),
  };
  await assert.rejects(
    gatedChange(core, withEffect, { channel: 'core', surface: 'mcp', approvalId: first.prepared.approvalId }),
    (error: unknown) => error instanceof CommsError,
  );
});

test('a change that is no longer what was approved is refused, and nothing is written', async () => {
  const core = coreWith('never');
  const first = await gatedChange(core, setSendPolicy(core, 'chat'), { channel: 'core', surface: 'mcp' });
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
  await assert.rejects(
    gatedChange(core, looser, { channel: 'core', surface: 'mcp', approvalId: first.prepared.approvalId }),
  );
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
    channel: 'core',
    env: { CLAUDECODE: '1' },
    output: { color: false },
    rerun: ['policy', '--account', 'acme/slack', 'chat'],
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
  // An agent's preview is for the person it shows it to, who says yes in the chat: that header is as it was.
  assert.match(plain.shown(), /· approved by a yes in the chat ·/);
  assert.doesNotMatch(plain.shown(), /at this terminal/);

  // An agent is refused even where a terminal is attached: the approval is the person's, and a terminal is not one.
  await assert.rejects(
    gatedChangeAtTerminal(core, change, { ...options, streams: terminal('yes').streams }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_PENDING',
  );
  assert.equal(await policyNow(core), 'never', 'the agent did not answer its own question');

  assert.equal(await gatedChangeAtTerminal(core, change, { ...options, approvalId }), 'chat');
});

test('a command to run again with a word Windows cannot print is shown as its words, to type, under either policy (CUE-306)', async () => {
  /*
   * The agent is told the command to run again with the approval. With a word no quoting brings through every Windows
   * shell alike — a folder with a `%` in it, which cmd.exe expands even in double quotes — there is no line to run:
   * the command, approval and all, is shown as its words in JSON, under `chat` and under `confirm` alike.
   */
  const folder = 'C:\\Profiles\\50% off';
  const words = ['attach', 'roots', 'add', folder];
  for (const policy of ['chat', 'confirm'] as const) {
    const core = coreWith('never', policy);
    await assert.rejects(
      gatedChangeAtTerminal(core, setSendPolicy(core, 'chat'), {
        channel: 'core',
        env: { CLAUDECODE: '1' },
        output: { json: true, color: false, platform: 'win32' },
        rerun: words,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommsError && error.code === 'APPROVAL_PENDING', String(error));
        const approvalId = String((error.details as { approvalId?: string }).approvalId);
        const rerun = coreHandoffs(core.paths, 'win32').own([...words, '--approval', approvalId]);
        assert.ok(isCommand(rerun) && rerun.line === null, 'the folder leaves the command no line');
        assert.ok(rerun.words.includes('C:\\Profiles\\50% off'));
        const json = inlineCommand(rerun);
        assert.match(
          json,
          /^`\[.*"C:\\\\Profiles\\\\50\\u0025 off","--approval","ap_\w+"\]` \(the command's words, written as JSON/,
        );
        assert.ok(error.hint?.endsWith(`run ${json}.`), `${policy}: ${error.hint}`);
        assert.doesNotMatch(String(error.hint), / attach roots add /, 'and no line to run');
        return true;
      },
    );
    // Elsewhere the folder goes in single quotes, and the line is there to run.
    await assert.rejects(
      gatedChangeAtTerminal(core, setSendPolicy(core, 'chat'), {
        channel: 'core',
        env: { CLAUDECODE: '1' },
        output: { json: true, color: false, platform: 'linux' },
        rerun: words,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        const approvalId = String((error.details as { approvalId?: string }).approvalId);
        assert.ok(
          error.hint?.endsWith(` attach roots add '${folder}' --approval ${approvalId}\`.`),
          `${policy}: ${error.hint}`,
        );
        const rerun = coreHandoffs(core.paths, 'linux').own([...words, '--approval', approvalId]);
        assert.ok(isCommand(rerun));
        assert.ok(error.hint?.endsWith(`run ${inlineCommand(rerun)}.`), `${policy}: ${error.hint}`);
        return true;
      },
    );
  }
});

test('a terminal change handoff renders its approval command for the selected shell platform', async () => {
  const core = coreWith('never', 'confirm');
  await assert.rejects(
    gatedChangeAtTerminal(core, setSendPolicy(core, 'chat'), {
      channel: 'core',
      env: { CLAUDECODE: '1' },
      output: { json: true, color: false, platform: 'win32' },
      rerun: ['policy', '--account', 'acme/slack', 'chat'],
    }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      const approvalId = String((error.details as { approvalId?: string }).approvalId);
      // This installation's own `approve`, quoted for Windows: the approve and the rerun both.
      const windows = coreHandoffs(core.paths, 'win32');
      const approve = windows.own(['approve', approvalId]);
      const rerun = windows.own(['policy', '--account', 'acme/slack', 'chat', '--approval', approvalId]);
      // And the wait that learns when they have, quoted for Windows too (design 2026-10-05 §D7).
      const wait = windows.own(['approval', 'wait', approvalId]);
      assert.ok(isCommand(approve) && isCommand(rerun) && isCommand(wait));
      assert.equal(
        error.hint,
        `Show the person the preview. They run ${inlineCommand(approve)}; learn when they have with ${inlineCommand(wait)}, then run ${inlineCommand(rerun)}.`,
      );
      return true;
    },
  );
});

test('a command whose --approval is taken by another change names the flag that carries this one', async () => {
  /*
   * `agent-gmail setup` registers the OAuth client under `--approval` and the MCP server under `--mcp-approval`. A
   * hint saying `--approval <id>` for the registration sent an agent to hand the server's approval to the client's
   * step, where it is never read — and the registration was prepared again, for ever.
   */
  const core = coreWith('never');
  await assert.rejects(
    gatedChangeAtTerminal(core, setSendPolicy(core, 'chat'), {
      channel: 'core',
      env: { CLAUDECODE: '1' },
      output: { json: true, color: false },
      rerun: ['setup', '--mcp-client', 'cursor'],
      approvalFlag: '--mcp-approval',
    }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      const approvalId = String((error.details as { approvalId?: string }).approvalId);
      assert.match(error.hint ?? '', new RegExp(` setup --mcp-client cursor --mcp-approval ${approvalId}\``));
      assert.doesNotMatch(error.hint ?? '', / --approval /);
      return true;
    },
  );
});

test('--mcp-approval is generated before an existing sentinel and positional lookalikes stay untouched', async () => {
  const core = coreWith('never');
  // One shell for the hint and the expected command: Windows quotes `--` and `--approval=x`, POSIX does not.
  const platform = process.platform;
  await assert.rejects(
    gatedChangeAtTerminal(core, setSendPolicy(core, 'chat'), {
      channel: 'core',
      env: { CLAUDECODE: '1' },
      output: { json: true, color: false, platform },
      rerun: ['setup', '--mcp-client', 'cursor', '--', '--mcp-approval', 'literal', '--approval=x'],
      approvalFlag: '--mcp-approval',
    }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      const approvalId = String((error.details as { approvalId?: string }).approvalId);
      // The generated flag and its id before the sentinel; after it, the lookalikes exactly as they were given.
      const rerun = coreHandoffs(core.paths, platform).own([
        'setup',
        '--mcp-client',
        'cursor',
        '--mcp-approval',
        approvalId,
        '--',
        '--mcp-approval',
        'literal',
        '--approval=x',
      ]);
      assert.ok(isCommand(rerun));
      assert.ok(error.hint?.includes(inlineCommand(rerun)), error.hint);
      return true;
    },
  );
});

test('at the CLI a person at a terminal approves there: yes applies, anything else cancels and revokes', async () => {
  const yes = coreWith('never');
  const person = terminal('yes');
  const applied = await gatedChangeAtTerminal(yes, setSendPolicy(yes, 'chat'), {
    channel: 'core',
    env: {},
    output: { color: false },
    rerun: ['policy', '--account', 'acme/slack', 'chat'],
    streams: person.streams,
  });
  assert.equal(applied, 'chat');
  assert.match(person.shown(), /send policy: never → chat/, 'the person saw what they agreed to');
  // The yes is typed here, at this terminal, under the `chat` policy too: the header says so, not "in the chat".
  assert.match(
    person.shown(),
    /^CHANGE PREVIEW · approval ap_\w+ · approved by a yes typed here, at this terminal · /m,
  );
  assert.doesNotMatch(person.shown(), /approved by a yes in the chat/);

  const no = coreWith('never');
  await assert.rejects(
    gatedChangeAtTerminal(no, setSendPolicy(no, 'chat'), {
      channel: 'core',
      env: {},
      output: { color: false },
      rerun: ['policy', '--account', 'acme/slack', 'chat'],
      streams: terminal('no').streams,
    }),
    /cancelled: nothing was changed/,
  );
  assert.equal(await policyNow(no), 'never');
  const [record] = await no.approvals.list();
  assert.equal(record && stateOf(record), 'revoked', 'a cancelled approval cannot be claimed later');
});

test('importing core never starts the agentcomms CLI, whatever the running program is called', async () => {
  /*
   * core's cli.ts runs `main()` when the running script's name ends in `cli.mjs` — which is also the name of every
   * product's CLI. A library module importing it would start `agentcomms` inside `agent-slack`. So nothing the index
   * reaches may import cli.ts; this runs a program called cli.mjs that imports the index and prints one line.
   */
  const dir = tempDir();
  // A URL, not a path: `import()` of an absolute Windows path reads its drive letter as a URL scheme.
  const index = new URL('../src/index.ts', import.meta.url).href;
  const script = join(dir, 'cli.mjs');
  writeFileSync(script, `await import(${JSON.stringify(index)});\nprocess.stdout.write('imported\\n');\n`);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script],
    { env: { ...process.env, AGENT_COMMS_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir } },
  );
  assert.equal(stdout, 'imported\n', `something ran on import:\n${stdout}${stderr}`);
});
