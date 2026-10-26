import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin, openCore } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * The second look of the 0.33.0 security review (SEC-3c, SEC-3d): on Windows and Linux nothing attests that the Agent
 * Comms app started a command, and `judge setup`, `provider key set|remove` and `integration set agent-sessions` took any
 * marker-less process without a terminal as the app — approving a judge kind's and a budget's standing activations
 * (recorded `approvedVia: app`), replacing a key, or pointing session prompts at a listener an agent runs. One rule now
 * holds for every person-only change: an attested origin, or an interactive terminal; an unattested origin is refused
 * with `APPROVAL_REQUIRED` (exit 10) and `ORIGIN_UNATTESTED`, by the CLI before the owner and by the owner too.
 */

const APPROVAL_EXIT = new CommsError('APPROVAL_REQUIRED', 'x').exitCode;
const UNATTESTED = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'unattested-platform' });
// A synthetic key: never a real one.
const KEY = 'fake-unattested-key-0000';

async function cliAs(
  stateDir: string,
  args: readonly string[],
  stdin = '',
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  // Markers stripped (env = {}), stdin a pipe, no terminal: what the review's agent shell ran.
  const input = Object.assign(new PassThrough(), { isTTY: false });
  input.end(stdin);
  const stdout = Object.assign(new PassThrough(), { isTTY: false });
  const stderr = Object.assign(new PassThrough(), { isTTY: false });
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk;
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await run(['--state-dir', stateDir, '--json', ...args], {
    env: {},
    desktopOrigin: UNATTESTED,
    streams: { stdin: input, stdout, stderr },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

test('UNATTESTED: every person-only change from an unattested origin is sent to the terminal — CLI and owner — and nothing changes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-unattested-');
  await withLaneOwner(
    async (harness) => {
      const { stateDir } = harness;
      const opened = await openEventDatabase({ stateDir });
      await selectEventSecretStore(opened.database, 'file');
      opened.close();
      const core = openCore({ pathOverrides: { stateDir, configDir: join(stateDir, '..', 'config') } });
      const disclosures = async () =>
        (await core.approvals.list()).flatMap((entry) =>
          entry.form === 'v2' && entry.record.kind === 'disclosure' ? [entry.record] : [],
        ).length;
      const before = await disclosures();
      const person = new EventControlClient({ stateDir, clientName: 'person-setup:terminal' });
      const settings = async () => person.request('integration-show', { integration: 'agent-sessions' });
      const settingsBefore = JSON.stringify(await settings());

      // The CLI refuses each one before the owner is asked, naming the words to type at a terminal.
      for (const [args, words, stdin] of [
        [['judge', 'setup', 'local-endpoint', '--url', 'http://127.0.0.1:9'], 'judge setup local-endpoint', ''],
        [['provider', 'key', 'set', 'linear'], 'provider key set linear, which asks for the key, hidden', `${KEY}\n`],
        [['provider', 'key', 'remove', 'openrouter'], 'provider key remove openrouter', ''],
        [
          ['integration', 'set', 'agent-sessions', '--relay-port', '45555', '--allow-folder', '/tmp'],
          'integration set agent-sessions',
          '',
        ],
      ] as const) {
        const ran = await cliAs(stateDir, args, stdin);
        assert.equal(ran.code, APPROVAL_EXIT, `${args.join(' ')}: ${ran.err}`);
        assert.ok(
          ran.err.includes(`at your terminal, with the event service's ${words}`),
          `${args.join(' ')} names the words to type: ${ran.err}`,
        );
        assert.match(ran.err, /nothing on this platform attests that the Agent Comms app started this/u);
        assert.equal(ran.out.includes(KEY) || ran.err.includes(KEY), false, 'a key is never echoed');
      }

      // The owner refuses the same origin for each, should any client claim it, and audits it with the reason.
      const claimed = new EventControlClient({ stateDir, clientName: 'person-setup:desktop-app-unattested' });
      for (const [operation, args] of [
        ['judge-setup', { kind: 'local-endpoint', url: 'http://127.0.0.1:9' }],
        ['provider-key-set', { provider: 'linear', hidden: KEY }],
        ['provider-key-remove', { provider: 'openrouter' }],
        ['integration-set', { integration: 'agent-sessions', relayPort: 45555, allowFolders: ['/tmp'] }],
      ] as const)
        await assert.rejects(claimed.request(operation, args), (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'APPROVAL_REQUIRED', operation);
          assert.equal((error as { details?: { reason?: string } }).details?.reason, 'ORIGIN_UNATTESTED', operation);
          return true;
        });
      const refusals = (await core.audit.tail({ limit: 100 }))
        .filter((line) => line.outcome === 'refused' && line.reason === 'ORIGIN_UNATTESTED')
        .map((line) => [line.operation, (line.ids as { approvedBy?: string }).approvedBy]);
      assert.deepEqual(refusals, [
        ['events.judgeSetup', 'desktop-app (unattested)'],
        ['events.providerKeySet', 'desktop-app (unattested)'],
        ['events.providerKeyRemove', 'desktop-app (unattested)'],
        ['events.integrationSet', 'desktop-app (unattested)'],
      ]);

      // Nothing changed: no standing activation approved, no judge, no key, the relay where it was.
      assert.equal(await disclosures(), before, 'no standing activation was approved');
      assert.deepEqual(await harness.control.request('judgesList', {}), []);
      const keys = (await person.request('provider-list', {})) as { providers: { id: string; hasKey: boolean }[] };
      assert.equal(keys.providers.find((entry) => entry.id === 'linear')?.hasKey, false, 'no Linear key was set');
      assert.equal(JSON.stringify(await settings()), settingsBefore, 'the relay settings are unchanged');

      // From the attested app, judge setup's activations are the app's: `approvedVia: app` means the attested app.
      const attested = new EventControlClient({ stateDir, clientName: 'person-setup:desktop-app' });
      await attested.request('judge-setup', { kind: 'local-endpoint', url: 'http://127.0.0.1:9' });
      const vias = (await core.approvals.list()).flatMap((entry) =>
        entry.form === 'v2' && entry.record.kind === 'disclosure'
          ? [(entry.record as { approvedVia?: string }).approvedVia]
          : [],
      );
      assert.deepEqual(vias, ['app', 'app'], 'the budget and the kind, each via the attested app');
    },
    { agentSessions: { homeDirectory: join(root, 'no-home'), reconcileMs: 60_000 } },
  );
});
