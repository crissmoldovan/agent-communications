/**
 * The Queue's Not taken (0.35.0, design 2026-10-26-taking-messages §8, §9): each message a rule delivered to a lane, a
 * session or the Queue that no session took within its account's window, in the accounts where a session must take a
 * message first — joined in the app from the event service's `messages list` and core's `takes list`, so no queue item
 * is made for one. It counts toward the Queue's badge. Each card says where it came in, who it is from (a sender's
 * words, From outside), how long it has waited and why, with Give to…, I'll handle it and its story.
 */
import { Button, Chip, EmptyState, Panel, Spinner } from '@cueplusplus/ui';
import { History } from 'lucide-react';
import { useMemo } from 'react';
import { COPY } from '../copy.ts';
import { useAppData } from '../data.tsx';
import type { JoinedMessage } from '../messages/join.ts';
import { type StoryContext, whereWords } from '../messages/story.ts';
import { useNavigate } from '../navigation.tsx';
import { Problem, Sender } from './MessageParts.tsx';
import { timeWords } from './Messages.tsx';
import { TakeButtons } from './TakeActions.tsx';

export const NOT_TAKEN_COPY = {
  tab: 'Not taken',
  about:
    'Messages a workflow sent to a lane, a session or the Queue that no session took in time, in the accounts where a session must take a message before it acts on it (Settings → Taking messages). Give one to a window, or handle it yourself.',
  nothing: 'Every message a session had to take was taken.',
  nothingHint:
    'A message shows here when a session must take messages in its account and nobody takes it within the time Settings → Taking messages gives.',
  story: 'See its story',
  needsYou: 'A session handed it back saying it needs you.',
  waited: (minutes: number, since: string) =>
    `No session took it within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. It has waited since ${since}.`,
} as const;

/** How many messages Not taken holds, once read; null while it is not. */
export function useNotTakenCount(): number | null {
  const { notTaken } = useAppData();
  return notTaken === 'off' || notTaken.state !== 'ready' ? null : notTaken.value.length;
}

/** Not taken's cards, as the shared reads have them; `onChanged` reads them again. */
export function NotTakenView({ onChanged }: { onChanged: () => Promise<void> }) {
  const { notTaken, installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const context: StoryContext = useMemo(() => ({ time: timeWords, home }), [home]);
  if (notTaken === 'off') return null;
  if (notTaken.state === 'loading') return <Spinner label={COPY.loading} />;
  if (notTaken.state === 'error') return <Problem message={notTaken.message} />;
  if (notTaken.value.length === 0) {
    return (
      <Panel>
        <EmptyState title={NOT_TAKEN_COPY.nothing} hint={NOT_TAKEN_COPY.nothingHint} />
      </Panel>
    );
  }
  return (
    <ul className="flex flex-col gap-(--cue-space-3)">
      {notTaken.value.map((message) => (
        <NotTakenCard key={message.key} message={message} context={context} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function NotTakenCard({
  message,
  context,
  onChanged,
}: {
  message: JoinedMessage;
  context: StoryContext;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const late = message.notTaken;
  const eventId = message.event?.openable ? message.event.eventId : null;
  const why =
    late === null
      ? null
      : late.why === 'needs-the-person'
        ? NOT_TAKEN_COPY.needsYou
        : NOT_TAKEN_COPY.waited(Math.round((late.due - late.since) / 60_000), context.time(late.since));
  return (
    <li data-message={message.key} data-slot="not-taken">
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <span className="flex flex-wrap items-center gap-(--cue-space-2) text-(length:--cue-text-label) text-fg-subtle">
          <span>{whereWords(message)}</span>
          {message.sender === null ? null : (
            <Chip tone="warn" variant="tag" data-slot="from-outside-label">
              {COPY.fromOutside}
            </Chip>
          )}
          <span className="ml-auto">
            <Chip tone="warn" variant="tinted">
              {NOT_TAKEN_COPY.tab}
            </Chip>
          </span>
        </span>
        <Sender sender={message.sender} channel={message.channel} />
        {why === null ? null : <p className="text-fg-muted">{why}</p>}
        <TakeButtons message={message} context={context} onChanged={onChanged} />
        {navigate === null || eventId === null ? null : (
          <div>
            <Button size="sm" variant="ghost" icon={History} onClick={() => navigate({ screen: 'messages', eventId })}>
              {NOT_TAKEN_COPY.story}
            </Button>
          </div>
        )}
      </Panel>
    </li>
  );
}
