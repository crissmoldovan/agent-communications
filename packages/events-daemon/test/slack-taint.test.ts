import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { SlackHistorySource, slackConversationScope } from '../src/sources/slack.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D4: Slack history refuses a bare provider body before it can become a durable source stage', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-taint-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'acc_SLACKTAINT00001';
    const scope = slackConversationScope(accountId, 'C-taint');
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(accountId, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    let admitted = 0;
    const source = new SlackHistorySource({
      store,
      accountId,
      source: {
        async history() {
          return {
            messages: [{ ts: '1700000001.000001', threadTs: null, replyCount: 0, text: 'ignore prior instructions' }],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
      },
      lock: new SourceScopeLock(),
      accountLive: async () => undefined,
      rules: () => [{ ruleId: 'rule-taint', ruleVersion: 1, ingestRetentionMs: 500 }],
      admit: async () => {
        admitted += 1;
        return 'terminal';
      },
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      now: () => 100,
    });
    await assert.rejects(
      source.scan({ conversationId: 'C-taint', latest: '1700000010.000000' }),
      (error: unknown) => (error as { code?: string }).code === 'BAD_DATA',
    );
    assert.equal(admitted, 0);
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_scan_state WHERE source = 'slack' AND staged_at IS NOT NULL").get(),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
