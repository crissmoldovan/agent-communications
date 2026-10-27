import { Chip } from '@cueplusplus/ui';
import { useAppData } from '../data.tsx';

/**
 * The queue's open count beside its name in the sidebar (design 2026-10-25-action-queue §4.5), said in full to a screen
 * reader — with, since 0.35.0, the messages nobody took in time, which the Queue's Not taken tab lists (design
 * 2026-10-26-taking-messages §8). Nothing while neither is read, when the events service has no queue, or when nothing
 * waits.
 */
export function QueueBadge() {
  const { queueCounts, notTaken } = useAppData();
  const open = typeof queueCounts === 'string' || queueCounts.state !== 'ready' ? 0 : queueCounts.value.open;
  const late = notTaken === 'off' || notTaken.state !== 'ready' ? 0 : notTaken.value.length;
  const waiting = open + late;
  if (waiting === 0) return null;
  return (
    <Chip tone="accent" variant="tinted" data-slot="queue-badge">
      <span aria-hidden="true">{waiting}</span>
      {/* A space first: the sidebar's row draws none between its name and its badge. */}
      <span className="sr-only">{` ${waiting} waiting`}</span>
    </Chip>
  );
}
