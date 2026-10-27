import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@agentcomms/core';
import {
  buildWorkflowCloudEvent,
  eventForOutcome,
  FAILURE_OUTCOMES,
  type FlowDocumentV1,
  type FlowStep,
  type JsonValue,
  STANDARD_STEP_EVENTS,
  schemaOf,
  WORKFLOW_EVENT_CATALOGUE_V1,
  type WorkflowCloudEventV1,
  type WorkflowEventDataV1,
  type WorkflowEventSchema,
  workflowEventBytes,
  workflowEventType,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import { subscriptionMatches } from '../../domain/event-subscription.ts';
import type { EncryptedRecordLocation, EventRecordCipher } from '../../store/records.ts';
import type {
  Output,
  PreparedEvents,
  RunTransition,
  RunView,
  StepTransition,
  WorkflowEventSink,
} from '../workflow/contracts.ts';
import { newEventId } from '../workflow/ids.ts';
import { expireSubscriberBacklogInTransaction } from './event-ledger.ts';
import { activeSubscriptions } from './subscriptions.ts';

/**
 * The workflow event sink (workflows design §9.1, W23–W28, W33, Appendix W): every transition the engine commits passes
 * through here. A word that is not ticked writes nothing. A ticked one is built as Appendix W.2's CloudEvent and sealed
 * in `prepare`, outside any transaction; `commitInTransaction` then writes it, in the engine's own transaction, with
 * one queued delivery per active subscription whose pattern matches, and charges the workflow's `eventsPerHour`. An
 * event over a limit is not raised: the run counts it, and the transition commits all the same.
 *
 * What a step stores and what its events carry are two sets (plan I5): an event's `outputs` are Appendix W.3's, mapped
 * here from the stored output — never a worktree's path, never a route's profile hash. Automatic events carry closed
 * values only; sender content reaches an event only through a Raise step's declared fields (W27).
 */

/** What the sink is given by the owner. */
export interface WorkflowEventSinkDeps {
  readonly cipher: Pick<EventRecordCipher, 'encrypt'>;
  readonly installationId: string;
  /**
   * The run's mapped values, unsealed, for a Raise step's declared `fields`: read only when a Raise step that declares
   * fields settles, never for an automatic event.
   */
  readonly fields?: ((run: RunView) => Promise<Readonly<Record<string, JsonValue>>>) | undefined;
  /** Test seam: the ids of automatic events. A Raise step's id is its settled output's. */
  readonly newEventId?: (() => string) | undefined;
  /**
   * D6's seam: runs in the same transaction, after each raised event is written, for chain requests. Absent until
   * chains land.
   */
  readonly onRaisedInTransaction?:
    | ((database: DatabaseSync, event: PreparedWorkflowEvent, now: number) => void)
    | undefined;
}

/** One event the sink built and sealed, waiting for its transaction. Opaque to the engine. */
export interface PreparedWorkflowEvent {
  readonly id: string;
  readonly run: RunView;
  readonly stepId: string | null;
  readonly type: string;
  readonly schema: WorkflowEventSchema;
  readonly raisedAt: number;
  readonly expiresAt: number;
  readonly eventsPerHour: number;
  /** The event's closed `data`, for D6's `/trigger`: never `data.fields`. */
  readonly data: Omit<WorkflowEventDataV1, 'fields'>;
  readonly sealed: Buffer;
}

const HOUR_MS = 3_600_000;
const OUTCOME_LESS: readonly string[] = ['started', 'waiting', 'retrying', 'skipped'];

const RUN_WORDS: Readonly<Record<RunTransition, string>> = Object.freeze({
  'run-started': 'started',
  'run-held': 'held',
  'run-finished': 'finished',
  'run-failed': 'failed',
  'run-cancelled': 'cancelled',
  'run-expired': 'expired',
});

/** The sealed location of a raised event's record (§4.3). */
export function workflowEventLocation(id: string): EncryptedRecordLocation {
  return { table: 'workflow_events', column: 'encryptedRecord', key: [{ type: 'text', value: id }] };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function flowOf(rule: CanonicalFullRuleDocument): FlowDocumentV1 | undefined {
  return (rule as CanonicalFullRuleDocument & { readonly flow?: FlowDocumentV1 }).flow;
}

/** A deliver step's target kind, from the workflow's own targets. */
function targetKindOf(rule: CanonicalFullRuleDocument, step: FlowStep): string | undefined {
  if (step.kind !== 'deliver') return undefined;
  return rule.targets.find(
    (target) => target.targetId === step.target.targetId && target.version === step.target.version,
  )?.kind;
}

/**
 * The step's closed outputs as its schema's events carry them (Appendix W.3): exactly W.3's names, from the stored
 * output where it has them. A Raise step carries its `name` and its declared field names; a split its branches.
 */
function eventOutputs(
  schema: WorkflowEventSchema,
  step: FlowStep | null,
  transition: StepTransition,
): Readonly<Record<string, JsonValue>> {
  const output: Output = transition.output ?? {};
  if (schema === 'run') {
    return {
      steps: typeof output.steps === 'number' ? output.steps : transition.index,
      endCode: typeof output.endCode === 'string' ? output.endCode : transition.error,
    };
  }
  if (step?.kind === 'raise') return { name: step.name, fields: [...(step.fields ?? [])] };
  if (step?.kind === 'split') return { branches: [...step.branches] };
  const names = WORKFLOW_EVENT_CATALOGUE_V1[schema].outputs;
  const outputs: Record<string, JsonValue> = {};
  for (const name of names) if (Object.hasOwn(output, name)) outputs[name] = output[name] as JsonValue;
  return outputs;
}

/** The words one transition raises, by its schema: its standard word, and on a settle its outcome's own word. */
function wordsOf(schema: WorkflowEventSchema, step: FlowStep, transition: StepTransition): readonly string[] {
  if (step.kind === 'raise') return transition.transition === 'succeeded' ? [step.name] : [];
  const known = WORKFLOW_EVENT_CATALOGUE_V1[schema];
  const words: string[] = [];
  let standard: string | undefined = transition.transition;
  if (transition.transition === 'succeeded' && transition.outcome !== null) {
    const failures = FAILURE_OUTCOMES[step.kind] ?? [];
    if (failures.includes(transition.outcome)) standard = 'failed';
  }
  if (standard !== undefined && known.standard.includes(standard)) words.push(standard);
  if (transition.transition === 'succeeded' && transition.outcome !== null) {
    const output = transition.output ?? {};
    const own = eventForOutcome(schema, transition.outcome, {
      ...(Array.isArray(output.changed)
        ? { changed: output.changed.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
      ...(typeof output.stateType === 'string' ? { stateType: output.stateType } : {}),
    });
    if (own !== null && !words.includes(own)) words.push(own);
  }
  return words;
}

function isStandard(word: string): boolean {
  return (STANDARD_STEP_EVENTS as readonly string[]).includes(word);
}

/** The text a declared field's value is carried as: a sender's text as it is, any other mapped value as JSON. */
function fieldText(value: JsonValue): string {
  return typeof value === 'string' ? value : canonicalJson(value as never);
}

export function createWorkflowEventSink(deps: WorkflowEventSinkDeps): WorkflowEventSink {
  const nextId = deps.newEventId ?? newEventId;
  return {
    async prepare(transitions: readonly StepTransition[]): Promise<PreparedEvents> {
      const rows: PreparedWorkflowEvent[] = [];
      for (const transition of transitions) {
        // Shadow and test raise nothing (W33): they record "would raise" elsewhere.
        if (transition.run.shadow) continue;
        const flow = flowOf(transition.rule);
        const named = flow?.events;
        if (flow === undefined || named === undefined) continue;
        let schema: WorkflowEventSchema;
        let step: FlowStep | null = null;
        let words: readonly string[];
        if (transition.stepId === null) {
          schema = 'run';
          const word = RUN_WORDS[transition.transition as RunTransition];
          words = word !== undefined && (named.run ?? []).includes(word as never) ? [word] : [];
        } else {
          step = flow.steps[transition.stepId] ?? null;
          if (step === null) continue;
          try {
            schema = schemaOf(step, targetKindOf(transition.rule, step));
          } catch {
            continue;
          }
          const ticked = new Set(step.emit ?? []);
          // A Raise step's one event is raised whenever it settles; every other word only when ticked (W23, W28).
          words = wordsOf(schema, step, transition).filter((word) => step?.kind === 'raise' || ticked.has(word));
        }
        for (const word of words) {
          const raise = step?.kind === 'raise';
          const id =
            raise && typeof transition.output?.event === 'string' ? (transition.output.event as string) : nextId();
          // W.2: no outcome for started, waiting, retrying and skipped, nor for a run's own words; a duration for a
          // settle (succeeded, failed and the outcome words) only.
          const outcomeLess = schema === 'run' || (isStandard(word) && OUTCOME_LESS.includes(word));
          const data: Omit<WorkflowEventDataV1, 'fields'> = {
            workflow: {
              id: transition.rule.ruleId,
              version: transition.rule.version,
              namespace: named.namespace,
              name: named.workflow,
            },
            run: {
              id: transition.run.id,
              startedAt: iso(transition.run.startedAt),
              depth: transition.run.depth,
              parent: transition.run.parentRunId,
            },
            step:
              step === null || transition.stepId === null
                ? null
                : {
                    id: transition.stepId,
                    kind: step.kind,
                    label: step.label ?? null,
                    index: transition.index,
                    attempt: transition.attempt,
                  },
            path: [...transition.path],
            event: word,
            outcome: outcomeLess ? null : transition.outcome,
            durationMs: (schema === 'run' ? word === 'started' || word === 'held' : outcomeLess)
              ? null
              : transition.durationMs,
            error: word === 'failed' || word === 'retrying' ? transition.error : null,
            outputs: eventOutputs(schema, step, transition),
            ...(word === 'retrying' && transition.nextAt !== null ? { nextAt: iso(transition.nextAt) } : {}),
            ...(word === 'waiting' && transition.wait !== null
              ? { wait: { kind: transition.wait.kind, since: iso(transition.wait.since) } }
              : {}),
          };
          // A Raise step's declared fields, by the mapped field's name: the only sender content an event can hold, sealed
          // with it, and shown only to a subscriber whose approved subscription allows it, enveloped (W27).
          let fields: Record<string, string> | undefined;
          if (step?.kind === 'raise' && (step.fields ?? []).length > 0 && deps.fields !== undefined) {
            const mapped = await deps.fields(transition.run);
            fields = {};
            for (const name of step.fields ?? [])
              if (Object.hasOwn(mapped, name)) fields[name] = fieldText(mapped[name] as JsonValue);
          }
          const event: WorkflowCloudEventV1 = buildWorkflowCloudEvent({
            id,
            installationId: deps.installationId,
            ruleId: transition.rule.ruleId,
            ruleVersion: transition.rule.version,
            type: workflowEventType(named.namespace, named.workflow, transition.stepId ?? 'run', word),
            schema,
            time: iso(transition.at),
            runId: transition.run.id,
            stepId: transition.stepId,
            data,
            ...(fields === undefined ? {} : { fields }),
          });
          const sealed = await deps.cipher.encrypt(
            workflowEventLocation(id),
            Buffer.from(workflowEventBytes(event), 'utf8'),
          );
          rows.push({
            id,
            run: transition.run,
            stepId: transition.stepId,
            type: event.type,
            schema,
            raisedAt: transition.at,
            expiresAt: transition.at + transition.rule.retention.deliveryMs,
            eventsPerHour: flow.limits.eventsPerHour,
            data,
            sealed,
          });
        }
      }
      return { rows };
    },

    commitInTransaction(database: DatabaseSync, prepared: PreparedEvents): void {
      const rows = prepared.rows as readonly PreparedWorkflowEvent[];
      if (rows.length === 0) return;
      const subscriptions = activeSubscriptions(database);
      const settings = database
        .prepare('SELECT events_per_hour_max FROM workflow_settings WHERE singleton = 1')
        .get() as { events_per_hour_max: number } | undefined;
      const ceiling = settings?.events_per_hour_max ?? 1_000;
      for (const row of rows) {
        const since = row.raisedAt - HOUR_MS;
        const { mine } = database
          .prepare("SELECT COUNT(*) AS mine FROM workflow_effects WHERE kind = 'event' AND rule_id = ? AND at > ?")
          .get(row.run.ruleId, since) as { mine: number };
        const { total } = database
          .prepare("SELECT COUNT(*) AS total FROM workflow_effects WHERE kind = 'event' AND at > ?")
          .get(since) as { total: number };
        if (mine >= row.eventsPerHour || total >= ceiling) {
          // Over a limit: not raised, counted in the run (EVENT_LIMIT), and never in the run's way (W33).
          database
            .prepare('UPDATE workflow_runs SET events_not_raised = events_not_raised + 1 WHERE id = ?')
            .run(row.run.id);
          continue;
        }
        const matching = subscriptions.filter((subscription) => subscriptionMatches(subscription.events, row.type));
        const { sequence } = database
          .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workflow_events WHERE run_id = ?')
          .get(row.run.id) as { sequence: number };
        database
          .prepare(
            `INSERT INTO workflow_events
               (id, run_id, step_id, rule_id, rule_version, account_id, type, schema, sequence, raised_at, expires_at,
                state, encrypted_record)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.run.id,
            row.stepId,
            row.run.ruleId,
            row.run.ruleVersion,
            row.run.accountId,
            row.type,
            row.schema,
            sequence,
            row.raisedAt,
            row.expiresAt,
            // An event no subscription receives is raised all the same, content-free: there is nothing to keep.
            matching.length === 0 ? 'done' : 'open',
            matching.length === 0 ? null : row.sealed,
          );
        database
          .prepare("INSERT INTO workflow_effects (rule_id, kind, at) VALUES (?, 'event', ?)")
          .run(row.run.ruleId, row.raisedAt);
        for (const subscription of matching) {
          const { ordering } = database
            .prepare(
              `SELECT COALESCE(MAX(ordering_sequence), 0) + 1 AS ordering FROM event_deliveries
                WHERE subscriber_id = ? AND subscriber_version = ?`,
            )
            .get(subscription.subscriberId, subscription.version) as { ordering: number };
          database
            .prepare(
              `INSERT INTO event_deliveries
                 (event_id, subscriber_id, subscriber_version, kind, state, attempts, next_at, ordering_sequence)
               VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
            )
            .run(row.id, subscription.subscriberId, subscription.version, subscription.kind, row.raisedAt, ordering);
          expireSubscriberBacklogInTransaction(database, subscription.subscriberId, subscription.version, row.raisedAt);
        }
        deps.onRaisedInTransaction?.(database, row, row.raisedAt);
      }
    },
  };
}
