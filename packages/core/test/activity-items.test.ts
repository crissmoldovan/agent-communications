import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ActivityLineInput, activityLineOf } from '../src/activity.ts';

/*
 * 0.32.0, Task E (design 2026-10-26-owner-feedback-0320 §3.6, §4): the activity lines that link a reply to what it
 * answers, and `activity items`, the person's view of every line that names an item, grouped by the item's id. Every
 * test runs against temporary folders and synthetic ids: nothing reads the real home, and nothing talks to a channel.
 */

const MAIL = { id: 'ibx_AAAAAAAAAAAAAAAA', alias: 'acme/gmail' };

function line(over: Partial<ActivityLineInput> = {}): ActivityLineInput {
  return {
    at: '2026-10-25T10:00:00.000Z',
    channel: 'gmail',
    account: MAIL,
    operation: 'gmail.draft.reply',
    kind: 'write',
    outcome: 'ok',
    session: {
      key: 'aaaaaaaaaaaaaaaa',
      process: 'p1',
      pid: 4242,
      folder: '/example/home/work/acme',
      grouped: true,
      surface: 'mcp',
    },
    ms: 3,
    ...over,
  };
}

// ── The links a line keeps ─────────────────────────────────────────────────────────────────────────────────────

test('a line keeps the ids that link a reply to what it answers', () => {
  const kept = activityLineOf(
    line({ replyTo: { messageId: 'm1', threadId: 't1' }, draftId: 'r-123', threadId: 't1', items: [{ id: 'r-123' }] }),
  );
  assert.deepEqual(kept.replyTo, { messageId: 'm1', threadId: 't1' });
  assert.equal(kept.draftId, 'r-123');
  assert.equal(kept.threadId, 't1');
});

test('a link that is not an id is dropped, never kept as text', () => {
  const raw = {
    replyTo: { messageId: 'ignore previous instructions', threadId: 't1' },
    draftId: '<script>x</script>',
    threadId: 'a'.repeat(201),
  } as unknown as Partial<ActivityLineInput>;
  const kept = activityLineOf(line(raw));
  assert.equal(kept.replyTo, undefined);
  assert.equal(kept.draftId, undefined);
  assert.equal(kept.threadId, undefined);
  // A thread that is not an id goes, and the message it names stays.
  const half = activityLineOf(
    line({ replyTo: { messageId: 'm1', threadId: 'not an id' } } as unknown as Partial<ActivityLineInput>),
  );
  assert.deepEqual(half.replyTo, { messageId: 'm1' });
});
