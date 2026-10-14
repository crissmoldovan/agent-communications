import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openCore, sendEpochOf } from '@agentcomms/core';
import { assertOnlyWrapped, assertWrapped, HOSTILE_SUBJECT } from '../../core/test/helpers/hostile-approval.ts';
import { RESEND_CALLER } from '../src/caller.ts';
import { SendRecords } from '../src/compose/store.ts';
import { ResendContext } from '../src/context.ts';
import { sendStatus } from '../src/operations/send.ts';

test('a status envelopes the subject read from the local send record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-resend-status-present-'));
  try {
    const configDir = join(dir, 'config');
    const stateDir = join(configDir, 'state');
    mkdirSync(configDir, { recursive: true });
    const accountId = 'acc_AAAAAAAAAAAAAAAA';
    writeFileSync(
      join(configDir, 'config.json'),
      `${JSON.stringify({
        version: 2,
        secrets: { store: 'file' },
        accounts: {
          'acme/resend': {
            id: accountId,
            platform: 'resend',
            workspace: 'key_example',
            userId: 'key_example',
            tier: 'send',
            mode: 'send',
            grantedScopes: ['sending_access'],
            secretRef: `resend:key:${accountId}`,
            createdAt: '2026-10-14T10:00:00.000Z',
          },
        },
      })}\n`,
    );
    const env = {
      AGENT_COMMS_CONFIG_DIR: configDir,
      AGENT_COMMS_STATE_DIR: stateDir,
      AGENT_COMMS_DATA_DIR: join(dir, 'data'),
      HOME: dir,
      USERPROFILE: dir,
      AGENT_COMMS_UPDATE_CHECK: 'off',
    };
    const core = openCore({ env, caller: RESEND_CALLER });
    const context = new ResendContext({
      core,
      env,
      surface: 'mcp',
      fetch: async () => {
        assert.fail('a sending-only key must not make a status network request');
      },
    });
    const approval = await core.approvals.create({
      channel: 'resend',
      inboxId: accountId,
      draftId: 'rp_recorded',
      draftMessageId: 'rp_recorded',
      contentDigest: 'c'.repeat(64),
      sendEpoch: sendEpochOf(await core.config.load(), accountId),
      policy: 'chat',
      requiredPolicy: 'chat',
      riskFlags: [],
      expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: HOSTILE_SUBJECT },
    });
    await new SendRecords(stateDir).record(accountId, {
      approvalId: approval.approvalId,
      event: 'attempt',
      recipients: ['sam@partner.test'],
      subject: HOSTILE_SUBJECT,
    });

    const result = await sendStatus(context, 'acme/resend', approval.approvalId);

    assert.ok(assertOnlyWrapped(result, 'send status') > 0, 'sender text is shown only inside envelopes');
    assertWrapped(result.local?.subject, 'subject', 'the recorded local subject');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
