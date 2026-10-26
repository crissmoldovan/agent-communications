import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { type ApprovalStore, CommsError, type ConfigStore, newBoundary, wrapUntrusted } from '@agentcomms/core';
import { buildSessionPrompt, type JsonValue, type ResolvedContextPart } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { newQueueItemId, parseQueueItemContent } from '../domain/queue-target.ts';
import type { SessionTargetDocument } from '../domain/session-target.ts';
import { PackedRecordError } from '../store/crypto.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { queueDeadlines } from '../store/retention.ts';
import { assertLiveEventAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import type { AgentSessionService, ReadyRelay } from './agent-sessions.ts';
import type { SessionDeliveryRecord } from './deliveries.ts';
import {
  type ClaimedDelivery,
  claimDelivery,
  type DeliveryClaimResult,
  hasLiveDeliveryLineage,
  isCurrentDeliveryClaim,
  releaseDeliveryClaim,
} from './delivery-claim.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import type { DeliveryDispatchHandler, DispatchResult } from './dispatcher.ts';
import { EventExpiry } from './expiry.ts';
import { queueItemLocation, ruleFor } from './queue-dispatcher.ts';
import type { RelaySessionV1, RelaySnapshotV1 } from './relay-client.ts';
import { isPromptableSession, RelayError } from './relay-client.ts';
import type { ContextGenerator } from './session-context.ts';
import { fileStillAllowed, resolveContextParts } from './session-context.ts';
import { enqueueSessionDeliveryInTransaction, type SessionQueueFollower } from './session-queue.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';
import type { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';

/**
 * The agent-session target's delivery boundary (0.33.0 design §3.5–§3.6). It claims a delivery with every fence the
 * queue's has, finds the session — the realpath of its folder, or the relay session behind the window bound to its lane
 * — or starts one when the target says so, and posts the prompt written in the fixed frame, under the delivery's own id
 * as `startId`, so a retry makes no second run. A busy session (409, or a live run) puts the delivery in the busy
 * queue, or leaves it in the Queue, as the target says; a lane whose window the relay does not run falls back to 0.31's
 * lane wake, the item a lane queue item as today, and the delivery says so (`LEFT_IN_LANE`).
 */

/** How a session delivery ended when it did not reach a session: the Queue's words, never an error. */
export const SESSION_FALLBACK_CODES: readonly ['LEFT_IN_LANE', 'LEFT_IN_QUEUE'] = Object.freeze([
  'LEFT_IN_LANE',
  'LEFT_IN_QUEUE',
] as const);

/** A relay failure retries with a backoff; after this many tries the delivery is dead-lettered. */
export const SESSION_RETRY_LIMIT = 12;
const MAX_BACKOFF_MS = 30 * 60_000;
const DEFAULT_DEAD_LETTER_MS = 7 * 86_400_000;
const MAX_CANDIDATES = 8;

const START_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** The `startId` a delivery's run is made under: its own id when that is a v4 UUID, else one derived from it. */
export function sessionStartId(deliveryId: string): string {
  if (START_ID.test(deliveryId)) return deliveryId;
  const hex = createHash('sha256').update(`agent-comms-start:${deliveryId}`).digest('hex');
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface DeliveryRow {
  readonly id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly expires_at: number;
  readonly switch_generation: number;
  readonly attempts: number;
  readonly decision_id: string;
  readonly event_id: string;
  readonly occurred_at: number;
  readonly whatsapp_message_id: string | null;
}

interface Delivery {
  readonly claim: ClaimedDelivery;
  readonly rule: CanonicalFullRuleDocument;
  readonly target: SessionTargetDocument;
  readonly record: SessionDeliveryRecord;
  readonly row: DeliveryRow;
}

export interface SessionDispatcherOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly sessions: AgentSessionService;
  readonly follower: Pick<SessionQueueFollower, 'notify'>;
  readonly generate: ContextGenerator;
  readonly expiry?: EventExpiry | undefined;
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly leaseMs?: number | undefined;
  readonly whatsappVisibilityFence?:
    | Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility' | 'withCurrentSseFrameVisibility'>
    | undefined;
  readonly newItemId?: ((now: number) => string) | undefined;
  /** Told after a fallback item commits, so a lane's watches settle at once; never throws. */
  readonly onAppended?: (() => void) | undefined;
}

export class SessionDispatcher implements DeliveryDispatchHandler {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #sessions: AgentSessionService;
  readonly #follower: Pick<SessionQueueFollower, 'notify'>;
  readonly #generate: ContextGenerator;
  readonly #expiry: EventExpiry;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #whatsapp: SessionDispatcherOptions['whatsappVisibilityFence'];
  readonly #newItemId: (now: number) => string;
  readonly #onAppended: (() => void) | undefined;

  constructor(options: SessionDispatcherOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#follower = options.follower;
    this.#generate = options.generate;
    this.#expiry = options.expiry ?? new EventExpiry(options.store, options.now ?? Date.now);
    this.#fence = options.fence ?? assertDisclosable;
    this.#now = options.now ?? Date.now;
    // A start may wait on a model and the relay: the lease outlasts both, so a recovery never races a live attempt.
    this.#leaseMs = options.leaseMs ?? 120_000;
    this.#whatsapp = options.whatsappVisibilityFence;
    this.#newItemId = options.newItemId ?? newQueueItemId;
    this.#onAppended = options.onAppended;
  }

  async dispatch(deliveryId: string): Promise<DispatchResult> {
    this.#expiry.sweep();
    let claimed: DeliveryClaimResult;
    try {
      claimed = await claimDelivery({
        store: this.#store,
        deliveryId,
        now: this.#now(),
        leaseMs: this.#leaseMs,
        newAttemptId: randomUUID,
        newLeaseToken: randomUUID,
        assertAccountLive: (accountId) => {
          const row = deliveryRow(this.#store, deliveryId);
          return assertLiveEventAccount(this.#config, {
            source: ruleFor(this.#store, row?.rule_id ?? '', row?.rule_version ?? 0).source.channel,
            accountId,
          });
        },
        preflight: (row) => this.#fence(this.#fenceRequest(row)).then(() => undefined),
      });
    } catch (error) {
      const row = deliveryRow(this.#store, deliveryId);
      if (row !== undefined && isRemovedAccountError(error)) {
        this.#purgeAccount(ruleFor(this.#store, row.rule_id, row.rule_version).source.channel, row.account_id);
        return { state: 'terminal', deliveryId };
      }
      throw error;
    }
    if (claimed.kind !== 'claimed') return { state: claimed.kind, deliveryId };
    const claim = claimed.claim;
    let delivery: Delivery;
    try {
      const rule = ruleFor(this.#store, claim.ruleId, claim.ruleVersion);
      const target = rule.targets.find(
        (candidate) => candidate.targetId === claim.targetId && candidate.version === claim.targetVersion,
      );
      if (target?.kind !== 'session')
        throw new CommsError('APPROVAL_VOID', 'the delivery does not name an authorised session target');
      const row = deliveryRow(this.#store, claim.id);
      if (row === undefined) throw new CommsError('APPROVAL_VOID', 'the session delivery is missing');
      let record: SessionDeliveryRecord | null;
      try {
        record = sessionRecord(await this.#cipher.decrypt(deliveryLocation(claim.id), claim.encryptedRecord));
      } catch (error) {
        // A record that does not open — one byte changed, or bytes that are no record at all — ends its delivery as
        // content-unreadable; it is never let go only to be claimed again (security review of 0.33.0, second look, 4).
        if (!(error instanceof RecordStorageError) && !(error instanceof PackedRecordError)) throw error;
        record = null;
      }
      if (record === null) {
        this.#finish(claim, { state: 'content-unreadable' });
        return { state: 'unreadable', deliveryId };
      }
      delivery = { claim, rule, target, record, row };
    } catch (error) {
      releaseDeliveryClaim(this.#store, claim);
      throw error;
    }
    try {
      return await this.#deliver(delivery);
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#purgeAccount(delivery.rule.source.channel, claim.accountId);
        return { state: 'terminal', deliveryId };
      }
      if (error instanceof RelayError) return this.#retry(delivery, error.reason);
      releaseDeliveryClaim(this.#store, claim);
      throw error;
    }
  }

  /** Claims interrupted work again; a run already made is found again by its `startId`, never made twice. */
  async recoverLeases(): Promise<readonly DispatchResult[]> {
    const ids = this.#store.database
      .prepare(
        "SELECT id FROM deliveries WHERE state = 'disclosing' AND lease_until <= ? AND target_key GLOB 'session:*' ORDER BY id",
      )
      .all(this.#now()) as Array<{ id: string }>;
    return Promise.all(ids.map(({ id }) => this.dispatch(id)));
  }

  async #deliver(delivery: Delivery): Promise<DispatchResult> {
    const { target } = delivery;
    const lane = 'lane' in target.find ? target.find.lane : undefined;
    let binding: { readonly session_id: string | null; readonly since: number } | undefined;
    if (lane !== undefined) {
      binding = this.#store.database.prepare('SELECT session_id, since FROM lane_bindings WHERE lane = ?').get(lane) as
        | { session_id: string | null; since: number }
        | undefined;
      // No window, a window with no Claude Code session id, or a match from before the binding (routing B3): the lane.
      if (binding === undefined || binding.session_id === null || delivery.row.occurred_at < binding.since)
        return this.#leaveInQueue(delivery, lane);
    }
    let ready: ReadyRelay;
    try {
      ready = await this.#sessions.relay();
    } catch (error) {
      // The window bound to the lane is still woken through the lane when the relay cannot be used.
      if (lane !== undefined && error instanceof RelayError) return this.#leaveInQueue(delivery, lane);
      throw error;
    }
    const chosen = await this.#chosen(delivery, ready);
    // A delivery starts at most one session. The one it started takes no prompt now — fenced, moved, watched or gone —
    // so it fails, saying why, rather than starting another (security review of 0.33.0, second look, 1).
    if (chosen.kind === 'lost') return this.#deadLetter(delivery, chosen.code);
    let snapshot = chosen.kind === 'usable' ? chosen.snapshot : null;
    let started = false;
    if (snapshot === null) {
      const found = await this.#find(delivery, ready, binding?.session_id ?? null);
      if (found === 'observed') return this.#leaveInQueue(delivery, lane);
      if (found === null) {
        if (lane !== undefined || target.ifNone === 'queue-only') return this.#leaveInQueue(delivery, lane);
        const folder = await realpath((target.find as { readonly folder: string }).folder);
        const session = await ready.client.createSession({
          provider: target.provider,
          cwd: folder,
          requestedMode: target.mode,
          title: `Agent Comms: ${delivery.rule.ruleId}`,
        });
        snapshot = { session, runs: [], cursor: 0 };
        started = true;
      } else snapshot = found;
      if (!this.#record(delivery, snapshot.session.id, started))
        return { state: 'terminal', deliveryId: delivery.claim.id };
    }
    const sessionId = snapshot.session.id;
    const startId = sessionStartId(delivery.claim.id);
    // A start whose answer was lost made its run already: found by its startId, it is never made twice.
    const made = snapshot.runs.find((run) => run.startId === startId);
    if (made !== undefined) return this.#delivered(delivery, made.id);
    if (snapshot.session.activeRunId !== undefined) return this.#busy(delivery, sessionId);
    await this.#refence(delivery);
    // The context is resolved once per delivery — its model parts run once, its files are read once — and kept sealed
    // in the delivery's own record, so a busy session's next try sends the same words (security review of 0.33.0, 3).
    // A kept file part is sent again only while its folder is still one it may be read from (second look, 2).
    const kept = delivery.record.parts;
    const parts = kept === undefined ? await this.#resolve(delivery, ready) : await this.#stillAllowed(kept, ready);
    const prompt = await this.#prompt(delivery, parts);
    if (prompt === null) return this.#deadLetter(delivery, 'PROMPT_TOO_LARGE');
    if (kept === undefined && !(await this.#keepParts(delivery, parts)))
      return { state: 'terminal', deliveryId: delivery.claim.id };
    const visible = await this.#visible(delivery);
    if (!visible) {
      this.#finish(delivery.claim, { state: 'cancelled' });
      return { state: 'terminal', deliveryId: delivery.claim.id };
    }
    const result = await ready.client.startRun(sessionId, { prompt, requestedMode: target.mode, startId });
    if (result.kind === 'busy') return this.#busy(delivery, sessionId);
    return this.#delivered(delivery, result.run.id);
  }

  /**
   * Seals the resolved context into the delivery's own record, beside what it was resolved from, inside a transaction
   * that proves the claim is still this attempt's. The record goes when the delivery ends — dead-lettered too.
   */
  async #keepParts(delivery: Delivery, parts: readonly ResolvedContextPart[]): Promise<boolean> {
    const record: SessionDeliveryRecord = { ...delivery.record, parts };
    const sealed = await this.#cipher.encrypt(deliveryLocation(delivery.claim.id), Buffer.from(JSON.stringify(record)));
    return this.#store.immediate(
      () =>
        isCurrentDeliveryClaim(this.#store.database, delivery.claim) &&
        this.#store.database
          .prepare(
            `UPDATE deliveries SET encrypted_record = ?
              WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
          )
          .run(
            sealed,
            delivery.claim.id,
            delivery.claim.attemptId,
            delivery.claim.leaseToken,
            delivery.claim.leaseUntil,
          ).changes === 1,
    );
  }

  /** The run is made: the delivery is done, its record purged, and the run it made recorded beside the session. */
  #delivered(delivery: Delivery, runId: string): DispatchResult {
    const delivered = this.#finish(delivery.claim, { state: 'delivered' }, (database) =>
      database.prepare('UPDATE session_deliveries SET run_id = ? WHERE delivery_id = ?').run(runId, delivery.claim.id),
    );
    return { state: delivered ? 'delivered' : 'terminal', deliveryId: delivery.claim.id };
  }

  /**
   * The session an earlier try of this delivery chose: `usable` when the relay still runs it; `none` when there is none
   * to use, so another is found; `lost` when it is one this delivery started, which is never replaced by another.
   */
  async #chosen(
    delivery: Delivery,
    ready: ReadyRelay,
  ): Promise<
    | { readonly kind: 'usable'; readonly snapshot: RelaySnapshotV1 }
    | { readonly kind: 'none' }
    | { readonly kind: 'lost'; readonly code: string }
  > {
    const row = this.#store.database
      .prepare('SELECT relay_session_id, started FROM session_deliveries WHERE delivery_id = ?')
      .get(delivery.claim.id) as { relay_session_id: string; started: number } | undefined;
    if (row === undefined) return { kind: 'none' };
    const snapshot = await ready.client.snapshot(row.relay_session_id);
    if (snapshot !== null && isPromptableSession(snapshot.session)) return { kind: 'usable', snapshot };
    if (row.started === 1) return { kind: 'lost', code: lostSessionCode(snapshot) };
    // Gone, or since become one the relay only watches, or fenced or moved away: it takes no prompt, so another is
    // found — never waited on (security review of 0.33.0, finding 3).
    this.#store.immediate(() =>
      this.#store.database.prepare('DELETE FROM session_deliveries WHERE delivery_id = ?').run(delivery.claim.id),
    );
    return { kind: 'none' };
  }

  /**
   * The session to send to: one whose realpath folder is the target's — or whose Claude Code session is the lane
   * window's — run by the target's provider, the most recently active of several. `observed` when the lane's window is
   * one the relay only watches: it takes no prompt, so the lane wakes it instead.
   */
  async #find(
    delivery: Delivery,
    ready: ReadyRelay,
    laneSession: string | null,
  ): Promise<RelaySnapshotV1 | 'observed' | null> {
    const { target } = delivery;
    const sessions = await ready.client.sessions();
    let candidates: RelaySessionV1[];
    if ('folder' in target.find) {
      let folder: string;
      try {
        folder = await realpath(target.find.folder);
      } catch {
        throw new RelayError('RELAY_REFUSED', 'the session folder is not there');
      }
      candidates = sessions.filter(
        (session) => session.cwd === folder && session.provider === target.provider && isPromptableSession(session),
      );
    } else {
      const bound = sessions.filter((session) => session.nativeSessionId === laneSession);
      if (bound.some((session) => !isPromptableSession(session))) return 'observed';
      candidates = bound.filter((session) => session.provider === target.provider);
    }
    if (candidates.length === 0) return null;
    const snapshots: RelaySnapshotV1[] = [];
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      const snapshot = await ready.client.snapshot(candidate.id);
      if (snapshot !== null) snapshots.push(snapshot);
    }
    snapshots.sort((left, right) => lastActive(right) - lastActive(left) || compare(left.session.id, right.session.id));
    return snapshots[0] ?? null;
  }

  /** Records the session this delivery chose, inside a transaction that proves the claim is still this attempt's. */
  #record(delivery: Delivery, relaySessionId: string, started: boolean): boolean {
    return this.#store.immediate(() => {
      if (!isCurrentDeliveryClaim(this.#store.database, delivery.claim)) return false;
      this.#store.database
        .prepare(
          `INSERT INTO session_deliveries (delivery_id, relay_session_id, started, run_id, chosen_at)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT (delivery_id) DO UPDATE SET relay_session_id = excluded.relay_session_id,
             started = excluded.started, run_id = NULL, chosen_at = excluded.chosen_at`,
        )
        .run(delivery.claim.id, relaySessionId, started ? 1 : 0, this.#now());
      return true;
    });
  }

  /** The parts this delivery's target lists, resolved: each model's words, each file's text, or the note for each. */
  async #resolve(delivery: Delivery, ready: ReadyRelay): Promise<readonly ResolvedContextPart[]> {
    return resolveContextParts({
      parts: delivery.target.context,
      values: delivery.record.values,
      fileRoots: await this.#sessions.fileRoots(ready),
      deniedFolders: this.#sessions.deniedFolders(),
      generate: this.#generate,
    });
  }

  /**
   * The kept parts, each file part's folder checked again against the folders a file may be read from now: one the
   * person has since taken off the list, or one the relay no longer allows, is left out, with the note that says so.
   */
  async #stillAllowed(
    parts: readonly ResolvedContextPart[],
    ready: ReadyRelay,
  ): Promise<readonly ResolvedContextPart[]> {
    if (!parts.some((part) => part.kind === 'file')) return parts;
    const roots = await this.#sessions.fileRoots(ready);
    const denied = this.#sessions.deniedFolders();
    const checked: ResolvedContextPart[] = [];
    for (const part of parts)
      checked.push(
        part.kind === 'file' && !(await fileStillAllowed(part.path, roots, denied))
          ? { kind: 'file-missing', path: part.path, reason: 'outside' }
          : part,
      );
    return checked;
  }

  /** The fixed frame around the resolved parts, with a boundary of its own; null when it is longer than a session takes. */
  async #prompt(delivery: Delivery, parts: readonly ResolvedContextPart[]): Promise<string | null> {
    const boundary = newBoundary();
    const built = buildSessionPrompt({
      ruleId: delivery.rule.ruleId,
      channel: delivery.rule.source.channel,
      account: await this.#accountName(delivery),
      parts,
      ...(delivery.target.instruction === undefined ? {} : { instruction: delivery.target.instruction }),
      envelope: (text, source) =>
        wrapUntrusted(text, { field: source === 'message' ? 'event' : source, id: delivery.claim.id }, boundary),
    });
    return built.ok ? built.value : null;
  }

  /** The account as the person knows it — its alias, `cue/gmail` — or its id when it has none. */
  async #accountName(delivery: Delivery): Promise<string> {
    const config = await this.#config.load();
    const id = delivery.claim.accountId;
    const inbox = Object.entries(config.inboxes).find(([, entry]) => entry.id === id)?.[0];
    const account = Object.entries(config.accounts).find(([, entry]) => entry.id === id)?.[0];
    return inbox ?? account ?? id;
  }

  /** Busy: the busy queue, or the Queue, as the target says (§3.5). */
  async #busy(delivery: Delivery, relaySessionId: string): Promise<DispatchResult> {
    if (delivery.target.ifBusy === 'queue-only')
      return this.#leaveInQueue(delivery, 'lane' in delivery.target.find ? delivery.target.find.lane : undefined);
    // A busy session is not a failure: the try is given back, so a session the person keeps busy never fails the match.
    // It waits, until its own expiry, each try further apart (security review of 0.33.0, second look, 3); a try is cheap,
    // since its context was resolved once. Only other failures count against SESSION_RETRY_LIMIT.
    const now = this.#now();
    const queued = this.#store.immediate(() => {
      const database = this.#store.database;
      if (!isCurrentDeliveryClaim(database, delivery.claim)) return false;
      // It keeps its record and waits, due only at its own expiry, until the session's run ends and lets it go.
      const changed = database
        .prepare(
          `UPDATE deliveries SET state = 'retryable', lease_until = NULL, next_at = expires_at,
                  attempts = MAX(0, attempts - 1), last_error_code = 'SESSION_BUSY', last_status = 409
            WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(delivery.claim.id, delivery.claim.attemptId, delivery.claim.leaseToken, delivery.claim.leaseUntil).changes;
      if (changed !== 1) return false;
      enqueueSessionDeliveryInTransaction(database, {
        deliveryId: delivery.claim.id,
        relaySessionId,
        ruleId: delivery.claim.ruleId,
        ruleVersion: delivery.claim.ruleVersion,
        targetId: delivery.claim.targetId,
        targetVersion: delivery.claim.targetVersion,
        now,
      });
      return true;
    });
    if (queued) this.#follower.notify();
    return { state: queued ? 'busy' : 'terminal', deliveryId: delivery.claim.id };
  }

  /**
   * Leaves the match in the Queue — its lane's when the target finds by a lane, so the bound window is woken as 0.31's
   * lane does — and finishes the delivery saying so. The item is the one the person's mapping allows (Q4).
   */
  async #leaveInQueue(delivery: Delivery, lane: string | undefined): Promise<DispatchResult> {
    const { rule, claim, row, record } = delivery;
    const queueMs = rule.retention.queueMs;
    if (record.item === undefined || queueMs === undefined) return this.#deadLetter(delivery, 'NO_QUEUE_ITEM');
    const sealed = await this.#sealItem(delivery);
    const now = this.#now();
    const append = () =>
      this.#store.immediate(() => {
        const database = this.#store.database;
        if (!isCurrentDeliveryClaim(database, claim)) return false;
        if (
          !hasLiveDeliveryLineage(database, { ...row, target_id: claim.targetId, target_version: claim.targetVersion })
        )
          return false;
        const deadlines = queueDeadlines(now, queueMs, queueMs);
        database
          .prepare(
            `INSERT INTO queue_items
              (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id,
               channel, whatsapp_message_id, state, state_at, arrived_at, appended_at, retention_ms, expires_at,
               row_expires_at, released, encrypted_record)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sealed.itemId,
            claim.id,
            row.decision_id,
            row.event_id,
            claim.ruleId,
            claim.ruleVersion,
            claim.targetId,
            claim.targetVersion,
            claim.accountId,
            rule.source.channel,
            row.whatsapp_message_id,
            now,
            row.occurred_at,
            now,
            deadlines.retentionMs,
            deadlines.expiresAt,
            deadlines.rowExpiresAt,
            record.released ? 1 : 0,
            sealed.bytes,
          );
        const settled = database
          .prepare(
            `UPDATE deliveries SET state = 'delivered', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
                    last_error_code = ?, last_status = NULL
              WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
          )
          .run(
            lane === undefined ? 'LEFT_IN_QUEUE' : 'LEFT_IN_LANE',
            claim.id,
            claim.attemptId,
            claim.leaseToken,
            claim.leaseUntil,
          ).changes;
        if (settled !== 1) throw new CommsError('APPROVAL_VOID', 'the session delivery changed before its item');
        dropRetainedTargetReference(database, claim.id, now);
        return true;
      });
    const appended =
      row.whatsapp_message_id === null
        ? append()
        : this.#whatsapp === undefined
          ? (() => {
              throw new CommsError(
                'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
                'a WhatsApp session delivery requires the concrete visibility fence',
              );
            })()
          : ((await this.#whatsapp.withCurrentDryRunVisibility(
              { accountId: claim.accountId, whatsappMessageId: row.whatsapp_message_id },
              () => this.#refence(delivery),
              append,
            )) ?? false);
    if (appended)
      try {
        this.#onAppended?.();
      } catch {
        // A lane's wake is told again on its next look; the committed item is unaffected.
      }
    return { state: appended ? 'delivered' : 'terminal', deliveryId: claim.id };
  }

  async #sealItem(delivery: Delivery): Promise<{ readonly itemId: string; readonly bytes: Buffer }> {
    const itemId = this.#newItemId(this.#now());
    const bytes = await this.#cipher.encrypt(
      queueItemLocation(itemId),
      Buffer.from(JSON.stringify(delivery.record.item ?? {})),
    );
    await this.#refence(delivery);
    return { itemId, bytes };
  }

  /** Every fence again, just before anything leaves: the rule's authority and the account, as at the claim. */
  async #refence(delivery: Delivery): Promise<void> {
    await this.#fence(this.#fenceRequest(delivery.claim));
    await assertLiveEventAccount(this.#config, {
      source: delivery.rule.source.channel,
      accountId: delivery.claim.accountId,
    });
  }

  /** A WhatsApp match is passed on only while its message is still in a visible chat (D6). */
  async #visible(delivery: Delivery): Promise<boolean> {
    const messageId = delivery.row.whatsapp_message_id;
    if (messageId === null) return true;
    if (this.#whatsapp === undefined)
      throw new CommsError(
        'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
        'a WhatsApp session delivery requires the concrete visibility fence',
      );
    const visible = await this.#whatsapp.withCurrentSseFrameVisibility(
      { accountId: delivery.claim.accountId, whatsappMessageId: messageId },
      () => this.#refence(delivery),
      () => true,
    );
    return visible === true;
  }

  /** A relay failure: tried again with a backoff, dead-lettered after `SESSION_RETRY_LIMIT` tries; busy ones are not. */
  #retry(delivery: Delivery, code: string): DispatchResult {
    // The claim already counted this try.
    const attempts = delivery.row.attempts;
    if (attempts >= SESSION_RETRY_LIMIT) return this.#deadLetter(delivery, code);
    const nextAt = this.#now() + Math.min(1_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
    if (nextAt >= delivery.claim.expiresAt) {
      this.#finish(delivery.claim, { state: 'retention-expired', code });
      return { state: 'expired', deliveryId: delivery.claim.id };
    }
    const retried = this.#store.immediate(
      () =>
        isCurrentDeliveryClaim(this.#store.database, delivery.claim) &&
        this.#store.database
          .prepare(
            `UPDATE deliveries SET state = 'retryable', lease_until = NULL, next_at = ?, last_error_code = ?,
                    last_status = NULL
              WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
          )
          .run(
            nextAt,
            code,
            delivery.claim.id,
            delivery.claim.attemptId,
            delivery.claim.leaseToken,
            delivery.claim.leaseUntil,
          ).changes === 1,
    );
    return { state: retried ? 'waiting-order' : 'terminal', deliveryId: delivery.claim.id };
  }

  #deadLetter(delivery: Delivery, code: string): DispatchResult {
    const now = this.#now();
    this.#store.immediate(
      () =>
        isCurrentDeliveryClaim(this.#store.database, delivery.claim) &&
        this.#store.database
          .prepare(
            `UPDATE deliveries SET state = 'dead-lettered', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
                    last_error_code = ?, dead_lettered_at = COALESCE(dead_lettered_at, ?),
                    dead_letter_expires_at = COALESCE(dead_letter_expires_at, ?)
              WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
          )
          .run(
            code,
            now,
            now + (delivery.rule.retention.deadLetterMs ?? DEFAULT_DEAD_LETTER_MS),
            delivery.claim.id,
            delivery.claim.attemptId,
            delivery.claim.leaseToken,
            delivery.claim.leaseUntil,
          ).changes === 1,
    );
    return { state: 'terminal', deliveryId: delivery.claim.id };
  }

  /** Ends the exact attempt in one transaction, its record purged, with any extra write it carries. */
  #finish(
    claim: ClaimedDelivery,
    change: {
      readonly state: 'delivered' | 'cancelled' | 'retention-expired' | 'content-unreadable';
      readonly code?: string | undefined;
    },
    extra?: (database: EventDatabase['database']) => void,
  ): boolean {
    const now = this.#now();
    return this.#store.immediate(() => {
      const database = this.#store.database;
      const changed = database
        .prepare(
          `UPDATE deliveries SET state = ?, encrypted_record = NULL, lease_until = NULL, next_at = NULL,
                  last_error_code = ?, last_status = NULL
            WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(change.state, change.code ?? null, claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil).changes;
      if (changed !== 1) return false;
      extra?.(database);
      dropRetainedTargetReference(database, claim.id, now);
      return true;
    });
  }

  #fenceRequest(row: {
    readonly accountId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly targetId: string;
    readonly targetVersion: number;
    readonly switchGeneration: number;
  }): ActiveDisclosableRequest {
    return {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: row.accountId,
      boundary: 'dispatch',
      ruleId: row.ruleId,
      ruleVersion: row.ruleVersion,
      targetId: row.targetId,
      targetVersion: row.targetVersion,
      switchGeneration: row.switchGeneration,
    };
  }

  #purgeAccount(source: CanonicalFullRuleDocument['source']['channel'], accountId: string): void {
    this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, { source, accountId }, this.#now()));
  }
}

/** Why the session a delivery started takes no prompt, as the code its dead letter carries. */
function lostSessionCode(snapshot: RelaySnapshotV1 | null): string {
  if (snapshot === null) return 'SESSION_GONE';
  if (snapshot.session.attached === 'observer') return 'SESSION_WATCHED';
  return snapshot.session.executor?.state === 'moved' ? 'SESSION_MOVED' : 'SESSION_FENCED';
}

function lastActive(snapshot: RelaySnapshotV1): number {
  if (snapshot.session.activeRunId !== undefined) return Number.POSITIVE_INFINITY;
  const times = [snapshot.session.createdAt, ...snapshot.runs.flatMap((run) => [run.createdAt, run.endedAt ?? ''])]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return Math.max(0, ...times);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deliveryRow(store: EventDatabase, id: string): DeliveryRow | undefined {
  return store.database
    .prepare(
      `SELECT d.id, d.account_id, d.rule_id, d.rule_version, d.expires_at, d.switch_generation, d.attempts,
              d.decision_id, decision.event_id, ingest.occurred_at, d.whatsapp_message_id
         FROM deliveries d
         JOIN decisions decision ON decision.id = d.decision_id
         JOIN ingest ON ingest.event_id = decision.event_id
        WHERE d.id = ?`,
    )
    .get(id) as DeliveryRow | undefined;
}

function deliveryLocation(id: string) {
  return { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

function dropRetainedTargetReference(database: EventDatabase['database'], deliveryId: string, now: number): void {
  for (const target of removeRetainedDeliveryTargetReference(database, deliveryId))
    purgeUnreferencedSystemTargets(database, { ...target, now });
}

/** Reads back a sealed session record; anything malformed is unreadable, never used in part. */
const GENERATE_FAILURES = new Set(['no-key', 'timeout', 'refused', 'failed', 'too-long', 'empty']);
const FILE_FAILURES = new Set(['missing', 'too-large', 'outside', 'not-a-file', 'unreadable']);
const GENERATE_PROVIDERS = new Set(['openrouter', 'anthropic']);

/** The resolved parts a record keeps, each of a shape the frame reads; null when any is not. */
function keptParts(value: unknown): readonly ResolvedContextPart[] | null {
  if (!Array.isArray(value)) return null;
  const text = (entry: unknown): entry is string => typeof entry === 'string';
  for (const part of value as unknown[]) {
    if (typeof part !== 'object' || part === null) return null;
    const entry = part as Record<string, unknown>;
    const ok =
      entry.kind === 'text'
        ? text(entry.text)
        : entry.kind === 'fields'
          ? Array.isArray(entry.fields) &&
            entry.fields.every(text) &&
            typeof entry.values === 'object' &&
            entry.values !== null &&
            !Array.isArray(entry.values)
          : entry.kind === 'generated'
            ? GENERATE_PROVIDERS.has(entry.provider as string) && text(entry.model) && text(entry.text)
            : entry.kind === 'generate-failed'
              ? GENERATE_PROVIDERS.has(entry.provider as string) &&
                text(entry.model) &&
                GENERATE_FAILURES.has(entry.reason as string)
              : entry.kind === 'file'
                ? text(entry.path) && text(entry.text)
                : entry.kind === 'file-missing' && text(entry.path) && FILE_FAILURES.has(entry.reason as string);
    if (!ok) return null;
  }
  return value as readonly ResolvedContextPart[];
}

function sessionRecord(value: Buffer): SessionDeliveryRecord | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<SessionDeliveryRecord>;
    if (parsed.kind !== 'session-message' || typeof parsed.released !== 'boolean') return null;
    if (typeof parsed.values !== 'object' || parsed.values === null || Array.isArray(parsed.values)) return null;
    let item: SessionDeliveryRecord['item'];
    if (parsed.item !== undefined) {
      const content = parseQueueItemContent(parsed.item);
      if (content === null) return null;
      item = content;
    }
    let parts: readonly ResolvedContextPart[] | undefined;
    if (parsed.parts !== undefined) {
      const kept = keptParts(parsed.parts);
      if (kept === null) return null;
      parts = kept;
    }
    return {
      kind: 'session-message',
      values: parsed.values as Readonly<Record<string, JsonValue>>,
      ...(item === undefined ? {} : { item }),
      released: parsed.released,
      ...(parts === undefined ? {} : { parts }),
    };
  } catch {
    return null;
  }
}
