import { Chip } from '@cueplusplus/ui';
import { useAppData } from '../data.tsx';

/**
 * The queue's open count beside its name in the sidebar (design 2026-10-25-action-queue §4.5), said in full to a screen
 * reader. Nothing while the counts are not read, when the events service has no queue, or when nothing is open.
 */
export function QueueBadge() {
  const { queueCounts } = useAppData();
  if (typeof queueCounts === 'string' || queueCounts.state !== 'ready' || queueCounts.value.open === 0) return null;
  const open = queueCounts.value.open;
  return (
    <Chip tone="accent" variant="tinted" data-slot="queue-badge">
      <span aria-hidden="true">{open}</span>
      {/* A space first: the sidebar's row draws none between its name and its badge. */}
      <span className="sr-only">{` ${open} waiting`}</span>
    </Chip>
  );
}
