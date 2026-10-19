#!/usr/bin/env node
/**
 * The real-Mac boundary run (E2-6, E2-9, E2 Task 10), the owner's alone. It never runs in CI, `pnpm verify` or a test:
 * the owner runs it on a protected Mac (`.github/workflows/laya-quality-gate.yml`), on a candidate that ships the real
 * Laya runtime lock, against that Mac's verified runtime and model trees. `docs/RELEASING.md` gives the procedure.
 *
 *   verify-candidate --runtime-tree <directory> --model-tree <directory>
 *                    the candidate ships the real lock, and both trees are exactly that candidate's
 *   egress-check     this host cannot open a connection beyond its allow-list
 *   run --runtime-tree <directory> --model-tree <directory>
 *                    the boundary run, which writes only packages/events-laya-runtime/gate/macos-boundary-v1.json
 *
 * `run` drives the candidate's own worker through the production supervisor and boundary (`LayaWorkerSupervisor`,
 * `createLayaWorkerBoundary`): the shipped entry, the literal `sandbox-exec` profile, the same-child proof and both
 * whole-tree checks before every start. It observes only the proven child's process id, to end it, and works on
 * disposable clones of the two trees, so the originals are never changed. It asks one synthetic, content-free question;
 * no event, message or corpus item is read. It writes the evidence only after it validates for this checkout.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxExecAvailable } from '../packages/events-daemon/src/runtime/laya/contracts.ts';
import { LAYA_NOUL_TEMPLATE_ID } from '../packages/events-daemon/src/runtime/laya/templates.ts';
import { createLayaWorkerBoundary } from '../packages/events-daemon/src/runtime/laya/worker-boundary-probe.ts';
import {
  LAYA_IDLE_EXIT_MS,
  LayaWorkerSupervisor,
} from '../packages/events-daemon/src/runtime/laya/worker-supervisor.ts';
import { verifyCandidateTrees } from './run-laya-quality-gate.mjs';
import {
  BOUNDARY_CHECKS,
  BOUNDARY_EVIDENCE,
  BOUNDARY_SCHEMA_VERSION,
  BoundaryGateError,
  boundaryPassed,
  canonicalEvidenceBytes,
  computeBoundaryCandidate,
  mergeBoundaryEvidence,
  parseEvidenceBytes,
  validateBoundaryEvidence,
} from './verify-laya-boundary-gate.mjs';
import { QUALITY_ARCHITECTURES } from './verify-laya-quality-gate.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** The one question the run asks: synthetic, and about nothing but itself. */
export const BOUNDARY_QUESTION = Object.freeze({
  instructions: 'Is this a synthetic request from the Laya boundary gate?',
  state: 'This is a synthetic request from the Laya boundary gate. It holds no event, message or account.',
});
/**
 * Literal public addresses no gate allow-list names. A runner whose host denies outbound connections beyond its
 * allow-list (GitHub, the npm registry and the Node download it needs to check out, install and report) reaches none.
 */
export const EGRESS_PROBES = Object.freeze([
  Object.freeze({ host: '1.1.1.1', port: 443 }),
  Object.freeze({ host: '8.8.8.8', port: 443 }),
  Object.freeze({ host: '9.9.9.9', port: 443 }),
]);
const EGRESS_TIMEOUT_MS = 3_000;
const EXIT_WAIT_MS = 10_000;
/** Ten idle minutes, and a margin for the timer and the exit to land. */
const IDLE_WAIT_MS = LAYA_IDLE_EXIT_MS + 15_000;

function fail(code, message) {
  throw new BoundaryGateError(code, message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function exited(pid, within = EXIT_WAIT_MS) {
  const deadline = Date.now() + within;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await delay(100);
  }
  return true;
}

/** Under Rosetta, `sysctl.proc_translated` is 1; on an Intel Mac it does not exist; natively on Apple silicon it is 0. */
function translatedByRosetta() {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim() === '1';
  } catch {
    return false;
  }
}

function macosVersion() {
  return execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
}

/**
 * The candidate's worker through the production supervisor and boundary, over the given trees. `startWorker` calls the
 * production `createLayaWorkerBoundary` and only records whether its proof passed and the proven child's process id.
 */
export function createBoundaryHarness({ candidate, runtimeTree, modelTree }) {
  const selection = {
    epoch: 1,
    version: 1,
    digest: candidate.subjectDigest,
    manifestId: candidate.manifestId,
    promptTemplates: candidate.templates.map((template) => template.templateId),
  };
  const state = { starts: 0, proofs: [], pid: null };
  const artifacts = {
    availability: () => ({ available: true }),
    workerSelection: () => selection,
    async verifyForWorkerStart() {
      return (await verifyCandidateTrees({ candidate, runtimeTree, modelTree }))
        ? { ok: true, runtimeRoot: runtimeTree, modelRoot: modelTree }
        : { ok: false, failureCode: 'integrity' };
    },
    recordWorkerFailure() {},
    trackWork: () => ({ signal: new AbortController().signal, release() {} }),
    attachWorker: () => () => undefined,
  };
  const supervisor = new LayaWorkerSupervisor({
    artifacts,
    startWorker: async (options) => {
      state.starts += 1;
      const boundary = await createLayaWorkerBoundary(options);
      state.proofs.push(boundary.ok);
      if (boundary.ok) {
        const child = boundary.child;
        state.pid = child.pid ?? null;
        child.once('exit', () => {
          if (state.pid === child.pid) state.pid = null;
        });
      }
      return boundary;
    },
  });
  return {
    state,
    async ask({ beforeWrite } = {}) {
      const prepared = supervisor.prepare({
        judge: { model: candidate.manifestId, promptTemplate: LAYA_NOUL_TEMPLATE_ID },
        state: BOUNDARY_QUESTION.state,
        instructions: BOUNDARY_QUESTION.instructions,
      });
      if (!prepared.ok) return { kind: 'refused', code: prepared.code, preIo: true };
      return supervisor.execute(prepared.request, {
        reservationId: randomUUID(),
        finalGate: () => beforeWrite?.(state.pid),
      });
    },
    stop: () => supervisor.stop(),
    close: () => supervisor.close(),
  };
}

/** The next request starts exactly one fresh, proven worker, and it answers. */
async function answersFromAFreshWorker(harness) {
  const before = harness.state.starts;
  const result = await harness.ask();
  return result.kind === 'answer' && harness.state.starts === before + 1 && harness.state.proofs.at(-1) === true;
}

/** Writes one changed byte into a listed file of a clone, and returns how to put it back. */
async function alterOneByte(path) {
  const original = await readFile(path);
  const changed = Buffer.from(original);
  changed[0] = (changed[0] ?? 0) ^ 0xff;
  await writeFile(path, changed);
  return () => writeFile(path, original);
}

/** Every check of the real-Mac run, each `pass` or `fail`; a check that cannot run is a `fail`. */
export async function runProductionChecks({ candidate, runtimeTree, modelTree }) {
  const checks = Object.fromEntries(BOUNDARY_CHECKS.map((name) => [name, 'fail']));
  const work = await mkdtemp(join(tmpdir(), 'laya-boundary-gate-'));
  try {
    // Disposable clones (copy-on-write on APFS): the altered-tree checks change a byte in these, never the originals.
    const trees = { runtimeTree: join(work, 'runtime'), modelTree: join(work, 'model') };
    await cp(runtimeTree, trees.runtimeTree, { recursive: true, mode: constants.COPYFILE_FICLONE });
    await cp(modelTree, trees.modelTree, { recursive: true, mode: constants.COPYFILE_FICLONE });
    if (!(await verifyCandidateTrees({ candidate, ...trees }))) return checks;
    const harness = createBoundaryHarness({ candidate, ...trees });
    try {
      // The first start: the production same-child proof, then the native load and an answer over the same pipes.
      const first = await harness.ask();
      const proved = harness.state.proofs[0] === true;
      for (const name of ['tcp', 'fetch', 'udp', 'uds']) checks[name] = proved ? 'pass' : 'fail';
      if (!proved || first.kind !== 'answer') return checks;
      checks.pipes = 'pass';
      checks.nativeLoad = 'pass';

      // A worker killed from outside: the supervisor sees it go, and the next request proves and loads a fresh one.
      const crashed = harness.state.pid;
      if (crashed !== null) {
        process.kill(crashed, 'SIGKILL');
        if ((await exited(crashed)) && (await answersFromAFreshWorker(harness))) checks.crashRestart = 'pass';
      }

      // A request past its deadline: the worker is stopped as its frame is written, so it never answers; the
      // supervisor's 30-second deadline kills it, and the next request proves and loads a fresh one.
      let stopped = null;
      const late = await harness.ask({
        beforeWrite(pid) {
          if (pid !== null) {
            stopped = pid;
            process.kill(pid, 'SIGSTOP');
          }
        },
      });
      if (
        stopped !== null &&
        late.kind === 'refused' &&
        late.code === 'laya-timeout' &&
        (await exited(stopped)) &&
        (await answersFromAFreshWorker(harness))
      )
        checks.timeoutRestart = 'pass';

      // Ten idle minutes: the worker exits on its own, and the next request proves and loads a fresh one.
      const idle = harness.state.pid;
      if (idle !== null) {
        await delay(IDLE_WAIT_MS);
        if (!alive(idle) && (await answersFromAFreshWorker(harness))) checks.idleRestart = 'pass';
      }

      // One changed byte in the runtime tree, then in the model tree: neither starts a worker. Restored, they do.
      await harness.stop();
      const runtimeFile = candidate.enablement.runtimeLock.platform.files[0];
      const modelFile = [...candidate.enablement.manifest.files].sort((left, right) => left.size - right.size)[0];
      let refused = runtimeFile !== undefined && modelFile !== undefined;
      for (const path of refused
        ? [
            join(trees.runtimeTree, 'node_modules', runtimeFile.package, runtimeFile.path),
            join(trees.modelTree, modelFile.path),
          ]
        : []) {
        const restore = await alterOneByte(path);
        const before = harness.state.starts;
        const result = await harness.ask();
        refused &&= result.kind === 'refused' && result.code === 'integrity' && harness.state.starts === before;
        await restore();
      }
      if (refused) checks.alteredTreeRefused = 'pass';
      if (refused && (await verifyCandidateTrees({ candidate, ...trees })) && (await answersFromAFreshWorker(harness)))
        checks.repairedTreeAccepted = 'pass';
    } finally {
      await harness.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return checks;
}

/** One TCP attempt to a literal address, bounded; `true` only if it connected. */
function connects({ host, port }) {
  return new Promise((resolveConnect) => {
    const socket = connect({ host, port });
    const done = (connected) => {
      socket.destroy();
      resolveConnect(connected);
    };
    socket.setTimeout(EGRESS_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export const PRODUCTION_BOUNDARY_DEPENDENCIES = Object.freeze({
  translated: translatedByRosetta,
  macosVersion,
  sandboxAvailable: (architecture) => sandboxExecAvailable({ platform: 'darwin', architecture }),
  verifyTrees: verifyCandidateTrees,
  runChecks: runProductionChecks,
  connects,
});

/** The gate runner's host must not reach the internet beyond its allow-list: one connection that opens refuses it. */
export async function egressCheck(dependencies = PRODUCTION_BOUNDARY_DEPENDENCIES) {
  const reached = [];
  for (const probe of EGRESS_PROBES) if (await dependencies.connects(probe)) reached.push(probe.host);
  if (reached.length > 0)
    fail('BOUNDARY_EGRESS', `this runner reached ${reached.join(', ')}; its host must deny outbound connections`);
  return { probes: EGRESS_PROBES.length };
}

/** Before any run reads a corpus or starts a worker: the candidate ships the real lock and both trees are its own. */
export async function verifyRunCandidate(options, dependencies = PRODUCTION_BOUNDARY_DEPENDENCIES) {
  const root = options.root ?? repositoryRoot;
  if ((options.platform ?? process.platform) !== 'darwin') fail('BOUNDARY_PLATFORM', 'the gate runs only on macOS');
  const architecture = options.architecture ?? process.arch;
  if (!QUALITY_ARCHITECTURES.includes(architecture)) fail('BOUNDARY_PLATFORM', 'the gate runs on an arm64 or x64 Mac');
  // An x64 result comes only from an Intel Mac, never Rosetta on Apple silicon (E2-J).
  if (dependencies.translated()) fail('BOUNDARY_TRANSLATED', 'this process runs under Rosetta; run on an Intel Mac');
  if (typeof options.runtimeTree !== 'string' || typeof options.modelTree !== 'string')
    fail('BOUNDARY_USAGE', 'the run names --runtime-tree and --model-tree');
  const boundaryCandidate = computeBoundaryCandidate({ root, architecture });
  if (
    !(await dependencies.verifyTrees({
      candidate: boundaryCandidate.candidate,
      runtimeTree: options.runtimeTree,
      modelTree: options.modelTree,
    }))
  )
    fail('BOUNDARY_TREES', "the runtime and model trees are not exactly this candidate's");
  return { architecture, boundaryCandidate };
}

/** The run: checks every boundary fact on this Mac and writes only the validated, content-free evidence. */
export async function runBoundaryGate(options, dependencies = PRODUCTION_BOUNDARY_DEPENDENCIES) {
  const root = options.root ?? repositoryRoot;
  const { architecture, boundaryCandidate } = await verifyRunCandidate(options, dependencies);
  if (!dependencies.sandboxAvailable(architecture))
    fail('BOUNDARY_SANDBOX_UNAVAILABLE', 'sandbox-exec does not apply its profile on this Mac');
  const checks = await dependencies.runChecks({
    candidate: boundaryCandidate.candidate,
    runtimeTree: options.runtimeTree,
    modelTree: options.modelTree,
  });
  const entry = {
    architecture,
    platformFileListDigest: boundaryCandidate.platformFileListDigest,
    subjectDigest: boundaryCandidate.subjectDigest,
    node: options.node ?? process.versions.node,
    macos: options.macos ?? dependencies.macosVersion(),
    checks: Object.fromEntries(BOUNDARY_CHECKS.map((name) => [name, checks[name] === 'pass' ? 'pass' : 'fail'])),
    passed: false,
  };
  entry.passed = boundaryPassed(entry.checks);
  const top = {
    schemaVersion: BOUNDARY_SCHEMA_VERSION,
    manifestId: boundaryCandidate.manifestId,
    manifestSha256: boundaryCandidate.manifestSha256,
    runtimeLockSha256: boundaryCandidate.runtimeLockSha256,
    runnerSha256: boundaryCandidate.runnerSha256,
  };
  const path = join(root, BOUNDARY_EVIDENCE);
  const existing = existsSync(path) ? parseEvidenceBytes(await readFile(path)) : undefined;
  const evidence = mergeBoundaryEvidence({ existing, top, entry });
  const candidates = Object.fromEntries(
    evidence.architectures.map((other) => [
      other.architecture,
      other.architecture === architecture
        ? boundaryCandidate
        : computeBoundaryCandidate({ root, architecture: other.architecture }),
    ]),
  );
  // Nothing is written that a release would refuse.
  validateBoundaryEvidence(evidence, { candidates });
  const temporary = `${path}.${process.pid}.partial`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, canonicalEvidenceBytes(evidence), { flag: 'wx', mode: 0o644 });
  await rename(temporary, path);
  return {
    path: BOUNDARY_EVIDENCE,
    passed: entry.passed,
    lines: BOUNDARY_CHECKS.map((name) => `${architecture} ${name}: ${entry.checks[name]}`),
  };
}

export function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!['verify-candidate', 'egress-check', 'run'].includes(command))
    fail('BOUNDARY_USAGE', 'usage: run-laya-macos-boundary-gate.mjs verify-candidate|egress-check|run');
  const options = {};
  const named = { '--runtime-tree': 'runtimeTree', '--model-tree': 'modelTree' };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (command === 'egress-check' || !Object.hasOwn(named, argument))
      fail('BOUNDARY_USAGE', `unknown argument ${JSON.stringify(argument)}`);
    const value = rest[++index];
    if (value === undefined || value.length === 0) fail('BOUNDARY_USAGE', `${argument} needs a directory`);
    options[named[argument]] = resolve(value);
  }
  return { command, options };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, options } = parseCommand(process.argv.slice(2));
    if (command === 'egress-check') {
      const result = await egressCheck();
      process.stdout.write(`Laya gate runner: none of ${result.probes} outside addresses is reachable\n`);
    } else if (command === 'verify-candidate') {
      const { architecture, boundaryCandidate } = await verifyRunCandidate(options);
      process.stdout.write(
        `Laya gate candidate: ${boundaryCandidate.manifestId} on ${architecture}, subject ${boundaryCandidate.subjectDigest}; both trees verify\n`,
      );
    } else {
      const result = await runBoundaryGate(options);
      for (const line of result.lines) process.stdout.write(`${line}\n`);
      process.stdout.write(`wrote ${result.path}${result.passed ? '' : ' (the run did not pass)'}\n`);
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    // Only a closed code and its fixed sentence: never a path, a child's output or an operating-system message.
    process.stderr.write(
      `${error instanceof BoundaryGateError ? error.message : 'BOUNDARY_RUN_FAILED: the boundary gate run failed'}\n`,
    );
    process.exitCode = 1;
  }
}
