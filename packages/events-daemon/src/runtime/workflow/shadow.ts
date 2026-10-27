import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@agentcomms/core';
import type { FlowStep, JsonValue, StepId } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import type { ProjectionCipher } from '../projections.ts';
import type { Output, PreparedEvents, RunView, StepResult, StepTransition, WorkflowEventSink } from './contracts.ts';
import { previewWorkflowEvents, renderTryStep, successOutcome, wouldStepOutput } from './flow-test.ts';
import { newEventId } from './ids.ts';
import { type RunRow, readRun } from './runs.ts';

/*
 * A shadow version (workflows design §7.7; plan B7): approved like any other, it runs on real messages, and route and
 * find, which only read, run for real; every start, worktree, delivery — a Linear write, a session's prompt, any other —
 * notice and raised event becomes a dry-run record instead, and a wait ends at once, timed out. The record is what a
 * try writes for the step — its "would", the prompt or issue as written with their envelopes, the events it would
 * raise — with the run's own values, sealed through the centrally leased cipher into the dry-run log for 24 hours, on
 * a delivery row of the run's own (a dry-run row, delivered, naming its run and step), so `dryrun list` lists it and
 * `dryrun show` opens it for the person, behind the same fences as any dry-run record. Nothing leaves.
 */

/** How long a shadow's dry-run record is kept: the dry-run log's own bound, 24 hours. */
export const SHADOW_RECORD_MS = 86_400_000;

/** The kinds a shadow never runs: each settles as it would and leaves a dry-run record. */
export const SHADOW_RECORDED_KINDS: ReadonlySet<string> = new Set([
  'start-session',
  'worktree',
  'deliver',
  'notify',
  'raise',
]);

/** Whether a shadow run handles this step itself rather than run its executor: every effect, and every wait. */
export function shadowHandles(step: FlowStep): boolean {
  return SHADOW_RECORDED_KINDS.has(step.kind) || step.kind === 'wait';
}

/** A shadow's dry-run record, sealed and ready for the settle's transaction. */
export interface PreparedShadowRecord {
  readonly deliveryId: string;
  readonly stepId: StepId;
  /** What the record's delivery row names: the step it stands for (its target id), and its key in the run. */
  readonly targetId: string;
  readonly targetKey: string;
  readonly sealed: Buffer;
  readonly at: number;
  readonly expiresAt: number;
}

/** Where a shadow's record lives: the dry-run log's record, bound to its delivery's id, as every dry-run record is. */
function shadowRecordLocation(deliveryId: string) {
  return { table: 'dryrun_log', column: 'encryptedRecord', key: [{ type: 'text' as const, value: deliveryId }] };
}

/**
 * What a shadow step settles with, and the record it leaves (none for a wait): the step's success, as a try answers
 * it — a delivery's own id, a raise's event id and name — and its "would", rendered from the run's values and sealed.
 */
export async function shadowStep(input: {
  readonly cipher: ProjectionCipher;
  readonly run: RunView;
  readonly rule: CanonicalFullRuleDocument;
  readonly stepId: StepId;
  readonly step: FlowStep;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly outputs: ReadonlyMap<StepId, Output>;
  readonly path: readonly StepId[];
  readonly installationId: string;
  readonly now: number;
  readonly newDeliveryId: () => string;
}): Promise<{ readonly result: StepResult; readonly record: PreparedShadowRecord | null }> {
  const { step } = input;
  if (step.kind === 'wait')
    return {
      result: { kind: 'settled', outcome: 'timed-out', output: wouldStepOutput(step, 'timed-out', '') },
      record: null,
    };
  const deliveryId = input.newDeliveryId();
  const outcome = successOutcome(step);
  const output: Output =
    step.kind === 'raise'
      ? { event: newEventId(), name: step.name }
      : step.kind === 'deliver'
        ? { delivery: deliveryId }
        : wouldStepOutput(step, outcome, '');
  const rendered = await renderTryStep({
    run: { ...input.run, shadow: false },
    rule: input.rule,
    stepId: input.stepId,
    step,
    outcome,
    output,
    data: input.fields,
    outputs: input.outputs,
    path: [...input.path, input.stepId],
    named: false,
    real: false,
    installationId: input.installationId,
    at: input.now,
  });
  const record = { record: 'workflow-shadow', runId: input.run.id, ...rendered };
  // The dry-run log's record shape: the text it shows, inside one untrusted-content envelope when it is opened.
  const plaintext = Buffer.from(
    JSON.stringify({ cloudEventBytes: canonicalJson(record as never), untrusted: [], representation: 'plain' }),
  );
  const sealed = await input.cipher.encrypt(shadowRecordLocation(deliveryId), plaintext);
  return {
    result: { kind: 'settled', outcome, output },
    record: {
      deliveryId,
      stepId: input.stepId,
      targetId: input.stepId,
      targetKey: `shadow:${input.stepId}`,
      sealed,
      at: input.now,
      expiresAt: input.now + SHADOW_RECORD_MS,
    },
  };
}

/**
 * Writes a shadow's record inside the step's settle: its delivery row — the run's own, a dry-run delivery already
 * delivered, holding nothing — and its sealed dry-run log entry, kept 24 hours.
 */
export function insertShadowRecordInTransaction(
  database: DatabaseSync,
  run: Pick<
    RunRow,
    'id' | 'decision_id' | 'account_id' | 'rule_id' | 'rule_version' | 'event_id' | 'switch_generation'
  >,
  record: PreparedShadowRecord,
): void {
  database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record,
          expires_at, state, switch_generation, target_kind, run_id, step_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'delivered', ?, 'dry-run', ?, ?)`,
    )
    .run(
      record.deliveryId,
      run.decision_id,
      run.account_id,
      run.rule_id,
      run.rule_version,
      record.targetKey,
      record.targetId,
      run.rule_version,
      record.expiresAt,
      run.switch_generation,
      run.id,
      record.stepId,
    );
  database
    .prepare(
      `INSERT INTO dryrun_log
         (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record,
          delivered_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.deliveryId,
      run.rule_id,
      run.rule_version,
      record.targetId,
      run.rule_version,
      run.event_id,
      run.account_id,
      record.sealed,
      record.at,
      record.expiresAt,
    );
}

/**
 * The events a shadow run's steps that do run — a condition, a judge, Which project?, a find, a split — and the run
 * itself would raise when ticked are dry-run records too, as its raises are (§7.7, W33; the lead's decision): each a
 * sealed record of the event's type and data, kept 24 hours, and never written to the outbox, so no subscriber gets one.
 * A step a shadow does not run keeps the events it would raise in its own record. Every other transition goes to `sink`.
 */
export function withShadowEvents(input: {
  readonly sink: WorkflowEventSink;
  readonly cipher: ProjectionCipher;
  readonly installationId: string;
  readonly now: () => number;
}): WorkflowEventSink {
  return {
    async prepare(transitions: readonly StepTransition[]): Promise<PreparedEvents> {
      const prepared = await input.sink.prepare(transitions);
      const shadowed = transitions.filter((transition) => {
        if (!transition.run.shadow) return false;
        if (transition.stepId === null) return true;
        const step = transition.rule.flow?.steps[transition.stepId];
        return step !== undefined && !shadowHandles(step);
      });
      const records: { readonly runId: string; readonly record: PreparedShadowRecord }[] = [];
      for (const transition of shadowed) {
        const runId = transition.run.id;
        const events = await previewWorkflowEvents(input.installationId, [
          { ...transition, run: { ...transition.run, shadow: false } },
        ]);
        for (const event of events) {
          const deliveryId = randomUUID();
          const at = input.now();
          const record = {
            record: 'workflow-shadow-event',
            runId,
            stepId: event.stepId,
            type: event.type,
            data: event.data,
          };
          const plaintext = Buffer.from(
            JSON.stringify({ cloudEventBytes: canonicalJson(record as never), untrusted: [], representation: 'plain' }),
          );
          records.push({
            runId,
            record: {
              deliveryId,
              stepId: event.stepId ?? 'run',
              targetId: event.stepId ?? 'run',
              targetKey: `shadow-event:${deliveryId}`,
              sealed: await input.cipher.encrypt(shadowRecordLocation(deliveryId), plaintext),
              at,
              expiresAt: at + SHADOW_RECORD_MS,
            },
          });
        }
      }
      return { rows: [prepared, records] };
    },
    commitInTransaction(database: DatabaseSync, prepared: PreparedEvents): void {
      input.sink.commitInTransaction(database, (prepared.rows[0] as PreparedEvents | undefined) ?? { rows: [] });
      for (const { runId, record } of (prepared.rows[1] ?? []) as readonly {
        readonly runId: string;
        readonly record: PreparedShadowRecord;
      }[]) {
        const run = readRun(database, runId);
        if (run !== undefined) insertShadowRecordInTransaction(database, run, record);
      }
    },
  };
}
