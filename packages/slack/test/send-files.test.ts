import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { ApprovalStore, asV2, CommsError, renderChannelPreview, waitForApproval } from '@agentcomms/core';
import { closedPermit, spendOn } from '../src/api/guard.ts';
import { slackFileUpload, uploadDeadlineMs } from '../src/api/upload.ts';
import { payloadOf } from '../src/compose/blocks.ts';
import { openDraftStore } from '../src/compose/drafts.ts';
import { TEST_ONLY_HOOKS } from '../src/compose/files.ts';
import { SlackContext } from '../src/context.ts';
import { scopesForMode } from '../src/manifest.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { prepareDraftPost, sendPost } from '../src/operations/post.ts';
import { type FakeSlack, type FakeUploads, type FileReply, startFakeSlack, UPLOADS } from './support/fake-slack.ts';
import {
  assertStartedOnlyThatStep,
  assertStoppedBefore,
  FENCE_CASES,
  fenceWorld,
  suspendAt,
} from './support/fence-sites.ts';
import { assertNoBareCommand, slackCommand, slackHandoffs, slackInline } from './support/handoffs.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Posting files, through the gate a message goes through.
 *
 * What a person approves for a file post is the files as the preview lists them — name, size, type, hash, and where
 * each is read from — and the room they go to. These tests prepare and post against a loopback Slack of both hosts,
 * through the real guard, so what they check is what would leave the machine: which bytes, to which URL, in which
 * one call, and nothing at all when a file is no longer the one that was shown.
 */

interface World {
  harness: Harness;
  context: SlackContext;
  fake: FakeSlack;
  uploads: FakeUploads;
  docs: string;
  slack: { fetch: FakeSlack['fetch'] };
  /** The room as `conversations.info` describes it, read at each call: a test changes it between prepare and send. */
  room: Record<string, unknown>;
}

async function world(
  t: TestContext,
  options: {
    mode?: 'read' | 'send';
    grantedScopes?: readonly string[];
    sendPolicy?: 'chat' | 'confirm' | 'never';
    members?: number;
  } = {},
): Promise<World> {
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    mode: options.mode ?? 'send',
    ...(options.grantedScopes === undefined ? {} : { grantedScopes: options.grantedScopes }),
    ...(options.sendPolicy === undefined ? {} : { sendPolicy: options.sendPolicy }),
  });
  const context = new SlackContext({ core: harness.core, env: harness.env, platform: 'darwin' });
  const w = {} as World;
  w.room = { id: 'C1', name: 'eng', num_members: options.members ?? 4, is_member: true };
  const fake = await startFakeSlack({ 'conversations.info': () => ({ ok: true, channel: w.room }) });
  t.after(() => fake.close());
  const uploads = fake.acceptUploads();
  const docs = join(harness.home, 'docs');
  mkdirSync(docs);
  return Object.assign(w, { harness, context, fake, uploads, docs, slack: { fetch: fake.fetch } });
}

/** A value as it leaves the process — `--json`, or an MCP result: a command a refusal's details hold, as its text. */
function wire(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A file under the harness's home, by its real path — which is what a draft records and the preview shows. */
function file(dir: string, name: string, content: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return realpathSync.native(path);
}

async function refusal(work: Promise<unknown>): Promise<CommsError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof CommsError, `not a CommsError: ${String(error)}`);
    return error;
  }
  assert.fail('it was not refused');
}

/** The methods Slack was asked, in order: what a test holds "nothing went out" against. */
function asked(fake: FakeSlack): string[] {
  return fake.requests.map((request) => (request.host === 'api' ? request.method : `${request.host}:${request.path}`));
}

// ── Preparing: what the person is shown, and what the approval is bound to ─────────────────────────────────────

test('the preview lists a file as it will leave: its name in Slack, size, type, hash and real path', async (t) => {
  const { context, fake, docs, slack } = await world(t);
  const content = 'the quarterly report, which nobody has read yet';
  const real = file(docs, 'report.pdf', content);
  const draft = await createDraft(context, 'acme', { channel: 'C1', text: 'the report', files: [real] });

  const prepared = await prepareDraftPost(context, 'acme', { draftId: draft.draftId }, slack);

  assert.deepEqual(prepared.preview.attachments, [
    { filename: 'report.pdf', size: 47, mimeType: 'application/pdf', sha256: sha256(content), path: real },
  ]);
  assert.ok(prepared.riskFlags.includes('contains-files'));
  // A PDF is shown in the channel itself, not only offered to download.
  assert.deepEqual(prepared.preview.warnings, [
    'Slack shows report.pdf in the channel itself: everyone who reads the channel sees what is in it, not only its name',
  ]);
  // The channel and the reach as for any post, after the files.
  assert.equal(prepared.preview.channel, '#eng');
  assert.equal(prepared.preview.notifies.estimated, 0);

  const rendered = renderChannelPreview(prepared.preview);
  assert.ok(rendered.includes('Attach:   report.pdf · 47 bytes · application/pdf'), rendered);
  assert.ok(rendered.includes(`          sha256 ${sha256(content)}`), rendered);
  assert.ok(rendered.includes(`          from ${real}`), rendered);
  assert.ok(rendered.includes('! Slack shows report.pdf in the channel itself'), rendered);
  assert.ok(rendered.indexOf('Attach:') > rendered.indexOf('Channel:'), 'the files come after the channel');

  // Preparing read the room, and nothing else: no upload URL was asked for, and nothing reached the files host.
  assert.deepEqual(asked(fake), ['conversations.info']);
});

test('the preview lists several files in order, and warns about a large one and one the channel shows', async (t) => {
  const { context, docs, slack } = await world(t);
  const chart = file(docs, 'chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
  const big = join(docs, 'dump.bin');
  writeFileSync(big, '');
  truncateSync(big, 10 * 1024 * 1024 + 1);
  const archive = file(docs, 'logs.zip', 'PK zipped');
  const draft = await createDraft(context, 'acme', {
    channel: 'C1',
    files: [chart, realpathSync.native(big), archive],
  });

  const prepared = await prepareDraftPost(context, 'acme', { draftId: draft.draftId }, slack);
  assert.deepEqual(
    prepared.preview.attachments?.map((a) => [a.filename, a.size, a.mimeType, a.sha256, a.path]),
    [
      ['chart.png', 6, 'image/png', sha256(Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9])), chart],
      [
        'dump.bin',
        10 * 1024 * 1024 + 1,
        'application/octet-stream',
        sha256(Buffer.alloc(10 * 1024 * 1024 + 1)),
        realpathSync.native(big),
      ],
      ['logs.zip', 9, 'application/zip', sha256('PK zipped'), archive],
    ],
  );
  assert.deepEqual(prepared.preview.warnings, [
    'Slack shows chart.png in the channel itself: everyone who reads the channel sees what is in it, not only its name',
    'dump.bin is over 10 MiB (10,485,761 bytes): check that it is the file you mean to share with the whole channel',
  ]);
  const rendered = renderChannelPreview(prepared.preview);
  for (const line of [
    'Attach:   chart.png · 6 bytes · image/png',
    'Attach:   dump.bin · 10.0 MB (10,485,761 bytes) · application/octet-stream',
    'Attach:   logs.zip · 9 bytes · application/zip',
  ]) {
    assert.ok(rendered.includes(line), `${line}\n${rendered}`);
  }
  // No words: the body is empty, and says so rather than inventing any.
  assert.equal(prepared.preview.body, '');
});

test('the approval is bound to each file’s hash: the same file with other bytes is another post', async (t) => {
  const { context, docs, slack } = await world(t);
  const digestOf = async (files: string[] | undefined): Promise<string> => {
    const draft = await createDraft(context, 'acme', { channel: 'C1', text: 'the numbers', files });
    const prepared = await prepareDraftPost(context, 'acme', { draftId: draft.draftId }, slack);
    return asV2(await context.core.approvals.get(prepared.approvalId))?.contentDigest ?? '';
  };
  mkdirSync(join(docs, 'b'));
  // Same name, same size, same type, other bytes: only the hash tells them apart.
  const one = await digestOf([file(docs, 'numbers.csv', 'a,b\n1,2\n')]);
  const other = await digestOf([file(join(docs, 'b'), 'numbers.csv', 'a,b\n1,3\n')]);
  const again = await digestOf([join(docs, 'numbers.csv')]);
  const none = await digestOf(undefined);
  assert.notEqual(one, other, 'a file with other bytes was bound to the same approval');
  assert.equal(one, again, 'the same file gave two different approvals');
  assert.notEqual(one, none, 'a post with a file was bound as the same words without it');
});

test('a file that changed after the draft was written is refused at prepare, and nothing is approved', async (t) => {
  const { context, fake, docs, slack } = await world(t);
  const real = file(docs, 'notes.md', '# notes');
  const draft = await createDraft(context, 'acme', { channel: 'C1', text: 'notes', files: [real] });
  writeFileSync(real, '# notes, edited after');

  const error = await refusal(prepareDraftPost(context, 'acme', { draftId: draft.draftId }, slack));
  assert.equal(error.code, 'BAD_DATA');
  assert.match(error.message, /notes\.md is not the file the draft recorded/);
  assert.equal(error.details?.file, 'notes.md');
  // The command that puts the files back is this installation's own, located: the context's shell (CUE-403).
  const refile = ['draft', 'update', draft.draftId, '--workspace', 'acme', '--file', '<path…>'];
  assert.ok(
    error.hint?.includes(`with ${slackInline(context.core.paths, refile, context.platform)} (every one`),
    error.hint,
  );
  assert.equal(wire(error.details?.command), slackCommand(context.core.paths, refile, context.platform));
  assertNoBareCommand(error.hint ?? '');
  assert.deepEqual(await context.core.approvals.list(), [], 'an approval was made for bytes nobody was shown');
  assert.deepEqual(asked(fake), [], 'Slack was asked something about a post that was refused');
});

test('a workspace connected to read cannot prepare a file post', async (t) => {
  const { context, fake, docs, slack } = await world(t, { mode: 'read' });
  const draft = await createDraft(context, 'acme', { channel: 'C1', text: 'x', files: [file(docs, 'a.txt', 'a')] });

  const error = await refusal(prepareDraftPost(context, 'acme', { draftId: draft.draftId }, slack));
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.match(error.message, /connected to read, and cannot send files/);
  assert.ok(
    error.hint?.includes(
      `${slackInline(context.core.paths, ['workspace', 'mode', 'acme'], context.platform)} shows the steps, as slack_mode does from a chat`,
    ),
    error.hint,
  );
  assertNoBareCommand(error.hint ?? '');
  assert.deepEqual(await context.core.approvals.list(), []);
  assert.deepEqual(asked(fake), []);
});

test('a grant without files:write cannot prepare a file post, and is told the command that fixes it', async (t) => {
  const withoutFiles = scopesForMode('send').filter((scope) => scope !== 'files:write');
  const { context, fake, docs, slack } = await world(t, { grantedScopes: withoutFiles });
  const draft = await createDraft(context, 'acme', { channel: 'C1', text: 'x', files: [file(docs, 'a.txt', 'a')] });

  const error = await refusal(prepareDraftPost(context, 'acme', { draftId: draft.draftId }, slack));
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.match(error.message, /was not granted files:write/);
  const reauth = ['workspace', 'reauth', 'acme', '--mode', 'send'];
  assert.ok(
    error.hint?.includes(`Sign in again to grant it: ${slackInline(context.core.paths, reauth, context.platform)}.`),
    error.hint,
  );
  // And the app's own manifest, for an app that does not offer the scope: located too, never a bare name.
  assert.ok(
    error.hint?.includes(slackInline(context.core.paths, ['manifest', '--mode', 'send'], context.platform)),
    error.hint,
  );
  assertNoBareCommand(error.hint ?? '');
  assert.equal(error.details?.scope, 'files:write');
  assert.equal(wire(error.details?.command), slackCommand(context.core.paths, reauth, context.platform));
  assert.deepEqual(await context.core.approvals.list(), []);
  assert.deepEqual(asked(fake), []);

  // A post of text alone goes on exactly as it did: the check is for files.
  const text = await createDraft(context, 'acme', { channel: 'C1', text: 'just words' });
  const prepared = await prepareDraftPost(context, 'acme', { draftId: text.draftId }, slack);
  assert.match(prepared.approvalId, /^ap_/);
});

test('a post of text alone is previewed and bound exactly as it was before files existed', async (t) => {
  /*
   * Golden, captured from 0.10.0's code before any of this was written: the preview a person reads, the structured one
   * a tool returns, and the digest the approval is bound to. A text post that previewed or hashed differently would
   * void every approval outstanding across the upgrade — and would mean the file path had leaked into the text one.
   *
   * The harness's workspace has the agent label switched off (`as: me`, design 2026-10-15 L3), so this is the post as
   * the person, unlabelled: bound by the same digest as before the label, and its preview's first line — the `From:` —
   * now says plainly that it goes out with no label, which is the one change the label makes to it.
   *
   * The behaviour rules (design 2026-10-19-agent-behaviour-rules, B4) bind it by the same digest too, and add one field
   * to the structured preview: `allowedHere`, the line every preview carries — here, with no rule, everything.
   */
  const { context, slack } = await world(t);
  const draft = await createDraft(context, 'acme', {
    channel: 'C1',
    text: 'shipping at 5 — see <https://example.com/notes?utm=x|the notes> & say hi',
    threadTs: '1700000000.000100',
    mentionUsers: ['U024BE7LH'],
  });
  const prepared = await prepareDraftPost(context, 'acme', { draftId: draft.draftId }, slack);
  const scrub = (text: string): string =>
    text.replaceAll(draft.draftId, '<draft>').replaceAll(prepared.approvalId, '<approval>');

  assert.equal(
    asV2(await context.core.approvals.get(prepared.approvalId))?.contentDigest,
    '03a877c2f1836d22301eba26b2916dfaa6bb9b02eef5c4982d4e3ca0029f25d0',
  );
  assert.deepEqual(prepared.riskFlags, []);
  assert.equal(prepared.requiredPolicy, 'chat');
  assert.equal(
    scrub(JSON.stringify(prepared.preview)),
    '{"workspace":"acme","postingAs":"Sent as you, with no label: it will look as if you wrote it yourself","channel":"#eng","thread":"a reply in the thread at 1700000000.000100","body":"@U024BE7LH shipping at 5 — see <https://example.com/notes?utm=x|the notes> & say hi","notifies":{"here":false,"channel":false,"users":["U024BE7LH"],"estimated":1},"context":{"workspace":"acme","draftId":"<draft>","note":"nothing has been posted","approvalId":"<approval>"},"links":[],"warnings":[],"allowedHere":"Allowed here: everything (no rule)","policy":"say yes and it posts"}',
  );
  assert.equal(
    scrub(renderChannelPreview(prepared.preview)),
    [
      'POST PREVIEW · workspace acme · approval <approval> · draft <draft> · nothing has been posted',
      'From:     Sent as you, with no label: it will look as if you wrote it yourself',
      'Channel:  #eng',
      'Thread:   a reply in the thread at 1700000000.000100',
      'Notifies: U024BE7LH — about 1 person',
      '',
      'Body (11 words, 83 characters):',
      '```text',
      '@U024BE7LH shipping at 5 — see <https://example.com/notes?utm=x|the notes> & say hi',
      '```',
      '',
      '── #eng · U024BE7LH — about 1 person',
      'say yes and it posts',
    ].join('\n'),
  );
});

// ── Links in a file post's words: Slack may unfurl them, and nothing can stop it ─────────────────────────────

/** The warning a file post with a link in its words carries — issue #44. */
const MAY_UNFURL =
  /^Slack may fetch a link in this post’s words and show its preview to everyone in the channel: Slack offers no way to turn that off for a post with files\. To keep a link from unfurling, post it as a message of its own\.$/;

test('a file post whose words hold a bare URL and a link span lists both, flags link-may-unfurl, and warns', async (t) => {
  /*
   * Issue #44. A message is posted with unfurling off; the files' message goes out through
   * files.completeUploadExternal, which takes no such switch, so Slack may fetch a link in it and show the page to the
   * whole room. Nothing here can turn that off, so the person is told before they agree — every link, the bare ones
   * Slack links by itself as well as a span, and what to do instead.
   *
   * The span is written into the draft's payload directly, as a hand-written draft would carry one: the composer
   * escapes the author's words, so it never writes one itself.
   */
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    text: 'placeholder',
    files: [file(w.docs, 'plan.zip', 'PK the plan')],
  });
  const words = 'the plan: https://docs.example.com/plan?v=2&amp;x=1, and <https://notes.example.org/q3|the notes>';
  const store = openDraftStore(w.harness.core.paths.stateDir, () => new Date(), slackHandoffs(w.harness.core.paths));
  await store.update(draft.draftId, payloadOf(words, 'C1', undefined), words, draft.files);

  const prepared = await prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack);
  assert.deepEqual(prepared.preview.links, ['https://docs.example.com/plan?v=2&x=1', 'https://notes.example.org/q3']);
  assert.ok(prepared.riskFlags.includes('link-may-unfurl'), prepared.riskFlags.join(', '));
  const warned = (prepared.preview.warnings ?? []).filter((warning) => MAY_UNFURL.test(warning));
  assert.equal(warned.length, 1, (prepared.preview.warnings ?? []).join('\n'));
  const rendered = renderChannelPreview(prepared.preview);
  assert.match(rendered, /Link: +https:\/\/docs\.example\.com\/plan\?v=2&x=1\n/);
  assert.match(rendered, /Link: +https:\/\/notes\.example\.org\/q3\n/);
  assert.match(rendered, /! Slack may fetch a link in this post’s words/);
});

test('a bare URL typed into a file post’s words is flagged as it is written, and the digest is what it was', async (t) => {
  /*
   * The ordinary way a link gets there: typed into the words. The digest is pinned from before #44 — a warning and a
   * flag are for the person reading, and must not change what the approval binds.
   */
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    text: 'the build is at HTTPS://ci.example.com/runs/42.',
    files: [file(w.docs, 'build.log', 'ok\n')],
  });
  const prepared = await prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack);
  // Pinned first, so that a mutation to the flag or the warning is caught by the assertions below, not masked here.
  assert.equal(
    asV2(await w.context.core.approvals.get(prepared.approvalId))?.contentDigest,
    'e8f5274ffc2e8ae4c65eb35c3d372f034973a068ad863c3bb47d01ce3320b9b9',
  );
  assert.deepEqual(prepared.preview.links, ['HTTPS://ci.example.com/runs/42']);
  assert.deepEqual(prepared.riskFlags, ['contains-files', 'link-may-unfurl']);
  assert.equal((prepared.preview.warnings ?? []).filter((warning) => MAY_UNFURL.test(warning)).length, 1);
});

test('a file post without a link in its words has no link, no flag and no warning about one', async (t) => {
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    // A domain with no scheme, and a scheme with no address: neither is a link Slack would fetch.
    text: 'the numbers from example.com, as promised — see https:// for nothing',
    files: [file(w.docs, 'numbers.csv', 'a,b\n1,2\n')],
  });
  const prepared = await prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack);
  assert.deepEqual(prepared.preview.links, []);
  assert.deepEqual(prepared.riskFlags, ['contains-files']);
  assert.equal(
    (prepared.preview.warnings ?? []).some((warning) => MAY_UNFURL.test(warning)),
    false,
  );
});

test('a post of text alone with a bare URL is previewed and flagged as it always was: it posts with unfurling off', async (t) => {
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    text: 'the build is at https://ci.example.com/runs/42',
  });
  const prepared = await prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack);
  assert.deepEqual(prepared.preview.links, []);
  assert.deepEqual(prepared.riskFlags, []);
  assert.deepEqual(prepared.preview.warnings, []);
});

// ── Sending: every file read again, then uploaded, then one post that names the channel ───────────────────────

/**
 * Prepares a draft, and hands back the send to make when the test is ready: under `chat`, the person's yes in the
 * conversation is the approval. Not started here, so what a test changes between the two happens before the send.
 */
async function prepareAndSend(w: World, draftId: string) {
  const prepared = await prepareDraftPost(w.context, 'acme', { draftId }, w.slack);
  const send = () =>
    sendPost(w.context, 'acme', { draftId, approvalId: prepared.approvalId, expectChannel: 'C1' }, w.slack);
  return { prepared, send };
}

/** What happened at Slack after the preview: the send's own requests, without the room it read again. */
function sending(fake: FakeSlack, from: number): string[] {
  return asked(fake)
    .slice(from)
    .filter((method) => method !== 'conversations.info');
}

test('a file post goes up file by file, then one call names the channel, and the message’s ts comes back', async (t) => {
  const w = await world(t);
  const chart = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);
  const csv = 'region,total\nnorth,12\nsouth,7\n';
  const one = file(w.docs, 'chart.png', chart);
  const two = file(w.docs, 'totals.csv', csv);
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    text: 'the numbers & the chart',
    mentionUsers: ['U024BE7LH'],
    files: [one, two],
  });

  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  const before = w.fake.requests.length;
  const posted = await send();

  const [first, second] = w.uploads.issued;
  assert.ok(first && second, 'two upload URLs were asked for');
  // One URL per file, asked for with the name Slack will show and the exact length; each POSTed its own bytes.
  assert.deepEqual(
    w.uploads.issued.map((issued) => [issued.filename, issued.length]),
    [
      ['chart.png', chart.length],
      ['totals.csv', Buffer.byteLength(csv)],
    ],
  );
  assert.deepEqual(w.uploads.received[first.fileId], chart, 'the upload host received other bytes than the file’s');
  assert.deepEqual(w.uploads.received[second.fileId], Buffer.from(csv));
  assert.deepEqual(sending(w.fake, before), [
    'files.getUploadURLExternal',
    `files:${new URL(first.url).pathname}`,
    'files.getUploadURLExternal',
    `files:${new URL(second.url).pathname}`,
    'files.completeUploadExternal',
    'files.info',
  ]);

  // One call makes both visible, in the channel, with the words as the files' message: one post.
  assert.deepEqual(w.uploads.completed, [
    {
      channelId: 'C1',
      initialComment: '<@U024BE7LH> the numbers &amp; the chart',
      threadTs: null,
      files: [
        { id: first.fileId, title: 'chart.png' },
        { id: second.fileId, title: 'totals.csv' },
      ],
    },
  ]);
  // The token went to Slack's two hosts in its header, and nowhere else in any request.
  for (const request of w.fake.requests) {
    assert.equal(request.authorization, 'Bearer fake-user-token-0', `${request.host} ${request.path}`);
    assert.equal(request.raw.split('fake-user-token-0').length, 2, `${request.host} ${request.path}`);
  }
  assert.equal(
    w.fake.requests.some((request) => request.method === 'chat.postMessage'),
    false,
    'the words went out a second time as a message of their own',
  );

  const { approval, ...result } = posted;
  assert.deepEqual(result, {
    approvalId: prepared.approvalId,
    channel: 'C1',
    ts: '1700000000.000200',
    files: [
      { id: first.fileId, name: 'chart.png', size: chart.length, sha256: sha256(chart) },
      { id: second.fileId, name: 'totals.csv', size: Buffer.byteLength(csv), sha256: sha256(csv) },
    ],
  });
  // Where the approval stands (design 2026-10-05 §D8): used, with the ts the files were posted in.
  assert.equal(approval.state, 'used');
  assert.equal(approval.sentMessageId, '1700000000.000200');
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'used');
});

test('a file post in a thread goes into the thread', async (t) => {
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    threadTs: '1700000000.000100',
    files: [file(w.docs, 'fix.diff', '- old\n+ new\n')],
  });
  const { send } = await prepareAndSend(w, draft.draftId);
  const posted = await send();
  assert.equal(w.uploads.completed.length, 1);
  assert.equal(w.uploads.completed[0]?.threadTs, '1700000000.000100', 'the reply went to the channel, not the thread');
  // No words, so no message of its own: the files are the post.
  assert.equal(w.uploads.completed[0]?.initialComment, null);
  assert.equal(posted.ts, '1700000000.000200');
});

test('a file edited after prepare is refused at send: nothing is uploaded, and the approval is spent', async (t) => {
  const w = await world(t);
  const kept = file(w.docs, 'a.txt', 'aaaa');
  const edited = file(w.docs, 'b.txt', 'bbbb');
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', text: 'two files', files: [kept, edited] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  // The same size, other bytes: only the hash can tell. And the second file, so a check made file by file as each is
  // uploaded would already have sent the first.
  writeFileSync(edited, 'BBBB');
  const before = w.fake.requests.length;

  const error = await refusal(send());
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /nothing was sent: b\.txt is not the file that was approved — its contents have changed/);
  assert.equal(error.details?.file, 'b.txt');
  assert.deepEqual(sending(w.fake, before), [], 'something went to Slack for a post that was refused');
  assert.deepEqual(w.uploads.received, {});
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'failed');

  // Spent: sending again, even with the file put back, sends nothing.
  writeFileSync(edited, 'bbbb');
  await refusal(
    sendPost(
      w.context,
      'acme',
      { draftId: draft.draftId, approvalId: prepared.approvalId, expectChannel: 'C1' },
      w.slack,
    ),
  );
  assert.deepEqual(w.uploads.issued, []);
});

test('a file replaced by a link after prepare is refused at send, even a link to the same bytes', async (t) => {
  const w = await world(t);
  const real = file(w.docs, 'plan.md', '# the plan');
  const twin = file(w.docs, 'twin.md', '# the plan');
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [real] });
  const { send } = await prepareAndSend(w, draft.draftId);
  rmSync(real);
  try {
    symlinkSync(twin, real);
  } catch (error) {
    // Windows without the privilege to make links: nothing to test there.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip('links cannot be made here');
    throw error;
  }
  const error = await refusal(send());
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /plan\.md is not the file that was approved — a link has been put in its place/);
  assert.deepEqual(w.uploads.issued, []);
  assert.deepEqual(w.uploads.received, {});
});

test('under confirm, a file post waits for the person, and nothing is uploaded meanwhile', async (t) => {
  const w = await world(t, { sendPolicy: 'confirm' });
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [file(w.docs, 'a.pdf', '%PDF')] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  const error = await refusal(send());
  assert.equal(error.code, 'APPROVAL_PENDING');
  assert.equal(
    wire(error.details?.command),
    slackCommand(w.context.core.paths, ['approve', prepared.approvalId], w.context.platform),
  );
  assert.deepEqual(w.uploads.issued, [], 'an upload URL was asked for before the person approved');
  assert.deepEqual(w.uploads.received, {});
  assert.deepEqual(w.uploads.completed, []);
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'pending', 'the wait spent it');
});

test('a grant narrowed after prepare refuses the send, before anything is uploaded or claimed', async (t) => {
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [file(w.docs, 'a.txt', 'a')] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  await w.context.core.config.update((config) => ({
    ...config,
    accounts: Object.fromEntries(
      Object.entries(config.accounts).map(([name, account]) => [
        name,
        { ...account, grantedScopes: account.grantedScopes.filter((scope) => scope !== 'files:write') },
      ]),
    ),
  }));
  const error = await refusal(send());
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.ok(
    error.hint?.includes(
      slackInline(w.context.core.paths, ['workspace', 'reauth', 'acme', '--mode', 'send'], w.context.platform),
    ),
    error.hint,
  );
  assert.deepEqual(w.uploads.issued, []);
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'pending');
});

test('a file post to a channel this account has not joined is refused at prepare: no upload URL, nothing uploaded', async (t) => {
  const w = await world(t);
  w.room = { ...w.room, is_member: false };
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    text: 'the report',
    files: [file(w.docs, 'report.pdf', '%PDF-1.7')],
  });

  const error = await refusal(prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack));
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.match(error.message, /#eng \(C1\)/);
  assert.deepEqual(error.details, { channel: 'C1', reason: 'not-a-member' });
  assert.deepEqual(asked(w.fake), ['conversations.info'], 'Slack was asked more than the room');
  assert.deepEqual(w.uploads.issued, []);
  assert.deepEqual(w.uploads.received, {});
  assert.deepEqual(await w.context.core.approvals.list(), []);
});

test('a file post whose sender left the channel after prepare is refused at send, before the claim and any upload', async (t) => {
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [file(w.docs, 'a.txt', 'a')] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  w.room = { ...w.room, is_member: false };
  const before = w.fake.requests.length;

  const error = await refusal(send());
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.equal(error.details?.reason, 'not-a-member');
  assert.deepEqual(sending(w.fake, before), [], 'something went to Slack after the room was read');
  assert.deepEqual(w.uploads.issued, []);
  assert.deepEqual(w.uploads.received, {});
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'pending');
});

test('a failure at the call that posts is a failed post, and is recorded as one', async (t) => {
  const w = await world(t);
  w.uploads = w.fake.acceptUploads({ completeError: 'channel_not_found' });
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', text: 'x', files: [file(w.docs, 'a.txt', 'a')] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);

  const error = await refusal(send());
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.details?.stage, 'complete');
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'failed');
  const [record] = (await w.context.core.audit.tail({ limit: 1 })).filter((entry) => entry.operation === 'slack.post');
  assert.equal(record?.outcome, 'failed');
  assert.equal(record?.approvalId, prepared.approvalId);
});

test('a failure before the post names the files already uploaded, which Slack discards, and posts nothing', async (t) => {
  const w = await world(t);
  let uploads = 0;
  w.fake.uploadAnswer = () => {
    uploads += 1;
    return uploads === 1 ? { status: 200, body: 'OK' } : { status: 500, body: 'no' };
  };
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    files: [file(w.docs, 'a.txt', 'a'), file(w.docs, 'b.txt', 'b'), file(w.docs, 'c.txt', 'c')],
  });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);

  const error = await refusal(send());
  assert.equal(error.code, 'TRANSIENT');
  assert.match(error.message, /nothing was posted/);
  assert.deepEqual(error.details?.uploaded, [{ id: w.uploads.issued[0]?.fileId, name: 'a.txt' }]);
  assert.match(error.hint ?? '', /a\.txt was uploaded and never shared; Slack discards it/);
  assert.deepEqual(w.uploads.completed, [], 'the files were shared after an upload failed');
  assert.equal(w.uploads.issued.length, 2, 'the third file was asked for after the second failed');
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'failed');
});

test('when Slack has not attached the files to a message yet, the ts is null and the result says so', async (t) => {
  const w = await world(t);
  w.uploads = w.fake.acceptUploads({ ts: null });
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [file(w.docs, 'a.txt', 'a')] });
  const { send } = await prepareAndSend(w, draft.draftId);
  const started = Date.now();
  const posted = await send();

  assert.equal(posted.ts, null, 'a ts was reported that Slack never gave');
  assert.match('note' in posted ? (posted.note ?? '') : '', /Slack had not attached the files to a message yet/);
  assert.deepEqual(
    'files' in posted ? posted.files.map((f) => f.id) : [],
    w.uploads.issued.map((issued) => issued.fileId),
    'the file ids are returned whatever happened to the ts',
  );
  // Asked a few times, over a few seconds, and then no more.
  const infos = w.fake.requests.filter((request) => request.method === 'files.info').length;
  assert.ok(infos >= 2 && infos <= 5, `files.info was asked ${infos} times`);
  assert.ok(Date.now() - started < 10_000);
});

test('the audit records a file post by its ids, names, sizes and hashes — never by its contents', async (t) => {
  const w = await world(t);
  const secret = 'the contents of the file, which no log should hold';
  const real = file(w.docs, 'memo.txt', secret);
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', text: 'the memo', files: [real] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  const posted = await send();

  const records = (await w.context.core.audit.tail()).filter((entry) => entry.operation === 'slack.post');
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record?.outcome, 'ok');
  assert.equal(record?.approvalId, prepared.approvalId);
  assert.deepEqual(record?.ids, {
    channel: 'C1',
    ts: '1700000000.000200',
    files: ['files' in posted ? (posted.files[0]?.id ?? '') : ''],
    fileNames: ['memo.txt'],
    fileSizes: [String(Buffer.byteLength(secret))],
    fileSha256: [sha256(secret)],
    // Whom it was posted for, by Slack user id and team (design 2026-10-19-standing-approvals).
    user: 'U0001',
    team: 'T0001',
  });
  const everything = JSON.stringify(await w.context.core.audit.tail());
  assert.equal(everything.includes(secret), false, 'the audit holds the file’s contents');
});

// ── Review round 1 ───────────────────────────────────────────────────────────────────────────────────────────

/** The draft file as the store keeps it, for a test that changes it the way anything with a shell could. */
function draftPath(w: World, draftId: string): string {
  return join(w.harness.core.paths.stateDir, 'slack', 'drafts', `${draftId}.json`);
}

test('the order of the files is part of what is approved: reordering them on disk voids the approval', async (t) => {
  /*
   * The preview lists the files in order and they are posted in that order, so a different order is a different post.
   * The digest used to sort them before hashing, and a draft whose files were reordered by hand — its revision left as
   * it was — posted in an order nobody was shown.
   */
  const w = await world(t);
  const draft = await createDraft(w.context, 'acme', {
    channel: 'C1',
    text: 'first the summary, then the detail',
    files: [file(w.docs, 'summary.pdf', 'the summary'), file(w.docs, 'detail.pdf', 'the detail')],
  });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  const stored = JSON.parse(readFileSync(draftPath(w, draft.draftId), 'utf8')) as {
    files: unknown[];
    revision: string;
  };
  writeFileSync(
    draftPath(w, draft.draftId),
    `${JSON.stringify({ ...stored, files: [...stored.files].reverse() }, null, 2)}\n`,
  );

  const error = await refusal(send());
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.equal(w.uploads.issued.length, 0, 'an upload URL was asked for, for files in an order nobody was shown');
  assert.deepEqual(w.uploads.received, {});
  assert.deepEqual(w.uploads.completed, []);
  assert.notEqual(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'used');
});

/**
 * Runs `hook` at `moment` of the `nth` read of a file from now on, and clears the hook however the test ends.
 *
 * A send reads every file twice: once in the pass that checks them all before anything is uploaded, and again just
 * before each one's upload. `nth` picks which of those a test races.
 */
function onRead(t: TestContext, moment: 'beforeOpen' | 'afterRead', nth: number, hook: (path: string) => void): void {
  let reads = 0;
  TEST_ONLY_HOOKS[moment] = (path) => {
    reads += 1;
    if (reads === nth) hook(path);
  };
  t.after(() => {
    delete TEST_ONLY_HOOKS[moment];
  });
}

/** Another file with the same bytes, put where `path` is: the same contents, and not the file that was looked at. */
function replaceWithTwin(path: string): void {
  writeFileSync(`${path}.twin`, readFileSync(path));
  renameSync(`${path}.twin`, path);
}

test('a file replaced while prepare reads it is refused, and nothing is approved', async (t) => {
  const w = await world(t);
  const real = file(w.docs, 'plan.md', '# plan');
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [real] });
  onRead(t, 'beforeOpen', 1, replaceWithTwin);

  const error = await refusal(prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack));
  assert.equal(error.code, 'BAD_DATA');
  assert.match(error.message, /plan\.md is not the file the draft recorded — it moved while it was being read/);
  assert.deepEqual(await w.context.core.approvals.list(), []);
});

test('at send, a file replaced while the first pass reads it voids the approval, and nothing is uploaded', async (t) => {
  const w = await world(t);
  const real = file(w.docs, 'plan.md', '# plan');
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [real] });
  const { send } = await prepareAndSend(w, draft.draftId);
  onRead(t, 'afterRead', 1, replaceWithTwin);

  const error = await refusal(send());
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /it moved while it was being read/);
  assert.equal(w.uploads.issued.length, 0);
  assert.deepEqual(w.uploads.received, {});
});

test('at send, a file replaced while it is read for its upload voids the approval, and its bytes never reach Slack', async (t) => {
  const w = await world(t);
  const real = file(w.docs, 'plan.md', '# plan');
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [real] });
  const { send } = await prepareAndSend(w, draft.draftId);
  // The second read of the send: the one whose bytes go to the upload URL.
  onRead(t, 'beforeOpen', 2, replaceWithTwin);

  const error = await refusal(send());
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /it moved while it was being read/);
  assert.equal(w.uploads.issued.length, 1, 'the upload URL is asked for before the read that goes to it');
  assert.deepEqual(w.uploads.received, {}, 'bytes reached the upload URL from a file that moved');
  assert.deepEqual(w.uploads.completed, []);
});

test('an upload whose answer failed is reported as possibly uploaded, in the error and the audit — by id and name', async (t) => {
  /*
   * The bytes were sent and the answer did not come back as success: a 500 after the body was read, or a connection
   * dropped. Whether Slack kept them is not known, so the file is neither "uploaded" nor left out — it is named as
   * possibly uploaded, which Slack discards all the same once it is never shared.
   */
  for (const answer of [{ status: 500, body: 'no' }, { drop: true }] as const) {
    const w = await world(t);
    let uploads = 0;
    w.fake.uploadAnswer = () => {
      uploads += 1;
      return uploads === 1 ? { status: 200, body: 'OK' } : answer;
    };
    const draft = await createDraft(w.context, 'acme', {
      channel: 'C1',
      files: [file(w.docs, 'a.txt', 'a'), file(w.docs, 'b.txt', 'secret b'), file(w.docs, 'c.txt', 'c')],
    });
    const { prepared, send } = await prepareAndSend(w, draft.draftId);
    const error = await refusal(send());
    const [first, second] = w.uploads.issued;
    const what = JSON.stringify(answer);

    assert.deepEqual(w.uploads.received[second?.fileId ?? ''], Buffer.from('secret b'), `${what}: the body was sent`);
    assert.deepEqual(error.details?.uploaded, [{ id: first?.fileId, name: 'a.txt' }], what);
    assert.deepEqual(error.details?.possiblyUploaded, [{ id: second?.fileId, name: 'b.txt' }], what);
    assert.match(error.hint ?? '', /b\.txt may have been uploaded/, what);
    assert.deepEqual(w.uploads.completed, [], what);

    const record = (await w.context.core.audit.tail()).find(
      (entry) => entry.operation === 'slack.post' && entry.approvalId === prepared.approvalId,
    );
    assert.equal(record?.outcome, 'failed', what);
    assert.deepEqual(record?.ids?.files, [first?.fileId], what);
    assert.deepEqual(record?.ids?.possiblyUploaded, [second?.fileId], what);
    assert.deepEqual(record?.ids?.possiblyUploadedNames, ['b.txt'], what);
    assert.equal(JSON.stringify(record).includes('secret b'), false, `${what}: the audit holds the file's contents`);
  }
});

test('a file changed after the first pass and before its upload voids the approval, and its bytes never reach Slack', async (t) => {
  /*
   * The first pass reads every file before anything is uploaded; each one is then read and hashed again just before
   * its own upload. This changes the file in between — as Slack is asked where to put it — so only that second read
   * can see it. The same size and other bytes, so only the hash tells.
   */
  const w = await world(t);
  const real = file(w.docs, 'totals.csv', 'a,b\n1,2\n');
  w.uploads = w.fake.acceptUploads({
    onUploadUrl: (filename) => {
      if (filename === 'totals.csv') writeFileSync(real, 'a,b\n9,9\n');
    },
  });
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', text: 'the totals', files: [real] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);

  const error = await refusal(send());
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /totals\.csv is not the file that was approved — its contents have changed/);
  assert.equal(w.uploads.issued.length, 1, 'the URL was asked for, so the first pass had passed');
  assert.deepEqual(w.uploads.received, {}, 'bytes reached the upload URL from a file changed after it was approved');
  assert.deepEqual(w.uploads.completed, []);
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'failed');
});

// ── What a file post says when it fails, and when Slack gives it no id ──────────────────────────────────────

test('a file post that fails before an upload, during one, after a known upload or at the share says nothing was posted, naming exactly the files that went up', async (t) => {
  /*
   * §5 D2pt-a. Until Slack shares them, uploaded files are in no channel: every failure before a successful share
   * posted nothing, and says so — with the files that went up, which Slack discards, and the one that may have.
   */
  const cases: {
    what: string;
    arrange: (w: World) => void;
    uploaded: number[];
    possiblyUploaded: number[];
    shared: number;
  }[] = [
    {
      what: 'before an upload: Slack gives no upload URL',
      arrange: (w) => {
        w.uploads = w.fake.acceptUploads({ urlError: 'invalid_arguments' });
      },
      uploaded: [],
      possiblyUploaded: [],
      shared: 0,
    },
    {
      what: 'during an upload: the connection drops with the bytes sent',
      arrange: (w) => {
        w.fake.uploadAnswer = () => ({ drop: true });
      },
      uploaded: [],
      possiblyUploaded: [0],
      shared: 0,
    },
    {
      what: 'after a known upload: Slack gives no URL for the next file',
      arrange: (w) => {
        const issue = w.fake.script['files.getUploadURLExternal'];
        let asked = 0;
        w.fake.script['files.getUploadURLExternal'] = (request) => {
          asked += 1;
          return asked === 2 ? { ok: false, error: 'internal_error' } : issue?.(request);
        };
      },
      uploaded: [0],
      possiblyUploaded: [],
      shared: 0,
    },
    {
      what: 'at the share: Slack refuses it',
      arrange: (w) => {
        w.uploads = w.fake.acceptUploads({ completeError: 'channel_not_found' });
      },
      uploaded: [0, 1],
      possiblyUploaded: [],
      shared: 1,
    },
  ];
  for (const { what, arrange, uploaded, possiblyUploaded, shared } of cases) {
    const w = await world(t);
    arrange(w);
    const names = ['a.txt', 'b.txt'];
    const draft = await createDraft(w.context, 'acme', {
      channel: 'C1',
      text: 'the files',
      files: [file(w.docs, 'a.txt', 'a'), file(w.docs, 'b.txt', 'b')],
    });
    const { prepared, send } = await prepareAndSend(w, draft.draftId);
    const error = await refusal(send());
    const named = (indices: number[]) =>
      indices.map((index) => ({ id: w.uploads.issued[index]?.fileId, name: names[index] }));

    assert.match(error.message, /^nothing was posted: /, what);
    assert.notEqual(error.code, 'SEND_OUTCOME_UNKNOWN', what);
    assert.deepEqual(error.details?.uploaded, named(uploaded), what);
    if (possiblyUploaded.length === 0) {
      assert.equal('possiblyUploaded' in (error.details ?? {}), false, `${what}: a file said to be possibly up`);
    } else {
      assert.deepEqual(error.details?.possiblyUploaded, named(possiblyUploaded), what);
    }
    const hint = error.hint ?? '';
    const up = uploaded.map((index) => names[index]).join(', ');
    if (uploaded.length === 1)
      assert.ok(hint.includes(`${up} was uploaded and never shared; Slack discards it.`), hint);
    if (uploaded.length > 1)
      assert.ok(hint.includes(`${up} were uploaded and never shared; Slack discards them.`), hint);
    if (uploaded.length === 0) assert.doesNotMatch(hint, /was uploaded and never shared|were uploaded/, what);
    const maybe = possiblyUploaded.map((index) => names[index]).join(', ');
    if (possiblyUploaded.length > 0) {
      assert.ok(
        hint.includes(
          `${maybe} may have been uploaded before the failure; nothing shared it, so if Slack has it, Slack discards it.`,
        ),
        hint,
      );
    } else {
      assert.doesNotMatch(hint, /may have been uploaded/, what);
    }
    assert.equal(w.uploads.completed.length, shared, what);
    assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'failed', what);
    const record = (await w.context.core.audit.tail()).find(
      (entry) => entry.operation === 'slack.post' && entry.approvalId === prepared.approvalId,
    );
    assert.equal(record?.outcome, 'failed', what);
    assert.match(record?.reason ?? '', /^nothing was posted: /, what);
    assert.deepEqual(
      record?.ids?.files ?? [],
      named(uploaded).map((one) => one.id),
      what,
    );
  }
});

test('a file Slack gives an empty id is never uploaded, shared, read back or recorded by that id', async (t) => {
  /*
   * §5 D8o-h, for files: an empty id is no id. A file Slack named `""` cannot be shared by it, and an approval or an
   * audit record that held one would be read as an id by everyone after. It is refused before its bytes go anywhere.
   */
  const w = await world(t);
  w.fake.script['files.getUploadURLExternal'] = () => ({ ok: true, upload_url: `${UPLOADS}v1/CwABempty`, file_id: '' });
  const draft = await createDraft(w.context, 'acme', { channel: 'C1', files: [file(w.docs, 'a.txt', 'a')] });
  const { prepared, send } = await prepareAndSend(w, draft.draftId);
  const store = w.context.core.approvals;
  const complete = store.complete.bind(store);
  const completions: unknown[] = [];
  store.complete = (approvalId, claimToken, outcome) => {
    completions.push(outcome);
    return complete(approvalId, claimToken, outcome);
  };

  const error = await refusal(send());
  assert.match(error.message, /^nothing was posted: /);
  assert.deepEqual(error.details?.uploaded, []);
  assert.equal(
    w.fake.requests.some((request) => request.host === 'files'),
    false,
    'bytes went to an upload URL for a file with no id',
  );
  assert.deepEqual(w.uploads.completed, []);
  assert.equal(
    w.fake.requests.some((request) => request.method === 'files.info'),
    false,
    'a file was read back by an empty id',
  );
  assert.equal(completions.length, 1);
  assert.ok(
    completions.every((outcome) => !('sentMessageId' in (outcome as object))),
    'the approval was completed as used',
  );
  assert.equal(asV2(await store.get(prepared.approvalId))?.state, 'failed');
  const record = (await w.context.core.audit.tail()).find(
    (entry) => entry.operation === 'slack.post' && entry.approvalId === prepared.approvalId,
  );
  assert.equal(record?.outcome, 'failed');
  assert.deepEqual(record?.ids, { channel: 'C1' }, 'the audit holds an empty file id');
});

// ── The fence before each step ─────────────────────────────────────────────────────────────────────────────────

/*
 * The fence-site table (`support/fence-sites.ts`), for the steps a two-file post makes: an upload URL for each file,
 * each upload, and the share. Each case suspends the claimant just before one step while another caller finds its
 * lease run out. §5 R11c and R12c — and R12b, after a fence said go.
 */
for (const c of FENCE_CASES.filter((one) => one.flow === 'files')) {
  test(`a claimant whose lease ran out just before ${c.label} starts neither it nor any later step, and says so`, async (t) => {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'before');
    await assertStoppedBefore(w, c, await w.run(c.flow), log);
  });
}

test('a file post’s claimant suspended right after a fence said go starts that one step and no later one', async (t) => {
  for (const c of FENCE_CASES.filter((one) => one.flow === 'files')) {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'after');
    await assertStartedOnlyThatStep(w, c, await w.run(c.flow), log);
  }
});

// ── Long work: one lease across uploads that take minutes ──────────────────────────────────────────────────────

/** Waits, in real time, for `check` to hold. */
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (await check()) return;
    await sleep(5);
  }
  assert.fail(`never: ${what}`);
}

test('a file post whose upload takes over five minutes keeps its lease, reads sending to status and wait throughout, and then records what Slack said', async (t) => {
  /*
   * §5 D1sl-c. One upload may take 1,600 seconds, and a post may carry ten: a fixed age would call a live post
   * unknown, so the claimant renews its lease every thirty seconds while Slack has the bytes. The time is the store's
   * and the renewal timer's, moved on by hand; the upload is real, against the loopback Slack, and held open until the
   * test lets it answer — once with success, once with a failure.
   */
  for (const ending of ['success', 'failure'] as const) {
    await t.test(ending, async (t) => {
      const w = await world(t);
      const started = Date.now();
      let now = started;
      const store = new ApprovalStore(w.harness.core.paths.stateDir, {
        now: () => new Date(now),
        handoffs: w.harness.core.handoffs,
        loadConfig: () => w.harness.core.config.load(),
      });
      w.harness.core.approvals = store;
      const renewals: string[] = [];
      const heartbeat = store.heartbeat.bind(store);
      store.heartbeat = async (approvalId, claimToken) => {
        const renewed = await heartbeat(approvalId, claimToken);
        renewals.push(renewed);
        return renewed;
      };
      let answer!: (reply: FileReply) => void;
      const answered = new Promise<FileReply>((settle) => {
        answer = settle;
      });
      w.fake.uploadAnswer = () => answered;
      const draft = await createDraft(w.context, 'acme', {
        channel: 'C1',
        text: 'the dump',
        files: [file(w.docs, 'dump.bin', 'x'.repeat(4096))],
      });
      const { prepared, send } = await prepareAndSend(w, draft.draftId);
      const id = prepared.approvalId;
      t.mock.timers.enable({ apis: ['setInterval'] });
      const sending = send().then(
        (posted) => ({ posted, error: undefined }),
        (error: unknown) => ({ posted: undefined, error }),
      );
      await until(() => w.fake.requests.some((request) => request.path.startsWith('/upload/')), 'the upload began');
      // The fences before the upload URL and the upload renewed it too (`fence` is a renewal); the timer's come next.
      const fenced = renewals.length;
      assert.equal(fenced, 2, 'a fence before each step so far');

      for (let beat = 1; beat <= 11; beat += 1) {
        now += 30_000;
        t.mock.timers.tick(30_000);
        await until(() => renewals.length === fenced + beat, `renewal ${beat}`);
        assert.equal(renewals.at(-1), 'renewed', `renewal ${beat}`);
        const record = asV2(await store.get(id));
        assert.equal(record?.state, 'sending', `status at ${beat * 30} seconds`);
        assert.equal(record?.sendingHeartbeatAt, new Date(now).toISOString(), `renewal ${beat} written`);
        const look = await waitForApproval(w.harness.core, id, { waitSeconds: 0, channel: 'slack' });
        assert.equal(look.state, 'sending', `a zero wait at ${beat * 30} seconds`);
      }
      assert.ok(now - started > 5 * 60_000, 'the upload was not held for five minutes');
      // A wait of its own, over two more seconds of the same clock: still being sent at its end.
      const clock = {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
      };
      const waited = await waitForApproval(w.harness.core, id, { waitSeconds: 2, channel: 'slack', clock });
      assert.equal(waited.state, 'sending');
      assert.equal(waited.ended, 'timeout');

      answer(ending === 'success' ? { status: 200, body: 'OK' } : { status: 500, body: 'no' });
      const { posted, error } = await sending;
      const [issued] = w.uploads.issued;
      if (ending === 'success') {
        assert.equal(error, undefined, String(error));
        assert.deepEqual(posted && 'files' in posted ? posted.files.map((one) => one.id) : [], [issued?.fileId]);
        assert.equal(asV2(await store.get(id))?.state, 'used');
      } else {
        assert.ok(error instanceof CommsError, String(error));
        assert.match(error.message, /^nothing was posted: /);
        assert.deepEqual(error.details?.possiblyUploaded, [{ id: issued?.fileId, name: 'dump.bin' }]);
        assert.equal(asV2(await store.get(id))?.state, 'failed');
      }
      // The renewals stopped with the post.
      const after = renewals.length;
      t.mock.timers.tick(5 * 30_000);
      await sleep(20);
      assert.equal(renewals.length, after, 'a renewal after the post was over');
    });
  }
});

// ── The time an upload is allowed ────────────────────────────────────────────────────────────────────────────

/** One upload straight to the transport, inside a post's permit as the gate opens it: nothing else of a post. */
function uploadOne(fake: FakeSlack, extra: { timeoutMs?: number } = {}) {
  const permit = closedPermit();
  return spendOn(permit, 'ap_1', 'files.completeUploadExternal', () =>
    slackFileUpload(
      { token: 'fake-user-token-0', fetch: fake.fetch, permit, ...extra },
      { url: `${UPLOADS}v1/CwABF0UP0001x7919`, bytes: new Uint8Array(64 * 1024) },
    ),
  );
}

test('an upload the host never answers is given up on in time, even with garbage collected while it waits', {
  timeout: 60_000,
}, async (t) => {
  /*
   * The shape the download's own deadline was measured against (see `deadline` in api/download.ts): a timeout handed
   * to `fetch` and trusted to wake the wait, with collection forced meanwhile. The upload's wait is raced against a
   * timer of its own instead, so this fails by name rather than hanging the post.
   */
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  fake.uploadAnswer = () => ({ stall: true });
  const every = setInterval(collect, 50);
  const started = Date.now();
  try {
    const error = await refusal(uploadOne(fake, { timeoutMs: 1_000 }));
    assert.equal(error.code, 'TRANSIENT');
    assert.match(error.message, /was not answered within 1 second/);
  } finally {
    clearInterval(every);
  }
  assert.ok(Date.now() - started < 15_000, `the upload waited ${Date.now() - started} ms`);
  assert.equal(fake.requests.filter((request) => request.path.startsWith('/upload/')).length, 1, 'sent once');
});

test('the time an upload is allowed grows with the file: five minutes at least, and 64 KiB a second beyond', () => {
  // Issue #49: five minutes for every file gave up on 100 MiB over any uplink slower than about 340 KiB a second.
  const MIB = 1024 * 1024;
  assert.equal(uploadDeadlineMs(100 * MIB), 1_600_000);
  assert.equal(uploadDeadlineMs(20 * MIB), 320_000);
  assert.equal(uploadDeadlineMs(1 * MIB), 300_000);
  assert.equal(uploadDeadlineMs(0), 300_000);
  assert.equal(uploadDeadlineMs(Number.NaN), 300_000);
});

test('an upload the host answers is done, and leaves no timer behind to hold the process', async (t) => {
  /*
   * Its deadline is a plain timer of minutes, so one left running would hold the process open that long after the post
   * was done. Counted, rather than waited out: the timers alive before the upload and after it.
   */
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  const timers = (): number => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const before = timers();
  await uploadOne(fake);
  assert.equal(timers(), before, 'a timer outlived the upload');
  const [sent] = fake.requests.filter((request) => request.path.startsWith('/upload/'));
  assert.equal(sent?.body.byteLength, 64 * 1024);
});
