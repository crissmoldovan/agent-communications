import { CommsError } from '@agentcomms/core';
import type { EventDatabase } from '../store/database.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';

export interface EventLifecycleStatus {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly switchGeneration: number;
}

export class EventLifecycle {
  private readonly store: EventDatabase;
  private readonly now: () => number;

  constructor(store: EventDatabase, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  status(): EventLifecycleStatus {
    const row = this.store.database
      .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
    if (!row) throw new CommsError('CONFIG', 'the local event settings are missing');
    return { enabled: row.enabled === 1, paused: row.paused === 1, switchGeneration: row.switch_generation };
  }

  async pause(): Promise<EventLifecycleStatus> {
    return this.store.immediate(() => {
      this.store.database
        .prepare('UPDATE event_settings SET paused = 1, changed_at = ? WHERE singleton = 1')
        .run(this.now());
      return this.status();
    });
  }

  async resume(): Promise<EventLifecycleStatus> {
    return this.store.immediate(() => {
      this.store.database
        .prepare('UPDATE event_settings SET paused = 0, changed_at = ? WHERE singleton = 1')
        .run(this.now());
      return this.status();
    });
  }

  /**
   * D12's one immediate tightening, in one transaction: switch off and fence by generation; purge source staging and
   * projections; cancel every queued or retryable delivery and mark one already disclosing `in-flight-at-disable`,
   * purging each record, and purge every retained dead-letter payload and dry-run row; cancel incomplete staged-position
   * activations and purge their positions. It keeps what later work and the cap need: the content-free ingest identity,
   * the Gmail mailbox cursor (D8: an enable-all baseline does not replace it), terminal resolutions, terminal decisions
   * and the delivery-cap charges. Pause is a separate state and is left as it was. B1 creates every decision terminal
   * with its deliveries, so there is no held or judging decision to cancel yet; the judge phases add that here.
   */
  async disableAll(): Promise<EventLifecycleStatus> {
    return this.store.immediate(() => {
      const database = this.store.database;
      const now = this.now();
      const retained = database
        .prepare(
          `SELECT id FROM deliveries
           WHERE state IN ('queued', 'retryable', 'disclosing', 'dead-lettered') AND encrypted_record IS NOT NULL`,
        )
        .all() as Array<{ id: string }>;
      database.exec('DELETE FROM dryrun_log');
      database.exec('DELETE FROM ingest_rules');
      database.exec('DELETE FROM source_scan_state');
      database.exec('DELETE FROM activation_baselines');
      database.exec('DELETE FROM replacement_drains');
      database.exec(
        "UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL WHERE state IN ('queued', 'retryable')",
      );
      database.exec(
        "UPDATE deliveries SET state = 'in-flight-at-disable', encrypted_record = NULL, lease_until = NULL WHERE state = 'disclosing'",
      );
      database.exec("UPDATE deliveries SET encrypted_record = NULL WHERE state = 'dead-lettered'");
      for (const delivery of retained) {
        for (const target of removeRetainedDeliveryTargetReference(database, delivery.id))
          purgeUnreferencedSystemTargets(database, { ...target, now });
      }
      database
        .prepare(
          "UPDATE activation_intents SET status = 'cancelled', updated_at = ? WHERE status IN ('pending', 'pending-completion')",
        )
        .run(now);
      database
        .prepare(
          'UPDATE event_settings SET enabled = 0, switch_generation = switch_generation + 1, changed_at = ? WHERE singleton = 1',
        )
        .run(now);
      return this.status();
    });
  }

  /** Batch 3 supplies the standing disclosure preparation and claim that can make this switch true. */
  async enableAll(): Promise<EventLifecycleStatus & { readonly standingApprovalRequired: true }> {
    return { ...this.status(), standingApprovalRequired: true };
  }

  commitAtGeneration<T>(generation: number, work: () => T): T {
    return this.store.immediate(() => {
      const current = this.status();
      if (!current.enabled || current.switchGeneration !== generation) {
        throw new CommsError('CONFIG', 'the local event switch generation changed before this work could commit', {
          details: { reason: 'STALE_GENERATION', expected: generation, actual: current.switchGeneration },
        });
      }
      return work();
    });
  }
}
