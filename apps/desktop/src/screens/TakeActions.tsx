/**
 * Who has a message, and the person's three overrides (0.35.0, design 2026-10-26-taking-messages §9, §10; board
 * MessageStory): **Take back** (`takes release`), **Give to…** (`takes give --window`, a recent agent window from
 * `activity sessions`, as the Lanes panel lists them) and **I'll handle it** (`takes keep`). Each runs its `takes`
 * command at once: it moves only the person's own coordination of their sessions, and gives an agent nothing (DA10).
 * Core refuses each inside an MCP server's process and in an agent's shell; the app's own call is neither.
 *
 * Who has it is the person's view: the holder's folder and client, which no agent sees of another session (T7). A
 * session's note on a hand-back is its words, and may carry a sender's: it shows only through `UntrustedText`.
 */
import { Button, Chip, Dialog, EmptyState, Panel, Row, Spinner } from '@cueplusplus/ui';
import { Hand, Send, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readSessions, type SessionView } from '../activity.ts';
import { useBridge } from '../bridge-context.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { Ago } from '../components/When.tsx';
import { COPY } from '../copy.ts';
import type { Loadable } from '../data.tsx';
import { isAccountName, isSessionKey } from '../grammar.ts';
import { type Call, errorMessage } from '../ipc.ts';
import { clientWords } from '../lanes.ts';
import type { JoinedMessage } from '../messages/join.ts';
import { isItemId } from '../messages/read.ts';
import { agentIn, REASON_WORDS, type StoryContext, whoHasIt } from '../messages/story.ts';
import { Problem } from './MessageParts.tsx';

export const TAKE_ACTIONS_COPY = {
  who: 'Who has it',
  takeBack: 'Take back',
  takeBackHint: 'Ends whoever has it now. Any session may take it again.',
  openAgain: 'Open it again',
  letThem: 'Let a session take it',
  giveTo: 'Give to…',
  handle: 'I’ll handle it',
  handedBack: 'Handed back',
  appliesAtOnce: 'Each applies at once: it changes only which of your sessions acts on it.',
  cannot:
    'Who has it can’t be changed from here: the app doesn’t know this message’s account by name, or its id is one it can’t pass on.',
  released: 'Taken back. Any session may take it again.',
  kept: 'You’re handling it. Every session is refused it until you let them take it.',
  given: (who: string) =>
    `Given to ${who}. It has 15 minutes to take it; until then every other session is refused it.`,
  pickerTitle: 'Give this message to an agent window',
  pickerBody:
    'Agent windows from the last 24 hours. The one you choose has 15 minutes to take it before it acts on it; until then every other session is refused it.',
  give: 'Give to this window',
  noWindows: 'No agent windows in the last 24 hours.',
  noWindowsHint: 'A window shows here once its agent has used Agent Comms.',
  hidden: (count: number) =>
    `${count} more not listed: a command, the event service or a process on its own can’t be told from another.`,
  windowsUnreadable: 'Recent windows could not be read.',
  folderUnknown: 'Folder unknown',
  lastSeen: 'Last seen',
  close: 'Close',
} as const;

/** The account and the message's id, as `takes` takes them; null when the app cannot pass either on. */
function target(message: JoinedMessage): { account: string; message: string } | null {
  const account = message.accountAlias;
  const id = message.takeId;
  if (account === null || id === null || !isAccountName(account) || !isItemId(id)) return null;
  return { account, message: id };
}

/**
 * The story's Who has it (board MessageStory): who has the message and what that means, each hand-back with its
 * reason and the session's note, and the person's three overrides.
 */
export function WhoHasIt({
  message,
  context,
  onChanged,
}: {
  message: JoinedMessage;
  context: StoryContext;
  onChanged: () => Promise<void>;
}) {
  const who = whoHasIt(message, context);
  const backs = message.touches.filter((touch) => touch.kind === 'handed-back');
  return (
    <SectionPanel title={TAKE_ACTIONS_COPY.who}>
      <div className="flex flex-col gap-(--cue-space-1)" data-slot="who-has-it" data-state={who.state}>
        <span className="font-semibold text-fg">{who.title}</span>
        <span className="text-fg-muted">{who.line}</span>
      </div>
      {backs.length === 0 ? null : (
        <ul aria-label={TAKE_ACTIONS_COPY.handedBack} className="flex flex-col gap-(--cue-space-2)">
          {backs.map((touch) => (
            <li
              key={`${touch.at}-${touch.windowKey ?? ''}`}
              className="flex flex-wrap items-start gap-(--cue-space-2) rounded-surface bg-surface-2 px-(--cue-space-3) py-(--cue-space-2)"
              data-slot="hand-back"
            >
              <Chip tone="warn" variant="tag">
                {TAKE_ACTIONS_COPY.handedBack}
              </Chip>
              <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
                <span className="text-fg">
                  {`${agentIn(touch.take?.window ?? null, context.home)} handed it back at ${context.time(touch.at)}: ${
                    touch.take?.reason ? REASON_WORDS[touch.take.reason] : 'no reason given'
                  }`}
                </span>
                {touch.take?.note ? (
                  <span className="text-fg-muted" data-slot="hand-back-note">
                    <UntrustedText text={touch.take.note} />
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <TakeButtons message={message} context={context} onChanged={onChanged} />
    </SectionPanel>
  );
}

/**
 * Take back, Give to… and I'll handle it, for one message: those that change who has it now. Each runs its `takes`
 * command at once, says what it did, and reads again.
 */
export function TakeButtons({
  message,
  context,
  onChanged,
}: {
  message: JoinedMessage;
  context: StoryContext;
  onChanged: () => Promise<void>;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const named = target(message);
  if (named === null) return <p className="text-(length:--cue-text-label) text-fg-muted">{TAKE_ACTIONS_COPY.cannot}</p>;
  const state = whoHasIt(message, context).state;
  const act = async (key: string, call: Call, done: string) => {
    setBusy(key);
    setSaid(null);
    setProblem(null);
    try {
      const result = await bridge.cli(call);
      if (result.status === 'ok') {
        setSaid(done);
        await onChanged();
      } else {
        setProblem(
          result.status === 'failed'
            ? { message: result.message, hint: result.hint }
            : { message: 'That was not a change.', hint: null },
        );
      }
    } catch (error) {
      setProblem({ message: errorMessage(error), hint: null });
    } finally {
      setBusy(null);
    }
  };
  const release = () => void act('release', { kind: 'takesRelease', ...named }, TAKE_ACTIONS_COPY.released);
  const keep = () => void act('keep', { kind: 'takesKeep', ...named }, TAKE_ACTIONS_COPY.kept);
  const releaseLabel =
    state === 'done'
      ? TAKE_ACTIONS_COPY.openAgain
      : state === 'person'
        ? TAKE_ACTIONS_COPY.letThem
        : TAKE_ACTIONS_COPY.takeBack;
  return (
    <div className="flex flex-col gap-(--cue-space-2)">
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        {state === 'nobody' ? null : (
          <Button
            size="sm"
            variant="secondary"
            icon={Undo2}
            title={TAKE_ACTIONS_COPY.takeBackHint}
            loading={busy === 'release'}
            disabled={busy !== null}
            onClick={release}
          >
            {releaseLabel}
          </Button>
        )}
        <GiveTo
          disabled={busy !== null}
          onGive={(window, who) =>
            void act('give', { kind: 'takesGive', ...named, window }, TAKE_ACTIONS_COPY.given(who))
          }
        />
        {state === 'person' ? null : (
          <Button
            size="sm"
            variant="secondary"
            icon={Hand}
            loading={busy === 'keep'}
            disabled={busy !== null}
            onClick={keep}
          >
            {TAKE_ACTIONS_COPY.handle}
          </Button>
        )}
      </div>
      <p className="text-(length:--cue-text-label) text-fg-muted">{TAKE_ACTIONS_COPY.appliesAtOnce}</p>
      {said === null ? null : (
        <p role="status" className="text-fg">
          {said}
        </p>
      )}
      {problem === null ? null : (
        <div className="flex flex-col gap-(--cue-space-1)">
          <Problem message={problem.message} />
          {problem.hint === null ? null : (
            <p className="text-fg-muted">
              <UntrustedText text={problem.hint} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Reads core's `activity sessions --since 24h` once, when the picker opens. */
function useRecentWindows(): Loadable<SessionView[]> {
  const bridge = useBridge();
  const [read, setRead] = useState<Loadable<SessionView[]>>({ state: 'loading' });
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    let next: Loadable<SessionView[]>;
    try {
      const result = await bridge.cli({ kind: 'activitySessions', since: '24h' });
      if (result.status === 'ok') {
        const value = readSessions(result.data);
        next =
          value === null
            ? { state: 'error', message: TAKE_ACTIONS_COPY.windowsUnreadable }
            : { state: 'ready', value: value.sessions };
      } else {
        next = {
          state: 'error',
          message: result.status === 'failed' ? result.message : TAKE_ACTIONS_COPY.windowsUnreadable,
        };
      }
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setRead(next);
  }, [bridge]);
  useEffect(() => {
    void load();
  }, [load]);
  return read;
}

/** Give to…: a picker of the agent windows of the last 24 hours, grouped ones only, as the Lanes panel lists them. */
function GiveTo({ disabled, onGive }: { disabled: boolean; onGive: (window: string, who: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={
          <Button size="sm" variant="secondary" icon={Send} disabled={disabled}>
            {TAKE_ACTIONS_COPY.giveTo}
          </Button>
        }
      />
      <Dialog.Content width="lg" showCloseButton={false}>
        <Dialog.Title>{TAKE_ACTIONS_COPY.pickerTitle}</Dialog.Title>
        <Dialog.Description>{TAKE_ACTIONS_COPY.pickerBody}</Dialog.Description>
        {open ? (
          <Windows
            onGive={(window, who) => {
              setOpen(false);
              onGive(window, who);
            }}
          />
        ) : null}
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost">{TAKE_ACTIONS_COPY.close}</Button>} />
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Windows({ onGive }: { onGive: (window: string, who: string) => void }) {
  const sessions = useRecentWindows();
  if (sessions.state === 'loading') return <Spinner label={COPY.loading} />;
  if (sessions.state === 'error') return <Problem message={sessions.message} />;
  const windows = sessions.value.filter((session) => session.grouped && isSessionKey(session.key));
  const hidden = sessions.value.length - windows.length;
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      {windows.length === 0 ? (
        <EmptyState title={TAKE_ACTIONS_COPY.noWindows} hint={TAKE_ACTIONS_COPY.noWindowsHint} />
      ) : (
        <Panel data-slot="give-windows">
          {windows.map((session) => {
            const client = clientWords(session.client);
            const who = session.folder === null ? 'an agent window' : `the agent in ${session.folder}`;
            return (
              <Row key={session.key} data-window={session.key} className="items-center gap-(--cue-space-4)">
                <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
                  {session.folder === null ? (
                    <span className="text-fg-muted">{TAKE_ACTIONS_COPY.folderUnknown}</span>
                  ) : (
                    <span className="truncate font-mono text-fg" title={session.folder}>
                      <UntrustedText text={session.folder} />
                    </span>
                  )}
                  <span className="flex flex-wrap gap-x-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
                    {client === null ? null : (
                      <>
                        <UntrustedText text={client} />
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span>
                      {TAKE_ACTIONS_COPY.lastSeen} <Ago at={session.lastSeen} />
                    </span>
                  </span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => onGive(session.key, who)}>
                  {TAKE_ACTIONS_COPY.give}
                </Button>
              </Row>
            );
          })}
        </Panel>
      )}
      {hidden <= 0 ? null : (
        <p className="text-(length:--cue-text-ui) text-fg-muted" data-slot="give-hidden">
          {TAKE_ACTIONS_COPY.hidden(hidden)}
        </p>
      )}
    </div>
  );
}
