import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError } from '@agentcomms/core';
import { EventControlClient } from '../../src/control/client.ts';
import { startEventOwner } from '../../src/runtime/owner.ts';
import { emptyConfigDir } from './config-dir.ts';
import { shortTempDir } from './short-temp.ts';
import { noRealHome } from './temp-home.ts';

/*
 * B3 control v3's Laya judge vectors (E2 Task 10a): one fixed sequence through the production owner over the daemon's
 * shipped assets, whose placeholder lock leaves Laya not offered. `test/fixtures/b3-control-contract-v3/` freezes its
 * answers, and `laya-b3-control-v3.test.ts` requires the live answers to equal them.
 */

export const SHIPPED_MANIFEST = 'laya-en-onnx-68f27dfe';
export const laya = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  judgeId: 'judge-laya',
  version: 1,
  kind: 'laya',
  provider: 'laya',
  model: SHIPPED_MANIFEST,
  promptTemplate: 'laya-noul-v1',
  ...overrides,
});
export const typesafe: Readonly<Record<string, unknown>> = {
  judgeId: 'judge-jev',
  version: 1,
  kind: 'typesafe',
  provider: 'typesafe',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul',
};
const target = { targetId: 'target-laya', version: 1, kind: 'dry-run', retentionMs: 60_000 };
export const rule = (judge: Record<string, unknown>, version = 1): Record<string, unknown> => ({
  ruleId: 'rule-laya',
  version,
  source: {
    channel: 'gmail',
    accountIds: ['ibx_LAYAVECTORAAAAAA'],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  agentic: {
    judge,
    question: 'Does this synthetic message ask for a reply?',
    inputs: ['/subject'],
    threshold: 0.5,
    onUncertain: 'no-match',
    callsPerRollingHour: 10,
    inputTokensPerRolling30Days: 100_000,
    concurrency: 1,
    maxInputTokens: 400,
    maxOutputTokens: 64,
  },
  mapping: { subject: { $path: '/subject' } },
  targets: [target],
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
});

export type Vector =
  | { readonly name: string; readonly request: { operation: string; args: unknown }; readonly result: unknown }
  | { readonly name: string; readonly request: { operation: string; args: unknown }; readonly error: unknown };

/** Every vector, as the production owner over the daemon's shipped assets (the placeholder lock) answers it. */
export async function liveVectors(): Promise<Vector[]> {
  const root = await shortTempDir('events-e2-t10a-v3-');
  const stateDir = join(root, 'state');
  const owner = await startEventOwner({
    ...noRealHome(stateDir),
    stateDir,
    configDir: await emptyConfigDir(root),
    dataDir: join(root, 'data'),
    tickMs: 60_000,
  });
  const vectors: Vector[] = [];
  try {
    const control = new EventControlClient({ stateDir, clientName: 'events-e2-t10a-v3' });
    const call = async (name: string, operation: string, args: Record<string, unknown>) => {
      vectors.push({ name, request: { operation, args }, result: await control.request(operation, args) });
    };
    const refused = async (name: string, operation: string, args: Record<string, unknown>) => {
      try {
        await control.request(operation, args);
      } catch (error) {
        assert.ok(error instanceof CommsError, name);
        const reason = (error.details as { reason?: unknown } | undefined)?.reason;
        assert.ok(typeof reason === 'string' && error.message.includes(reason), `${name}: the message names ${reason}`);
        vectors.push({ name, request: { operation, args }, error: { code: error.code, reason } });
        return;
      }
      assert.fail(`${name} was not refused`);
    };
    await call('judge-add-laya', 'addJudge', { document: laya() });
    await call('judge-update-laya', 'updateJudge', { document: laya({ version: 2 }) });
    await call('judge-add-typesafe', 'addJudge', { document: typesafe });
    await call('judges-list', 'judgesList', {});
    await control.request('target-add', { document: target });
    await call('rule-create-laya', 'rule-create', { document: rule(laya()) });
    await call('rule-update-laya', 'rule-update', { document: rule(laya({ version: 2 }), 2) });
    await refused('judge-add-choice-template', 'addJudge', {
      document: laya({ judgeId: 'judge-laya-choice', promptTemplate: 'laya-choice2-v1' }),
    });
    await refused('judge-update-unreviewed-manifest', 'updateJudge', {
      document: laya({ version: 3, model: 'laya-en-onnx-unreviewed' }),
    });
    await refused('rule-create-choice-template', 'rule-create', {
      document: rule(laya({ promptTemplate: 'laya-choice2-v1' }), 3),
    });
    await refused('rule-enable-laya-not-offered', 'rule-enable', { ruleId: 'rule-laya', version: 1 });
  } finally {
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
  return vectors;
}
