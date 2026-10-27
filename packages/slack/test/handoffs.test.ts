import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { afterEach, test } from 'node:test';
import { agentMarkerHint, EXIT_CODES, handoffText, isCommand } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { SlackContext } from '../src/context.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type FakeSlack, startFakeSlack } from './support/fake-slack.ts';
import { assertNoBareCommand, SLACK_SOURCE_CLI, slackCommand, slackHandoffs, slackInline } from './support/handoffs.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * The Slack slice of CUE-403's §4 7d: what Slack tells a person to run is its own command, located — this Node, its own
 * entry here, its folders pinned — or the sentence saying there is none here. Never a bare binary, never an option
 * with no command in front of it, never `agent-slack --help`, and on Windows never a name in another case or with an
 * extension. Each refusal here is made before anything reaches Slack: the loopback Slack each test stands up records
 * every request, and none arrives.
 */

interface Envelope {
  ok: boolean;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

let fakes: FakeSlack[] = [];
afterEach(async () => {
  const started = fakes;
  fakes = [];
  await Promise.all(started.map((fake) => fake.close()));
});

/** A loopback Slack that answers nothing it is not asked, and records whatever reaches it. */
async function loopback(): Promise<FakeSlack> {
  const fake = await startFakeSlack({});
  fakes.push(fake);
  return fake;
}

/** The CLI, with every route to Slack — reading, the app, the doctor — through the loopback, and nothing else. */
async function cli(
  harness: Harness,
  fake: FakeSlack,
  argv: string[],
  options: { platform: NodeJS.Platform; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string; error: () => NonNullable<Envelope['error']> }> {
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
  const code = await run(argv, {
    core: harness.core,
    env: { ...harness.env, ...options.env },
    exchange: (params) => harness.exchange(params),
    streams: { stdout: out, stderr: err, stdin: new PassThrough() },
    openBrowser: () => undefined,
    probe: fake.fetch,
    read: fake.fetch,
    appConfig: fake.fetch,
    platform: options.platform,
  });
  const error = () => {
    const parsed = JSON.parse(stdout) as Envelope;
    assert.ok(parsed.error, stdout);
    return parsed.error;
  };
  return { code, stdout, stderr, error };
}

const PLATFORMS = ['darwin', 'win32'] as const;

test('the scanner refuses a bare binary, an option-only command and a Windows name in another case (7d)', () => {
  // What a printed command must never be. If the scanner let any of these through, every test below would be blind.
  for (const bare of [
    'Run `agent-slack` to start it.',
    'Run `agent-slack --help` to see the commands.',
    'Nothing to do. Try agent-slack --help.',
    'Ask the user to run `agent-slack approve ap_1` in their own terminal.',
    'Run `Agent-Slack.CMD --help`.',
    'AGENT-SLACK.exe workspace reauth acme',
    'Fix the secret store (run `agentcomms doctor`).',
  ]) {
    assert.throws(() => assertNoBareCommand(bare), /names a suite command by its bare name/, bare);
  }
  // And what a printed command is: this Node, then Slack's own entry here, then its words.
  for (const platform of PLATFORMS) {
    const help = slackHandoffs(undefined, platform).own(['--help'], { uses: [] });
    assert.ok(isCommand(help), 'message' in help ? help.message : '');
    assert.deepEqual(help.words, [process.execPath, '--experimental-strip-types', SLACK_SOURCE_CLI, '--help']);
  }
});

test('a usage error names this installation’s own help, pinning no folder (7d: --help, option-only)', async () => {
  const harness = await newHarness();
  for (const platform of PLATFORMS) {
    const fake = await loopback();
    // Help reads no folder of this suite, so the command it names carries none of the four pins.
    const help = slackInline(harness.core.paths, ['--help'], platform, { uses: [] });
    assert.doesNotMatch(help, /--config-dir|--state-dir|--data-dir|--secrets-dir/);

    const unknown = await cli(harness, fake, ['--json', 'nonsense'], { platform });
    assert.equal(unknown.code, EXIT_CODES.USAGE, unknown.stdout);
    assert.equal(unknown.error().hint, `Run ${help} to see the commands.`);
    assertNoBareCommand(unknown.stdout, `${platform}: the usage error`);

    // A required option left out is Commander's refusal too, with the same help: in plain words this time.
    const missing = await cli(harness, fake, ['files', 'download'], { platform });
    assert.equal(missing.code, EXIT_CODES.USAGE);
    assert.ok(missing.stderr.includes(`Run ${help} to see the commands.`), missing.stderr);
    assertNoBareCommand(missing.stderr, `${platform}: the missing option`);

    assert.deepEqual(fake.requests, [], `${platform}: something reached Slack`);
  }
});

test('an agent asked to approve a post is told this installation’s own approve, and nothing reaches Slack (7d)', async () => {
  // The one command an agent may not run for the person. What it hands over has to run where the person types it.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  for (const platform of PLATFORMS) {
    const fake = await loopback();
    const asked = await cli(harness, fake, ['--json', 'approve', 'ap_0000000000000000000000000'], {
      platform,
      env: { CLAUDECODE: '1' },
    });
    assert.equal(asked.code, EXIT_CODES.APPROVAL, asked.stdout);
    const error = asked.error();
    assert.equal(error.code, 'APPROVAL_REQUIRED');
    assert.equal(
      error.hint,
      // And, for a person who set the marker themselves, which variable it is and how to clear it (0.35.0 re-review).
      `Ask the user to run ${slackInline(harness.core.paths, ['approve', 'ap_0000000000000000000000000'], platform)} in their own terminal; learn when they have with ${slackInline(harness.core.paths, ['approval', 'wait', 'ap_0000000000000000000000000'], platform)}. ${agentMarkerHint('CLAUDECODE', platform)}`,
    );
    assertNoBareCommand(asked.stdout, `${platform}: the approve refusal`);
    assert.deepEqual(fake.requests, [], `${platform}: something reached Slack`);
  }
});

test('a workspace or an app to repair is named with this installation’s own command, before Slack is asked (7d)', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read', redirectPort: 51234 });
  // A record from before workspaces remembered their app: `app update` cannot know which one to change.
  await harness.core.config.update((config) => {
    const { appId: _forgotten, ...account } = config.accounts.acme as NonNullable<(typeof config.accounts)['acme']>;
    return { ...config, accounts: { ...config.accounts, acme: account } };
  });
  for (const platform of PLATFORMS) {
    const fake = await loopback();
    const paths = harness.core.paths;

    const unknown = await cli(harness, fake, ['--json', 'workspace', 'show', 'nope'], { platform });
    assert.equal(unknown.code, EXIT_CODES.NOT_FOUND, unknown.stdout);
    assert.equal(unknown.error().hint, `List them with ${slackInline(paths, ['workspace', 'list'], platform)}.`);
    assertNoBareCommand(unknown.stdout, `${platform}: the unknown workspace`);

    const app = await cli(harness, fake, ['--json', 'app', 'update', 'acme', '--mode', 'send', '--port', '51234'], {
      platform,
      // The token is there, so nothing waits for one: the refusal is about the app, made before the token is used.
      env: { SLACK_APP_CONFIG_TOKEN: 'fake-config-token-0000' },
    });
    assert.equal(app.code, EXIT_CODES.CONFIG, app.stdout);
    assert.equal(
      app.error().hint,
      `Re-authorising records it: ${slackInline(paths, ['workspace', 'reauth', 'acme'], platform)}. Or paste ${slackInline(paths, ['manifest', '--mode', 'send', '--port', '51234'], platform)} on the app's page at https://api.slack.com/apps.`,
    );
    assertNoBareCommand(app.stdout, `${platform}: the app repair`);
    assert.doesNotMatch(app.stdout, /fake-config-token/, 'the token was printed');

    assert.deepEqual(fake.requests, [], `${platform}: something reached Slack`);
  }
});

test('a context or a server that opens core itself opens it with this package’s caller (7d)', async () => {
  // The library entry's server, and any context made without a core, locate their commands as the CLI's do.
  const harness = await newHarness();
  const context = new SlackContext({ env: harness.env, platform: 'darwin' });
  assert.equal(context.core.handoffs?.caller.packageName, '@agentcomms/slack');
  assert.equal(
    handoffText(context.handoffs.own(['workspace', 'list'])),
    slackCommand(context.core.paths, ['workspace', 'list'], 'darwin'),
  );
  const { server } = await createSlackMcpServer({ env: harness.env, platform: 'darwin' });
  await server.close();
});
