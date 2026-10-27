import type { AgenticConditionV1, FlowStep, JsonValue, StepId } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import type { EventDatabase } from '../../store/database.ts';
import type { ProjectionCipher } from '../projections.ts';
import type { JudgeAnswer, Output, RunView, StepContext } from './contracts.ts';
import { chargeInTransaction } from './limits.ts';
import { type RunRecord, runRecordLocation } from './runs.ts';

/*
 * The real `StepContext` (workflows plan I4): what one attempt of one step is given. The run's mapped values are
 * opened from its sealed record only when the step asks, through the owner's leased cipher, and never kept beyond the
 * attempt; the settled steps' outputs are the closed ones the engine read; a charge is one effect counted in its
 * window, in a transaction of its own; the fence re-checks the version's authority and the account just before an
 * effect. Judging is B3's: until it is composed, a judge fails closed.
 */

/** The judge a context asks until B3 composes the real one: it fails closed, so no step treats it as a yes. */
export const JUDGE_NOT_COMPOSED: StepContext['judge'] = async (): Promise<JudgeAnswer> => ({
  kind: 'failed',
  code: 'JUDGE_NOT_COMPOSED',
});

/**
 * A live run's mapped values, opened from its sealed record through the owner's leased cipher: what a Raise step's
 * declared fields read when its event is built. Empty once the run has ended and its record is purged.
 */
/** A live run's whole sealed record, opened through the owner's leased cipher; null once the run has ended. */
export async function openRunRecord(
  store: EventDatabase,
  cipher: ProjectionCipher,
  runId: string,
): Promise<RunRecord | null> {
  const row = store.database.prepare('SELECT encrypted_record FROM workflow_runs WHERE id = ?').get(runId) as
    | { encrypted_record: Uint8Array | null }
    | undefined;
  if (row?.encrypted_record === null || row?.encrypted_record === undefined) return null;
  return JSON.parse(
    (await cipher.decrypt(runRecordLocation(runId), row.encrypted_record)).toString('utf8'),
  ) as RunRecord;
}

export async function openRunFields(
  store: EventDatabase,
  cipher: ProjectionCipher,
  runId: string,
): Promise<Readonly<Record<string, JsonValue>>> {
  const row = store.database.prepare('SELECT encrypted_record FROM workflow_runs WHERE id = ?').get(runId) as
    | { encrypted_record: Uint8Array | null }
    | undefined;
  if (row?.encrypted_record === null || row?.encrypted_record === undefined) return {};
  const record = JSON.parse(
    (await cipher.decrypt(runRecordLocation(runId), row.encrypted_record)).toString('utf8'),
  ) as RunRecord;
  const fields = record.fields;
  return typeof fields === 'object' && fields !== null && !Array.isArray(fields)
    ? (fields as Readonly<Record<string, JsonValue>>)
    : {};
}

export function stepContextFor(input: {
  readonly store: EventDatabase;
  readonly cipher: ProjectionCipher;
  readonly run: RunView;
  readonly rule: CanonicalFullRuleDocument;
  readonly stepId: StepId;
  readonly step: FlowStep;
  readonly attempt: { readonly id: string; readonly number: number };
  readonly now: () => number;
  /** The run's sealed record as the engine read it with the claim; null once the run has ended. */
  readonly sealedRecord: Uint8Array | null;
  /** Every settled step's closed output, by step id. */
  readonly outputs: ReadonlyMap<StepId, Output>;
  readonly judge?: StepContext['judge'] | undefined;
  readonly fence: () => Promise<void>;
}): StepContext {
  let opened: Promise<RunRecord | null> | undefined;
  const record = (): Promise<RunRecord | null> => {
    opened ??= (async () => {
      if (input.sealedRecord === null) return null;
      const plaintext = await input.cipher.decrypt(runRecordLocation(input.run.id), input.sealedRecord);
      return JSON.parse(plaintext.toString('utf8')) as RunRecord;
    })();
    return opened;
  };
  const flow = input.rule.flow;
  return {
    run: input.run,
    rule: input.rule,
    stepId: input.stepId,
    step: input.step,
    attempt: { id: input.attempt.id, number: input.attempt.number },
    now: input.now,
    async fields(): Promise<Readonly<Record<string, JsonValue>>> {
      const fields = (await record())?.fields;
      return typeof fields === 'object' && fields !== null && !Array.isArray(fields)
        ? (fields as Readonly<Record<string, JsonValue>>)
        : {};
    },
    async trigger(): Promise<Output | null> {
      return (await record())?.trigger ?? null;
    },
    output(stepId: StepId): Output | null {
      return input.outputs.get(stepId) ?? null;
    },
    charge(kind) {
      if (flow === undefined) return { ok: false, until: input.run.expiresAt };
      return input.store.immediate(() =>
        chargeInTransaction(input.store.database, input.run.ruleId, kind, flow.limits, input.now()),
      );
    },
    judge(ask: AgenticConditionV1, inputs: Readonly<Record<string, JsonValue>>, question?: string) {
      return (input.judge ?? JUDGE_NOT_COMPOSED)(ask, inputs, question);
    },
    fence: input.fence,
  };
}
