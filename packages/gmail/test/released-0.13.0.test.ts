import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Core, openCore, withFileLock } from '@agentcomms/core';
import {
  baseEnvironment,
  NEEDS_TERMINAL,
  ROOT,
  sealAttempts,
  TERMINAL_PYTHON,
} from '../../../test/helpers/real-shell.mjs';
// `agentcomms doctor`, in this process, over core's own opening of this home: a child would reach for the keychain,
// which the seal refuses.
import { openCore as openCoreSource } from '../../core/src/core.ts';
import { CORE_CALLER } from '../../core/src/handoffs.ts';
import { doctor } from '../../core/src/operations/maintenance.ts';
import { GMAIL_CALLER } from '../src/caller.ts';
import { run } from '../src/cli/program.ts';
import { GmailContext } from '../src/context.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { DRAFT_SEND_PATH } from './support/fake-google.ts';
import { type Harness, migrateNamesForTest, newHarness, setAgentLabel } from './support/harness.ts';

/*
 * The released 0.13.0 `agent-gmail`, run as its own process beside this release over one home, one configuration and
 * one approvals store (CUE-404 Task 24; design 2026-10-05 §5 Round-28 and Round-29, and Task 1's person-revoke race).
 *
 * `fixtures/released-0.13.0/gmail` is `@agentcomms/gmail@0.13.0` as npm published it — `package.json` and `dist/`,
 * nothing edited, `FROZEN.json` recording the tarball's integrity and each file's SHA-256. It bundles its own 0.13.0
 * core. A released build will not take `AGENT_COMMS_GOOGLE_ROOT_URL`, so `support/released-google.mjs` hands every
 * request it makes to a Google host to this test's fake Google instead, from outside the release; the seal
 * (`test/helpers/seal-process.mjs`) is loaded first and refuses anything that is not loopback, and every test asserts
 * it refused nothing. No real Google, keychain or address is reached.
 *
 * The barrier is the fake's `holdNext`: the released `send execute` reads the configuration, then the draft, then
 * takes the record's lock to claim — holding the draft read pauses it after its last configuration read and before
 * the lock. Holding `drafts/send` pauses it after its claim.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FROZEN_DIR = join(HERE, 'fixtures', 'released-0.13.0', 'gmail');
const RELEASED_CLI = join(FROZEN_DIR, 'dist', 'cli.mjs');
const FROZEN_INTEGRITY =
  'sha512-q4DMLcCjOy7KLBRIhhuaOkK1QySU9JB4l+tRKcpCx1GaHsgTvAWCORF964NfW0pnph3oNub7TTEn0wVMnIslFA==';
const FROZEN_TARBALL = 'https://registry.npmjs.org/@agentcomms/gmail/-/gmail-0.13.0.tgz';
const REDIRECT = join(HERE, 'support', 'released-google.mjs');
const HOLD = join(HERE, 'support', 'released-hold.mjs');
const SEAL = join(ROOT, 'test', 'helpers', 'seal-process.mjs');
const TERMINAL = join(ROOT, 'test', 'helpers', 'terminal.py');
/** This release's own `agentcomms`, as built: the person's `agentcomms approvals revoke`. */
const CORE_CLI = join(ROOT, 'packages', 'core', 'dist', 'cli.mjs');

const ALIAS = 'acme/gmail';
const OTHER = 'acme/gmail-2';
const TO = 'sam@partner.test';
const SUBJECT = 'Tuesday';
const MIN = 60_000;
const DRAIN_REASON = 'prepared by an earlier release; prepare it again';
const VERSION_REFUSAL = /has version 3; this release reads versions 1 and 2/;

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Machine {
  harness: Harness;
  /** This release, in this process, on a clock a test can move forward. */
  core: Core;
  context: GmailContext;
  advance(ms: number): void;
  now(): Date;
  draftId: string;
  sealLog: string;
  /** The released `agent-gmail`, as its own process. With `terminal`, on a pseudo-terminal a person answers at. */
  released(
    args: readonly string[],
    options?: { terminal?: 'challenge' | 'enter'; holdWrite?: { record: string; signals: string } },
  ): Promise<Finished>;
  /** This release's `agent-gmail`, in this process, on the machine's clock. */
  current(args: readonly string[]): Promise<Finished>;
  /** This release's `agentcomms`, as its own process. */
  agentcomms(args: readonly string[]): Promise<Finished>;
  recordPath(approvalId: string, suffix?: string): string;
  bytes(approvalId: string): string;
  config(): Record<string, unknown>;
  /** Every request made of the fake Google from here on: `METHOD /path`. */
  requestsSince(mark: number): string[];
}

function finish(child: ReturnType<typeof spawn>): Promise<Finished> {
  return new Promise((settle, fail) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', fail);
    child.once('close', (code) => {
      clearTimeout(timer);
      settle({ code, stdout, stderr });
    });
  });
}

async function machine(): Promise<Machine> {
  const sendAs = (email: string) => [{ sendAsEmail: email, displayName: 'Jo', isDefault: true, isPrimary: true }];
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test', sendAs: sendAs('jo@example.test') },
      { sub: 'sub-2', email: 'kim@example.test', sendAs: sendAs('kim@example.test') },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'chat' });
  await harness.connectInbox({ alias: 'home', email: 'kim@example.test', sub: 'sub-2', sendPolicy: 'chat' });
  // `home` signs in as the first account, whose send-as list has no name for its address: the label's comes from here.
  await setAgentLabel(harness, { name: 'Kim Example' });
  // Version 2, as a configuration made or migrated since 0.11 is: the one 0.13.0 and this release share.
  await migrateNamesForTest(harness, [`work=${ALIAS}`, `home=${OTHER}`]);

  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const core = openCore({ env: harness.env, caller: GMAIL_CALLER, now });
  const context = new GmailContext({ core, env: harness.env, now, platform: 'darwin' });
  const draft = await createDraft(context, ALIAS, { to: [TO], subject: SUBJECT, text: 'Tuesday works.' });
  const sealLog = join(harness.configDir, 'seal.jsonl');
  const env = {
    ...baseEnvironment({ home: harness.configDir, sealLog }),
    AGENT_COMMS_CONFIG_DIR: harness.configDir,
    AGENTCOMMS_TEST_GOOGLE_ORIGIN: harness.google.url,
  };
  const imports = [`--import=${pathToFileURL(SEAL).href}`, `--import=${pathToFileURL(REDIRECT).href}`];
  const approvals = join(core.paths.stateDir, 'approvals');

  return {
    harness,
    core,
    context,
    advance: (ms) => {
      offset += ms;
    },
    now,
    draftId: draft.draftId,
    sealLog,
    released: (args, options = {}) => {
      const hold = options.holdWrite;
      const argv = [...imports, ...(hold ? [`--import=${pathToFileURL(HOLD).href}`] : []), RELEASED_CLI, ...args];
      const runEnv = hold
        ? { ...env, AGENTCOMMS_TEST_HOLD_WRITE: hold.record, AGENTCOMMS_TEST_HOLD_SIGNALS: hold.signals }
        : env;
      if (options.terminal === undefined) {
        return finish(
          spawn(process.execPath, argv, { env: runEnv, cwd: harness.configDir, stdio: ['ignore', 'pipe', 'pipe'] }),
        );
      }
      if (!TERMINAL_PYTHON) throw new Error('no pseudo-terminal here: see NEEDS_TERMINAL');
      return finish(
        spawn(TERMINAL_PYTHON, [TERMINAL, options.terminal, process.execPath, ...argv], {
          env: runEnv,
          cwd: harness.configDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    },
    current: async (args) => {
      let stdout = '';
      let stderr = '';
      const out = new PassThrough().on('data', (chunk) => {
        stdout += String(chunk);
      });
      const err = new PassThrough().on('data', (chunk) => {
        stderr += String(chunk);
      });
      const code = await run(args, {
        core,
        env: harness.env,
        now,
        platform: 'darwin',
        streams: {
          stdout: Object.assign(out, { isTTY: false }),
          stderr: Object.assign(err, { isTTY: false }),
          stdin: Object.assign(new PassThrough(), { isTTY: false }),
        },
      });
      return { code, stdout, stderr };
    },
    agentcomms: (args) =>
      finish(
        spawn(process.execPath, [`--import=${pathToFileURL(SEAL).href}`, CORE_CLI, ...args], {
          env,
          cwd: harness.configDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      ),
    recordPath: (approvalId, suffix = '.json') => join(approvals, `${approvalId}${suffix}`),
    bytes: (approvalId) => readFileSync(join(approvals, `${approvalId}.json`), 'utf8'),
    config: () => JSON.parse(readFileSync(core.config.path, 'utf8')) as Record<string, unknown>,
    requestsSince: (mark) => harness.google.requests.slice(mark).map((request) => `${request.method} ${request.path}`),
  };
}

function envelope(run: Finished): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
} {
  try {
    return JSON.parse(run.stdout);
  } catch {
    assert.fail(`not a JSON envelope (exit ${run.code}): ${run.stdout}${run.stderr}`);
  }
}

/** The released `send prepare`: a version-1 approval of the machine's draft, by 0.13.0's own rules. */
async function releasedPrepare(m: Machine): Promise<string> {
  const prepared = await m.released(['send', 'prepare', m.draftId, '--inbox', ALIAS, '--json']);
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const approvalId = String(envelope(prepared).data?.approvalId);
  const written = JSON.parse(m.bytes(approvalId)) as Record<string, unknown>;
  assert.equal(written.digestVersion, 1, 'written by 0.13.0: version 1');
  assert.equal('kind' in written, false);
  return approvalId;
}

/** The released `send execute` of the machine's draft under `approvalId`, as an agent runs it. */
function releasedExecute(
  m: Machine,
  approvalId: string,
  options: Parameters<Machine['released']>[1] = {},
): Promise<Finished> {
  return m.released(
    [
      'send',
      'execute',
      m.draftId,
      '--inbox',
      ALIAS,
      '--approval',
      approvalId,
      '--expect-to',
      TO,
      '--expect-subject',
      SUBJECT,
      '--json',
    ],
    options,
  );
}

/** Holds the next request to `path` until released; fails the test if it never arrives. */
async function held(m: Machine, path: string): Promise<{ release(): void; reached: Promise<void> }> {
  const hold = m.harness.google.holdNext(path);
  return hold;
}

async function arrived(hold: { reached: Promise<void> }, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    hold.reached,
    new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`the released process never reached ${what}`)), 30_000);
    }),
  ]);
  clearTimeout(timer);
}

const draftPath = (m: Machine) => `/gmail/v1/users/me/drafts/${m.draftId}`;
const sends = (requests: string[]) => requests.filter((request) => request === `POST ${DRAFT_SEND_PATH}`);

/** This release's `inbox policy <alias> --send never`: tightening applies at once, converting and fencing first. */
async function turnSendingOff(m: Machine): Promise<Record<string, unknown>> {
  const result = await m.current(['inbox', 'policy', ALIAS, '--send', 'never', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return envelope(result).data ?? {};
}

/** This release's loosening of `alias` back to `chat`, as an agent runs it: prepared, then applied on the yes. */
async function turnSendingBackOn(m: Machine): Promise<Finished> {
  const first = await m.current(['inbox', 'policy', ALIAS, '--send', 'chat', '--json']);
  const pending = envelope(first);
  assert.equal(pending.error?.code, 'APPROVAL_PENDING', first.stdout);
  const approvalId = String(pending.error?.details?.approvalId);
  return m.current(['inbox', 'policy', ALIAS, '--send', 'chat', '--json', '--approval', approvalId]);
}

function nothingSealed(m: Machine): void {
  assert.deepEqual(sealAttempts(m.sealLog), [], 'no keychain, and no connection off this machine, was even tried');
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// ── The fixture is what npm published ──────────────────────────────────────────────────────────────────────────

test('the released 0.13.0 agent-gmail is the published tarball, unedited: its integrity, its version and every file', () => {
  const frozen = JSON.parse(readFileSync(join(FROZEN_DIR, 'FROZEN.json'), 'utf8')) as {
    name: string;
    version: string;
    integrity: string;
    tarball: string;
    files: Record<string, string>;
  };
  assert.equal(frozen.name, '@agentcomms/gmail');
  assert.equal(frozen.version, '0.13.0');
  assert.equal(frozen.integrity, FROZEN_INTEGRITY, 'npm’s dist.integrity for @agentcomms/gmail@0.13.0');
  assert.equal(frozen.tarball, FROZEN_TARBALL);
  const manifest = JSON.parse(readFileSync(join(FROZEN_DIR, 'package.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.name, '@agentcomms/gmail');
  assert.equal(manifest.version, '0.13.0');
  const onDisk = walk(FROZEN_DIR)
    .map((path) => relative(FROZEN_DIR, path).split(sep).join('/'))
    .filter((path) => path !== 'FROZEN.json')
    .sort();
  assert.deepEqual(onDisk, Object.keys(frozen.files).sort(), 'exactly the files recorded, no more and no fewer');
  for (const [path, sha256] of Object.entries(frozen.files)) {
    const actual = createHash('sha256')
      .update(readFileSync(join(FROZEN_DIR, ...path.split('/'))))
      .digest('hex');
    assert.equal(actual, sha256, `${path} is as published`);
  }
});

test('the released agent-gmail runs here as 0.13.0, against the fake Google only', async () => {
  const m = await machine();
  const version = await m.released(['--version']);
  assert.equal(version.stdout.trim(), '0.13.0');
  const mark = m.harness.google.requests.length;
  const approvalId = await releasedPrepare(m);
  // This release reads what 0.13.0 wrote, in the same store: one legacy record, never its to claim.
  const read = await m.core.approvals.get(approvalId);
  assert.equal(read?.form, 'legacy');
  assert.ok(m.requestsSince(mark).includes(`GET ${draftPath(m)}`), 'the released process asked the fake for the draft');
  nothingSealed(m);
});

// ── Round 28: after a 0.14 conversion, 0.13.0 refuses everything before it asks Google anything ──────────────

test('after a 0.14 never converts the config, the released prepare, execute, approve and send-policy commands refuse with "this release reads versions 1 and 2" and ask Google nothing — its own approval included, and after never → chat over a failed sweep (R28a)', async () => {
  const m = await machine();
  // Prepared by 0.13.0 itself while the configuration was still version 2.
  const own = await releasedPrepare(m);
  // A version-2 send this release prepared, whose revocation by the never sweep is forced to fail: its lock is busy.
  const prepared = await m.current(['send', 'prepare', m.draftId, '--inbox', ALIAS, '--json']);
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const v2 = String(envelope(prepared).data?.approvalId);
  assert.equal(m.config().version, 3, 'this release’s prepare converted it first');
  let releaseLock!: () => void;
  const lockHeld = new Promise<void>((settle) => {
    void withFileLock(`${m.recordPath(v2)}.lock`, () => {
      settle();
      return new Promise<void>((done) => {
        releaseLock = done;
      });
    });
  });
  await lockHeld;
  const off = await turnSendingOff(m);
  releaseLock();
  const fenced = off.fenced as { revoked: string[]; couldNotRevoke: string[] };
  assert.deepEqual(fenced.couldNotRevoke, [v2], 'the sweep could not revoke it');
  assert.equal((m.config().sendEpochs as Record<string, number>)[idOf(m)], 1, 'the epoch raised');

  const refusesBeforeGoogle = async (what: string, args: readonly string[], terminal?: 'challenge') => {
    const mark = m.harness.google.requests.length;
    const refused = await m.released(args, terminal === undefined ? {} : { terminal });
    assert.equal(refused.code, 78, `${what}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stdout + refused.stderr, VERSION_REFUSAL, what);
    assert.deepEqual(m.requestsSince(mark), [], `${what}: Google was asked nothing`);
  };
  const everyCommand = async (moment: string) => {
    await refusesBeforeGoogle(`${moment}: prepare`, ['send', 'prepare', m.draftId, '--inbox', ALIAS, '--json']);
    await refusesBeforeGoogle(`${moment}: execute of its own approval`, [
      'send',
      'execute',
      m.draftId,
      '--inbox',
      ALIAS,
      '--approval',
      own,
      '--expect-to',
      TO,
      '--expect-subject',
      SUBJECT,
      '--json',
    ]);
    await refusesBeforeGoogle(`${moment}: send policy`, ['inbox', 'policy', ALIAS, '--send', 'chat', '--json']);
    if (TERMINAL_PYTHON) {
      await refusesBeforeGoogle(`${moment}: approve of its own approval`, ['approve', own], 'challenge');
    }
  };
  await everyCommand('under never');

  // Loosened again by this release, once the drain retiring 0.13.0's own approval has closed.
  m.advance(10 * MIN);
  const on = await turnSendingBackOn(m);
  assert.equal(on.code, 0, on.stdout + on.stderr);
  assert.equal(m.config().version, 3, 'never written back as version 2');
  await everyCommand('after never → chat');

  // Nothing the earlier approvals permit can send through this release either.
  const mark = m.harness.google.requests.length;
  const claimed = await m.current([
    'send',
    'execute',
    m.draftId,
    '--inbox',
    ALIAS,
    '--approval',
    v2,
    '--expect-to',
    TO,
    '--expect-subject',
    SUBJECT,
    '--json',
  ]);
  assert.equal(claimed.code, 10, claimed.stdout);
  assert.deepEqual(sends(m.requestsSince(mark)), []);
  nothingSealed(m);
});

function idOf(m: Machine): string {
  const inboxes = m.config().inboxes as Record<string, { id: string }>;
  return String(inboxes[ALIAS]?.id);
}

// ── Round 29: a 0.13.0 operation paused after its last config read, and a 0.14 conversion meanwhile ─────────────

test('a released execute held after its config read: 0.14 converts and turns sending off, the drain retires the approval, and the released claim is refused with no transition and no send (R29a)', async () => {
  const m = await machine();
  const approvalId = await releasedPrepare(m);
  const hold = await held(m, draftPath(m));
  const executing = releasedExecute(m, approvalId);
  await arrived(hold, 'its draft read');

  const off = await turnSendingOff(m);
  assert.equal(m.config().version, 3);
  assert.deepEqual(off.legacyDrain, { couldNotRevoke: [], inFlight: [] });
  const retired = m.bytes(approvalId);
  assert.equal(JSON.parse(retired).state, 'revoked');
  assert.equal(JSON.parse(retired).reason, DRAIN_REASON);
  assert.equal(JSON.parse(retired).digestVersion, 1, 'retired in its own shape');

  const mark = m.harness.google.requests.length;
  hold.release();
  const refused = await executing;
  assert.equal(refused.code, 10, refused.stdout + refused.stderr);
  const error = envelope(refused).error;
  assert.equal(error?.code, 'APPROVAL_VOID');
  assert.equal(error?.message, `nothing was sent: the approval was voided (${DRAIN_REASON})`);
  assert.equal(m.bytes(approvalId), retired, 'the released claim wrote no transition');
  assert.equal(existsSync(m.recordPath(approvalId, '.claim')), false, 'and no claim marker');
  assert.deepEqual(sends(m.requestsSince(mark)), [], 'Google was asked to send nothing');
  nothingSealed(m);
});

test(
  'a released terminal approval held after its config read: the drain retires the approval, and the released approval is refused before it asks for a code (R29a)',
  NEEDS_TERMINAL,
  async () => {
    const m = await machine();
    const approvalId = await releasedPrepare(m);
    // A terminal approval reads the configuration once more as it opens the mailbox after the draft read, so its last
    // configuration read comes before its look at Sent (the recipient study) — the barrier — and its lock after it.
    const hold = await held(m, '/gmail/v1/users/me/messages');
    const approving = m.released(['approve', approvalId], { terminal: 'challenge' });
    await arrived(hold, 'the recipient study of its terminal approval');

    await turnSendingOff(m);
    const retired = m.bytes(approvalId);
    assert.equal(JSON.parse(retired).state, 'revoked');

    hold.release();
    const refused = await approving;
    assert.equal(refused.code, 10, refused.stdout + refused.stderr);
    assert.match(refused.stdout, new RegExp(`voided \\(${DRAIN_REASON.replace(/[.;]/g, '.')}\\)`));
    assert.doesNotMatch(refused.stdout, /Type \S+ to send this/, 'no code was asked for');
    assert.equal(m.bytes(approvalId), retired, 'no transition: not approved, no challenge');
    nothingSealed(m);
  },
);

test('the drain’s revocation forced to fail under a held released execute: named, still pending, loosening refused, retried by the next 0.14 operation, then loosening allowed — and the released claim is refused (R29b)', async () => {
  const m = await machine();
  const approvalId = await releasedPrepare(m);
  const hold = await held(m, draftPath(m));
  const executing = releasedExecute(m, approvalId);
  await arrived(hold, 'its draft read');

  // The record's lock is busy for as long as this release's never change takes: its revocation cannot be made.
  const original = m.bytes(approvalId);
  let releaseLock!: () => void;
  await new Promise<void>((settle) => {
    void withFileLock(`${m.recordPath(approvalId)}.lock`, () => {
      settle();
      return new Promise<void>((done) => {
        releaseLock = done;
      });
    });
  });
  const off = await turnSendingOff(m);
  releaseLock();
  assert.deepEqual(off.legacyDrain, { couldNotRevoke: [approvalId], inFlight: [] }, 'the record is named');
  const drain = m.config().legacyDrain as { tracked: Record<string, string> };
  assert.deepEqual(drain.tracked, { [approvalId]: 'open' }, 'the drain stays pending');
  assert.equal(m.bytes(approvalId), original, 'not retired yet');

  const refusedLoosening = await turnSendingBackOn(m);
  assert.equal(refusedLoosening.code, 75, refusedLoosening.stdout);
  assert.match(envelope(refusedLoosening).error?.message ?? '', /still being retired/);

  // The next operation of this release that relies on the epoch — a send prepared from the other mailbox — retries it.
  const other = await createDraft(m.context, OTHER, { to: [TO], subject: 'Other', text: 'Other.' });
  const retry = await m.current(['send', 'prepare', other.draftId, '--inbox', OTHER, '--json']);
  assert.equal(retry.code, 0, retry.stdout + retry.stderr);
  assert.deepEqual(envelope(retry).data?.legacyDrain, { couldNotRevoke: [], inFlight: [] });
  assert.deepEqual((m.config().legacyDrain as { tracked: Record<string, string> }).tracked, {
    [approvalId]: 'revoked',
  });
  const retired = m.bytes(approvalId);
  assert.deepEqual(JSON.parse(retired), {
    ...JSON.parse(original),
    state: 'revoked',
    reason: DRAIN_REASON,
    updatedAt: JSON.parse(retired).updatedAt,
  });

  // Released only now: its claim meets the retired record.
  const mark = m.harness.google.requests.length;
  hold.release();
  const refused = await executing;
  assert.equal(refused.code, 10, refused.stdout + refused.stderr);
  assert.equal(envelope(refused).error?.message, `nothing was sent: the approval was voided (${DRAIN_REASON})`);
  assert.equal(m.bytes(approvalId), retired);
  assert.deepEqual(sends(m.requestsSince(mark)), []);

  // Loosening still waits for the drain's own lifetime, and then is allowed.
  const early = await turnSendingBackOn(m);
  assert.equal(early.code, 75, early.stdout);
  m.advance(10 * MIN);
  const loosened = await turnSendingBackOn(m);
  assert.equal(loosened.code, 0, loosened.stdout + loosened.stderr);
  assert.equal(m.config().legacyDrain, undefined, 'the drain closed');
  nothingSealed(m);
});

test('a released claim holding the record lock when 0.14 converts completes, and the conversion lists it (R29c)', async () => {
  const m = await machine();
  const approvalId = await releasedPrepare(m);
  // Paused inside its record lock: it has read the record pending and not yet written `sending`.
  const signals = mkdtempSync(join(m.harness.configDir, 'hold-'));
  const mark = m.harness.google.requests.length;
  const executing = releasedExecute(m, approvalId, { holdWrite: { record: m.recordPath(approvalId), signals } });
  await until(() => existsSync(join(signals, 'reached')), 'the released claim inside its lock');
  assert.equal(JSON.parse(m.bytes(approvalId)).state, 'pending');

  // The conversion's scan reads it pending and tracks it; its retirement then waits for the lock 0.13.0 holds. Once
  // the version-3 write tracks it, the claim goes on and writes `sending`: the retirement finds a send under way.
  const off = turnSendingOff(m);
  await until(() => {
    const config = m.config();
    const tracked = (config.legacyDrain as { tracked?: Record<string, string> } | undefined)?.tracked;
    return config.version === 3 && tracked?.[approvalId] === 'open';
  }, 'the version-3 write tracking it');
  writeFileSync(join(signals, 'release'), '');
  const report = await off;
  assert.deepEqual(report.legacyDrain, { couldNotRevoke: [], inFlight: [approvalId] }, 'the conversion lists it');

  /*
   * It completes as 0.13.0 completes a claim: its last look at the draft reads the configuration once more, finds
   * version 3, and records the send failed without asking Google to send — so the drain saw it under way, or already
   * failed, depending on which took the lock first. Either way nothing went out.
   */
  const finished = await executing;
  assert.equal(finished.code, 78, finished.stdout + finished.stderr);
  assert.match(envelope(finished).error?.message ?? '', VERSION_REFUSAL);
  const tracked = (m.config().legacyDrain as { tracked: Record<string, string> }).tracked[approvalId];
  assert.ok(tracked === 'sending' || tracked === 'failed', `tracked as ${tracked}`);
  const record = JSON.parse(m.bytes(approvalId)) as Record<string, unknown>;
  assert.equal(record.state, 'failed');
  assert.equal(record.digestVersion, 1, 'in its own shape');
  assert.deepEqual(sends(m.requestsSince(mark)), [], 'nothing sent');
  nothingSealed(m);
});

test('a released send past its last config read when 0.14 converts is the documented limit: it is sent, once — and the conversion lists it, and doctor shows it (R29c, CUE-404)', async () => {
  const m = await machine();
  const approvalId = await releasedPrepare(m);
  const hold = await held(m, DRAFT_SEND_PATH);
  const mark = m.harness.google.requests.length;
  const executing = releasedExecute(m, approvalId);
  await arrived(hold, 'drafts/send');
  assert.equal(JSON.parse(m.bytes(approvalId)).state, 'sending', 'claimed, and its draft read again, before');

  // Being sent already, it is no record the drain can retire — and so the one the stated limit says the conversion
  // names: tracked as being sent from the start, listed by the call that converted, shown by doctor.
  const off = await turnSendingOff(m);
  assert.deepEqual(off.legacyDrain, { couldNotRevoke: [], inFlight: [approvalId] }, 'the conversion lists it');
  assert.deepEqual((m.config().legacyDrain as { tracked: Record<string, string> }).tracked, {
    [approvalId]: 'sending',
  });
  assert.equal(JSON.parse(m.bytes(approvalId)).state, 'sending', 'never revoked under it');
  const agentcomms = openCoreSource({ env: m.harness.env, caller: CORE_CALLER });
  const shown = (await doctor(agentcomms, m.harness.env, { keyring: null })).checks.find(
    (check) => check.name === 'earlier-release approvals',
  );
  assert.match(shown?.detail ?? '', new RegExp(`1 reached by an earlier release's send \\(${approvalId}\\)$`));

  hold.release();
  const sent = await executing;
  assert.equal(sent.code, 0, sent.stdout + sent.stderr);
  assert.equal(typeof envelope(sent).data?.sentMessageId, 'string');
  assert.equal(sends(m.requestsSince(mark)).length, 1, 'exactly one send');
  assert.equal(JSON.parse(m.bytes(approvalId)).state, 'used');
  nothingSealed(m);
});

/** Waits for `ready`, polling; fails the test after 30 seconds. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`never reached: ${what}`);
    await sleep(10);
  }
}

// ── Task 1's legacy path against a real 0.13.0 claim: a person's "no" and the record lock ──────────────────────

test('a person’s revoke that takes the record lock first stops a frozen 0.13 claim', async () => {
  const m = await machine();
  const approvalId = await releasedPrepare(m);
  const original = m.bytes(approvalId);
  const hold = await held(m, draftPath(m));
  const executing = releasedExecute(m, approvalId);
  await arrived(hold, 'its draft read');

  // `agentcomms approvals revoke <id>`, this release's, as the person runs it; then the claim goes on.
  const revoked = await m.agentcomms(['approvals', 'revoke', approvalId, '--json']);
  const written = m.bytes(approvalId);
  const mark = m.harness.google.requests.length;
  hold.release();
  const refused = await executing;
  assert.deepEqual(sends(m.requestsSince(mark)), [], 'no drafts/send request');
  assert.equal(refused.code, 10, refused.stdout + refused.stderr);
  assert.equal(envelope(refused).error?.message, 'nothing was sent: the approval was voided (revoked by the user)');
  assert.equal(existsSync(m.recordPath(approvalId, '.claim')), false, 'no claim marker');
  assert.equal(m.bytes(approvalId), written, 'the released claim wrote nothing over the revoke');

  assert.equal(revoked.code, 0, revoked.stdout + revoked.stderr);
  assert.equal(m.config().version, 2, 'no conversion: a person’s revoke relies on no epoch');
  assert.equal(m.config().legacyDrain, undefined);
  assert.deepEqual(JSON.parse(written), {
    ...JSON.parse(original),
    state: 'revoked',
    reason: 'revoked by the user',
    updatedAt: JSON.parse(written).updatedAt,
  });
  // 0.13.0's own store reads it revoked.
  const released = (await import(
    pathToFileURL(join(ROOT, 'packages', 'core', 'test', 'fixtures', 'released-0.13.0', 'core', 'dist', 'index.mjs'))
      .href
  )) as { ApprovalStore: new (stateDir: string) => { get(id: string): Promise<{ state: string } | null> } };
  assert.equal((await new released.ApprovalStore(m.core.paths.stateDir).get(approvalId))?.state, 'revoked');
  nothingSealed(m);
});

test('a frozen 0.13 claim that takes the record lock first is the documented locked-winner limit', async () => {
  const m = await machine();
  const approvalId = await releasedPrepare(m);
  const hold = await held(m, DRAFT_SEND_PATH);
  const mark = m.harness.google.requests.length;
  const executing = releasedExecute(m, approvalId);
  await arrived(hold, 'drafts/send');
  const claimed = m.bytes(approvalId);
  assert.equal(JSON.parse(claimed).state, 'sending');

  const revoked = await m.agentcomms(['approvals', 'revoke', approvalId, '--json']);
  assert.equal(revoked.code, 0, revoked.stdout + revoked.stderr);
  assert.equal(envelope(revoked).data?.state, 'sending', 'the revoke returns the record as it is: being sent');
  assert.equal(m.bytes(approvalId), claimed, 'and writes nothing');

  hold.release();
  const sent = await executing;
  assert.equal(sent.code, 0, sent.stdout + sent.stderr);
  assert.equal(sends(m.requestsSince(mark)).length, 1, 'the in-flight send completes, once');
  assert.equal(JSON.parse(m.bytes(approvalId)).state, 'used');
  nothingSealed(m);
});
