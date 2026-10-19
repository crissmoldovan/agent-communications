import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { asV2, EXIT_CODES, STANDING_AGENT_LINE } from '@agentcomms/core';
import {
  BLIND,
  cli,
  ENG,
  GENERAL,
  GRIDROOM,
  MPIM,
  mcp,
  PARTNERS,
  recordOf,
  type StandingWorld,
  standingWorld,
  TOWNHALL,
  terminal,
  VENDORS,
} from './support/standing.ts';

/**
 * Making a standing approval in Slack (design 2026-10-19-standing-approvals, S5, S8, and §8.1): `agent-slack standing
 * add` and `slack_standing_add` read each place — its name, how many are in it, and who shares it — and prepare one for
 * the person to approve at their terminal with its code. Against the loopback fake: nothing here reaches Slack.
 */

/** Every standing record the store holds. */
async function standings(w: StandingWorld) {
  return (await w.core.approvals.list())
    .map((stored) => asV2(stored))
    .filter((record) => record !== null && record.kind === 'standing');
}

/** A file of replies, one per line, in the harness's home. */
function repliesFile(w: StandingWorld, name: string, lines: readonly string[]): string {
  const path = join(w.harness.home, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/** A standing approval a person made and approved at their terminal, with these words after `standing add`. */
async function approvedAtTerminal(w: StandingWorld, words: readonly string[]): Promise<string> {
  const before = new Set((await standings(w)).map((record) => record?.approvalId));
  const made = await cli(w, ['standing', 'add', '--workspace', 'acme', ...words], { streams: terminal() });
  assert.equal(made.code, EXIT_CODES.OK, made.stdout);
  const [record] = (await standings(w)).filter((each) => !before.has(each?.approvalId));
  assert.equal(record?.state, 'approved', made.stdout);
  return record?.approvalId as string;
}

test('an add prepared over MCP says an agent proposed it, and has no approvalId input', async (t) => {
  const w = await standingWorld(t);
  const { client, call } = await mcp(w, t);
  const tool = (await client.listTools()).tools.find((each) => each.name === 'slack_standing_add');
  assert.ok(tool, 'slack_standing_add is a tool');
  assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'approvalId'), false, 'it only prepares');
  assert.equal(tool.annotations?.readOnlyHint, false);

  // An approval id is not something it takes: refused, and nothing prepared.
  const refused = await call('slack_standing_add', {
    workspace: 'acme',
    places: [ENG],
    approvalId: `ap_${'7'.repeat(26)}`,
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent?.error.code, 'USAGE');
  assert.equal((await standings(w)).length, 0);

  const prepared = await call('slack_standing_add', { workspace: 'acme', places: [ENG] });
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared.structuredContent));
  const data = prepared.structuredContent as Record<string, any>;
  assert.equal(data.approvalRequired, true);
  assert.equal(data.preview.split('\n')[0], STANDING_AGENT_LINE, 'the preview opens with the agent line');
  // Only a person, at a terminal, with the code: the next step says so, and offers nothing an agent could run itself.
  assert.match(data.next, /approve/);
  assert.match(data.next, /An agent cannot approve it/);
  const record = await recordOf(w, data.approvalId);
  assert.equal(record.kind, 'standing');
  assert.equal(record.state, 'pending');
  assert.equal(record.standing?.proposedBy, 'agent');
  // No content given: `eyes` alone.
  assert.deepEqual(
    record.standing?.contents.map((content) => [content.kind, content.text]),
    [['reaction', 'eyes']],
  );
});

test('the preview names each place with its member count and sharing', async (t) => {
  const w = await standingWorld(t);
  const { call } = await mcp(w, t);
  const prepared = await call('slack_standing_add', {
    workspace: 'acme',
    places: [ENG, GENERAL, TOWNHALL, PARTNERS, VENDORS],
  });
  const data = prepared.structuredContent as Record<string, any>;
  assert.notEqual(prepared.isError, true, JSON.stringify(data));
  const lines: string[] = data.preview.split('\n');
  for (const line of [
    '#eng (C0ENG): 4 members, not shared with another organisation',
    '#general (C0GENERAL): 61 members, not shared with another organisation; its members were not read one by one',
    '#townhall (C0TOWNHALL): 60 members, not shared with another organisation; its members were not read one by one',
    '#partners (C0PARTNERS): 4 members, shared with another organisation',
    '#vendors (C0VENDORS): 3 members, shared with another organisation (an invitation to share it is pending)',
  ]) {
    assert.ok(lines.includes(line), `the preview has no line "${line}":\n${data.preview}`);
  }
  // What the person was shown is what the record holds.
  const record = await recordOf(w, data.approvalId);
  const places = record.standing?.places;
  assert.equal(places?.kind, 'exact');
  assert.deepEqual(
    places?.kind === 'exact' ? places.places.map((place) => [place.id, place.members, place.shared]) : [],
    [
      [ENG, 4, { extShared: false, pendingExtShared: false, externalMembers: false }],
      [GENERAL, 61, { extShared: false, pendingExtShared: false, externalMembers: null }],
      [TOWNHALL, 60, { extShared: false, pendingExtShared: false, externalMembers: null }],
      [PARTNERS, 4, { extShared: true, pendingExtShared: false, externalMembers: true }],
      [VENDORS, 3, { extShared: false, pendingExtShared: true, externalMembers: false }],
    ],
  );
  // A big room's members are not read one by one, counted by Slack or paged: nobody of the sixty was looked up.
  const lookedUp = w.requests('users.info').map((request) => request.params.get('user'));
  assert.equal(
    lookedUp.some((user) => /^U0C\d{3}$/.test(user ?? '')),
    false,
    'a member of the big room was read',
  );
});

test("a group DM's members are counted", async (t) => {
  const w = await standingWorld(t);
  const { call } = await mcp(w, t);
  const prepared = await call('slack_standing_add', { workspace: 'acme', places: [MPIM] });
  const data = prepared.structuredContent as Record<string, any>;
  assert.notEqual(prepared.isError, true, JSON.stringify(data));
  // Slack's answer for it has no `num_members`: its members are paged and counted instead.
  assert.ok(
    data.preview.split('\n').includes('#mpdm-jo--sam--ana-1 (G0MPIM): 3 members, not shared with another organisation'),
    data.preview,
  );
  assert.ok(
    w.requests('conversations.members').some((request) => request.params.get('channel') === MPIM),
    'its members were not paged',
  );
});

test('an unreadable count refuses the add', async (t) => {
  const w = await standingWorld(t);
  const { call } = await mcp(w, t);
  const refused = await call('slack_standing_add', { workspace: 'acme', places: [ENG, BLIND] });
  assert.equal(refused.isError, true);
  const error = refused.structuredContent?.error;
  assert.equal(error.code, 'STANDING_REFUSED', error.message);
  assert.equal(error.details.reason, 'count-unreadable');
  assert.equal(error.details.place, BLIND);
  assert.equal((await standings(w)).length, 0, 'nothing was prepared');

  // The command refuses it the same way, exit 10.
  const command = await cli(w, ['--json', 'standing', 'add', '--workspace', 'acme', '--places', BLIND]);
  assert.equal(command.code, EXIT_CODES.APPROVAL);
  assert.equal(command.json().error?.details.reason, 'count-unreadable');
});

test('is_org_shared alone is not shared with another organisation', async (t) => {
  const w = await standingWorld(t);
  const { call } = await mcp(w, t);
  const prepared = await call('slack_standing_add', { workspace: 'acme', places: [GRIDROOM] });
  const data = prepared.structuredContent as Record<string, any>;
  assert.notEqual(prepared.isError, true, JSON.stringify(data));
  assert.ok(
    data.preview.split('\n').includes('#grid (C0GRIDROOM): 3 members, not shared with another organisation'),
    data.preview,
  );
  const places = (await recordOf(w, data.approvalId)).standing?.places;
  assert.deepEqual(places?.kind === 'exact' ? places.places[0]?.shared : null, {
    extShared: false,
    pendingExtShared: false,
    externalMembers: false,
  });
});

test('--replaces with a new text asks for a code', async (t) => {
  const w = await standingWorld(t);
  const original = await approvedAtTerminal(w, [
    '--places',
    ENG,
    '--replies-file',
    repliesFile(w, 'replies.txt', ['Got it, I will look at this.']),
  ]);

  // "Got it" swapped for "Approved, go ahead": a text outside the old set, so a widening, however it is asked for.
  const swapped = repliesFile(w, 'swapped.txt', ['Approved, go ahead']);
  const asked = await cli(w, [
    '--json',
    'standing',
    'add',
    '--workspace',
    'acme',
    '--places',
    ENG,
    '--replies-file',
    swapped,
    '--replaces',
    original,
  ]);
  assert.equal(asked.code, EXIT_CODES.APPROVAL, asked.stdout);
  const error = asked.json().error;
  assert.equal(error?.code, 'APPROVAL_PENDING');
  const replacement = error?.details.approvalId as string;
  assert.notEqual(replacement, original);
  const pending = await recordOf(w, replacement);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.standing?.replaces, original);
  assert.match(error?.details.preview, new RegExp(`Replaces ${original}: approving this ends it\\.`));
  // The one it would replace is untouched until the person approves: in force, and not narrowed.
  const before = await recordOf(w, original);
  assert.equal(before.state, 'approved');
  assert.equal(before.narrowed, undefined);

  // The person approves it at their terminal, with its code; the one it replaces ends.
  const approved = await cli(w, ['approve', replacement], { streams: terminal() });
  assert.equal(approved.code, EXIT_CODES.OK, approved.stdout);
  assert.equal((await recordOf(w, replacement)).state, 'approved');
  assert.equal((await recordOf(w, original)).state, 'revoked');
});

test('--replaces with a subset narrows at once', async (t) => {
  const w = await standingWorld(t);
  const original = await approvedAtTerminal(w, [
    '--places',
    ENG,
    '--reactions',
    'eyes,raised_hands',
    '--replies-file',
    repliesFile(w, 'replies.txt', ['Got it, I will look at this.', '', 'Thanks, on it.']),
  ]);
  const held = (await recordOf(w, original)).standing?.contents ?? [];
  assert.deepEqual(
    held.map((content) => content.text),
    ['eyes', 'raised_hands', 'Got it, I will look at this.', 'Thanks, on it.'],
    'a blank line in the replies file is skipped',
  );

  const narrowed = await cli(w, [
    '--json',
    'standing',
    'add',
    '--workspace',
    'acme',
    '--places',
    ENG,
    '--reactions',
    'eyes',
    '--per-hour',
    '4',
    '--replaces',
    original,
  ]);
  assert.equal(narrowed.code, EXIT_CODES.OK, narrowed.stdout);
  assert.equal(narrowed.json<{ narrowed: boolean; standingId: string }>().data?.narrowed, true);
  assert.equal((await standings(w)).length, 1, 'nothing new was prepared');
  const record = await recordOf(w, original);
  assert.equal(record.state, 'approved');
  assert.deepEqual(record.narrowed?.keep, [held[0]?.digest]);
  assert.equal(record.narrowed?.limits?.perHour, 4);
});

test('agent-slack approve completes a standing record with its code', async (t) => {
  const w = await standingWorld(t);
  const { call } = await mcp(w, t);
  const prepared = (await call('slack_standing_add', { workspace: 'acme', places: [ENG] })).structuredContent as {
    approvalId: string;
  };

  // An agent is refused before anything is shown, whatever it passes.
  const agent = await cli(w, ['approve', prepared.approvalId], { streams: terminal(), env: { CLAUDECODE: '1' } });
  assert.equal(agent.code, EXIT_CODES.APPROVAL);
  assert.equal((await recordOf(w, prepared.approvalId)).state, 'pending');

  // A typed yes is not the code.
  const yes = await cli(w, ['approve', prepared.approvalId], { streams: terminal('yes') });
  assert.notEqual(yes.code, EXIT_CODES.OK);
  assert.equal((await recordOf(w, prepared.approvalId)).state, 'pending');

  const approved = await cli(w, ['approve', prepared.approvalId], { streams: terminal() });
  assert.equal(approved.code, EXIT_CODES.OK, approved.stdout);
  assert.match(approved.stdout, /Approved\./);
  const record = await recordOf(w, prepared.approvalId);
  assert.equal(record.state, 'approved');
  assert.equal(record.approvedVia, 'terminal');
});

test('standing add and slack_standing_add prepare the same standing approval', async (t) => {
  const w = await standingWorld(t);
  const { call } = await mcp(w, t);
  const command = await cli(w, [
    '--json',
    'standing',
    'add',
    '--workspace',
    'acme',
    '--places',
    `${ENG},${GENERAL}`,
    '--reactions',
    'eyes,white_check_mark',
    '--per-hour',
    '5',
    '--expires',
    '3d',
  ]);
  assert.equal(command.code, EXIT_CODES.APPROVAL, command.stdout);
  const fromCli = command.json().error?.details;
  const tool = await call('slack_standing_add', {
    workspace: 'acme',
    places: [ENG, GENERAL],
    reactions: ['eyes', 'white_check_mark'],
    perHour: 5,
    expiresDays: 3,
  });
  const fromMcp = tool.structuredContent as Record<string, any>;
  assert.notEqual(tool.isError, true, JSON.stringify(fromMcp));
  const shown = (preview: string, id: string) => preview.replaceAll(id, '<id>');
  assert.equal(shown(fromCli.preview, fromCli.approvalId), shown(fromMcp.preview, fromMcp.approvalId));
  assert.match(fromCli.preview, /:white_check_mark: can read as approval/);
  // The same binding: one digest, proposed by an agent from both surfaces.
  const [a, b] = [await recordOf(w, fromCli.approvalId), await recordOf(w, fromMcp.approvalId)];
  assert.equal(a.contentDigest, b.contentDigest);
  assert.equal(a.standing?.limits.expiresDays, 3);
  assert.equal(a.standing?.limits.perHour, 5);
});
