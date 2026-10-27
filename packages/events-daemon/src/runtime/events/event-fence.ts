import type { DatabaseSync } from 'node:sqlite';
import { type ApprovalStore, CommsError, type ConfigStore, sha256Hex } from '@agentcomms/core';
import { subscriptionMatches } from '../../domain/event-subscription.ts';
import { assertDisclosable, type DisclosureBoundary } from '../disclosure-fence.ts';
import { type ActiveSubscription, activeSubscription } from './subscriptions.ts';

/**
 * W35's fence before an event leaves (workflows design W35, §9.2): two authorities let it out — the emitting workflow's
 * approval and the subscriber's — and a delivery needs both, live, checked again just before it leaves. The await-
 * capable half (`assertEventDisclosable`) re-reads the core approvals, the account and the workflow's lineage; the
 * synchronous half (`eventDisclosureIsCurrent`) runs in the transaction immediately before bytes are written or sent,
 * so a revocation that commits in between always wins.
 */

/** What an event's delivery to one subscriber version is checked against. */
export interface EventDisclosure {
  readonly eventId: string;
  readonly runId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly accountId: string;
  readonly switchGeneration: number;
  readonly type: string;
  readonly subscription: ActiveSubscription;
}

interface EventRunRow {
  readonly id: string;
  readonly run_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly account_id: string;
  readonly type: string;
  readonly state: string;
  readonly switch_generation: number;
}

function refuse(reason: string, message: string): never {
  throw new CommsError('APPROVAL_VOID', message, { details: { reason } });
}

function eventRun(database: DatabaseSync, eventId: string): EventRunRow | undefined {
  return database
    .prepare(
      `SELECT event.id, event.run_id, event.rule_id, event.rule_version, event.account_id, event.type, event.state,
              run.switch_generation
         FROM workflow_events AS event JOIN workflow_runs AS run ON run.id = event.run_id
        WHERE event.id = ?`,
    )
    .get(eventId) as EventRunRow | undefined;
}

/** The subscriber version's own approval: its completed subscription activation, and core's used disclosure record. */
async function assertSubscriptionApproved(
  database: DatabaseSync,
  approvals: Pick<ApprovalStore, 'get'>,
  subscription: ActiveSubscription,
): Promise<void> {
  const row = database
    .prepare('SELECT approval_id FROM subscriber_versions WHERE subscriber_id = ? AND version = ?')
    .get(subscription.subscriberId, subscription.version) as { approval_id: string | null } | undefined;
  const approvalId = row?.approval_id ?? null;
  if (approvalId === null) refuse('SUBSCRIPTION_NOT_APPROVED', "the subscriber version's events were never approved");
  const intent = database
    .prepare("SELECT document, status FROM activation_intents WHERE approval_id = ? AND kind = 'subscription'")
    .get(approvalId) as { document: string; status: string } | undefined;
  let digest: unknown;
  try {
    digest = (JSON.parse(intent?.document ?? '{}') as { subscription?: { digest?: unknown } }).subscription?.digest;
  } catch {
    digest = undefined;
  }
  if (intent?.status !== 'completed' || digest !== subscription.digest)
    refuse('SUBSCRIPTION_LINEAGE', "the subscriber version's approval does not match its stored document");
  const approval = await approvals.get(approvalId as string);
  if (approval?.form !== 'v2' || approval.record.kind !== 'disclosure' || approval.record.state !== 'used')
    refuse('SUBSCRIPTION_NOT_USED', "the subscriber version's standing approval is no longer in force");
}

/**
 * Both authorities, live: the emitting version active or retained superseded work, its account connected, at its run's
 * switch generation (`assertDisclosable`); the subscriber version active, unrevoked and approved; and its pattern
 * matching the event inside its namespaces. Throws `APPROVAL_VOID` (or the account's `NOT_FOUND`) to refuse.
 */
export async function assertEventDisclosable(input: {
  readonly database: DatabaseSync;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly eventId: string;
  readonly subscriberId: string;
  readonly subscriberVersion: number;
  readonly boundary: DisclosureBoundary;
}): Promise<EventDisclosure> {
  const row = eventRun(input.database, input.eventId);
  if (row === undefined) return refuse('EVENT_MISSING', 'the raised event or its run is no longer kept');
  await assertDisclosable({
    database: input.database,
    approvals: input.approvals,
    config: input.config,
    accountId: row.account_id,
    boundary: input.boundary,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    switchGeneration: row.switch_generation,
  });
  const subscription = activeSubscription(input.database, input.subscriberId, input.subscriberVersion);
  if (subscription === null) return refuse('SUBSCRIBER_REVOKED', 'the subscriber version no longer receives events');
  if (!subscriptionMatches(subscription.events, row.type))
    return refuse('PATTERN_MISMATCH', "the event is not one the subscriber's approved patterns name");
  await assertSubscriptionApproved(input.database, input.approvals, subscription);
  return {
    eventId: row.id,
    runId: row.run_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    accountId: row.account_id,
    switchGeneration: row.switch_generation,
    type: row.type,
    subscription,
  };
}

/**
 * The synchronous re-check, for the transaction directly before a write or a send: the event switch at the run's
 * generation, the emitting version neither revoked nor retired, and the subscriber version still the active, unrevoked
 * one with the same stored document. Content-free; it never awaits.
 */
export function eventDisclosureIsCurrent(database: DatabaseSync, disclosure: EventDisclosure): boolean {
  const settings = database
    .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
    .get() as { enabled: number; switch_generation: number } | undefined;
  if (settings?.enabled !== 1 || settings.switch_generation !== disclosure.switchGeneration) return false;
  const rule = database
    .prepare('SELECT state, revoked_at FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(disclosure.ruleId, disclosure.ruleVersion) as { state: string | null; revoked_at: number | null } | undefined;
  if (rule === undefined || rule.revoked_at !== null || (rule.state !== 'active' && rule.state !== 'superseded'))
    return false;
  const subscriber = database
    .prepare(
      `SELECT document, digest FROM subscriber_versions
        WHERE subscriber_id = ? AND version = ? AND state = 'active' AND revoked_at IS NULL`,
    )
    .get(disclosure.subscription.subscriberId, disclosure.subscription.version) as
    | { document: string; digest: string }
    | undefined;
  return (
    subscriber !== undefined &&
    subscriber.digest === disclosure.subscription.digest &&
    sha256Hex(subscriber.document) === subscriber.digest
  );
}
