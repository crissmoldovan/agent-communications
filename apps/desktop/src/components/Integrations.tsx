import {
  AlertDialog,
  Button,
  Chip,
  Field,
  FieldLabel,
  Panel,
  PasswordInput,
  SectionHeader,
  SegmentedControl,
} from '@cueplusplus/ui';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY, needsLine } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { GATES, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { RELAY_WORDS, readAgentSessions, readLinear, type SessionsState } from '../integrations.ts';
import { type Call, errorMessage, type RelayHome } from '../ipc.ts';
import { takeDestination } from '../navigation.tsx';
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
  body: 'Other tools a rule can act in. Each one is connected here, once, and a rule names it when you approve it.',
  linear: 'Linear',
  linearBody: 'Lets a rule add an issue. Nothing reads your Linear on its own.',
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
  noRule: 'No rule yet',
  changeTeams: 'Change teams…',
  disconnect: 'Disconnect',
  disconnectTitle: 'Disconnect Linear?',
  disconnectBody: (rules: number) =>
    rules === 0
      ? 'Your key is removed from this Mac. No rule uses it.'
      : `Your key is removed from this Mac, and ${rules === 1 ? 'the rule that uses it adds' : `the ${rules} rules that use it add`} no issue until you connect it again.`,
  sessions: 'Agent sessions',
  sessionsBody:
    'A rule can hand a message to a Claude Code or Codex session that claude-stream runs on this Mac. Agent Comms reads claude-stream’s token as you, and never shows it.',
  relay: 'claude-stream',
  useRelayAt: 'Use claude-stream at',
  homes: { 'claude-stream': 'claude-stream’s own home', pilot: 'The Pilot app’s home' },
  version: 'Version',
  allowed: 'Folders a session may work in',
  noFolders: 'None yet',
  notFound: 'not found here',
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
      if (result.status === 'failed') setProblem({ message: result.message, hint: result.hint });
      else setForm(false);
    } catch (error) {
      setProblem({ message: errorMessage(error), hint: null });
    } finally {
      setBusy(false);
    }
    await shown.reload();
  };

  const disconnect = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await run({ kind: 'providerKeyRemove', provider: 'linear' });
    if (outcome.state === 'failed') setProblem({ message: outcome.message, hint: outcome.hint });
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
  const actions = form ? undefined : read.connected ? (
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
          <AlertDialog.Description>{INTEGRATIONS_COPY.disconnectBody(read.usedBy.length)}</AlertDialog.Description>
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
    <Button size="sm" variant="primary" disabled={busy} onClick={() => setForm(true)}>
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
            [
              INTEGRATIONS_COPY.usedBy,
              <UntrustedText
                key="u"
                text={read.usedBy.length === 0 ? INTEGRATIONS_COPY.noRule : read.usedBy.join(', ')}
              />,
            ],
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
    </Card>
  );
}

function homeLabel(state: SessionsState, home: RelayHome): string {
  const entry = state.homes.find((each) => each.home === home);
  const where = entry?.path ?? '';
  const missing = entry?.found === false ? ` (${INTEGRATIONS_COPY.notFound})` : '';
  return `${INTEGRATIONS_COPY.homes[home]}${where === '' ? '' : `, ${where}`}${missing}`;
}

function AgentSessions() {
  const { run } = useChange();
  const shown = useCall<unknown>(SESSIONS);
  useReloadOnReturn(shown.reload);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const read = shown.result.state === 'ready' ? readAgentSessions(shown.result.value) : null;
  const choose = async (home: RelayHome) => {
    setBusy(true);
    setProblem(null);
    const outcome = await run({ kind: 'integrationSetAgentSessions', home });
    if (outcome.state === 'failed') setProblem({ message: outcome.message, hint: outcome.hint });
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
    <Chip tone={read.relay === 'running' ? 'ok' : 'warn'} variant="tag">
      {`${INTEGRATIONS_COPY.relay}: ${RELAY_WORDS[read.relay]}`}
    </Chip>
  );
  const homes = read.homes.length > 0 ? read.homes.map((entry) => entry.home) : read.home === null ? [] : [read.home];
  return (
    <Card letter="A" title={INTEGRATIONS_COPY.sessions} chip={chip} body={INTEGRATIONS_COPY.sessionsBody}>
      {homes.length === 0 ? null : (
        <div className="flex flex-col gap-(--cue-space-1)">
          <span className="text-(length:--cue-text-label) text-fg-muted">{INTEGRATIONS_COPY.useRelayAt}</span>
          <SegmentedControl
            aria-label={INTEGRATIONS_COPY.useRelayAt}
            size="sm"
            className="self-start"
            value={read.home ?? ''}
            items={homes.map((home) => ({ value: home, label: homeLabel(read, home), disabled: busy }))}
            onValueChange={(home) => void choose(home as RelayHome)}
          />
        </div>
      )}
      <Facts
        rows={[
          [INTEGRATIONS_COPY.version, <UntrustedText key="v" text={read.version ?? '—'} />],
          [
            INTEGRATIONS_COPY.allowed,
            <UntrustedText
              key="a"
              text={read.allowedRoots.length === 0 ? INTEGRATIONS_COPY.noFolders : read.allowedRoots.join(', ')}
            />,
          ],
        ]}
      />
      <SetupProblem problem={problem} />
    </Card>
  );
}
