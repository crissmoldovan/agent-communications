import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore } from '../src/approvals.ts';
import { newApprovalId } from '../src/ids.ts';
import { renderChannelPreview } from '../src/render.ts';
import { securityNotice } from '../src/update-gate.ts';
import { readUpdateCheck, securityAnswered } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { coreHandoffs } from './helpers/handoffs.ts';
import { holdLock } from './helpers/hold-lock.ts';
import { liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';
import { LATEST, launchedThrough, machine, markJobSetUp, seed } from './helpers/update-machine.ts';

/*
 * The security line (design 2026-10-16, U7): on `every-14-days`, `never`, and `auto` while its background job is not
 * set up, a release whose manifest declares a security fix puts one line first in the next send or post preview —
 * once — and the person's yes to that preview is the answer. One core helper, which every channel's prepare calls.
 */

const SECURITY = { version: LATEST, security: true, needsDecision: false };
const LINE = `A security fix is out (${LATEST}): update first, or approve to send anyway`;

test('a security release is asked about in every preview until the person answers one, on every level that does not install it', async () => {
  for (const config of [{}, { defaults: { updates: 'every-14-days' } }, { defaults: { updates: 'never' } }]) {
    const m = machine({}, config);
    await seed(m, { latest: LATEST, behind: true, release: SECURITY });
    const first = newApprovalId();
    assert.equal(
      await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: first }),
      LINE,
      JSON.stringify(config),
    );
    // Prepared and never answered — set aside, let run out, refused: it was not answered, so the next preview asks.
    const second = newApprovalId();
    assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: second }), LINE);
    assert.equal((await readUpdateCheck(m.stateDir)).securityAsked, null, 'counted as asked before an answer');
    // An answer to an approval no preview carried the line on is not this question's.
    await securityAnswered(m.stateDir, newApprovalId());
    assert.equal(
      await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: newApprovalId() }),
      LINE,
    );
    // The person's yes to a preview that carried it is the answer: asked once, then never again for that release.
    await securityAnswered(m.stateDir, first);
    assert.equal((await readUpdateCheck(m.stateDir)).securityAsked, LATEST);
    assert.equal(
      await securityNotice({ core: m.core, env: m.env, running: VERSION, act: 'post', approvalId: newApprovalId() }),
      null,
      'asked again after the answer',
    );
  }
  // Each act in its own words: a post is approved to post.
  const slack = machine();
  await seed(slack, { latest: LATEST, behind: true, release: SECURITY });
  assert.equal(
    await securityNotice({
      core: slack.core,
      env: slack.env,
      running: VERSION,
      act: 'post',
      approvalId: newApprovalId(),
    }),
    `A security fix is out (${LATEST}): update first, or approve to post anyway`,
  );
});

test('the approval store counts the answer when a send is approved, or claimed to be sent — never when it is only prepared or revoked', async () => {
  const dir = tempDir();
  const paths = { configDir: dir, stateDir: dir, dataDir: dir, secretsDir: dir, downloadsDir: dir };
  const INBOX = 'ibx_AAAAAAAAAAAAAAAA';
  const expect = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' };
  const draft = { draftMessageId: 'msg-v1', contentDigest: 'a'.repeat(64) };
  const config = liveConfig(dir, { inboxes: { 'acme/gmail': { id: INBOX, sendPolicy: 'confirm' } } });
  const answered: string[] = [];
  const store = new ApprovalStore(dir, {
    handoffs: coreHandoffs(paths),
    loadConfig: config.loadConfig,
    answered: async (approvalId) => {
      answered.push(approvalId);
    },
  });
  const create = () =>
    store.create({
      channel: 'gmail',
      inboxId: INBOX,
      inboxSub: 'sub-1',
      draftId: 'r-draft-1',
      ...draft,
      sendEpoch: 0,
      policy: 'confirm',
      requiredPolicy: 'confirm',
      riskFlags: [],
      expect,
    });
  const record = await create();
  assert.deepEqual(answered, [], 'a preview prepared is no answer');
  const challenge = await store.issueChallenge(record.approvalId);
  assert.deepEqual(answered, []);
  await store.approve(record.approvalId, 'terminal', draft, challenge.toLowerCase());
  assert.deepEqual(answered, [record.approvalId], 'approved at a terminal: answered');
  await store.claimForSend(record.approvalId, { inboxId: INBOX, inboxSub: 'sub-1', ...draft, expect });
  assert.deepEqual(answered, [record.approvalId, record.approvalId], 'claimed to be sent: answered');
  // Revoked before anyone said yes: no answer.
  const revoked = await create();
  await store.revoke(revoked.approvalId, 'the person said no', { disposition: 'person' });
  assert.deepEqual(answered, [record.approvalId, record.approvalId]);
});

test('the core wires the approval store to the security question: a send claimed answers it', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true, release: SECURITY });
  const id = newApprovalId();
  assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: id }), LINE);
  // The store's hook, as `openCore` hands it in: the same answer as `securityAnswered`.
  await m.core.approvals.answered?.(id);
  assert.equal((await readUpdateCheck(m.stateDir)).securityAsked, LATEST);
});

/**
 * The daily check's lock handed on for 6 s, a holder a second, as a busy machine's refreshes hand it on — longer than a
 * preview, or the send a person approved, may wait on its account. `over()` says whether the last holder let go.
 */
async function handedOnFor6s(m: ReturnType<typeof machine>) {
  const held = holdLock(join(m.stateDir, '.update-check.lock'), [1_000, 1_000, 1_000, 1_000, 1_000, 1_000]);
  await held.taken;
  let done = false;
  void held.then(() => {
    done = true;
  });
  return { held, over: () => done };
}

test("a preview's security line waits 2 s at most for a lock handed on, and the next preview carries it", async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true, release: SECURITY });
  const { held, over } = await handedOnFor6s(m);
  // Shown only once the approval it is shown on is recorded: busy, this preview goes without, and is not held up.
  assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: newApprovalId() }), null);
  assert.equal(over(), false, 'the preview waited until the lock was free');
  await held;
  assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: newApprovalId() }), LINE);
});

test("the person's answer to the security line waits 2 s at most for a lock handed on, and the line is asked once more", async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true, release: SECURITY });
  const id = newApprovalId();
  assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: id }), LINE);
  const { held, over } = await handedOnFor6s(m);
  // The approval store awaits this as a send is approved, or claimed: the send is not held up for it.
  await securityAnswered(m.stateDir, id);
  assert.equal(over(), false, 'the answer waited until the lock was free');
  assert.equal((await readUpdateCheck(m.stateDir)).securityAsked, null, 'nothing was recorded while it was busy');
  await held;
  // Unrecorded, the question is still open: the next preview asks it once more, and the answer to that one counts.
  const again = newApprovalId();
  assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION, approvalId: again }), LINE);
  await securityAnswered(m.stateDir, again);
  assert.equal((await readUpdateCheck(m.stateDir)).securityAsked, LATEST);
});

test('nothing is said when no security release is waiting, when the job installs it, when running it already, or switched off', async () => {
  const cases: [string, () => Promise<ReturnType<typeof machine>>][] = [
    [
      'not a security release',
      async () => {
        const m = machine();
        await seed(m, { latest: LATEST, behind: true, release: { ...SECURITY, security: false } });
        return m;
      },
    ],
    [
      'the facts are of another release',
      async () => {
        const m = machine();
        await seed(m, { latest: LATEST, behind: true, release: { ...SECURITY, version: '98.0.0' } });
        return m;
      },
    ],
    [
      'auto, with its background job set up: it installs within a day',
      async () => {
        const m = machine();
        // A minor release the job installs on its own, for a process started through the launcher it switches: only
        // such a process is the job's (re-review of 0.20.0, severity 6; update-job-reach.test.ts has the others).
        const [major, minor] = VERSION.split('.').map(Number) as [number, number];
        const fix = `${major}.${minor + 1}.0`;
        await seed(m, { latest: fix, behind: true, release: { ...SECURITY, version: fix } });
        markJobSetUp(m);
        Object.assign(m.env, launchedThrough(m, 'core', VERSION));
        return m;
      },
    ],
    [
      'already running it',
      async () => {
        const m = machine();
        await seed(m, { latest: VERSION, behind: false, release: { ...SECURITY, version: VERSION } });
        return m;
      },
    ],
    [
      'CI',
      async () => {
        const m = machine({ CI: 'true' });
        await seed(m, { latest: LATEST, behind: true, release: SECURITY });
        return m;
      },
    ],
  ];
  for (const [label, make] of cases) {
    const m = await make();
    assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION }), null, label);
  }
  // A file nobody has written: nothing, and nothing thrown.
  const empty = machine();
  assert.equal(await securityNotice({ core: empty.core, env: empty.env, running: VERSION }), null);
});

test('a channel preview carries the line first, above everything it shows', () => {
  const rendered = renderChannelPreview({
    security: `A security fix is out (${LATEST}): update first, or approve to post anyway`,
    workspace: 'acme/slack',
    postingAs: 'Jo (U1)',
    channel: '#eng',
    body: 'shipping now',
    notifies: { channel: false, here: false, users: [], estimated: 0 },
    context: { approvalId: 'ap_1' },
  });
  assert.equal(rendered.split('\n')[0], `A security fix is out (${LATEST}): update first, or approve to post anyway`);
  assert.match(rendered.split('\n')[1] as string, /POST PREVIEW/);
});
