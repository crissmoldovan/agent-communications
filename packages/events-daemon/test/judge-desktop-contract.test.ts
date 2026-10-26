import assert from 'node:assert/strict';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import type { LayaPlatformProbe, LayaReviewedAssetSource } from '../src/domain/judges.ts';
import { assertB3ControlV2LayaResult, assertLayaModelStatusV1 } from '../src/operations/b3-control-v2.ts';
import layaStatusSchema from '../src/operations/contracts/laya-model-status-v1.schema.json' with { type: 'json' };
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import type { LayaArtifactEdge, LayaArtifactNetwork } from '../src/runtime/laya/manager.ts';
import { type EventOwner, startEventOwner } from '../src/runtime/owner.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import beforeE2Frozen from './fixtures/b3-control-contract-v1/unavailable-e2.json' with { type: 'json' };
import contract from './fixtures/judges/desktop-contract-v1.json' with { type: 'json' };
import { emptyConfigDir } from './support/config-dir.ts';
import {
  LAYA,
  layaArtifactOrigin,
  macPlatform,
  modelPath,
  syntheticLaya,
  treeListing,
} from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

assertLoopbackSeal();

/*
 * The daemon side of the desktop app's Laya contract (E2 Task 11, desktop design DA16). The app reads `judge model
 * status --json` and runs `judge kind disable laya --json` through the events-daemon launcher, and opens `judge kind
 * enable laya` in a terminal. This file freezes what those answer, as the real owner gives it through its sealed
 * control peer, in `fixtures/judges/desktop-contract-v1.json`; the app's own fixtures are copies of its vectors.
 */

/** A fixed clock for every D8 stamp: in the past, so core's real-time approval expiry is always still ahead of it. */
const NOW = 1_760_000_000_000;
/** The B3 control v1 answer of an owner composed without E2's artifact manager: a CLI from before E2. */
const BEFORE_E2 = 'b3-control-v1';
const STATUS_V1 = 'laya-model-status-v1';
const STATUS_KEYS = [
  'state',
  'manifestId',
  'runtimeLockDigest',
  'bytesVerified',
  'totalBytes',
  'failureCode',
  'reason',
  'updatedAt',
] as const;

interface Vector {
  readonly name: string;
  readonly contract: typeof STATUS_V1 | typeof BEFORE_E2;
  /** The Laya entry of `judge kinds list` at the same moment: is E's enablement pointer there? */
  readonly pointer: 'disabled' | 'enabled' | 'unavailable';
  readonly result: Record<string, unknown>;
}

interface ContractCall {
  readonly call: string;
  readonly operation: string;
  readonly words: readonly string[];
  readonly json: boolean;
  readonly terminal: boolean;
}

const frozen = contract as unknown as {
  readonly schemaVersion: string;
  readonly calls: readonly ContractCall[];
  readonly disable: Record<string, unknown>;
  readonly statusVectors: readonly Vector[];
};

function callNamed(name: string): ContractCall {
  const found = frozen.calls.find((entry) => entry.call === name);
  assert.ok(found !== undefined, `the contract names ${name}`);
  return found;
}

function validator(): (value: unknown) => boolean {
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(layaStatusSchema);
  return (value) => {
    const valid = validate(value);
    assert.equal(valid, true, JSON.stringify(validate.errors));
    return valid;
  };
}

/** One controllable pause at each artifact edge a test arms; every other visit passes straight through. */
function edges(): {
  readonly failpoint: (edge: LayaArtifactEdge) => Promise<void>;
  pauseAt(edge: LayaArtifactEdge): { readonly reached: Promise<void>; release(): void };
} {
  const armed = new Map<LayaArtifactEdge, { reach(): void; released: Promise<void> }>();
  return {
    failpoint: async (edge) => {
      const pause = armed.get(edge);
      if (pause === undefined) return;
      armed.delete(edge);
      pause.reach();
      await pause.released;
    },
    pauseAt(edge) {
      let reach!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed.set(edge, { reach, released });
      return { reached, release };
    },
  };
}

interface Running {
  readonly owner: EventOwner;
  readonly control: EventControlClient;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly configDir: string;
  /** The four folder pins the app passes on every call. */
  readonly pins: readonly string[];
}

/** The production owner over `root`, with the test's reviewed Laya bytes, platform probe and sealed origin. */
async function startOwner(
  root: string,
  laya: {
    readonly assets?: LayaReviewedAssetSource | undefined;
    readonly platform: LayaPlatformProbe;
    readonly network?: LayaArtifactNetwork | undefined;
    readonly freeBytes?: (() => Promise<number>) | undefined;
    readonly failpoint?: ((edge: LayaArtifactEdge) => Promise<void>) | undefined;
  },
): Promise<Running> {
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'data');
  const configDir = await emptyConfigDir(root);
  const secretsDir = join(root, 'secrets');
  const owner = await startEventOwner({
    ...noRealHome(stateDir),
    stateDir,
    configDir,
    dataDir,
    tickMs: 60_000,
    pollIntervalMs: 60_000,
    now: () => NOW,
    laya: { freeBytes: async () => Number.MAX_SAFE_INTEGER, ...laya },
  });
  return {
    owner,
    control: new EventControlClient({ stateDir, clientName: 'events-e2-t11-desktop' }),
    stateDir,
    dataDir,
    configDir,
    pins: ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir],
  };
}

async function snapshot(control: EventControlClient, name: string): Promise<Vector> {
  const result = (await control.request('judgeModelStatus')) as Record<string, unknown>;
  const kinds = (await control.request('judgeKindsList')) as readonly Record<string, unknown>[];
  const entry = kinds.find((kind) => kind.kind === LAYA);
  return { name, contract: STATUS_V1, pointer: entry?.state as Vector['pointer'], result };
}

/** Reads the status until `done` holds, for at most ten seconds. */
async function until(
  control: EventControlClient,
  done: (status: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let status = (await control.request('judgeModelStatus')) as Record<string, unknown>;
  for (let attempt = 0; !done(status) && attempt < 500; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (await control.request('judgeModelStatus')) as Record<string, unknown>;
  }
  assert.equal(done(status), true, `the status never came to what was awaited: ${JSON.stringify(status)}`);
  return status;
}

/** A person's terminal approval of the prepared enablement, through the owner's own challenge and approve. */
async function approve(control: EventControlClient, prepared: { readonly approvalId: string }): Promise<void> {
  const answer = await control.request('approve-challenge', { approvalId: prepared.approvalId });
  await control.request('approve', { approvalId: prepared.approvalId, answer });
}

async function prepareEnable(control: EventControlClient): Promise<{ readonly approvalId: string }> {
  return (await control.request('enableJudgeKind', { kind: LAYA })) as { readonly approvalId: string };
}

/** Runs one owner over a fresh short root, and always stops it and removes the root. */
async function withRoot(prefix: string, work: (root: string) => Promise<void>): Promise<void> {
  const root = await shortTempDir(prefix);
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stopped(running: Running | undefined): Promise<void> {
  await running?.owner.stop();
}

/** Every vector the contract freezes, each the live answer of production code: the owner, or a pre-E2 control. */
async function liveVectors(): Promise<Vector[]> {
  const vectors: Vector[] = [];
  const laya = await syntheticLaya();
  const modelBytes = laya.modelFiles.reduce((sum, file) => sum + file.size, 0);

  // Disabled, approval pending, then each state of an approved install, a disable that keeps the verified trees, and
  // a removal.
  await withRoot('events-e2-t11-a-', async (root) => {
    const origin = layaArtifactOrigin(laya);
    const points = edges();
    let running: Running | undefined;
    try {
      running = await startOwner(root, {
        assets: laya.assets,
        platform: macPlatform(),
        network: origin.network,
        failpoint: points.failpoint,
      });
      const { control } = running;
      vectors.push(await snapshot(control, 'disabled'));
      const prepared = await prepareEnable(control);
      vectors.push(await snapshot(control, 'approval-pending'));
      const installing = points.pauseAt('runtime-promotion');
      const first = laya.modelFiles[0];
      assert.ok(first !== undefined);
      const gate = origin.gate(modelPath(laya, first.path));
      const verifying = points.pauseAt('model-ready');
      await approve(control, prepared);
      await installing.reached;
      vectors.push(await snapshot(control, 'installing'));
      installing.release();
      await gate.reached;
      // The first half of the first model file has arrived; the rest is held until the vector is read.
      await until(
        control,
        (status) =>
          status.state === 'downloading' &&
          status.bytesVerified === (status.totalBytes as number) - modelBytes + Math.floor(first.size / 2),
      );
      vectors.push(await snapshot(control, 'downloading'));
      gate.release();
      await verifying.reached;
      vectors.push(await snapshot(control, 'verifying'));
      verifying.release();
      await until(control, (status) => status.state === 'ready');
      vectors.push(await snapshot(control, 'ready'));
      await control.request('disableJudgeKind', { kind: LAYA });
      vectors.push(await snapshot(control, 'disabled-kept'));
      await control.request('removeJudgeModel');
      vectors.push(await snapshot(control, 'removed'));
    } finally {
      await stopped(running);
    }
  });

  // An installed tree that no longer verifies: a runtime file altered on disk before the final verification.
  await withRoot('events-e2-t11-b-', async (root) => {
    const points = edges();
    let running: Running | undefined;
    try {
      running = await startOwner(root, {
        assets: laya.assets,
        platform: macPlatform(),
        network: layaArtifactOrigin(laya).network,
        failpoint: points.failpoint,
      });
      const promotion = points.pauseAt('model-promotion');
      await approve(running.control, await prepareEnable(running.control));
      await promotion.reached;
      const runtimeRoot = join(running.dataDir, 'events', LAYA, 'runtime');
      const [file] = (await treeListing(runtimeRoot)) ?? [];
      assert.ok(file !== undefined, 'the runtime tree was promoted');
      await appendFile(join(runtimeRoot, file), ' ');
      promotion.release();
      await until(running.control, (status) => status.state === 'failed');
      vectors.push(await snapshot(running.control, 'failed-integrity'));
    } finally {
      await stopped(running);
    }
  });

  // A model file the origin serves empty: the download fails.
  await withRoot('events-e2-t11-c-', async (root) => {
    const origin = layaArtifactOrigin(laya);
    origin.serve(modelPath(laya, 'laya_config.json'), Buffer.alloc(0));
    let running: Running | undefined;
    try {
      running = await startOwner(root, { assets: laya.assets, platform: macPlatform(), network: origin.network });
      await approve(running.control, await prepareEnable(running.control));
      await until(running.control, (status) => status.state === 'failed');
      vectors.push(await snapshot(running.control, 'failed-download'));
    } finally {
      await stopped(running);
    }
  });

  // No room for the runtime: its install fails before any fetch.
  await withRoot('events-e2-t11-d-', async (root) => {
    let running: Running | undefined;
    try {
      running = await startOwner(root, {
        assets: laya.assets,
        platform: macPlatform(),
        network: layaArtifactOrigin(laya).network,
        freeBytes: async () => 0,
      });
      await approve(running.control, await prepareEnable(running.control));
      await until(running.control, (status) => status.state === 'failed');
      vectors.push(await snapshot(running.control, 'failed-runtime'));
    } finally {
      await stopped(running);
    }
  });

  // Enabled and ready, then started again on a Mac whose sandbox no longer works: the boundary fails.
  await withRoot('events-e2-t11-e-', async (root) => {
    let running: Running | undefined;
    try {
      running = await startOwner(root, {
        assets: laya.assets,
        platform: macPlatform(),
        network: layaArtifactOrigin(laya).network,
      });
      await approve(running.control, await prepareEnable(running.control));
      await until(running.control, (status) => status.state === 'ready');
      await running.owner.stop();
      running = undefined;
      running = await startOwner(root, {
        assets: laya.assets,
        platform: macPlatform('fails'),
        network: layaArtifactOrigin(laya).network,
      });
      vectors.push(await snapshot(running.control, 'failed-boundary'));
    } finally {
      await stopped(running);
    }
  });

  // Not offered here: a Mac with no usable sandbox, Linux, Windows, and the release's placeholder lock.
  for (const [name, platform, assets] of [
    ['unavailable-sandbox', macPlatform('fails'), laya.assets],
    ['unavailable-linux', { platform: 'linux', architecture: 'x64' }, laya.assets],
    ['unavailable-windows', { platform: 'win32', architecture: 'x64' }, laya.assets],
    // The daemon's own shipped manifest, disclosures and placeholder lock: no reviewed bytes are injected at all.
    ['unavailable-placeholder', macPlatform(), undefined],
  ] as const) {
    await withRoot('events-e2-t11-f-', async (root) => {
      let running: Running | undefined;
      try {
        running = await startOwner(root, { assets, platform });
        vectors.push(await snapshot(running.control, name));
      } finally {
        await stopped(running);
      }
    });
  }

  // A CLI from before E2: its owner composed no artifact manager, and B3 v1 answers its typed placeholder.
  await withRoot('events-e2-t11-g-', async (root) => {
    const store = await openEventDatabase({ stateDir: join(root, 'state') });
    try {
      const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } as never });
      const result = (await control.handle({ operation: 'judgeModelStatus', args: {} })) as Record<string, unknown>;
      const kinds = (await control.handle({ operation: 'judgeKindsList', args: {} })) as Record<string, unknown>[];
      const entry = kinds.find((kind) => kind.kind === LAYA);
      vectors.push({ name: 'before-e2', contract: BEFORE_E2, pointer: entry?.state as Vector['pointer'], result });
    } finally {
      store.close();
    }
  });
  return vectors;
}

/** Every string anywhere in `value`. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

test('E2 desktop Laya contract: every status vector is the real owner’s answer through its control peer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const live = await liveVectors();
  const validate = validator();
  assert.equal(frozen.schemaVersion, 'desktop-contract-v1');
  assert.deepEqual(
    live.map((vector) => vector.name),
    frozen.statusVectors.map((vector) => vector.name),
    'the contract freezes exactly the vectors production gave, in order',
  );
  for (const vector of frozen.statusVectors) {
    const answer = live.find((entry) => entry.name === vector.name);
    assert.deepEqual(answer, vector, `${vector.name}: the frozen vector is the live answer`);
    if (vector.contract === STATUS_V1) {
      validate(vector.result);
      assertLayaModelStatusV1(vector.result);
      assertB3ControlV2LayaResult('judgeModelStatus', vector.result);
      assert.deepEqual(Object.keys(vector.result).sort(), [...STATUS_KEYS].sort(), `${vector.name}: a closed DTO`);
      // E's pointer alone decides idle: every enabled state is not idle, every disabled one is.
      if (vector.pointer === 'enabled') assert.notEqual(vector.result.state, 'idle', vector.name);
      if (vector.pointer === 'disabled') assert.equal(vector.result.state, 'idle', vector.name);
      if (vector.pointer === 'unavailable') assert.equal(vector.result.state, 'unavailable', vector.name);
    } else {
      assert.deepEqual(vector.result, beforeE2Frozen.result, 'the pre-E2 answer is B3 v1’s frozen placeholder');
      assert.equal(vector.pointer, 'unavailable');
    }
    // Stable codes only: no path, address, input, request, response, key or token.
    for (const text of strings(vector)) {
      assert.doesNotMatch(text, /[/\\]|:\/\/|@|\s/u, `${vector.name}: ${JSON.stringify(text)} is a code, not content`);
    }
  }
  // Every closed state, failure code and reason the app reads has a vector.
  const results = frozen.statusVectors.filter((vector) => vector.contract === STATUS_V1).map((vector) => vector.result);
  assert.deepEqual([...new Set(results.map((result) => result.state))].sort(), [
    'downloading',
    'failed',
    'idle',
    'installing',
    'ready',
    'unavailable',
    'verifying',
  ]);
  assert.deepEqual([...new Set(results.map((result) => result.failureCode).filter((code) => code !== null))].sort(), [
    'boundary-failed',
    'download-failed',
    'integrity',
    'runtime-failed',
  ]);
  assert.deepEqual([...new Set(results.map((result) => result.reason).filter((reason) => reason !== null))].sort(), [
    'E2_EXTERNAL_REFERENCE_BLOCKED',
    'LAYA_PLATFORM_UNAVAILABLE',
    'LAYA_SANDBOX_UNAVAILABLE',
  ]);
});

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

test('E2 desktop Laya contract: the app’s two calls run through the events CLI exactly as the allow-list builds them', {
  skip: WINDOWS_SKIP,
}, async () => {
  const status = callNamed('eventsJudgeModelStatus');
  const disable = callNamed('eventsJudgeKindDisable');
  assert.deepEqual(status, {
    call: 'eventsJudgeModelStatus',
    operation: 'judgeModelStatus',
    words: ['judge', 'model', 'status'],
    json: true,
    terminal: false,
  });
  assert.deepEqual(disable, {
    call: 'eventsJudgeKindDisable',
    operation: 'disableJudgeKind',
    words: ['judge', 'kind', 'disable', LAYA],
    json: true,
    terminal: false,
  });
  const laya = await syntheticLaya();
  await withRoot('events-e2-t11-cli-', async (root) => {
    let running: Running | undefined;
    try {
      running = await startOwner(root, {
        assets: laya.assets,
        platform: macPlatform(),
        network: layaArtifactOrigin(laya).network,
      });
      const { control, pins } = running;
      // The words, then `--json`, then the pins: the order Rust's `argv` writes them in.
      const read = async () => {
        const answer = await cli([...status.words, '--json', ...pins]);
        assert.equal(answer.code, 0);
        assert.equal(answer.stdout.split('\n').length, 2, 'one JSON line');
        return JSON.parse(answer.stdout) as Record<string, unknown>;
      };
      assert.deepEqual(await read(), await control.request('judgeModelStatus'));
      assert.equal((await read()).state, 'idle');
      await approve(control, await prepareEnable(control));
      await until(control, (answer) => answer.state === 'ready');
      assert.deepEqual(await read(), await control.request('judgeModelStatus'));
      // Disable is E's immediate tightening: the owner applies it, with no terminal gate and nothing to approve.
      const disabled = await cli([...disable.words, '--json', ...pins]);
      assert.equal(disabled.code, 0);
      assert.deepEqual(JSON.parse(disabled.stdout), frozen.disable);
      assertB3ControlV2LayaResult('disableJudgeKind', frozen.disable);
      assert.equal((await read()).state, 'idle');
      const kinds = (await control.request('judgeKindsList')) as readonly Record<string, unknown>[];
      assert.deepEqual(
        kinds.find((kind) => kind.kind === LAYA),
        { kind: LAYA, state: 'disabled', version: null },
      );
    } finally {
      await stopped(running);
    }
  });
});

test('E2 desktop Laya contract: the Enable line prepares the enablement in the terminal and approves nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const enable = callNamed('eventsJudgeKindEnable');
  assert.deepEqual(enable, {
    call: 'eventsJudgeKindEnable',
    operation: 'enableJudgeKind',
    words: ['judge', 'kind', 'enable', LAYA],
    json: false,
    terminal: true,
  });
  assert.equal(frozen.calls.length, 3, 'the app has two calls and one terminal line for Laya, and nothing else');
  for (const entry of frozen.calls) {
    assert.ok(!entry.words.some((word) => word.startsWith('--approval') || word === 'approve'), entry.call);
  }
  const laya = await syntheticLaya();
  await withRoot('events-e2-t11-enable-', async (root) => {
    let running: Running | undefined;
    try {
      running = await startOwner(root, {
        assets: laya.assets,
        platform: macPlatform(),
        network: layaArtifactOrigin(laya).network,
      });
      const { control, pins } = running;
      // The terminal's line: the words and the pins, with no `--json` and no `--approval`.
      const opened = await cli([...enable.words, ...pins]);
      assert.equal(opened.code, 0);
      const prepared = JSON.parse(opened.stdout) as Record<string, unknown>;
      assertB3ControlV2LayaResult('enableJudgeKind', prepared);
      assert.equal(prepared.kind, 'judge-kind');
      assert.equal(prepared.status, 'pending', 'the enablement waits for the person’s own approval');
      // Nothing was approved by opening it: the pointer is absent and the status is still idle.
      const kinds = (await control.request('judgeKindsList')) as readonly Record<string, unknown>[];
      assert.deepEqual(
        kinds.find((kind) => kind.kind === LAYA),
        { kind: LAYA, state: 'disabled', version: null },
      );
      assert.equal(((await control.request('judgeModelStatus')) as Record<string, unknown>).state, 'idle');
    } finally {
      await stopped(running);
    }
  });
});
