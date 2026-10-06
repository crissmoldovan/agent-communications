import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { ROWS } from './helpers/approval-matrix.mjs';
import { ROOT } from './helpers/real-shell.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/**
 * The D2 outcome matrix, every row on every surface (CUE-404 Task 24; design 2026-10-05 §D2 and §5 D2-a).
 *
 * D2 is one locked classification of every approval record into an outcome, which every surface reports as it is:
 * Gmail's tools, command and terminal approval, Slack's posts, posts with files, reactions, edits and deletions,
 * Resend's sends, core's changes, the download questions, and every status, wait and list. Each package's driver
 * (`test/support/matrix.ts`, listed below) prepares a real approval through its own surface on a fresh home with its
 * fake provider, puts it into each row's state through `test/helpers/approval-matrix.mjs` — the one place states are
 * made — acts on it through each of its surfaces, and writes down what each said, one JSON line each. This file holds
 * what D2 says each must be, and holds every line to it.
 *
 * What a row is, here:
 *
 * | row | the record |
 * |---|---|
 * | not-found | an id nobody prepared, another owner's, another kind's, another channel's, or pinned away |
 * | corrupt | a parseable, attributable record whose timestamps its state does not allow |
 * | pending-chat | pending on the chat route, the live policy still chat |
 * | pending-confirm | pending on the confirm route: waiting for a person outside the chat |
 * | wrong-code-1/2/3 | a confirm approval the person typed a wrong code for, once, twice, three times |
 * | approved | approved at the terminal, inside its day |
 * | live-never | pending, the owner's policy turned to never and the revocation not there yet |
 * | revoked-by-never | revoked by a never, the policy back to chat |
 * | expired-pending, expired-approved | expired before approval; approved, then a day unused |
 * | clock-anomaly | observed with the clock before its creation |
 * | provider-uncertain | claimed, and the provider's answer leaves the outcome uncertain |
 * | sending, unknown | another call's claim inside its lease; past it |
 * | used, failed, revoked | sent (or the change claimed); failed; cancelled by a person |
 * | answered, expired-unanswered, expired-answered | a download question answered; expired before; answered, then expired |
 *
 * A surface that departs from D2 where a decision for the coordinator is still open is listed in `KNOWN` with what it
 * does instead: its case runs, and is reported as a TODO rather than passed or failed.
 */

/** The drivers: each a package's own program, run with its own fakes. */
const DRIVERS = [
  ...['gmail', 'slack', 'resend'].map((channel) => ({
    channel,
    dir: join(ROOT, 'packages', channel),
    entry: join('test', 'support', 'matrix.ts'),
  })),
  { channel: 'core', dir: join(ROOT, 'packages', 'core'), entry: join('test', 'helpers', 'matrix.ts') },
];

/** Every surface each driver must report on, by the action it takes: nothing named here may go missing. */
const SURFACES = {
  gmail: {
    send: {
      look: ['gmail_send_wait'],
      list: ['gmail_send_list'],
      claim: ['gmail_draft_send', 'gmail_draft_send (a client trusted with forms)', 'send execute'],
      approve: ['approve (terminal)'],
    },
    download: {
      look: ['gmail_send_wait (a download’s question)'],
      claim: ['gmail_attachment_download'],
    },
  },
  slack: {
    send: {
      look: [
        'slack_approval_wait (a post)',
        'slack_approval_wait (a post with a file)',
        'slack_approval_wait (a reaction)',
        'slack_approval_wait (an edit)',
        'slack_approval_wait (a deletion)',
      ],
      claim: [
        'slack_post_send',
        'slack_post_send (a post with a file)',
        'slack_react_send',
        'slack_edit_send',
        'slack_delete_send',
      ],
      approve: [
        'approve (terminal, a post)',
        'approve (terminal, a post with a file)',
        'approve (terminal, a reaction)',
        'approve (terminal, an edit)',
        'approve (terminal, a deletion)',
      ],
    },
    download: {
      look: ['slack_approval_wait (a download’s question)'],
      claim: ['slack_file_download'],
    },
  },
  resend: {
    send: {
      look: ['resend_send_status', 'resend_send_wait'],
      claim: ['resend_send_execute'],
      approve: ['approve (terminal)'],
    },
  },
  core: {
    send: {
      look: ['gmail', 'slack', 'resend'].map((channel) => `comms_approval_wait (a ${channel} send)`),
      list: ['gmail', 'slack', 'resend'].map((channel) => `comms_approvals_list (a ${channel} send)`),
    },
    change: {
      look: ['comms_approval_wait'],
      list: ['comms_approvals_list'],
      claim: ['comms_attach'],
      approve: ['agentcomms approve'],
    },
  },
};

/**
 * Where a surface does not do what D2 says, and the decision is not this task's: the observation's case is reported as
 * a TODO naming what it does instead.
 */
const KNOWN = [];

const NOT_FOUND_APPROVAL_NULL = true;

/** Every observation, by driver. */
let seen = [];

function run(driver, out) {
  return new Promise((settle, fail) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', driver.entry],
      {
        cwd: driver.dir,
        env: { ...process.env, AGENTCOMMS_MATRIX_OUT: out, NO_COLOR: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', fail);
    child.once('close', (code) => settle({ code, stderr }));
  });
}

before(async () => {
  const dir = await tempDir('approval-matrix-');
  const runs = await Promise.all(
    DRIVERS.map(async (driver) => {
      const out = join(dir, `${driver.channel}.jsonl`);
      const finished = await run(driver, out);
      assert.equal(finished.code, 0, `the ${driver.channel} driver failed:\n${finished.stderr}`);
      return readFileSync(out, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }),
  );
  seen = runs.flat();
});

// ── What each row must say ─────────────────────────────────────────────────────────────────────────────────────────

/** A look or a list: the approval's state and whether it can be claimed now. */
function shows(state, claimable, extra = () => {}) {
  return (o, line) => {
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.ok(o.approval, 'the record is shown');
    assert.equal(o.approval.state, state);
    // Resend's `send status` is its send-record look-up, not the approval-status contract (D8): it shows the record as
    // stored. Every other look and list is the approval object, and says whether it can be claimed now.
    if (!STORED_ONLY.has(line.surface)) assert.equal(o.approval.claimable, claimable);
    extra(o, line);
  };
}

/** The looks that show the record as stored rather than as classified (design 2026-10-05 §D8, "Status at any time"). */
const STORED_ONLY = new Set(['resend_send_status']);

/** A refusal: its code, its words, and where the approval stands — and nothing asked of the provider. */
function refused(code, pattern, state, extra = () => {}) {
  return (o) => {
    assert.equal(o.ok, false, `refused, not done: ${JSON.stringify(o)}`);
    assert.equal(o.code, code, o.message);
    assert.match(o.message, pattern);
    assert.equal(o.sends, 0, 'nothing was sent, posted, reacted or saved');
    // D2: every surface classifies before it acts — a refusal for the record's state asks the provider nothing at all.
    if (o.asked !== undefined) assert.equal(o.asked, 0, 'the provider was asked nothing, not even a read');
    if (state !== null) {
      assert.ok(o.approval, `the refusal says where the approval stands: ${JSON.stringify(o)}`);
      assert.equal(o.approval.state, state);
      // A corrupt record's object is its stub, `{ approvalId, state, reason }`: nothing else of it is shown (D2).
      if (state === 'corrupt') assert.deepEqual(Object.keys(o.approval).sort(), ['approvalId', 'reason', 'state']);
      else assert.equal(o.approval.claimable, false);
    }
    // D2: APPROVAL_REQUIRED never describes a record that is approved, finished, unusable or being sent.
    if (['approved', 'expired', 'used', 'failed', 'sending', 'unknown', 'corrupt', 'revoked'].includes(state)) {
      assert.notEqual(o.code, 'APPROVAL_REQUIRED');
    }
    extra(o);
  };
}

/** Sent, once, with the approval spent. */
function sent(o) {
  assert.equal(o.ok, true, `sent: ${JSON.stringify(o)}`);
  assert.equal(o.sends, 1, 'exactly one send');
  assert.equal(o.approval?.state, 'used');
  assert.equal(o.approval?.claimable, false);
}

/** Approved at the terminal: a day to use it. */
function approvedNow(o) {
  assert.equal(o.ok, true, JSON.stringify(o));
  assert.equal(o.approval?.state, 'approved');
  assert.equal(o.approval?.claimable, true);
  assert.equal(o.sends, 0);
}

/** Waiting for a person outside the chat: the person's command and the wait that learns it, named. */
/**
 * Where a refusal may come after the provider was read — never after it was written to:
 *
 * - a download's question binds the files as they are now, so the download reads what it would save before it looks
 *   at the question (design 2026-10-05 §D2, downloads; CUE-404 Task 19);
 * - a terminal approval shows the preview — the draft, the room — before it asks for the code a wrong answer is to;
 * - a claim waiting for a person outside the chat is not refused by its record's state: the record is pending, and the
 *   claim reads the draft or the room before the store says it is not yet approved.
 *
 * Everywhere else a refusal comes from the record's state alone, before the provider is asked anything.
 */
function readsAllowed(kind, row, action) {
  return (
    kind === 'download' ||
    (action === 'approve' && /^wrong-code-/.test(row)) ||
    (action === 'claim' && row === 'pending-confirm')
  );
}

function waitingForPerson(code) {
  return refused(code, /needs approval outside the chat/, 'pending', (o) => {
    assert.ok(o.hint?.includes(o.approval.id), `the hint names this approval: ${o.hint}`);
    assert.match(o.hint ?? '', /wait/, 'and the wait that learns when they have');
  });
}

/** A live never, refused naming the owner by its kind — the channel's own noun for it, never "this inbox" for all. */
const OWNER_NOUN = { gmail: 'mailbox', slack: 'workspace', resend: 'account' };
function turnedOff(channel) {
  assert.ok(OWNER_NOUN[channel], `a noun for ${channel}'s owner`);
  return refused(
    'POLICY_NEVER',
    new RegExp(`^nothing was sent: sending is turned off for this ${OWNER_NOUN[channel]} \\(policy: never\\)$`),
    'revoked',
  );
}

const VOIDED_BY_NEVER = /the approval was voided \(sending was turned off since this was prepared \(policy: never\)\)$/;
const TIME = '\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z';

/** D2 for a send: by row, then by action. A surface with its own words is named. */
const SEND = {
  corrupt: {
    look: shows('corrupt', false),
    list: shows('corrupt', false),
    claim: refused('APPROVAL_VOID', /^nothing was done: approval \S+ is corrupt \(timestamp-misplaced\)$/, 'corrupt'),
    approve: refused('APPROVAL_VOID', /^nothing was done: approval \S+ is corrupt \(timestamp-misplaced\)$/, 'corrupt'),
  },
  'pending-chat': {
    look: shows('pending', true),
    list: shows('pending', true),
    claim: sent,
    // Not a D2 row: a person may still approve a chat-route send at the terminal, and nothing is sent by it.
    approve: approvedNow,
  },
  'pending-confirm': {
    look: shows('pending', false),
    list: shows('pending', false),
    claim: (o, { surface, role }) => {
      // D2: a trusted client shows the form — the code accepted approves (and the send goes), a decline revokes as
      // declined, a cancel decides nothing. An untrusted client is APPROVAL_REQUIRED with the command and the wait;
      // a surface with no forms at all (a command, Slack, Resend) says the approval is pending, with the same two.
      if (role === 'decline') {
        return refused('APPROVAL_VOID', /^nothing was sent: the approval was declined$/, 'revoked', (r) => {
          assert.equal(r.approval.reason, 'declined');
          assert.equal(r.extra?.stored, 'revoked', 'revoked as the person’s decision');
        })(o);
      }
      if (role === 'cancel') {
        return refused(
          'APPROVAL_PENDING',
          /the form was cancelled, and the approval is still waiting/,
          'pending',
          (r) => assert.equal(r.extra?.stored, 'pending'),
        )(o);
      }
      if (surface.includes('trusted with forms')) return sent(o);
      return waitingForPerson(surface === 'gmail_draft_send' ? 'APPROVAL_REQUIRED' : 'APPROVAL_PENDING')(o);
    },
    approve: approvedNow,
  },
  'wrong-code-1': {
    look: shows('pending', false),
    list: shows('pending', false),
    approve: refused('APPROVAL_REQUIRED', /the challenge did not match$/, 'pending', (o) =>
      assert.equal(o.extra?.stored, 'pending'),
    ),
  },
  'wrong-code-2': {
    look: shows('pending', false),
    list: shows('pending', false),
    approve: refused('APPROVAL_REQUIRED', /the challenge did not match$/, 'pending', (o) =>
      assert.equal(o.extra?.stored, 'pending'),
    ),
  },
  'wrong-code-3': {
    look: shows('pending', false),
    list: shows('pending', false),
    approve: refused('APPROVAL_VOID', /too many wrong answers to the challenge$/, 'revoked', (o) =>
      assert.equal(o.extra?.stored, 'revoked'),
    ),
  },
  approved: {
    look: shows('approved', true),
    list: shows('approved', true),
    claim: sent,
    // Not a D2 row: approved once, it is not approved again — and stays approved.
    approve: (o) => {
      assert.equal(o.ok, false);
      assert.equal(o.approval?.state, 'approved');
      assert.equal(o.sends, 0);
    },
  },
  'live-never': {
    look: shows('pending', false, (o) => {
      if (o.approval.reason !== undefined) {
        assert.equal(o.approval.reason, 'sending is turned off (policy: never); any use revokes it');
      }
    }),
    list: shows('pending', false, (o) =>
      assert.equal(o.approval.reason, 'sending is turned off (policy: never); any use revokes it'),
    ),
    claim: (o, line) => turnedOff(line.channel)(o),
    approve: (o, line) => turnedOff(line.channel)(o),
  },
  'revoked-by-never': {
    look: shows('revoked', false),
    list: shows('revoked', false),
    claim: refused('APPROVAL_VOID', VOIDED_BY_NEVER, 'revoked'),
    approve: refused('APPROVAL_VOID', VOIDED_BY_NEVER, 'revoked'),
  },
  'expired-pending': {
    look: shows('expired', false),
    list: shows('expired', false),
    claim: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^this approval expired; nothing was sent with it: prepared at ${TIME}, expired at ${TIME}$`),
      'expired',
    ),
    approve: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^this approval expired; nothing was sent with it: prepared at ${TIME}, expired at ${TIME}$`),
      'expired',
    ),
  },
  'expired-approved': {
    look: shows('expired', false),
    list: shows('expired', false),
    claim: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^this approval expired; nothing was sent with it: approved at ${TIME}, expired unused at ${TIME}$`),
      'expired',
    ),
    approve: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^this approval expired; nothing was sent with it: approved at ${TIME}, expired unused at ${TIME}$`),
      'expired',
    ),
  },
  'clock-anomaly': {
    look: shows('expired', false),
    list: shows('expired', false, (o) => assert.equal(o.approval.reason, 'clock-anomaly')),
    claim: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^the clock moved backwards; this approval was expired safely at ${TIME}; nothing was sent with it$`),
      'expired',
      (o) => assert.equal(o.approval.reason, 'clock-anomaly'),
    ),
    approve: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^the clock moved backwards; this approval was expired safely at ${TIME}; nothing was sent with it$`),
      'expired',
      (o) => assert.equal(o.approval.reason, 'clock-anomaly'),
    ),
  },
  'provider-uncertain': {
    claim: (o) => {
      assert.equal(o.ok, false, JSON.stringify(o));
      assert.equal(o.code, 'SEND_OUTCOME_UNKNOWN', o.message);
      assert.match(o.message, /is not known/);
      assert.equal(o.sends, 1, 'the provider was asked once, and its answer was uncertain');
      assert.equal(o.approval?.state, 'sending');
      assert.equal(o.approval?.claimable, false);
      assert.ok(o.approval?.sendingAt, 'when it was claimed');
      assert.ok(o.approval?.unknownAt, 'when it reads unknown');
    },
  },
  sending: {
    look: shows('sending', false, (o, line) => {
      if (!STORED_ONLY.has(line.surface)) assert.ok(o.approval.unknownAt, 'when it reads unknown');
    }),
    list: shows('sending', false),
    claim: refused(
      'APPROVAL_PENDING',
      new RegExp(`being sent by another call since ${TIME}; wait for it$`),
      'sending',
      (o) => assert.doesNotMatch(o.hint ?? '', /prepare (it|the send) again and/i),
    ),
    approve: refused(
      'APPROVAL_PENDING',
      new RegExp(`being sent by another call since ${TIME}; wait for it$`),
      'sending',
    ),
  },
  unknown: {
    look: shows('unknown', false),
    list: shows('unknown', false),
    claim: refused('SEND_OUTCOME_UNKNOWN', /the outcome of its send is unknown: it may have gone out$/, 'unknown'),
    approve: refused('SEND_OUTCOME_UNKNOWN', /the outcome of its send is unknown: it may have gone out$/, 'unknown'),
  },
  used: {
    // A wait is core's: acceptance by the provider. Gmail's own list: acceptance is sending, and says so (D2).
    look: shows('used', false, (o) => {
      if (o.approval.said !== undefined) {
        assert.match(o.approval.said, new RegExp(`^accepted by (Gmail|Slack|Resend) at ${TIME}$`));
      }
    }),
    list: shows('used', false, (o, line) => {
      if (line.channel === 'gmail') assert.match(o.approval.said, new RegExp(`^sent at ${TIME}$`));
    }),
    claim: (o, line) => usedRefusal(line.channel)(o),
    approve: (o, line) => usedRefusal(line.channel)(o),
  },
  failed: {
    look: shows('failed', false),
    list: shows('failed', false),
    claim: (o, { role }) => {
      // The failure itself, as Slack's post with a file meets it: the upload done, the share refused. Nothing was
      // posted, and what was uploaded is said (D2, `failed`).
      if (role === 'provider-refused') {
        assert.equal(o.ok, false);
        assert.match(o.message, /^nothing was posted: Slack refused the request: posting_to_channel_denied$/);
        assert.notEqual(o.code, 'SEND_OUTCOME_UNKNOWN');
        assert.equal(o.sends, 1, 'the share was asked, and refused');
        assert.equal(o.details?.uploaded?.length, 1);
        assert.equal(o.details.uploaded[0].name, 'report.pdf');
        assert.ok(o.details.uploaded[0].id, 'by its id in Slack');
        assert.equal(o.approval?.state, 'failed');
        assert.equal(o.extra?.stored, 'failed');
        return;
      }
      refused('APPROVAL_VOID', /^nothing was sent: the send it was claimed for failed \(backendError\)$/, 'failed')(o);
    },
    approve: refused(
      'APPROVAL_VOID',
      /^nothing was sent: the send it was claimed for failed \(backendError\)$/,
      'failed',
    ),
  },
  revoked: {
    look: shows('revoked', false),
    list: shows('revoked', false),
    claim: refused('APPROVAL_VOID', /^nothing was sent: the approval was voided \(cancelled\)$/, 'revoked'),
    approve: refused('APPROVAL_VOID', /^nothing was sent: the approval was voided \(cancelled\)$/, 'revoked'),
  },
};

/**
 * A used send claimed again, in its channel's words (D2): Gmail and Slack, where acceptance is sending, say sent with
 * the message id; Resend's own surfaces say it was accepted by Resend, never that it was sent.
 */
function usedRefusal(channel) {
  return refused(
    'APPROVAL_VOID',
    channel === 'resend'
      ? new RegExp(`the approval was used already: it was accepted by Resend at ${TIME}, message id matrix-sent-1$`)
      : new RegExp(`the approval was used already: it was sent at ${TIME}, message id matrix-sent-1$`),
    'used',
  );
}

/** Applied, once, with the approval spent. */
function applied(o) {
  assert.equal(o.ok, true, `applied: ${JSON.stringify(o)}`);
  assert.equal(o.sends, 1, 'the change was made');
  assert.equal(o.approval?.state, 'used');
  assert.equal(o.approval?.claimable, false);
}

/** D2 for a change: as for a send, in a change's words — nothing was changed, and never a provider id or "sent". */
const CHANGE = {
  corrupt: SEND.corrupt,
  'pending-chat': { look: shows('pending', true), list: shows('pending', true), claim: applied, approve: approvedNow },
  'pending-confirm': {
    look: shows('pending', false),
    list: shows('pending', false),
    // D2: a confirm change is APPROVAL_PENDING, with the terminal command and the wait; changes never raise a form.
    claim: refused(
      'APPROVAL_PENDING',
      /^nothing was changed: this change needs a person to approve it at a terminal first$/,
      'pending',
      (o) => {
        assert.ok(o.hint?.includes(o.approval.id), `the hint names this approval: ${o.hint}`);
        assert.match(o.hint ?? '', /wait/);
      },
    ),
    approve: approvedNow,
  },
  'wrong-code-1': {
    ...SEND['wrong-code-1'],
    approve: refused('APPROVAL_REQUIRED', /^nothing was changed: the challenge did not match$/, 'pending', (o) =>
      assert.equal(o.extra?.stored, 'pending'),
    ),
  },
  'wrong-code-2': {
    ...SEND['wrong-code-2'],
    approve: refused('APPROVAL_REQUIRED', /^nothing was changed: the challenge did not match$/, 'pending', (o) =>
      assert.equal(o.extra?.stored, 'pending'),
    ),
  },
  'wrong-code-3': {
    ...SEND['wrong-code-3'],
    approve: refused(
      'APPROVAL_VOID',
      /^nothing was changed: too many wrong answers to the challenge$/,
      'revoked',
      (o) => assert.equal(o.extra?.stored, 'revoked'),
    ),
  },
  approved: { ...SEND.approved, claim: applied },
  'expired-pending': {
    look: shows('expired', false),
    list: shows('expired', false),
    claim: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^this approval expired; nothing was changed with it: prepared at ${TIME}, expired at ${TIME}$`),
      'expired',
    ),
    approve: refused(
      'APPROVAL_EXPIRED',
      new RegExp(`^this approval expired; nothing was changed with it: prepared at ${TIME}, expired at ${TIME}$`),
      'expired',
    ),
  },
  'expired-approved': {
    look: shows('expired', false),
    list: shows('expired', false),
    claim: refused(
      'APPROVAL_EXPIRED',
      new RegExp(
        `^this approval expired; nothing was changed with it: approved at ${TIME}, expired unused at ${TIME}$`,
      ),
      'expired',
    ),
    approve: refused(
      'APPROVAL_EXPIRED',
      new RegExp(
        `^this approval expired; nothing was changed with it: approved at ${TIME}, expired unused at ${TIME}$`,
      ),
      'expired',
    ),
  },
  'clock-anomaly': {
    look: shows('expired', false),
    list: shows('expired', false, (o) => assert.equal(o.approval.reason, 'clock-anomaly')),
    claim: refused(
      'APPROVAL_EXPIRED',
      new RegExp(
        `^the clock moved backwards; this approval was expired safely at ${TIME}; nothing was changed with it$`,
      ),
      'expired',
    ),
    approve: refused(
      'APPROVAL_EXPIRED',
      new RegExp(
        `^the clock moved backwards; this approval was expired safely at ${TIME}; nothing was changed with it$`,
      ),
      'expired',
    ),
  },
  used: {
    look: shows('used', false),
    list: shows('used', false),
    claim: refused(
      'APPROVAL_VOID',
      new RegExp(`^nothing was changed: the approved change was already claimed at ${TIME}$`),
      'used',
    ),
    approve: refused(
      'APPROVAL_VOID',
      new RegExp(`^nothing was changed: the approved change was already claimed at ${TIME}$`),
      'used',
    ),
  },
  revoked: {
    look: shows('revoked', false),
    list: shows('revoked', false),
    claim: refused('APPROVAL_VOID', /^nothing was changed: the approval was voided \(cancelled\)$/, 'revoked'),
    approve: refused('APPROVAL_VOID', /^nothing was changed: the approval was voided \(cancelled\)$/, 'revoked'),
  },
};

/** Saved, once, where the answer said, and the question spent: answered, and never claimable again. */
function saved(o) {
  assert.equal(o.ok, true, `saved: ${JSON.stringify(o)}`);
  assert.equal(o.sends, 1, 'one file saved');
  assert.equal(o.approval?.state, 'answered');
  assert.equal(o.approval?.claimable, false);
}

/**
 * D2 for a download's question: `pending` until answered, `answered` once answered (in the chat, at the terminal or in
 * a form) — claimable until it is used — and `expired` said for whether the person had answered it.
 */
const DOWNLOAD = {
  corrupt: {
    look: shows('corrupt', false),
    claim: refused('APPROVAL_VOID', /^nothing was done: approval \S+ is corrupt \(timestamp-misplaced\)$/, 'corrupt'),
  },
  // Under chat, the answer may be relayed in the chat: claimable now, and a wait returns at once.
  'pending-chat': { look: shows('pending', true), claim: saved },
  // Under confirm, the answer comes from the terminal or a trusted form: not claimable, and the claim says where to go.
  'pending-confirm': {
    look: shows('pending', false),
    claim: (o) => {
      assert.equal(o.ok, false, JSON.stringify(o));
      assert.equal(o.code, 'APPROVAL_PENDING');
      assert.match(
        o.message,
        /^nothing was saved: the change policy here is confirm, so the person answers where to save/,
      );
      assert.equal(o.sends, 0);
      if (o.asked !== undefined) assert.equal(o.asked, 0, 'the provider was asked nothing');
      assert.match(o.hint ?? '', /approve ap_\w+/, 'the person’s command');
      assert.match(o.hint ?? '', /_wait/, 'and the wait');
      // A question's refusal names it in its words, and says where it stands (D8): pending, and not claimable here.
      assert.deepEqual([o.approval?.state, o.approval?.claimable], ['pending', false], 'the pending question');
    },
  },
  answered: { look: shows('answered', true), claim: saved },
  used: {
    look: shows('answered', false),
    claim: refused(
      'APPROVAL_VOID',
      /^nothing was saved: the question was answered already, and an answer is used once$/,
      'answered',
    ),
  },
  'expired-unanswered': {
    look: shows('expired', false),
    claim: refused('APPROVAL_EXPIRED', /^nothing was saved: the question expired before it was answered$/, 'expired'),
  },
  'expired-answered': {
    look: shows('expired', false),
    claim: refused(
      'APPROVAL_EXPIRED',
      /^nothing was saved: the question was answered and expired before it was used$/,
      'expired',
    ),
  },
};

const EXPECT = { send: SEND, change: CHANGE, download: DOWNLOAD };

/** D2's one NOT_FOUND: no record detail, `approval: null`, nothing asked of the provider. */
function notFound(o) {
  assert.equal(o.ok, false, JSON.stringify(o));
  assert.equal(o.code, 'NOT_FOUND', o.message);
  assert.match(o.message, /: no approval ap_\w+$/);
  if (NOT_FOUND_APPROVAL_NULL) assert.equal(o.approval, null, 'approval: null');
  assert.equal(o.sends, 0);
  // Nothing of another's record is read far enough to act on it: the provider is asked nothing.
  if (o.asked !== undefined) assert.equal(o.asked, 0, 'the provider was asked nothing, not even a read');
}

function known(line) {
  return KNOWN.find(
    (each) =>
      each.channel === line.channel &&
      each.surface === line.surface &&
      (each.variant === undefined || each.variant === line.observation.extra?.variant) &&
      (each.row === undefined || each.row === line.row),
  );
}

const labelOf = (line) =>
  `${line.channel} · ${line.surface} (${line.action})${line.role ? ` · ${line.role}` : ''}${
    line.observation.extra?.variant ? ` · ${line.observation.extra.variant}` : ''
  }`;

for (const kind of ['send', 'change', 'download']) {
  test(`${kind}: every surface reported every row its actions meet`, () => {
    for (const [channel, kinds] of Object.entries(SURFACES)) {
      for (const [action, surfaces] of Object.entries(kinds[kind] ?? {})) {
        for (const surface of surfaces) {
          const rows = new Set(
            seen
              .filter((line) => line.channel === channel && line.surface === surface && line.kind === kind)
              .map((line) => line.row),
          );
          for (const row of ROWS[kind]) {
            const meets =
              (action !== 'claim' || !/^wrong-code-/.test(row)) &&
              (action === 'claim' || row !== 'provider-uncertain') &&
              (action !== 'list' || row !== 'not-found');
            if (meets) assert.ok(rows.has(row), `${channel} · ${surface} (${action}) never met the row ${row}`);
          }
        }
      }
    }
  });

  for (const row of ROWS[kind]) {
    test(`${kind}: ${row}`, async (t) => {
      const lines = seen.filter((line) => line.kind === kind && line.row === row);
      assert.ok(lines.length > 0, 'no surface met this row');
      for (const line of lines) {
        const todo = known(line);
        await t.test(labelOf(line), todo ? { todo: todo.todo } : {}, () => {
          const observation = readsAllowed(kind, row, line.action)
            ? { ...line.observation, asked: undefined }
            : line.observation;
          if (row === 'not-found') return notFound(observation);
          const expect = EXPECT[kind][row]?.[line.action];
          assert.ok(expect, `D2 says nothing here for ${row} on ${line.action}`);
          return expect(observation, line);
        });
      }
      if (row === 'not-found') {
        // One NOT_FOUND, byte for byte: every id a surface must not find is refused in the same words, but its id.
        const bySurface = Map.groupBy(
          lines.filter((line) => !known(line)),
          (line) => `${line.channel} · ${line.surface}`,
        );
        for (const [surface, refusals] of bySurface) {
          const words = new Set(
            refusals.map((line) =>
              JSON.stringify({ ...line.observation, extra: undefined }).replaceAll(line.observation.extra.id, '<id>'),
            ),
          );
          assert.equal(words.size, 1, `${surface}: ${[...words].join('\n')}`);
        }
      }
    });
  }
}
