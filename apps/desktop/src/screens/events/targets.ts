/**
 * Where a delivery went and when it was made, from its rule version's document (owner feedback 0.32.0, §3.5): the
 * list rows name a target by its id and version, and the rule's document says what that target is — a lane, a host.
 */
import { type DeliveryRow, madeAt } from '../../events-deliveries.ts';
import { deliveryRetentionOf, type TargetView, targetsOf, targetWords } from '../../events-rules.ts';
import { type EventsLists, readVersions } from './lists.ts';

/** A delivery's rule version's document, once its rule's versions are read. */
export function documentOf(lists: EventsLists, row: Pick<DeliveryRow, 'ruleId' | 'ruleVersion'>) {
  return readVersions(lists, row.ruleId)?.find((each) => each.version === row.ruleVersion)?.document ?? null;
}

/** The target a delivery went to, from its rule version's document: by its id and version. */
export function targetOf(lists: EventsLists, row: DeliveryRow): TargetView | null {
  return (
    targetsOf(documentOf(lists, row)).find(
      (target) => target.id === row.targetId && (row.targetVersion === null || target.version === row.targetVersion),
    ) ?? null
  );
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  'dry-run': 'Dry-run log',
  queue: 'Queue',
  webhook: 'Webhook',
  sse: 'Live stream',
  linear: 'Linear issue',
  session: 'Agent session',
};

/** Where a delivery went, in words: "Queue, lane billing", "Webhook, hooks.ci.example", "Dry-run log". */
export function whereItWent(lists: EventsLists, row: DeliveryRow, known?: Partial<TargetView>): string {
  // The issue a Linear delivery added names it best: "Linear, CUE-1".
  if (row.linear !== null) return `Linear, ${row.linear.identifier}`;
  const target = targetOf(lists, row);
  const given = Object.fromEntries(
    Object.entries(known ?? {}).filter(([, value]) => value !== null && value !== undefined),
  );
  if (target !== null)
    return targetWords({ ...target, ...given })
      .map((part) => part.text)
      .join('');
  const kind = known?.kind ?? row.targetKind;
  if (kind === null || kind === undefined) return row.targetId;
  if (kind === 'queue' && known?.lane) return `Queue, lane ${known.lane}`;
  if (kind === 'webhook' && known?.host) return `Webhook, ${known.host}`;
  return KIND_WORDS[kind] ?? row.targetId;
}

/** When a delivery was made, as `madeAt` works it out from its rule version's delivery retention. */
export function madeAtOf(lists: EventsLists, row: DeliveryRow): number | null {
  return madeAt(row, deliveryRetentionOf(documentOf(lists, row)));
}
