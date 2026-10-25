import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { assertB3ControlV2LayaResult } from '../src/operations/b3-control-v2.ts';
import { assertB3ControlV3LayaJudgeResult } from '../src/operations/b3-control-v3.ts';
import { type EventOwner, startEventOwner } from '../src/runtime/owner.ts';
import contract from './fixtures/judges/desktop-contract-judges-v1.json' with { type: 'json' };
import { emptyConfigDir } from './support/config-dir.ts';
import { macPlatform } from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * The daemon side of the desktop app's Judges section (0.27.1), beside Laya's (`judge-desktop-contract.test.ts`, whose
 * `desktop-contract-v1.json` stays as Task 11 froze it). The app reads `judge kinds list --json` and `judges list
 * --json`, runs `judge kind disable typesafe|local-endpoint --json` at once, and opens `judge kind enable
 * typesafe|local-endpoint` in a terminal, all through the events-daemon launcher with the four folder pins. This file
 * runs each of those words through the events CLI against the real owner, and freezes what it answers at each step in
 * `fixtures/judges/desktop-contract-judges-v1.json`; the app's tests read those vectors as the events service's answers.
 */

/** A fixed clock for every D8 stamp: in the past, so core's real-time approval expiry is always still ahead of it. */
const NOW = 1_760_000_000_000;
const ENDPOINT_KINDS = ['typesafe', 'local-endpoint'] as const;

type EndpointKind = (typeof ENDPOINT_KINDS)[number];

interface ContractCall {
  readonly call: string;
  readonly judgeKind?: EndpointKind;
  readonly operation: string;
  readonly words: readonly string[];
  readonly json: boolean;
  readonly terminal: boolean;
}

interface Vector {
  readonly name: string;
  readonly kinds: readonly Record<string, unknown>[];
  readonly judges: readonly Record<string, unknown>[];
}

const frozen = contract as unknown as {
  readonly schemaVersion: string;
  readonly calls: readonly ContractCall[];
  readonly vectors: readonly Vector[];
  readonly disable: Readonly<Record<EndpointKind, Record<string, unknown>>>;
};

function callNamed(name: string, judgeKind?: EndpointKind): ContractCall {
  const found = frozen.calls.find((entry) => entry.call === name && entry.judgeKind === judgeKind);
  assert.ok(found !== undefined, `the contract names ${name}${judgeKind === undefined ? '' : ` ${judgeKind}`}`);
  return found;
}

/** Runs the events CLI as the app's launcher would, with stdin closed, and gives back its exit and what it printed. */
async function cli(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const stdin = new PassThrough();
  stdin.end();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let printed = '';
  let complained = '';
  stdout.setEncoding('utf8').on('data', (chunk: string) => {
    printed += chunk;
  });
  stderr.setEncoding('utf8').on('data', (chunk: string) => {
    complained += chunk;
  });
  const code = await run(argv, { streams: { stdin, stdout, stderr }, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(complained, '', 'the CLI wrote nothing to stderr');
  return { code, stdout: printed };
}

/** A call's words, then `--json` when the app reads its answer, then the pins: the order Rust's `argv` writes them in. */
async function answer(entry: ContractCall, pins: readonly string[]): Promise<unknown> {
  const printed = await cli([...entry.words, ...(entry.json ? ['--json'] : []), ...pins]);
  assert.equal(printed.code, 0, `${entry.words.join(' ')} exits 0`);
  assert.equal(printed.stdout.split('\n').length, 2, `${entry.words.join(' ')} prints one JSON line`);
  return JSON.parse(printed.stdout);
}

/** A person's terminal approval of a prepared enablement, through the owner's own challenge and approve. */
async function approve(control: EventControlClient, prepared: unknown): Promise<void> {
  const approvalId = (prepared as { readonly approvalId?: unknown }).approvalId;
  assert.equal(typeof approvalId, 'string', 'the terminal line prepares an approval');
  const challenge = await control.request('approve-challenge', { approvalId });
  const completed = (await control.request('approve', { approvalId, answer: challenge })) as { status?: unknown };
  assert.equal(completed.status, 'completed');
}

/** TypeSafe's hosted Jev, as the README's `judge.json` has it. */
const JEV = {
  judgeId: 'jev',
  version: 1,
  kind: 'typesafe',
  provider: 'typesafe',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul',
} as const;

/** A model server on this machine, at the loopback address its approved address set names. */
const LOCAL = {
  judgeId: 'local',
  version: 1,
  kind: 'local-endpoint',
  provider: 'ollama',
  model: 'example-model',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'],
  promptTemplate: 'ollama-noul-v1',
  protocol: 'noul',
} as const;

interface Running {
  readonly owner: EventOwner;
  readonly control: EventControlClient;
  /** The four folder pins the app passes on every call. */
  readonly pins: readonly string[];
}

/** The production owner over `root`, with this release's own Laya placeholder lock on a Mac: Laya is not offered. */
async function startOwner(root: string): Promise<Running> {
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'data');
  const configDir = await emptyConfigDir(root);
  const secretsDir = join(root, 'secrets');
  const owner = await startEventOwner({
    stateDir,
    configDir,
    dataDir,
    tickMs: 60_000,
    pollIntervalMs: 60_000,
    now: () => NOW,
    laya: { platform: macPlatform(), freeBytes: async () => Number.MAX_SAFE_INTEGER },
  });
  return {
    owner,
    control: new EventControlClient({ stateDir, clientName: 'events-0271-desktop-judges' }),
    pins: ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir],
  };
}

/**
 * Every vector the contract freezes, each the live answer of the app's two reads through the events CLI, and each
 * disable's answer, while both kinds are turned on in the terminal, given judges, and turned off again.
 */
async function liveVectors(): Promise<{
  readonly vectors: readonly Vector[];
  readonly disable: Readonly<Record<EndpointKind, unknown>>;
}> {
  const vectors: Vector[] = [];
  const disable: Partial<Record<EndpointKind, unknown>> = {};
  const root = await shortTempDir('events-0271-judges-');
  let running: Running | undefined;
  try {
    running = await startOwner(root);
    const { control, pins } = running;
    const read = async (name: string) => {
      const kinds = (await answer(callNamed('judgeKindsList'), pins)) as Vector['kinds'];
      const judges = (await answer(callNamed('judgesList'), pins)) as Vector['judges'];
      vectors.push({ name, kinds, judges });
      return kinds;
    };
    const kindState = (kinds: Vector['kinds'], kind: EndpointKind) => kinds.find((entry) => entry.kind === kind);
    /** The terminal's line: it prepares the enablement and approves nothing; the person approves it there. */
    const turnOn = async (kind: EndpointKind) => {
      const opened = await cli([...callNamed('judgeKindEnable', kind).words, ...pins]);
      assert.equal(opened.code, 0);
      const prepared = JSON.parse(opened.stdout) as Record<string, unknown>;
      assertB3ControlV2LayaResult('enableJudgeKind', prepared);
      assert.equal(prepared.status, 'pending', `${kind}: the enablement waits for the person's own approval`);
      const before = (await control.request('judgeKindsList')) as Vector['kinds'];
      assert.deepEqual(kindState(before, kind), { kind, state: 'disabled', version: null }, `${kind}: still off`);
      await approve(control, prepared);
    };
    const turnOff = async (kind: EndpointKind) => {
      disable[kind] = await answer(callNamed('judgeKindDisable', kind), pins);
    };

    await read('fresh');
    await turnOn('typesafe');
    await read('typesafe-on');
    await control.request('addJudge', { document: JEV });
    await read('typesafe-on-with-jev');
    await turnOn('local-endpoint');
    await read('both-on');
    await control.request('addJudge', { document: LOCAL });
    await read('both-on-with-local');
    await control.request('removeJudge', { judgeId: LOCAL.judgeId });
    await read('local-removed');
    await turnOff('typesafe');
    await read('typesafe-off');
    await turnOff('local-endpoint');
    await read('all-off');
  } finally {
    await running?.owner.stop();
    await rm(root, { recursive: true, force: true });
  }
  return { vectors, disable: disable as Record<EndpointKind, unknown> };
}

test('Desktop judges contract: the app’s judge calls are the words the events CLI takes, and none approves', () => {
  assert.equal(frozen.schemaVersion, 'desktop-contract-judges-v1');
  assert.deepEqual(
    frozen.calls.map((entry) => [entry.call, entry.judgeKind ?? null]),
    [
      ['judgeKindsList', null],
      ['judgesList', null],
      ['judgeKindDisable', 'typesafe'],
      ['judgeKindDisable', 'local-endpoint'],
      ['judgeKindEnable', 'typesafe'],
      ['judgeKindEnable', 'local-endpoint'],
    ],
    'two reads, a disable and a terminal line for each kind whose judges name an endpoint, and nothing else',
  );
  assert.deepEqual(callNamed('judgeKindsList'), {
    call: 'judgeKindsList',
    operation: 'judgeKindsList',
    words: ['judge', 'kinds', 'list'],
    json: true,
    terminal: false,
  });
  assert.deepEqual(callNamed('judgesList'), {
    call: 'judgesList',
    operation: 'judgesList',
    words: ['judges', 'list'],
    json: true,
    terminal: false,
  });
  for (const kind of ENDPOINT_KINDS) {
    assert.deepEqual(callNamed('judgeKindDisable', kind), {
      call: 'judgeKindDisable',
      judgeKind: kind,
      operation: 'disableJudgeKind',
      words: ['judge', 'kind', 'disable', kind],
      json: true,
      terminal: false,
    });
    assert.deepEqual(callNamed('judgeKindEnable', kind), {
      call: 'judgeKindEnable',
      judgeKind: kind,
      operation: 'enableJudgeKind',
      words: ['judge', 'kind', 'enable', kind],
      json: false,
      terminal: true,
    });
  }
  for (const entry of frozen.calls) {
    assert.ok(!entry.words.some((word) => word.startsWith('--approval') || word === 'approve'), entry.call);
    // Laya keeps its own zero-argument calls (desktop-contract-v1.json): none of these names it.
    assert.ok(!entry.words.includes('laya'), entry.call);
  }
});

test('Desktop judges contract: every vector is the real owner’s answer through the events CLI', {
  skip: WINDOWS_SKIP,
}, async () => {
  const live = await liveVectors();
  assert.deepEqual(
    live.vectors.map((vector) => vector.name),
    frozen.vectors.map((vector) => vector.name),
    'the contract freezes exactly the vectors production gave, in order',
  );
  for (const vector of frozen.vectors) {
    assert.deepEqual(
      live.vectors.find((entry) => entry.name === vector.name),
      vector,
      `${vector.name}: the frozen vector is the live answer`,
    );
    assertB3ControlV2LayaResult('judgeKindsList', vector.kinds);
    assertB3ControlV3LayaJudgeResult('judgesList', vector.judges);
  }
  assert.deepEqual(live.disable, frozen.disable, 'each disable is the frozen answer');
  for (const kind of ENDPOINT_KINDS) {
    assertB3ControlV2LayaResult('disableJudgeKind', frozen.disable[kind]);
    assert.equal(frozen.disable[kind].kind, kind);
  }
  // Each state the app shows has a vector: off and on for both kinds, a kind on without a judge, one with only a
  // removed judge, and Laya not offered.
  const states = (kind: string) =>
    new Set(frozen.vectors.map((vector) => vector.kinds.find((entry) => entry.kind === kind)?.state));
  for (const kind of ENDPOINT_KINDS) assert.deepEqual([...states(kind)].sort(), ['disabled', 'enabled']);
  assert.deepEqual([...states('laya')], ['unavailable']);
  assert.ok(frozen.vectors.some((vector) => vector.judges.some((judge) => judge.revokedAt !== null)));
});
