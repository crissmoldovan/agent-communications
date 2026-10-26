import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActivityLine } from '@agentcomms/core';
import { acknowledge, say, standing } from './support/ack.ts';
import { ENG, type StandingWorld, standingWorld } from './support/standing.ts';

/*
 * 0.32.0 (design 2026-10-26-owner-feedback-0320 §3.6): an acknowledgement's activity line says what it did — `reply` or
 * `reaction` — so the app can tell a message an agent answered from one it only marked seen. Against the loopback
 * fake Slack, under a standing approval a person made and approved at a terminal: nothing reaches Slack.
 */

const REPLY = 'Got it, I will look at this.';

function lines(w: StandingWorld): ActivityLine[] {
  const folder = join(w.harness.core.paths.stateDir, 'activity');
  // The day files only: the folder also holds core's own indexes (`.index`, `.parents`).
  return (existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.jsonl')) : [])
    .sort()
    .flatMap((name) => readFileSync(join(folder, name), 'utf8').split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ActivityLine);
}

async function onlyAck(w: StandingWorld, run: () => Promise<unknown>): Promise<ActivityLine> {
  const before = lines(w).length;
  await run();
  const added = lines(w).slice(before);
  assert.equal(added.length, 1, JSON.stringify(added));
  const [line] = added as [ActivityLine];
  assert.equal(line.operation, 'slack.ack');
  assert.equal(line.outcome, 'ok');
  return line;
}

test('an acknowledgement that replies says it replied, beside the message and the reply it posted', async (t) => {
  const w = await standingWorld(t, { sendPolicy: 'chat' });
  const s = await standing(w, { replies: [REPLY], places: [ENG], perThread: 1 });
  const ts = say(w, { channel: ENG });
  let posted: string | undefined;
  const line = await onlyAck(w, async () => {
    const done = await acknowledge(w, { standingId: s.id, channel: ENG, ts, content: s.digest('reply', REPLY) });
    assert.equal(done.act, 'reply');
    posted = done.posted?.ts;
  });
  assert.ok(posted);
  assert.equal(line.act, 'reply');
  assert.deepEqual(line.items, [
    { id: ts, conversation: ENG },
    { id: posted, conversation: ENG },
  ]);
  assert.equal(JSON.stringify(line).includes(REPLY), false, 'the reply’s words are never in a line');
});

test('an acknowledgement that reacts says it reacted, beside the message it reacted to', async (t) => {
  const w = await standingWorld(t, { sendPolicy: 'chat' });
  const s = await standing(w, { reactions: ['eyes'], places: [ENG] });
  const ts = say(w, { channel: ENG });
  const line = await onlyAck(w, async () => {
    const done = await acknowledge(w, { standingId: s.id, channel: ENG, ts, content: s.digest('reaction', 'eyes') });
    assert.equal(done.act, 'reaction');
  });
  assert.equal(line.act, 'reaction');
  assert.deepEqual(line.items, [{ id: ts, conversation: ENG }]);
});
