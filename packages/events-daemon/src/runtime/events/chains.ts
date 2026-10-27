import type { DatabaseSync } from 'node:sqlite';
import { type FlowOn, type JsonValue, matchesEventPattern } from '@agentcomms/events';
import type { ProjectionCipher } from '../projections.ts';
import type { Output, RunView } from '../workflow/contracts.ts';
import { settleFinishedEventsInTransaction } from './event-ledger.ts';
import { workflowEventLocation } from './sink.ts';

/**
 * Chains (workflows design W34, §9.3): a raised event may start another workflow, about the same message. A chained
 * workflow — one whose flow has `on` — admits each message as any workflow does, then waits: its evaluator commits an
 * `awaiting-chain` decision, content-free, that keeps the message's projection sealed until a run about that message
 * raises an event its `on.raised` matches, or `withinMs` passes. The source cursor is never held for it, as a judge's
 * hold keeps its content past admission (`runtime/holds.ts`).
 *
 * The sink asks here, in the engine's transaction, for one `workflow_chain_requests` row per chained workflow the event
 * matches, for the raising run's message, while the run is under depth 3. The owner's tick then gates and maps each
 * waiting message a request has come for, through the chained workflow's own approval, and its run gets the raising
 * run as its parent, the parent's depth plus 1, and the raised event's closed `data` under `/trigger`: never its
 * declared fields, which are the raising workflow's to give. A decision is one per message and workflow version, so a
 * chain never loops. At the deadline the wait ends `not-chained`, content-free, and the projection goes.
 */

/** A chain reaches at most this depth: an event raised by a run at this depth starts nothing. */
export const CHAIN_DEPTH_MAX = 3;

/** The decision a chained workflow keeps while it waits for its chain, and the one it ends with when none came. */
export const AWAITING_CHAIN = 'awaiting-chain';
export const NOT_CHAINED = 'not-chained';

/** One `workflow_chain_requests` row: content-free. */
export interface ChainRequestRow {
  readonly event_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly workflow_event_id: string;
  readonly parent_run_id: string;
  readonly depth: number;
  readonly requested_at: number;
}

/** What a chained run starts with: its parent, its depth, and the raised event's closed data as `/trigger`. */
export interface ChainStart {
  readonly parentRunId: string;
  readonly depth: number;
  readonly trigger: Output;
}

interface ChainedVersionRow {
  readonly rule_id: string;
  readonly version: number;
  readonly state: 'active' | 'superseded';
  readonly document: string;
}

function onOf(document: string): FlowOn | undefined {
  try {
    return (JSON.parse(document) as { readonly flow?: { readonly on?: FlowOn } }).flow?.on;
  } catch {
    return undefined;
  }
}

/** Whether a chained workflow's `on.raised` names this event: each pattern's namespace and workflow are literal. */
function startsOn(on: FlowOn, type: string): boolean {
  return on.raised.some((pattern) => matchesEventPattern(type, pattern, [pattern.split('.')[0] as string]));
}

/**
 * The chain requests one raised event makes (§9.1), in the sink's transaction: one per chained workflow version whose
 * `on.raised` matches it, for the raising run's message, while the run is under depth 3. A version that has already
 * decided for the message is never asked again, so A → B → A ends at A; a superseded version is asked only for a
 * message it is already waiting on; a workflow never starts on its own run's events. Returns how many it made.
 */
export function chainRequestsInTransaction(
  database: DatabaseSync,
  event: Readonly<{ id: string; type: string }>,
  run: RunView,
  now: number,
): number {
  if (run.shadow || run.depth >= CHAIN_DEPTH_MAX) return 0;
  const versions = database
    .prepare(
      `SELECT rule_id, version, state, document FROM rule_versions
        WHERE state IN ('active', 'superseded') AND revoked_at IS NULL AND rule_id != ?
          AND json_extract(document, '$.flow.on') IS NOT NULL
        ORDER BY rule_id, version`,
    )
    .all(run.ruleId) as unknown as ChainedVersionRow[];
  let requested = 0;
  for (const version of versions) {
    const on = onOf(version.document);
    if (on === undefined || !startsOn(on, event.type)) continue;
    const decided = database
      .prepare('SELECT outcome FROM decisions WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .get(run.eventId, version.rule_id, version.version) as { outcome: string } | undefined;
    if (decided !== undefined && decided.outcome !== AWAITING_CHAIN) continue;
    if (version.state === 'superseded' && decided === undefined) continue;
    requested += Number(
      database
        .prepare(
          `INSERT OR IGNORE INTO workflow_chain_requests
             (event_id, rule_id, rule_version, workflow_event_id, parent_run_id, depth, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(run.eventId, version.rule_id, version.version, event.id, run.id, run.depth + 1, now).changes,
    );
  }
  return requested;
}

/** The chain request for one message and chained workflow version, if one has come. */
export function chainRequestFor(
  database: DatabaseSync,
  eventId: string,
  ruleId: string,
  ruleVersion: number,
): ChainRequestRow | undefined {
  return database
    .prepare('SELECT * FROM workflow_chain_requests WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
    .get(eventId, ruleId, ruleVersion) as ChainRequestRow | undefined;
}

/** Whether a chained workflow version is waiting for its chain on this message. */
export function isAwaitingChain(database: DatabaseSync, eventId: string, ruleId: string, ruleVersion: number): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present FROM decisions
          WHERE event_id = ? AND rule_id = ? AND rule_version = ? AND outcome = '${AWAITING_CHAIN}'`,
      )
      .get(eventId, ruleId, ruleVersion) !== undefined
  );
}

/**
 * The start a request gives a chained run: the raising run, its depth, and the raised event's closed `data` — opened
 * from the event's sealed record, which the sink keeps while a chain may still read it — without `fields`. Null when
 * the record is gone: its event expired or was cancelled, and the chain has nothing to start from.
 */
export async function chainStartFor(
  database: DatabaseSync,
  cipher: Pick<ProjectionCipher, 'decrypt'>,
  request: ChainRequestRow,
): Promise<ChainStart | null> {
  const row = database
    .prepare('SELECT encrypted_record FROM workflow_events WHERE id = ?')
    .get(request.workflow_event_id) as { encrypted_record: Uint8Array | null } | undefined;
  if (row === undefined || row.encrypted_record === null) return null;
  const opened = await cipher.decrypt(workflowEventLocation(request.workflow_event_id), row.encrypted_record);
  const event = JSON.parse(opened.toString('utf8')) as { readonly data?: unknown };
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const { fields: _declared, ...closed } = data as Record<string, JsonValue>;
  return { parentRunId: request.parent_run_id, depth: request.depth, trigger: closed };
}

/** The start for one message and chained workflow version, or null when no request came or its event is gone. */
export async function chainStartForMessage(
  database: DatabaseSync,
  cipher: Pick<ProjectionCipher, 'decrypt'>,
  message: Readonly<{ eventId: string; ruleId: string; ruleVersion: number }>,
): Promise<ChainStart | null> {
  const request = chainRequestFor(database, message.eventId, message.ruleId, message.ruleVersion);
  return request === undefined ? null : chainStartFor(database, cipher, request);
}

/**
 * Ends the chain request a decision answered, in that decision's transaction, and settles the raised event: once no
 * chain and no delivery needs it, its sealed record goes.
 */
export function consumeChainRequestInTransaction(
  database: DatabaseSync,
  message: Readonly<{ eventId: string; ruleId: string; ruleVersion: number }>,
  now: number,
): void {
  const ended = database
    .prepare(
      `DELETE FROM workflow_chain_requests WHERE event_id = ? AND rule_id = ? AND rule_version = ?
        RETURNING workflow_event_id`,
    )
    .all(message.eventId, message.ruleId, message.ruleVersion) as Array<{ workflow_event_id: string }>;
  settleFinishedEventsInTransaction(
    database,
    ended.map((row) => row.workflow_event_id),
    now,
  );
}

/** A waiting message a request has come for: the chained workflow version gates and maps it next. */
export interface ReadyChain {
  readonly eventId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly accountId: string;
  readonly whatsappMessageId: string | null;
}

/** The waiting messages whose chain request has come, oldest request first. */
export function readyChains(database: DatabaseSync, limit = 50): readonly ReadyChain[] {
  return (
    database
      .prepare(
        `SELECT decision.event_id, decision.rule_id, decision.rule_version, decision.account_id,
                projection.whatsapp_message_id
           FROM decisions AS decision
           JOIN workflow_chain_requests AS request
             ON request.event_id = decision.event_id
            AND request.rule_id = decision.rule_id
            AND request.rule_version = decision.rule_version
           JOIN ingest_rules AS projection
             ON projection.event_id = decision.event_id
            AND projection.rule_id = decision.rule_id
            AND projection.rule_version = decision.rule_version
          WHERE decision.outcome = '${AWAITING_CHAIN}'
          ORDER BY request.requested_at, decision.event_id, decision.rule_id, decision.rule_version
          LIMIT ?`,
      )
      .all(limit) as Array<{
      event_id: string;
      rule_id: string;
      rule_version: number;
      account_id: string;
      whatsapp_message_id: string | null;
    }>
  ).map((row) => ({
    eventId: row.event_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    accountId: row.account_id,
    whatsappMessageId: row.whatsapp_message_id,
  }));
}

/**
 * What time and purges have ended, content-free (§9.3): a wait whose deadline has passed, or whose projection a purge
 * took (a revocation, an account's removal, a disable), ends `not-chained` and its projection goes; a request that was
 * answered, whose wait lapsed, or whose version is gone, ends, and its raised event is settled. Returns how many waits
 * ended.
 */
export function sweepChainsInTransaction(database: DatabaseSync, now: number): number {
  const waits = database
    .prepare(
      `SELECT decision.id, decision.event_id, decision.rule_id, decision.rule_version
         FROM decisions AS decision
         LEFT JOIN ingest_rules AS projection
           ON projection.event_id = decision.event_id
          AND projection.rule_id = decision.rule_id
          AND projection.rule_version = decision.rule_version
        WHERE decision.outcome = '${AWAITING_CHAIN}'
          AND (projection.event_id IS NULL OR projection.decision_deadline <= ?)`,
    )
    .all(now) as Array<{ id: string; event_id: string; rule_id: string; rule_version: number }>;
  for (const wait of waits) {
    database
      .prepare(
        `UPDATE decisions SET outcome = '${NOT_CHAINED}', encrypted_record = NULL
          WHERE id = ? AND outcome = '${AWAITING_CHAIN}'`,
      )
      .run(wait.id);
    database
      .prepare('DELETE FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .run(wait.event_id, wait.rule_id, wait.rule_version);
  }
  const ended = database
    .prepare(
      `DELETE FROM workflow_chain_requests AS request
        WHERE EXISTS (
                SELECT 1 FROM decisions AS decision
                 WHERE decision.event_id = request.event_id
                   AND decision.rule_id = request.rule_id
                   AND decision.rule_version = request.rule_version
                   AND decision.outcome NOT IN ('${AWAITING_CHAIN}', 'hold'))
           OR NOT EXISTS (
                SELECT 1 FROM rule_versions AS version
                 WHERE version.rule_id = request.rule_id AND version.version = request.rule_version
                   AND version.state IN ('active', 'superseded') AND version.revoked_at IS NULL
                   AND request.requested_at + COALESCE(json_extract(version.document, '$.flow.on.withinMs'), 0) > ?)
       RETURNING workflow_event_id`,
    )
    .all(now) as Array<{ workflow_event_id: string }>;
  settleFinishedEventsInTransaction(
    database,
    ended.map((row) => row.workflow_event_id),
    now,
  );
  return waits.length;
}
