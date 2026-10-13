import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { TaintStore } from '@agentcomms/core';
import { slackMessagePostedV1, whatsappMessageReceivedV1 } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { JudgeTransport } from '../src/runtime/judge-transport.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const NOW = 1_800_000_000_000;
const localJudge = {
  judgeId: 'judge-platform-taint',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'nimble',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'ollama-noul-v1',
  protocol: 'noul' as const,
};
const limits = {
  callsPerRollingHour: 10,
  inputTokensPerRolling30Days: 20_000,
  concurrency: 1,
  maxInputTokens: 10_000,
  maxOutputTokens: 64,
};

type ChannelCase =
  | {
      readonly channel: 'slack';
      readonly accountId: string;
      readonly event: Record<string, unknown> & { readonly id: string; readonly type: string };
      readonly handle: { readonly scope: string; readonly id: string };
    }
  | {
      readonly channel: 'whatsapp';
      readonly accountId: string;
      readonly event: Record<string, unknown> & { readonly id: string; readonly type: string };
      readonly handle: { readonly scope: string; readonly id: string };
    };

function channelCases(): readonly ChannelCase[] {
  const slack = slackMessagePostedV1.examples[1];
  const whatsapp = whatsappMessageReceivedV1.examples[1];
  assert.ok(slack, 'the Slack catalogue provides the platform-taint fixture');
  assert.ok(whatsapp, 'the WhatsApp catalogue provides the platform-taint fixture');
  return [
    {
      channel: 'slack',
      accountId: slack.account.id,
      event: slack as unknown as Record<string, unknown> & { readonly id: string; readonly type: string },
      handle: { scope: slack.workspaceId, id: slack.author.userId as string },
    },
    {
      channel: 'whatsapp',
      accountId: whatsapp.account.id,
      event: whatsapp as unknown as Record<string, unknown> & { readonly id: string; readonly type: string },
      handle: { scope: whatsapp.workspaceId, id: whatsapp.sender.id },
    },
  ];
}

function ruleFor(input: ChannelCase, agentic: boolean): CanonicalFullRuleDocument {
  const common = {
    ruleId: `rule-${input.channel}-platform-taint-${agentic ? 'judge' : 'delivery'}`,
    version: 1,
    condition: { path: '/text', op: 'exists' as const },
    mapping:
      input.channel === 'slack'
        ? {
            workspaceId: { $path: '/workspaceId' },
            channel: { id: { $path: '/channel/id' } },
            ts: { $path: '/ts' },
            author: { userId: { $path: '/author/userId' } },
          }
        : {
            workspaceId: { $path: '/workspaceId' },
            chat: { id: { $path: '/chat/id' } },
            sender: { id: { $path: '/sender/id' } },
          },
    targets: [
      {
        targetId: `target-${input.channel}-platform-taint`,
        version: 1,
        kind: 'dry-run' as const,
        retentionMs: 60_000,
      },
    ],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
    ...(agentic
      ? {
          agentic: {
            judge: localJudge,
            question: 'Score the fixed channel event.',
            inputs: [input.channel === 'slack' ? '/author' : '/sender'],
            threshold: 0.5,
            onUncertain: 'no-match' as const,
            ...limits,
          },
        }
      : {}),
  };
  return input.channel === 'slack'
    ? {
        ...common,
        source: {
          channel: 'slack',
          accountIds: [input.accountId],
          options: { channel: 'slack', conversations: [(input.event.channel as { id: string }).id] },
        },
        event: { type: 'slack.message.posted', version: 1 },
      }
    : {
        ...common,
        source: {
          channel: 'whatsapp',
          accountIds: [input.accountId],
          options: { channel: 'whatsapp', chats: 'all-allowed' },
        },
        event: { type: 'whatsapp.message.received', version: 1 },
      };
}

function responseSocket(requests: Buffer[]) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  return {
    write(bytes: Uint8Array) {
      requests.push(Buffer.from(bytes));
      queueMicrotask(() => {
        listeners.get('data')?.(
          Buffer.from(
            'HTTP/1.1 200 OK\r\n\r\n{"answers":{"decision":{"type":"noul","noul":0.75}},"model":"nimble","usage":{"input_tokens":3,"output_tokens":1}}',
          ),
        );
        listeners.get('end')?.();
      });
      return true;
    },
    destroy() {},
    once(event: string, listener: (value?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
    on(event: string, listener: (value?: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
  };
}

async function setup(input: ChannelCase, agentic: boolean) {
  const root = await shortTempDir(`events-${input.channel}-platform-taint-`);
  const store = await openEventDatabase({ stateDir: root });
  store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1 WHERE singleton = 1');
  const rule = ruleFor(input, agentic);
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(rule.targets[0] as never);
  if (agentic) {
    versions.createJudge(localJudge);
    versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: {
        callsPerRollingHour: limits.callsPerRollingHour,
        inputTokensPerRolling30Days: limits.inputTokensPerRolling30Days,
        concurrency: limits.concurrency,
      },
      providers: [
        {
          provider: 'ollama',
          callsPerRollingHour: limits.callsPerRollingHour,
          inputTokensPerRolling30Days: limits.inputTokensPerRolling30Days,
          concurrency: limits.concurrency,
        },
      ],
    });
  }
  versions.createRule(rule);
  store.database
    .prepare(
      "UPDATE rule_versions SET state = 'active', approval_id = ?, authorization_activation_id = ?, activated_at = ? WHERE rule_id = ? AND version = 1",
    )
    .run('approval-platform-taint', 'activation-platform-taint', NOW, rule.ruleId);
  if (agentic)
    store.database.exec(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-kind', 'local-endpoint', 1, NULL, ${NOW}),
              ('judge-budget', 'judge-budget', 1, NULL, ${NOW});`,
    );
  store.database
    .prepare(
      `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.event.id,
      store.installationId,
      input.event.type,
      input.accountId,
      `dedupe-${rule.ruleId}`,
      NOW,
      NOW,
      NOW,
    );
  if (agentic)
    store.database
      .prepare(
        `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
         VALUES (?, ?, 1, ?, X'01')`,
      )
      .run(input.event.id, rule.ruleId, NOW + 60_000);
  return { root, store, rule };
}

test('E7 taint platform: real Slack and WhatsApp coordinators persist the channel-scoped handle before transport', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const input of channelCases()) {
    const fixture = await setup(input, true);
    try {
      const taintStore = new TaintStore(fixture.root, () => new Date(NOW));
      let taintVisibleBeforeTcp = false;
      const taint: EventTaintRecorder = {
        async record(observation) {
          await recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, observation);
          taintVisibleBeforeTcp = await taintStore.checkHandle({ platform: input.channel, ...input.handle });
        },
      };
      const requests: Buffer[] = [];
      const result = await new JudgeCoordinator({
        store: fixture.store,
        taint,
        now: () => NOW,
        newId: () => `reservation-${input.channel}-platform-taint`,
        transport: new JudgeTransport({
          tcpConnect: async () => {
            assert.equal(
              taintVisibleBeforeTcp,
              true,
              `${input.channel}: the exact platform-scoped key exists before TCP`,
            );
            return responseSocket(requests) as never;
          },
        }),
      }).evaluate({
        eventId: input.event.id as string,
        accountId: input.accountId,
        rule: fixture.rule,
        ruleId: fixture.rule.ruleId,
        ruleVersion: 1,
        event: input.event,
        switchGeneration: 1,
      });
      assert.equal(
        taintVisibleBeforeTcp,
        true,
        `${input.channel}: the platform-scoped taint key was visible at the TCP boundary`,
      );
      assert.equal(requests.length, 1, `${input.channel}: one request follows the taint flush`);
      assert.deepEqual(
        result,
        {
          kind: 'closed',
          reason: 'network-failure',
          reservationId: `reservation-${input.channel}-platform-taint`,
        },
        `${input.channel}: the real coordinator closes the synthetic socket after the taint-gated transport path`,
      );
      assert.equal(
        await taintStore.checkHandle({ platform: 'gmail', ...input.handle }),
        false,
        `${input.channel}: no Gmail-scoped alias is recorded`,
      );
    } finally {
      fixture.store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('E7 taint platform: real Slack and WhatsApp delivery commits see the channel-scoped handle first', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const input of channelCases()) {
    const fixture = await setup(input, false);
    try {
      const taintStore = new TaintStore(fixture.root, () => new Date(NOW));
      const cipher = {
        async encrypt(_location: unknown, bytes: Uint8Array) {
          return Buffer.from(bytes);
        },
        async decrypt(_location: unknown, bytes: Uint8Array) {
          return Buffer.from(bytes);
        },
      };
      const evaluator = new EventEvaluator({
        store: fixture.store,
        cipher,
        now: () => NOW,
        newId: (() => {
          let id = 0;
          return () => `platform-taint-${input.channel}-${++id}`;
        })(),
        fence: async () => ({
          approvalId: 'approval-platform-taint',
          authorizationActivationId: 'activation-platform-taint',
          usedAt: '2027-01-15T08:00:00.000Z',
          switchGeneration: 1,
        }),
        taint: {
          async record(observation) {
            await recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, observation);
            assert.equal(
              await taintStore.checkHandle({ platform: input.channel, ...input.handle }),
              true,
              `${input.channel}: the exact platform-scoped key exists before the outbox write`,
            );
            assert.equal(
              (fixture.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number })
                .count,
              0,
              `${input.channel}: no delivery is durable before taint`,
            );
          },
        },
      });
      assert.equal(
        await evaluator.admit({
          event: input.event,
          eventId: input.event.id as string,
          ruleId: fixture.rule.ruleId,
          ruleVersion: 1,
          stagedAt: NOW,
        }),
        'terminal',
        `${input.channel}: the deterministic delivery completes`,
      );
      assert.equal(
        (fixture.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
        1,
        `${input.channel}: one delivery is committed after the taint flush`,
      );
      assert.equal(
        await taintStore.checkHandle({ platform: 'gmail', ...input.handle }),
        false,
        `${input.channel}: the delivery path records no Gmail-scoped alias`,
      );
    } finally {
      fixture.store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});
