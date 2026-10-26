import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DesktopOrigin } from '../src/desktop-origin.ts';
import { captureForSearch, resetCaptureForTests } from '../src/search/capture.ts';
import { runMain } from './helpers/main-in-process.ts';
import { MAIL, QWEN_LOCAL, type SearchMachine, SLACK, searchMachine, startFakeOllama } from './helpers/search.ts';

/*
 * `agentcomms search …` at the surface (design 2026-10-26-local-search §8): each command's JSON, the loosenings shown
 * first and approved — at a terminal, or by the attested app with `--app-approval` — the tightenings at once, and the
 * options only `search` reads refused elsewhere. A temporary home, a secret store in memory, stand-ins for tmutil and
 * fdesetup, and a fake Ollama on loopback; no keychain, no network.
 */

const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});
const UNATTESTED = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'unattested-platform' });

async function cli(machine: SearchMachine, words: string[], appOrigin?: () => Promise<DesktopOrigin>) {
  const run = await runMain(['--json', ...words], machine.env, process.platform, {
    search: machine.deps,
    ...(appOrigin === undefined ? {} : { appOrigin }),
  });
  return {
    ...run,
    envelope: run.json() as { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> },
  };
}

function config(machine: SearchMachine): { search?: { enabled?: string; accounts?: string[]; model?: unknown } } {
  return JSON.parse(readFileSync(join(machine.configDir, 'config.json'), 'utf8'));
}

/** What the desktop app does: the command without an approval, for the preview and its id; then with `--app-approval`. */
async function fromTheApp(machine: SearchMachine, words: string[], origin = ATTESTED) {
  const first = await cli(machine, words, origin);
  assert.equal(first.code, 10, first.stdout);
  const error = first.envelope.error as { code: string; details: { approvalId: string; preview: string } };
  assert.equal(error.code, 'APPROVAL_PENDING');
  const second = await cli(machine, [...words, '--app-approval', error.details.approvalId], origin);
  return { preview: error.details.preview, second };
}

test('search on is a loosening: shown first, approved in the app, and the folder made private and left out of backups', async () => {
  const machine = searchMachine();
  const { preview, second } = await fromTheApp(machine, ['search', 'on']);
  assert.match(preview, /keeping the words of messages on this machine/u);
  assert.match(preview, /Activity keeps no message’s words, and this does/u);
  assert.equal(second.code, 0, second.stdout);
  assert.equal((second.envelope.data as { on: boolean }).on, true);
  assert.equal(config(machine).search?.enabled, 'on');
  assert.ok(machine.calls.some((call) => call.program === '/usr/bin/tmutil' && call.args[0] === 'addexclusion'));
  assert.ok(machine.secrets.values.has('search-index'), 'the key is made before anything is kept');
  // Off applies at once, from anywhere.
  const off = await cli(machine, ['search', 'off']);
  assert.equal(off.code, 0);
  assert.equal(config(machine).search?.enabled, 'off');
});

test('where nothing attests the app, a loosening is approved at the terminal instead, and nothing changes', async () => {
  const machine = searchMachine();
  const { second } = await fromTheApp(machine, ['search', 'on'], UNATTESTED);
  assert.equal(second.code, 10);
  assert.equal((second.envelope.error as { details: { reason: string } }).details.reason, 'ORIGIN_UNATTESTED');
  assert.equal(config(machine).search?.enabled, undefined);
});

test('accounts add and model set are loosenings; accounts remove and model none apply at once', async () => {
  const ollama = await startFakeOllama([QWEN_LOCAL]);
  try {
    const machine = searchMachine({ enabled: 'on', accounts: [] });
    const added = await fromTheApp(machine, ['search', 'accounts', 'add', MAIL.alias]);
    assert.match(added.preview, /the accounts whose messages Search keeps: none → acme\/gmail/u);
    assert.equal(added.second.code, 0, added.second.stdout);
    assert.deepEqual(config(machine).search?.accounts, [MAIL.id]);
    const model = await fromTheApp(machine, ['search', 'model', 'set', ollama.address]);
    assert.match(model.preview, /not set → qwen3-embedding:0\.6b at http:\/\/127\.0\.0\.1:/u);
    assert.equal(model.second.code, 0, model.second.stdout);
    assert.equal((model.second.envelope.data as { next: string }).next, 'ollama pull qwen3-embedding:0.6b');
    const removed = await cli(machine, ['search', 'accounts', 'remove', MAIL.alias]);
    assert.equal(removed.code, 0, removed.stdout);
    assert.deepEqual(config(machine).search?.accounts, []);
    const none = await cli(machine, ['search', 'model', 'none']);
    assert.equal(none.code, 0);
    assert.equal(config(machine).search?.model, null);
    // An unknown account, and one Search cannot keep.
    assert.equal((await cli(machine, ['search', 'accounts', 'add', 'nobody/gmail'])).code, 66);
    assert.equal((await cli(machine, ['search', 'accounts', 'add', 'acme/whatsapp'])).code, 64);
  } finally {
    await ollama.close();
  }
});

test('the JSON of status, query, people, person, show and index', async () => {
  const ollama = await startFakeOllama([QWEN_LOCAL]);
  try {
    const machine = searchMachine({
      enabled: 'on',
      accounts: [MAIL.id, SLACK.id],
      model: { address: ollama.address, name: QWEN_LOCAL.name },
    });
    resetCaptureForTests();
    await captureForSearch(
      machine.core,
      MAIL,
      [
        {
          channel: 'gmail',
          direction: 'in',
          sourceId: '18c00000000000d1',
          threadId: '18c00000000000d1',
          from: { address: 'david.park@acme.example', name: 'David Park' },
          subject: 'October invoice',
          text: 'Could you send me the invoice for October?',
          at: Date.parse('2026-10-26T09:00:00Z'),
          partial: false,
        },
      ],
      { secrets: machine.deps.secrets },
    );
    const index = await cli(machine, ['search', 'index', '--budget', '5']);
    assert.equal(index.code, 0, index.stdout);
    assert.deepEqual(Object.keys(index.envelope.data ?? {}).sort(), [
      'backups',
      'busy',
      'embedded',
      'inserted',
      'model',
      'ms',
      'pending',
      'pruned',
      'ran',
      'refused',
      'replaced',
      'stopped',
      'taken',
      'unchanged',
    ]);
    const status = await cli(machine, ['search', 'status']);
    assert.equal(status.code, 0, status.stdout);
    const shown = status.envelope.data as Record<string, unknown> & {
      kept: { messages: number };
      model: { state: string };
    };
    assert.equal(shown.on, true);
    assert.equal(shown.kept.messages, 1);
    assert.equal(shown.model.state, 'running');
    assert.equal(shown.backups, 'excluded');
    assert.equal(shown.diskEncryption, 'on');
    assert.equal(JSON.stringify(shown).includes('invoice'), false, 'status says nothing a message says');
    const query = await cli(machine, ['search', 'query', '--limit', '5', '--', 'invoice', 'October']);
    assert.equal(query.code, 0, query.stdout);
    const result = query.envelope.data as { mode: string; hits: Record<string, unknown>[] };
    assert.equal(result.mode, 'hybrid');
    assert.deepEqual(Object.keys(result.hits[0] ?? {}).sort(), [
      'account',
      'answeredBy',
      'at',
      'channel',
      'direction',
      'eventId',
      'excerpt',
      'flags',
      'from',
      'handle',
      'line',
      'partial',
      'person',
      'rank',
      'sourceId',
      'subject',
    ]);
    const people = await cli(machine, ['search', 'people']);
    const person = (people.envelope.data as { people: { id: string }[] }).people[0];
    assert.ok(person);
    assert.equal((await cli(machine, ['search', 'person', person.id])).code, 0);
    const show = await cli(machine, ['search', 'show', '18c00000000000d1']);
    assert.equal(show.code, 0);
    assert.equal((await cli(machine, ['search', 'label', person.id, 'David', 'Park'])).code, 0);
    assert.equal((await cli(machine, ['search', 'show', 'nothing-here'])).code, 66);
    // The doctor shows the content-free check.
    const doctor = await runMain(['doctor', '--json'], machine.env, process.platform, { search: machine.deps });
    const checks = (doctor.json().data as { checks: { name: string; detail: string }[] }).checks;
    const search = checks.find((check) => check.name === 'search');
    assert.match(search?.detail ?? '', /^on for acme\/gmail, acme\/slack; 1 message kept for 30 days/u);
    assert.equal((search?.detail ?? '').includes('invoice'), false);
  } finally {
    await ollama.close();
  }
});

test('search’s own options are refused on every other command, and other commands’ options on search', async () => {
  const machine = searchMachine({ enabled: 'on', accounts: [MAIL.id] });
  for (const words of [
    ['activity', 'sessions', '--person', 'p_0000000000000000000000000A'],
    ['audit', 'tail', '--budget', '3'],
    ['doctor', '--confirm'],
    ['paths', '--all'],
    ['audit', 'tail', '--channel', 'gmail'],
  ]) {
    assert.equal((await cli(machine, words)).code, 64, words.join(' '));
  }
  for (const words of [
    ['search', 'status', '--budget', '3'],
    ['search', 'people', '--direction', 'in'],
    ['search', 'off', '--all'],
    ['search', 'query', 'invoice', '--kind', 'read'],
    ['search', 'delete', '--all'],
    ['search', 'delete', '--confirm'],
    ['search', 'nothing'],
    ['search', 'model', 'set'],
  ]) {
    assert.equal((await cli(machine, words)).code, 64, words.join(' '));
  }
  // `--channel` is query's too.
  assert.equal((await cli(machine, ['search', 'query', 'invoice', '--channel', 'gmail'])).code, 0);
  // The approval goes only with a change.
  assert.equal((await cli(machine, ['search', 'status', '--approval', 'ap_00000000000000000000000000'])).code, 64);
  assert.equal(
    (await cli(machine, ['search', 'query', 'x', '--app-approval', 'ap_00000000000000000000000000'])).code,
    64,
  );
});

test('the help names every search command, and the refusal is called a speed bump', async () => {
  const machine = searchMachine();
  const help = await runMain(['--help'], machine.env, process.platform);
  for (const line of [
    'search status',
    'search query <words…>',
    'search people',
    'search person <id>',
    'search show <sourceId>',
    'search index',
    'search rebuild',
    'search link <person> <person>',
    'search unlink <handle>',
    'search label <person> <name>',
    'search on',
    'search off',
    'search accounts add <account>',
    'search accounts remove <account>',
    'search model set <address>',
    'search model none',
    'search delete --all --confirm',
  ]) {
    assert.ok(help.stdout.includes(`  ${line}`), line);
  }
  assert.match(help.stdout, /a speed bump against\s+agents, not a boundary/u);
});
