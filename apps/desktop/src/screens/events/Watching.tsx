/**
 * Events → Service, in plain words (0.34.0 design B4, the approved board `EventsService.dc.html`): one line that says
 * whether the event service watches the person's accounts, what that means, and the action beside it.
 *
 * - **Switched off** — running, but not watching: **Switch on…** prepares the standing approval that starts collection
 *   (`enable-all`), reads its preview (`approval view`, without its challenge), and shows which rules would start. On
 *   macOS the person approves it here, and only that press runs `collection approve <approval> --digest <digest>`, for
 *   the approval Rust recorded for this `enable-all` and nothing else. Where the app cannot attest the person (Windows
 *   and Linux), or when the event service refuses it for that reason, the person approves it at a terminal instead:
 *   the events service's `approve <approval-id>`, which shows the preview there and asks for its challenge. Cancel, or
 *   leaving before the terminal opened, revokes the approval.
 * - **On** — Pause, which applies at once, and **Switch off** (`disable-all`), a tightening applied at once once the
 *   person confirms, whose own sentence (`said`) is the line that follows.
 * - **Paused** — Resume, which applies at once, and Switch off.
 *
 * Switching on in the app and Switch off need an event service that has them (`collectionSwitch`); one with the rule
 * editor but older still prepares Switch on…, which is then approved in Terminal, and offers no Switch off.
 */
import { AlertDialog, Button, DescriptionList, Panel } from '@cueplusplus/ui';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import { aliasOf } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import { AT_TERMINAL_COPY, refusedAsUnattested } from '../../components/DoInTerminal.tsx';
import { ScreenState } from '../../components/ScreenState.tsx';
import { TerminalResult } from '../../components/TerminalResult.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY, needsLine } from '../../copy.ts';
import { type Loadable, useAppData } from '../../data.tsx';
import { accountIdsOf, type TargetView, targetsOf } from '../../events-rules.ts';
import { GATES, supports } from '../../gates.ts';
import { useChange } from '../../hooks/use-change.ts';
import { type Call, type CliResult, errorMessage, type TerminalOutcome } from '../../ipc.ts';
import { isMac } from '../../platform.ts';
import { readActivation } from '../../rule-editor/submit.ts';
import { type EventsLists, readVersions } from './lists.ts';

/** The section's words, as the board has them. */
export const WATCH_COPY = {
  title: 'Watching your accounts',
  stopped: 'Not running',
  stoppedBody: "The event service isn't running on this Mac, so nothing is watched and no rule does anything.",
  off: 'Switched off',
  offBody: "The event service is running, but it isn't watching your accounts, so no rule does anything.",
  on: 'On',
  paused: 'Paused',
  pausedBody: 'Not watching; nothing new is collected.',
  switchOn: 'Switch on…',
  switchOff: 'Switch off',
  pause: 'Pause',
  pauseNote: 'Stops watching until you resume; nothing is lost.',
  resume: 'Resume',
  resumeNote: 'Your rules, the Queue and anything waiting were kept.',
  pausedSaid: 'Paused at once.',
  resumedSaid: 'Resumed at once.',
  askTitle: 'Switch on watching? Approve it',
  rulesStart: 'The rules that would start:',
  noRules: 'No rule is on yet, so switching on watches nothing until you switch one on.',
  approve: 'Approve',
  cancel: 'Cancel',
  cancelled: 'Cancelled: nothing was changed. Watching stays off.',
  notSwitchedOn: 'Not switched on',
  seeAgain: 'Press Switch on… to see its preview again.',
  unreadable: 'What switching on covers could not be read.',
  notApplied: 'That was not applied.',
  notRevoked: 'The approval was not revoked',
  offTitle: 'Switch off watching?',
  offConfirm:
    "Your rules are kept, but none of them does anything until you switch watching on again and approve it. Deliveries not yet sent, the Queue's items, the dry-run log and approvals not yet given are cleared, and each lane's window is unbound.",
  offSaid: 'Switched off.',
  updateToSwitch: 'Update agent-communications to switch watching on here.',
  unreadableStatus: 'The status could not be read.',
} as const;

/** What the words on this tab mean, as the board's card says them. */
export const WORDS_COPY = {
  title: 'What the words here mean',
  words: [
    ['Running', 'The program is open on this Mac. On its own, it does nothing with your mail or Slack.'],
    ['Watching', 'It reads new messages in the accounts your rules name, so the rules can act on them.'],
    ['Paused', 'Watching stops for a while. Your rules, the Queue and anything waiting are kept.'],
    ['Switched off', 'No rule acts until you switch watching on again, and approve it.'],
  ],
} as const;

/** Names in a sentence: "a", "a and b", "a, b and c". */
export function inWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** `Watching <accounts>. <n> rules active.` — "your accounts" where none is known. */
export function watchingLine(accounts: readonly string[], rules: number | null): string {
  const watching = accounts.length === 0 ? 'Watching your accounts.' : `Watching ${inWords(accounts)}.`;
  if (rules === null) return watching;
  return `${watching} ${rules} ${rules === 1 ? 'rule' : 'rules'} active.`;
}

/** `Switching on lets your rules watch <accounts> for new messages.` */
export function switchOnLine(accounts: readonly string[]): string {
  return `Switching on lets your rules watch ${accounts.length === 0 ? 'your accounts' : inWords(accounts)} for new messages.`;
}

/** `Approved. Your rules are watching <accounts>.` */
export function approvedLine(accounts: readonly string[]): string {
  return `Approved. Your rules are watching ${accounts.length === 0 ? 'your accounts' : inWords(accounts)}.`;
}

/** Where a target sends each match, in words to follow a rule's name. */
const GOES: Readonly<Record<TargetView['kind'], string>> = {
  'dry-run': 'writes each match to the dry-run log, for you to read',
  queue: 'adds each match to the Queue, for an agent to work through',
  session: 'hands each match to an agent session',
  webhook: 'sends each match to a webhook',
  sse: 'streams each match to a listener on this Mac',
  linear: 'adds a Linear issue for each match',
  other: 'passes each match on',
};

function goes(target: TargetView): string {
  return target.kind === 'webhook' && target.host !== null ? `${GOES.webhook} at ${target.host}` : GOES[target.kind];
}

type Watch = 'stopped' | 'off' | 'on' | 'paused';
type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `EventsDaemonStatus`, as one word: whether the service runs, and whether it watches. Null when it is not a status. */
export function watchOf(value: unknown): Watch | null {
  if (!isRecord(value) || typeof value.owner !== 'string') return null;
  if (value.owner !== 'running') return 'stopped';
  if (value.enabled !== true) return 'off';
  return value.paused === true ? 'paused' : 'on';
}

/** One rule version's document, once its rule's versions are read. */
function documentAt(lists: EventsLists, ruleId: string, version: number | null) {
  const versions = readVersions(lists, ruleId);
  if (versions === null) return null;
  const found =
    version === null
      ? versions.find((each) => each.state === 'active')
      : versions.find((each) => each.version === version);
  return found?.document ?? null;
}

/** The accounts some rule versions watch, by alias, each once, in order. */
function accountsOf(lists: EventsLists, rules: readonly { ruleId: string; version: number | null }[]): string[] {
  const ids = rules.flatMap((rule) => accountIdsOf(documentAt(lists, rule.ruleId, rule.version)));
  return [...new Set(ids.map((id) => aliasOf(lists.names, id)))];
}

/** The rules that are on, as the Rules tab reads them; null while the list is not read. */
function rulesOn(lists: EventsLists): { ruleId: string; version: number | null }[] | null {
  if (lists.rules.state !== 'ready') return null;
  return lists.rules.value.filter((rule) => rule.status === 'on').map((rule) => ({ ruleId: rule.id, version: null }));
}

/** The rule versions switching on would start, from its own preview. Null when it is not a ready view of switching on. */
export function readSwitchOnPreview(data: unknown): { ruleId: string; version: number }[] | null {
  if (!isRecord(data) || data.kind !== 'READY' || !isRecord(data.preview)) return null;
  const { preview } = data;
  if (preview.kind !== 'enable-all' || !Array.isArray(preview.ruleVersions)) return null;
  return preview.ruleVersions.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.ruleId === 'string' &&
    entry.ruleId !== '' &&
    typeof entry.ruleVersion === 'number' &&
    Number.isSafeInteger(entry.ruleVersion)
      ? [{ ruleId: entry.ruleId, version: entry.ruleVersion }]
      : [],
  );
}

/** Whether the event service refused the app's approval because it cannot attest the person here (its words say so). */
function refusedForTerminal(result: Extract<CliResult, { status: 'failed' }>): boolean {
  return refusedAsUnattested(result.code) || /\battests\b/u.test(result.message);
}

/** A failure's words, and its hint after them. */
function sayFailed(prefix: string, result: CliResult): string {
  if (result.status !== 'failed') return prefix;
  return [`${prefix}: ${result.message}`, result.hint].filter(Boolean).join(' ');
}

/** Switching on, prepared and waiting for the person. */
interface PreparedSwitch {
  approvalId: string;
  digest: string;
  rules: { ruleId: string; version: number }[];
}

/** A line the section says after an action: what it came to, as a success or as news. */
type Said = { text: string; tone: 'ok' | 'neutral' };

/**
 * Switching on's preview and its approval: in the app, where the app attests the person, else at a terminal. Left
 * behind — another tab, another screen — it revokes its approval a moment after it goes, as `ChangePreview` does, unless
 * Approve, Cancel or the terminal already has it.
 */
function SwitchOnReview({
  review,
  lists,
  inApp,
  onApproved,
  onClosed,
}: {
  review: PreparedSwitch;
  lists: EventsLists;
  inApp: boolean;
  onApproved: () => void;
  /** Closed: cancelled, refused, or approved at the terminal; what to say then. */
  onClosed: (said: Said | null, problem: string | null) => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [atTerminal, setAtTerminal] = useState(!inApp);
  const [opened, setOpened] = useState<TerminalOutcome | null>(null);
  const handled = useRef(false);
  const mounted = useRef(false);
  const { approvalId, digest } = review;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (mounted.current || handled.current) return;
        handled.current = true;
        bridge.revokePreview(approvalId).catch(() => undefined);
      }, 0);
    };
  }, [bridge, approvalId]);

  const approve = async () => {
    setBusy(true);
    setProblem(null);
    handled.current = true;
    try {
      const result = await bridge.cli({ kind: 'eventsCollectionApprove', approvalId, digest });
      if (result.status === 'ok') {
        onApproved();
        return;
      }
      if (result.status === 'failed' && refusedForTerminal(result)) {
        // Nothing attests the app here: the approval is the terminal's, and still this preview's to cancel.
        handled.current = false;
        setAtTerminal(true);
        setProblem(sayFailed(WATCH_COPY.notSwitchedOn, result));
        return;
      }
      // Refused for another reason — what switching on covers changed, or the approval went: prepare it again.
      bridge.revokePreview(approvalId).catch(() => undefined);
      onClosed(null, `${sayFailed(WATCH_COPY.notSwitchedOn, result)} ${WATCH_COPY.seeAgain}`);
    } catch (error) {
      handled.current = false;
      setProblem(`${WATCH_COPY.notSwitchedOn}: ${errorMessage(error)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const approveInTerminal = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await bridge.openInTerminal({ kind: 'ruleApprove', approvalId });
      // The approval is the terminal's now: leaving no longer revokes it.
      handled.current = true;
      setOpened(outcome);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setProblem(null);
    handled.current = true;
    try {
      const result = await bridge.revokePreview(approvalId);
      if (result.status === 'ok') {
        onClosed({ text: WATCH_COPY.cancelled, tone: 'neutral' }, null);
        return;
      }
      handled.current = false;
      setProblem(sayFailed(WATCH_COPY.notRevoked, result));
    } catch (error) {
      handled.current = false;
      setProblem(`${WATCH_COPY.notRevoked}: ${errorMessage(error)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const accounts = accountsOf(lists, review.rules);
  return (
    <section
      aria-label={WATCH_COPY.askTitle}
      data-slot="switch-on"
      className="flex flex-col gap-(--cue-space-3) rounded-control bg-surface-2 p-(--cue-space-4)"
    >
      <div className="flex flex-col gap-(--cue-space-1)">
        <h3 className="font-semibold text-fg">{WATCH_COPY.askTitle}</h3>
        <p className="text-fg-muted">
          <UntrustedText
            text={review.rules.length === 0 ? WATCH_COPY.noRules : `${switchOnLine(accounts)} ${WATCH_COPY.rulesStart}`}
          />
        </p>
      </div>
      {review.rules.length === 0 ? null : (
        <ul className="flex flex-col gap-(--cue-space-1) rounded-control bg-surface-1 px-(--cue-space-3) py-(--cue-space-2)">
          {review.rules.map((rule) => {
            const document = documentAt(lists, rule.ruleId, rule.version);
            const where = targetsOf(document).map(goes);
            const parts = [
              accountIdsOf(document)
                .map((id) => aliasOf(lists.names, id))
                .join(', '),
              where.join(' and '),
            ].filter((part) => part !== '');
            return (
              <li key={`${rule.ruleId}@${rule.version}`} data-rule-start={rule.ruleId}>
                <span className="font-medium text-fg">
                  <UntrustedText text={rule.ruleId} />
                </span>
                {parts.length === 0 ? null : (
                  <span className="text-fg-muted">
                    {' '}
                    <UntrustedText text={`· ${parts.join(' · ')}`} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {atTerminal ? (
        <div data-slot="at-terminal" className="flex flex-col gap-(--cue-space-2)">
          <p className="text-fg-muted">{AT_TERMINAL_COPY.why}</p>
          {opened === null ? (
            <div className="flex flex-wrap items-center gap-(--cue-space-2)">
              <Button size="sm" variant="primary" loading={busy} onClick={() => void approveInTerminal()}>
                {AT_TERMINAL_COPY.doIt}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                {WATCH_COPY.cancel}
              </Button>
            </div>
          ) : (
            <>
              <TerminalResult outcome={opened} />
              <p className="text-fg-muted">{AT_TERMINAL_COPY.after}</p>
              <div>
                <Button size="sm" onClick={() => onClosed(null, null)}>
                  {AT_TERMINAL_COPY.done}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <Button size="sm" variant="primary" loading={busy} onClick={() => void approve()}>
            {WATCH_COPY.approve}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
            {WATCH_COPY.cancel}
          </Button>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={problem} />
        </p>
      )}
    </section>
  );
}

/** Switch off, which asks first: only its own Switch off runs `confirm`; Cancel, Escape or closing it runs nothing. */
function SwitchOff({ disabled, confirm }: { disabled: boolean; confirm: () => void }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        render={
          <Button size="sm" variant="ghost" disabled={disabled}>
            {WATCH_COPY.switchOff}
          </Button>
        }
      />
      <AlertDialog.Content>
        <AlertDialog.Title>{WATCH_COPY.offTitle}</AlertDialog.Title>
        <AlertDialog.Description>{WATCH_COPY.offConfirm}</AlertDialog.Description>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
          <AlertDialog.Action tone="danger" onClick={confirm}>
            {WATCH_COPY.switchOff}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/** A dot in the state's tone beside the section's label: the words say the state; the dot only colours it. */
function WatchDot({ watch }: { watch: Watch | null }) {
  const tone = watch === 'on' ? 'bg-ok' : watch === 'paused' ? 'bg-warn' : 'bg-fg-subtle';
  return <span aria-hidden="true" className={`size-(--cue-space-2) shrink-0 rounded-full ${tone}`} />;
}

/** A state's big word and what it means. */
function Stated({ word, children }: { word: string; children: ReactNode }) {
  return (
    <>
      <p data-slot="watch-state" className="font-semibold text-(length:--cue-text-title) text-fg">
        {word}
      </p>
      <p className="text-fg-muted">{children}</p>
    </>
  );
}

/**
 * The section: the status, polled with the shared data; what it means; and the one action that changes it. `version` is
 * the events service's own, as the Judges section reads it.
 */
export function Watching({ lists, version }: { lists: EventsLists; version: Loadable<string> }) {
  const { events, refresh } = useAppData();
  const bridge = useBridge();
  const { run } = useChange();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<PreparedSwitch | null>(null);

  const installed = version.state === 'ready' ? version.value : null;
  const canPrepare = installed !== null && supports(installed, 'ruleEditor');
  const switchHere = installed !== null && supports(installed, 'collectionSwitch');

  const done = async (next: Said | null, failed: string | null) => {
    setSaid(next);
    setProblem(failed);
    await refresh('events');
  };

  // Pause, Resume and Switch off apply at once: each says what it came to, and the status is read again.
  const act = async (call: Call, success: (data: unknown) => string) => {
    setBusy(true);
    setSaid(null);
    setProblem(null);
    const result = await run(call);
    if (result.state === 'applied') await done({ text: success(result.data), tone: 'ok' }, null);
    else if (result.state === 'failed') await done(null, [result.message, result.hint].filter(Boolean).join(' '));
    else await done(null, WATCH_COPY.notApplied);
    setBusy(false);
  };

  // Not prepared: why, and the status read again, since another session may have switched it on meanwhile.
  const fail = async (message: string) => {
    setProblem(message);
    setBusy(false);
    await refresh('events');
  };

  // Switch on…: prepare, then read what it covers from its own preview. Nothing is approved until the person presses.
  const prepare = async () => {
    setBusy(true);
    setSaid(null);
    setProblem(null);
    try {
      const prepared = await bridge.cli({ kind: 'eventsEnableAll' });
      if (prepared.status !== 'ok') return fail(sayFailed(WATCH_COPY.notSwitchedOn, prepared));
      const activation = readActivation(prepared.data);
      if (activation === null) return fail(WATCH_COPY.unreadable);
      const viewed = await bridge.cli({ kind: 'eventsApprovalView', ...activation });
      const rules = viewed.status === 'ok' ? readSwitchOnPreview(viewed.data) : null;
      if (rules === null) {
        await bridge.revokePreview(activation.approvalId).catch(() => undefined);
        return fail(viewed.status === 'failed' ? sayFailed(WATCH_COPY.unreadable, viewed) : WATCH_COPY.unreadable);
      }
      setReview({ ...activation, rules });
      setBusy(false);
    } catch (error) {
      await fail(`${WATCH_COPY.notSwitchedOn}: ${errorMessage(error)}`);
    }
  };

  const watch = events !== 'absent' && events.state === 'ready' ? watchOf(events.value) : null;
  // Switched on or stopped meanwhile — here, at a terminal, or by an agent: a preview left open no longer applies.
  useEffect(() => {
    if (watch !== null && watch !== 'off') setReview(null);
  }, [watch]);

  if (events === 'absent') return null;
  const on = rulesOn(lists);
  return (
    <section aria-label={WATCH_COPY.title}>
      <Panel>
        <div className="flex flex-col gap-(--cue-space-3) p-(--cue-space-5)">
          <div className="flex items-center gap-(--cue-space-2)">
            <WatchDot watch={watch} />
            <span className="font-medium text-(length:--cue-text-label) text-fg-muted">{WATCH_COPY.title}</span>
          </div>
          {said === null ? null : (
            <p
              role="status"
              className={`rounded-control px-(--cue-space-3) py-(--cue-space-2) text-fg ${said.tone === 'ok' ? 'bg-(color:--cue-ok-soft)' : 'bg-surface-2'}`}
            >
              <UntrustedText text={said.text} />
            </p>
          )}
          <ScreenState value={events}>
            {(value) => {
              const state = watchOf(value);
              if (state === null) {
                return (
                  <p role="alert" className="text-danger">
                    {WATCH_COPY.unreadableStatus}
                  </p>
                );
              }
              if (state === 'stopped') return <Stated word={WATCH_COPY.stopped}>{WATCH_COPY.stoppedBody}</Stated>;
              if (state === 'off') {
                return (
                  <>
                    <Stated word={WATCH_COPY.off}>{WATCH_COPY.offBody}</Stated>
                    {review !== null ? (
                      <SwitchOnReview
                        review={review}
                        lists={lists}
                        inApp={switchHere && isMac()}
                        onApproved={() => {
                          setReview(null);
                          void done({ text: approvedLine(accountsOf(lists, review.rules)), tone: 'ok' }, null);
                        }}
                        onClosed={(next, failed) => {
                          setReview(null);
                          void done(next, failed);
                        }}
                      />
                    ) : canPrepare ? (
                      <div>
                        <Button variant="primary" loading={busy} onClick={() => void prepare()}>
                          {WATCH_COPY.switchOn}
                        </Button>
                      </div>
                    ) : installed !== null ? (
                      <div className="flex flex-col gap-(--cue-space-1)">
                        <p className="text-fg">{WATCH_COPY.updateToSwitch}</p>
                        <p className="text-fg-muted">{needsLine(GATES.ruleEditor, installed)}</p>
                      </div>
                    ) : null}
                  </>
                );
              }
              const offButton = switchHere ? (
                <SwitchOff
                  disabled={busy}
                  confirm={() =>
                    void act({ kind: 'eventsDisableAll' }, (data) =>
                      isRecord(data) && typeof data.said === 'string' && data.said !== ''
                        ? data.said
                        : WATCH_COPY.offSaid,
                    )
                  }
                />
              ) : null;
              if (state === 'on') {
                return (
                  <>
                    <Stated word={WATCH_COPY.on}>
                      <UntrustedText
                        text={watchingLine(on === null ? [] : accountsOf(lists, on), on?.length ?? null)}
                      />
                    </Stated>
                    <div className="flex flex-wrap items-center gap-(--cue-space-2)">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void act({ kind: 'eventsPause' }, () => WATCH_COPY.pausedSaid)}
                      >
                        {WATCH_COPY.pause}
                      </Button>
                      {offButton}
                      <span className="text-(length:--cue-text-label) text-fg-muted">{WATCH_COPY.pauseNote}</span>
                    </div>
                  </>
                );
              }
              return (
                <>
                  <Stated word={WATCH_COPY.paused}>{WATCH_COPY.pausedBody}</Stated>
                  <div className="flex flex-wrap items-center gap-(--cue-space-2)">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void act({ kind: 'eventsResume' }, () => WATCH_COPY.resumedSaid)}
                    >
                      {WATCH_COPY.resume}
                    </Button>
                    {offButton}
                    <span className="text-(length:--cue-text-label) text-fg-muted">{WATCH_COPY.resumeNote}</span>
                  </div>
                </>
              );
            }}
          </ScreenState>
          {problem === null ? null : (
            <p role="alert" className="text-danger">
              <UntrustedText text={problem} />
            </p>
          )}
        </div>
      </Panel>
    </section>
  );
}

/** The board's short card: what Running, Watching, Paused and Switched off each mean. */
export function WatchWords() {
  return (
    <section aria-label={WORDS_COPY.title}>
      <Panel>
        <div className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
          <h2 className="font-semibold text-fg">{WORDS_COPY.title}</h2>
          <DescriptionList.Root>
            {WORDS_COPY.words.map(([word, meaning]) => (
              <Fragment key={word}>
                <DescriptionList.Term className="font-medium text-fg">{word}</DescriptionList.Term>
                <DescriptionList.Detail className="text-fg-muted">{meaning}</DescriptionList.Detail>
              </Fragment>
            ))}
          </DescriptionList.Root>
        </div>
      </Panel>
    </section>
  );
}
