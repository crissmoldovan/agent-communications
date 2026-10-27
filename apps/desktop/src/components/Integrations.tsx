import {
  AlertDialog,
  Button,
  Chip,
  Field,
  FieldLabel,
  Input,
  Panel,
  PasswordInput,
  SectionHeader,
} from '@cueplusplus/ui';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY, needsLine } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { GATES, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { readAgentSessions, readLinear, type SessionsState, SOURCE_WORDS } from '../integrations.ts';
import { type Call, errorMessage, type TerminalCommand } from '../ipc.ts';
import { takeDestination } from '../navigation.tsx';
import { DoInTerminal, refusedAsUnattested, setupsAtTerminal } from './DoInTerminal.tsx';
import { SetupProblem } from './judges/JudgeRow.tsx';
import { ScreenState } from './ScreenState.tsx';
import { UntrustedText } from './UntrustedText.tsx';

/*
 * Settings → Integrations (0.33.0, design 2026-10-26-rules-that-act-0330 §3.4, §3.5, the prototype's Integrations): the
 * other tools a rule can act in. Linear is connected with a personal API key, which goes the way an AI provider's key
 * does — typed into a field React never holds, handed to Rust's `provider_key_set` and on to the events CLI on stdin,
 * the field emptied at once — and the card shows only the workspace and teams it sees. Agent sessions are
 * claude-stream's: the card names whose relay home the event service reads its token from, and how the relay answers;
 * it never shows the token. What the event service does not do yet says so, and offers nothing.
 */

/** Where Settings → Integrations is, for a link to land on it. */
export const INTEGRATIONS_SECTION = 'integrations';

export const INTEGRATIONS_COPY = {
  title: 'Integrations',
  body: 'Other tools a workflow can act in. Each one is connected here, once, and a workflow names it when you approve it.',
  linear: 'Linear',
  linearBody: 'Lets a workflow add an issue. Nothing reads your Linear on its own.',
  connected: 'Connected',
  notConnected: 'Not connected',
  connect: 'Connect Linear…',
  keyLabel: 'Linear personal API key',
  keyPlaceholder: 'Paste your Linear API key',
  keyHint:
    'Make a personal API key in Linear’s settings, under your account’s security. It is kept in this Mac’s keychain, and never shown again.',
  save: 'Connect',
  cancel: 'Cancel',
  workspace: 'Workspace',
  teams: 'Teams it may use',
  usedBy: 'Used by',
  noRule: 'No workflow yet',
  changeTeams: 'Change teams…',
  disconnect: 'Disconnect',
  disconnectTitle: 'Disconnect Linear?',
  disconnectBody: (rules: number | null) =>
    rules === 0
      ? 'Your key is removed from this Mac. No workflow uses it.'
      : rules === null
        ? 'Your key is removed from this Mac, and a workflow that adds Linear issues adds none until you connect it again.'
        : `Your key is removed from this Mac, and ${rules === 1 ? 'the workflow that uses it adds' : `the ${rules} workflows that use it add`} no issue until you connect it again.`,
  sessions: 'Agent sessions',
  sessionsBody:
    'A workflow can hand a message to a Claude Code or Codex session that claude-stream runs on this Mac. Agent Comms reads claude-stream’s token as you, and never shows it.',
  relay: 'claude-stream',
  ready: 'Ready',
  notReady: 'Not ready',
  notFound: 'Not found on this Mac',
  state: 'State',
  foundAt: 'Found at',
  useRelayAt: 'Use claude-stream at',
  wherever: 'Wherever it is: claude-stream’s own home, then the Pilot app’s.',
  findIt: 'Find it for me instead',
  relayFolder: 'Or name its home folder',
  relayFolderHint: 'The folder that holds claude-stream’s control.token',
  useFolder: 'Use this folder',
  version: 'Version',
  allowed: 'Folders a session may work in',
  noFolders: 'None yet',
  waiting: 'Waiting for a busy session',
  later: 'Later: GitHub issues, Notion pages, calendars.',
  laterRelease: 'Comes in a later release',
  unreadable: 'This could not be read.',
} as const;

const EVENTS_VERSION: Call = { kind: 'version', product: 'events-daemon' };
const LINEAR: Call = { kind: 'integrationShow', integration: 'linear' };
const SESSIONS: Call = { kind: 'integrationShow', integration: 'agent-sessions' };

/** The section, once the events service is one with integrations; otherwise what it needs first, or nothing. */
export function Integrations() {
  const { installation } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  const sectionRef = useRef<HTMLElement>(null);
  // A link from the rule editor lands here: the section is scrolled to, and focus moves to it.
  useEffect(() => {
    if (takeDestination('settings', (destination) => destination.section === 'integrations') === null) return;
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
    sectionRef.current?.focus();
  }, []);
  if (!present) return null;
  return (
    <section
      ref={sectionRef}
      id={INTEGRATIONS_SECTION}
      aria-label={INTEGRATIONS_COPY.title}
      tabIndex={-1}
      className="outline-none"
    >
      <SectionHeader label={INTEGRATIONS_COPY.title}>
        <p className="mb-(--cue-space-3) text-fg-muted">{INTEGRATIONS_COPY.body}</p>
        <Gated />
      </SectionHeader>
    </section>
  );
}

function Gated() {
  const { result: version } = useCall<string>(EVENTS_VERSION);
  if (!(version.state === 'ready' && supports(version.value, 'ruleEditor')))
    return (
      <Panel>
        <div className="px-(--cue-pad-row-x) py-(--cue-space-3)">
          <ScreenState value={version}>
            {(installed) => (
              <div className="flex flex-col gap-(--cue-space-1)">
                <p className="text-fg">{COPY.updateToUse}</p>
                <p className="text-fg-muted">{needsLine(GATES.ruleEditor, installed)}</p>
              </div>
            )}
          </ScreenState>
        </div>
      </Panel>
    );
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      <Linear />
      <AgentSessions />
      <Panel className="p-(--cue-space-4) opacity-60">
        <p className="text-(length:--cue-text-label) text-fg-muted">
          {INTEGRATIONS_COPY.later} {INTEGRATIONS_COPY.laterRelease}.
        </p>
      </Panel>
    </div>
  );
}

/** A tool's card: its letter, its name and state, what it does, and its buttons. */
function Card({
  letter,
  title,
  chip,
  body,
  actions,
  children,
}: {
  letter: string;
  title: string;
  chip?: ReactNode;
  body: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel className="flex items-start gap-(--cue-space-3) p-(--cue-space-4)">
        <span
          aria-hidden="true"
          className="flex size-chip shrink-0 items-center justify-center rounded-control bg-sunken font-semibold text-fg-muted"
        >
          {letter}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2)">
          <div className="flex flex-wrap items-center gap-(--cue-space-2)">
            <h3 id={id} className="font-semibold text-fg">
              {title}
            </h3>
            {chip}
          </div>
          <p className="text-fg-muted">{body}</p>
          {children}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 flex-wrap gap-(--cue-space-2)">{actions}</div>}
      </Panel>
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--cue-space-4) gap-y-(--cue-space-1)">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-(length:--cue-text-label) text-fg-muted">{name}</dt>
          <dd className="min-w-0 text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Linear() {
  const bridge = useBridge();
  const { run } = useChange();
  const shown = useCall<unknown>(LINEAR);
  useReloadOnReturn(shown.reload);
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // Where the app cannot attest the person, the key is set or removed in a terminal, which asks for it there.
  const [refused, setRefused] = useState(false);
  const atTerminal = setupsAtTerminal() || refused;
  const [pending, setPending] = useState<TerminalCommand | null>(null);
  const connectAtTerminal: TerminalCommand = { kind: 'providerKeySet', provider: 'linear' };
  const disconnectAtTerminal: TerminalCommand = {
    kind: 'atTerminal',
    call: { kind: 'providerKeyRemove', provider: 'linear' },
  };
  const read = shown.result.state === 'ready' ? readLinear(shown.result.value) : null;
  const empty = () => {
    if (field.current !== null) field.current.value = '';
  };

  const save = async () => {
    const value = field.current?.value.trim() ?? '';
    // Read once, then gone from the window: the field is emptied before the key is even sent.
    empty();
    if (value === '') return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.providerKeySet('linear', value);
      if (result.status === 'failed') {
        setProblem({ message: result.message, hint: result.hint });
        if (refusedAsUnattested(result.code)) {
          setRefused(true);
          setForm(false);
          setPending(connectAtTerminal);
        }
      } else setForm(false);
    } catch (error) {
      setProblem({ message: errorMessage(error), hint: null });
    } finally {
      setBusy(false);
    }
    await shown.reload();
  };

  const disconnect = async () => {
    setProblem(null);
    if (atTerminal) {
      setPending(disconnectAtTerminal);
      return;
    }
    setBusy(true);
    const outcome = await run({ kind: 'providerKeyRemove', provider: 'linear' });
    if (outcome.state === 'failed') {
      setProblem({ message: outcome.message, hint: outcome.hint });
      if (refusedAsUnattested(outcome.code)) {
        setRefused(true);
        setPending(disconnectAtTerminal);
      }
    }
    await shown.reload();
    setBusy(false);
  };

  if (shown.result.state !== 'ready' || read === null)
    return (
      <Card letter="L" title={INTEGRATIONS_COPY.linear} body={INTEGRATIONS_COPY.linearBody}>
        {shown.result.state === 'ready' ? (
          <p role="alert" className="text-danger">
            {INTEGRATIONS_COPY.unreadable}
          </p>
        ) : (
          <ScreenState value={shown.result}>{() => null}</ScreenState>
        )}
      </Card>
    );
  const chip = (
    <Chip tone={read.connected ? 'ok' : 'neutral'} variant="tag">
      {read.connected ? INTEGRATIONS_COPY.connected : INTEGRATIONS_COPY.notConnected}
    </Chip>
  );
  const actions =
    form || pending !== null ? undefined : read.connected ? (
      <>
        <Button size="sm" disabled title={INTEGRATIONS_COPY.laterRelease}>
          {INTEGRATIONS_COPY.changeTeams}
        </Button>
        <AlertDialog.Root>
          <AlertDialog.Trigger
            render={
              <Button size="sm" variant="danger-outline" disabled={busy}>
                {INTEGRATIONS_COPY.disconnect}
              </Button>
            }
          />
          <AlertDialog.Content>
            <AlertDialog.Title>{INTEGRATIONS_COPY.disconnectTitle}</AlertDialog.Title>
            <AlertDialog.Description>
              {INTEGRATIONS_COPY.disconnectBody(read.usedBy?.length ?? null)}
            </AlertDialog.Description>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
              <AlertDialog.Action tone="danger" onClick={() => void disconnect()}>
                {INTEGRATIONS_COPY.disconnect}
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog.Root>
      </>
    ) : (
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={() => (atTerminal ? setPending(connectAtTerminal) : setForm(true))}
      >
        {INTEGRATIONS_COPY.connect}
      </Button>
    );
  return (
    <Card letter="L" title={INTEGRATIONS_COPY.linear} chip={chip} body={INTEGRATIONS_COPY.linearBody} actions={actions}>
      {read.connected ? (
        <Facts
          rows={[
            [INTEGRATIONS_COPY.workspace, <UntrustedText key="w" text={read.workspace ?? '—'} />],
            [
              INTEGRATIONS_COPY.teams,
              <UntrustedText key="t" text={read.teams.map((team) => team.key).join(', ') || '—'} />,
            ],
            ...(read.usedBy === null
              ? []
              : [
                  [
                    INTEGRATIONS_COPY.usedBy,
                    <UntrustedText
                      key="u"
                      text={read.usedBy.length === 0 ? INTEGRATIONS_COPY.noRule : read.usedBy.join(', ')}
                    />,
                  ] as [string, ReactNode],
                ]),
          ]}
        />
      ) : null}
      {form ? (
        <form
          className="flex flex-wrap items-end gap-(--cue-space-2)"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field name="linear-key" className="min-w-64 flex-1">
            <FieldLabel>{INTEGRATIONS_COPY.keyLabel}</FieldLabel>
            <PasswordInput
              ref={field}
              showReveal={false}
              autoComplete="off"
              spellCheck={false}
              placeholder={INTEGRATIONS_COPY.keyPlaceholder}
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>
            {INTEGRATIONS_COPY.save}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              empty();
              setForm(false);
            }}
          >
            {INTEGRATIONS_COPY.cancel}
          </Button>
          <p className="w-full text-(length:--cue-text-label) text-fg-muted">{INTEGRATIONS_COPY.keyHint}</p>
        </form>
      ) : null}
      <SetupProblem problem={problem} />
      {pending === null ? null : (
        <DoInTerminal
          command={pending}
          asksForKey={pending.kind === 'providerKeySet'}
          onCancel={() => setPending(null)}
          onDone={() => {
            setPending(null);
            void shown.reload();
          }}
        />
      )}
    </Card>
  );
}

/** The relay's state in words: ready, or why not, in the event service's closed word. */
function relayWords(state: SessionsState): string {
  if (state.ready) return INTEGRATIONS_COPY.ready;
  if (!state.found) return INTEGRATIONS_COPY.notFound;
  return state.problem === null ? INTEGRATIONS_COPY.notReady : `${INTEGRATIONS_COPY.notReady}: ${state.problem}`;
}

function AgentSessions() {
  const { run } = useChange();
  const shown = useCall<unknown>(SESSIONS);
  useReloadOnReturn(shown.reload);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const [folder, setFolder] = useState('');
  // Where the app cannot attest the person, where the relay is is set in a terminal (Do it in Terminal).
  const [refused, setRefused] = useState(false);
  const atTerminal = setupsAtTerminal() || refused;
  const [pending, setPending] = useState<TerminalCommand | null>(null);
  const read = shown.result.state === 'ready' ? readAgentSessions(shown.result.value) : null;
  const choose = async (relayHome: string) => {
    setProblem(null);
    const atTerminalCommand: TerminalCommand = {
      kind: 'atTerminal',
      call: { kind: 'integrationSetAgentSessions', relayHome },
    };
    if (atTerminal) {
      setPending(atTerminalCommand);
      return;
    }
    setBusy(true);
    const outcome = await run({ kind: 'integrationSetAgentSessions', relayHome });
    if (outcome.state === 'failed') {
      setProblem({ message: outcome.message, hint: outcome.hint });
      if (refusedAsUnattested(outcome.code)) {
        setRefused(true);
        setPending(atTerminalCommand);
      }
    }
    await shown.reload();
    setBusy(false);
  };
  if (shown.result.state !== 'ready' || read === null)
    return (
      <Card letter="A" title={INTEGRATIONS_COPY.sessions} body={INTEGRATIONS_COPY.sessionsBody}>
        {shown.result.state === 'ready' ? (
          <p role="alert" className="text-danger">
            {INTEGRATIONS_COPY.unreadable}
          </p>
        ) : (
          <ScreenState value={shown.result}>{() => null}</ScreenState>
        )}
      </Card>
    );
  const chip = (
    <Chip tone={read.ready ? 'ok' : 'warn'} variant="tag">
      {`${INTEGRATIONS_COPY.relay}: ${read.ready ? INTEGRATIONS_COPY.ready : INTEGRATIONS_COPY.notReady}`}
    </Chip>
  );
  const typed = folder.trim();
  const whole = isWholeFolder(typed);
  return (
    <Card letter="A" title={INTEGRATIONS_COPY.sessions} chip={chip} body={INTEGRATIONS_COPY.sessionsBody}>
      <Facts
        rows={[
          [INTEGRATIONS_COPY.state, <UntrustedText key="s" text={relayWords(read)} />],
          [
            INTEGRATIONS_COPY.foundAt,
            <UntrustedText
              key="h"
              text={
                read.home === null
                  ? '—'
                  : `${read.home}${read.source === null ? '' : ` (${SOURCE_WORDS[read.source]})`}`
              }
            />,
          ],
          [INTEGRATIONS_COPY.version, <UntrustedText key="v" text={read.version ?? '—'} />],
          [
            INTEGRATIONS_COPY.allowed,
            <UntrustedText
              key="a"
              text={read.allowedRoots.length === 0 ? INTEGRATIONS_COPY.noFolders : read.allowedRoots.join(', ')}
            />,
          ],
          [INTEGRATIONS_COPY.waiting, String(read.waiting)],
        ]}
      />
      <div className="flex flex-col gap-(--cue-space-2)">
        <span className="text-(length:--cue-text-label) text-fg-muted">{INTEGRATIONS_COPY.useRelayAt}</span>
        <p data-slot="relay-home" className="text-fg">
          <UntrustedText text={read.relayHome ?? INTEGRATIONS_COPY.wherever} />
        </p>
        {read.relayHome === null ? null : (
          <div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void choose('default')}>
              {INTEGRATIONS_COPY.findIt}
            </Button>
          </div>
        )}
        <form
          className="flex flex-wrap items-end gap-(--cue-space-2)"
          onSubmit={(event) => {
            event.preventDefault();
            if (whole) void choose(typed).then(() => setFolder(''));
          }}
        >
          <Field name="relay-home" className="min-w-64 flex-1" invalid={typed !== '' && !whole}>
            <FieldLabel>{INTEGRATIONS_COPY.relayFolder}</FieldLabel>
            <Input
              value={folder}
              spellCheck={false}
              autoComplete="off"
              placeholder={INTEGRATIONS_COPY.relayFolderHint}
              onValueChange={(value: string) => setFolder(value)}
            />
          </Field>
          <Button type="submit" size="sm" disabled={busy || !whole}>
            {INTEGRATIONS_COPY.useFolder}
          </Button>
        </form>
      </div>
      <SetupProblem problem={problem} />
      {pending === null ? null : (
        <DoInTerminal
          key={JSON.stringify(pending)}
          command={pending}
          onCancel={() => setPending(null)}
          onDone={() => {
            setPending(null);
            void shown.reload();
          }}
        />
      )}
    </Card>
  );
}

/** A folder written whole: absolute, with no `.` or `..` step and no repeated or trailing `/`, as Rust checks it too. */
function isWholeFolder(value: string): boolean {
  return (
    value.startsWith('/') &&
    value !== '/' &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !/[\p{Cc}\p{Cf}]/u.test(value) &&
    value
      .slice(1)
      .split('/')
      .every((step) => step !== '.' && step !== '..')
  );
}
