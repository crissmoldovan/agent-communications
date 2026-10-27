import { Breadcrumb, Button, Field, FieldLabel, Input, Panel, StatusDot } from '@cueplusplus/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { ChangePreview } from '../../components/ChangePreview.tsx';
import { Fact, Facts } from '../../components/Facts.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { Ago, When } from '../../components/When.tsx';
import { useCall } from '../../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../../hooks/use-change.ts';
import { useReloadOnReturn } from '../../hooks/use-reload-on-return.ts';
import type { Call, ConnectionPartRequest } from '../../ipc.ts';
import { shownFolder } from '../../lanes.ts';
import {
  type AccountChoice,
  accountsOf,
  appName,
  appNameAtStart,
  CONNECTION_APP_LABELS,
  CORE_PART,
  type ConnectionView,
  entryLine,
  grantsFor,
  hasCore,
  nameOf,
  nameProblem,
  type PartChoice,
  type PartSettings,
  partLine,
  partName,
  partsNow,
  partsRequest,
  readChanged,
  readRemoved,
  readReplaced,
  readShownConnection,
  readUndone,
  type Snippets as SnippetSet,
  statusOf,
  whereLong,
  whereShort,
} from '../../mcp-connections.ts';
import { AppMark, KeyWhy, type Outcome, PrepareAndApprove } from './bits.tsx';
import { MCP_COPY, ONE_COPY } from './copy.ts';
import { PartsEditor } from './PartsEditor.tsx';
import { Snippets } from './Snippets.tsx';

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/** What the last act on the page came to: said, or refused with core's hint. */
type Said = Outcome;

/** The one ask open on the page at a time, as the Connection board opens them. */
type Asking = 'rename' | 'key' | 'remove' | null;

/** A change of parts waiting for the person's approval: what was asked, and what it adds. */
interface PartsWaiting {
  outcome: Waiting;
  parts: ConnectionPartRequest[];
  grants: string[];
}

/**
 * One connection's page (§11; the Connection board): how it stands — and, from `connection show`, what runs for it now —
 * with its app, place and entry; its key, replaced at once (a Manual connection's new snippet shown this once); its parts
 * and accounts, each change sent as it is made, a taking-away applied at once and a giving-more approved in the app (in
 * Terminal where nothing attests the app); when it was last used; back to separate entries (the migration's undo,
 * approved first); and Remove, at once. Rename applies at once. The test build only shows.
 */
export function ConnectionPage({
  view,
  choices,
  accounts,
  home,
  approveHere,
  readOnly,
  onBack,
  onGone,
  onChanged,
  onActivity,
}: {
  view: ConnectionView;
  choices: readonly PartChoice[];
  accounts: readonly AccountChoice[];
  home: string | null;
  approveHere: boolean;
  readOnly: boolean;
  onBack: () => void;
  /** It is no longer here: back to the list, which says what happened. */
  onGone: (said: string) => void;
  onChanged: () => Promise<void>;
  onActivity: () => void;
}) {
  const change = useChange();
  const shown = useCall<unknown>({ kind: 'connectionShow', connectionId: view.id });
  useReloadOnReturn(shown.reload);
  const running = useMemo(() => {
    if (shown.result.state !== 'ready') return undefined;
    return readShownConnection(shown.result.value)?.running;
  }, [shown.result]);
  const [said, setSaid] = useState<Said | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [partsWaiting, setPartsWaiting] = useState<PartsWaiting | null>(null);
  // A remove core asked about first: its entry shadows a wider one the agents in its folder would then use (H1).
  const [removeWaiting, setRemoveWaiting] = useState<Waiting | null>(null);
  // A Manual connection's new snippet, with its key in it: held only while it is shown, and let go at Done.
  const [snippets, setSnippets] = useState<SnippetSet | null>(null);

  const name = nameOf(view);
  const app = appName(view.app);
  const App = appNameAtStart(view.app);
  const manual = view.app === 'manual';
  const file = view.entry?.path ? shownFolder(view.entry.path, home) : `${app}’s settings`;
  const status = statusOf(view, home, running);
  const settings: PartSettings = partsNow(choices, view);
  const reload = async () => {
    await Promise.all([onChanged(), shown.reload()]);
  };
  const refuse = (text: string, hint: string | null) => setSaid({ tone: 'refused', text, hint });
  const open = (next: Asking) => {
    setSaid(null);
    setSnippets(null);
    setAsking(asking === next ? null : next);
    if (next === 'rename') setDraft(name);
  };

  const rename = async () => {
    const typed = draft.trim();
    const wrong = nameProblem(typed);
    if (wrong !== null) return refuse(ONE_COPY.notRenamed(wrong), null);
    if (typed === name) {
      setAsking(null);
      setSaid({ tone: 'quiet', text: ONE_COPY.sameName });
      return;
    }
    setBusy(true);
    const outcome = await change.run({ kind: 'connectionRename', connectionId: view.id, name: typed });
    setBusy(false);
    if (outcome.state === 'applied') {
      setAsking(null);
      setSaid({ tone: 'ok', text: ONE_COPY.renamed(typed) });
      await reload();
      return;
    }
    refuse(
      ONE_COPY.notRenamed(outcome.state === 'failed' ? outcome.message : 'it asked for an approval'),
      outcome.state === 'failed' ? outcome.hint : null,
    );
  };

  const replaceKey = async () => {
    setBusy(true);
    const outcome = await change.run({ kind: 'connectionKeyReplace', connectionId: view.id });
    setBusy(false);
    setAsking(null);
    if (outcome.state !== 'applied') {
      refuse(
        ONE_COPY.notReplaced(outcome.state === 'failed' ? outcome.message : 'it asked for an approval'),
        outcome.state === 'failed' ? outcome.hint : null,
      );
      return;
    }
    const replaced = readReplaced(outcome.data);
    if (manual) {
      setSnippets(replaced.snippets);
      setSaid({ tone: 'ok', text: ONE_COPY.replaced });
    } else if (replaced.connection?.entry?.keyMatches === false) {
      // The old key stopped; the new one did not reach the app's entry. Core says what to do.
      refuse(ONE_COPY.replaced, replaced.next);
    } else {
      setSaid({ tone: 'ok', text: ONE_COPY.replacedKnown(app) });
    }
    await reload();
  };

  /** The list's words for a connection removed, at once or once approved: what was done, and any entry left. */
  const gone = (data: unknown, approved: boolean) => {
    const { kept } = readRemoved(data);
    const lines = [
      approved
        ? MCP_COPY.removedApprovedSaid(name, manual ? 'the app' : app)
        : MCP_COPY.removedSaid(name, manual ? 'the app' : app, manual),
      ...kept.map((each) => ONE_COPY.keptEntry(each.name, each.path, each.reason)),
    ];
    onGone(lines.join(' '));
  };

  const remove = async () => {
    setBusy(true);
    const outcome = await change.run({ kind: 'connectionRemove', connectionId: view.id });
    setBusy(false);
    setAsking(null);
    if (outcome.state === 'needsTerminal') {
      // Its entry shadows a wider one: core prepared it, and the person approves it here, as a loosening.
      setRemoveWaiting(outcome);
      return;
    }
    if (outcome.state !== 'applied') {
      refuse(ONE_COPY.notRemoved(outcome.message), outcome.hint);
      return;
    }
    gone(outcome.data, false);
  };

  /** Every part after one change: sent at once, as the board applies each switch. */
  const changeParts = async (server: string, next: PartSettings[string]) => {
    const after = { ...settings, [server]: next };
    const parts = partsRequest(choices, after);
    if (parts.length === 0) return refuse(ONE_COPY.needOnePart, null);
    setSaid(null);
    setSnippets(null);
    setBusy(true);
    const call: Extract<Call, { kind: 'connectionChange' }> = {
      kind: 'connectionChange',
      connectionId: view.id,
      parts,
    };
    const outcome = await change.run(call);
    setBusy(false);
    if (outcome.state === 'applied') {
      const { appliedAtOnce } = readChanged(outcome.data);
      setSaid(
        appliedAtOnce.length === 0
          ? { tone: 'quiet', text: ONE_COPY.alreadySo }
          : { tone: 'ok', text: ONE_COPY.partsAtOnce(appliedAtOnce.join('; '), app) },
      );
      await reload();
      return;
    }
    if (outcome.state === 'needsTerminal') {
      setPartsWaiting({
        outcome,
        parts,
        grants: grantsFor(reachingMore(view, parts), (each) => accountsOf(each, accounts)),
      });
      // Core takes away at once what the change narrows, before it asks for the rest: read again.
      await reload();
      return;
    }
    refuse(ONE_COPY.partsNotChanged(outcome.message), outcome.hint);
  };

  const notIncluded = choices.filter(
    (choice) => choice.server !== CORE_PART && !view.parts.some((part) => part.server === choice.server),
  );

  return (
    <section aria-label={name} className="flex flex-col gap-(--cue-space-4)">
      <Breadcrumb
        label="Where you are"
        separator="›"
        items={[{ label: MCP_COPY.title, onClick: onBack }, { label: name }]}
      />
      <Panel className="flex items-start gap-(--cue-space-4) p-(--cue-space-5)">
        <AppMark app={view.app} />
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
          <h2 className="font-semibold text-(length:--cue-text-title) text-fg">{name}</h2>
          <p className="text-fg-muted">{whereShort(view, home)}</p>
        </div>
        {readOnly || !view.readable ? null : (
          <Button size="sm" variant="secondary" aria-expanded={asking === 'rename'} onClick={() => open('rename')}>
            {ONE_COPY.rename}
          </Button>
        )}
      </Panel>

      <SaidLine said={said} />

      {asking === 'rename' ? (
        <Ask title={ONE_COPY.renameTitle}>
          <Field name="rename" className="max-w-80">
            <FieldLabel>{ONE_COPY.renameLabel}</FieldLabel>
            <Input value={draft} autoComplete="off" onValueChange={(value: string) => setDraft(value)} />
          </Field>
          <p className="text-(length:--cue-text-ui) text-fg-subtle">{ONE_COPY.renameNote}</p>
          <div className="flex gap-(--cue-space-2)">
            <Button variant="primary" loading={busy} onClick={() => void rename()}>
              {ONE_COPY.save}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAsking(null);
                setSaid({ tone: 'quiet', text: ONE_COPY.renameCancelled(name) });
              }}
            >
              {ONE_COPY.cancel}
            </Button>
          </div>
        </Ask>
      ) : null}

      <Section title={ONE_COPY.about}>
        <div
          data-slot="connection-status"
          className={`flex flex-col gap-(--cue-space-1) rounded-control px-(--cue-space-3) py-(--cue-space-2) ${status.tone === 'ok' ? 'bg-ok-soft' : status.tone === 'warn' ? 'bg-warn-soft' : status.tone === 'danger' ? 'bg-danger-soft' : 'bg-surface-2'}`}
        >
          <span className="flex flex-wrap items-center gap-(--cue-space-2)">
            <StatusDot tone={status.tone} label={status.word} />
            <span className="font-medium text-fg">{status.word}</span>
            <span aria-hidden="true" className="text-fg-subtle">
              ·
            </span>
            <span className="text-fg-subtle">
              {view.lastUsed === null ? (
                MCP_COPY.notUsed
              ) : (
                <>
                  {`${MCP_COPY.lastUsed} `}
                  <Ago at={view.lastUsed} />
                </>
              )}
            </span>
          </span>
          <p className="text-fg-muted">
            <UntrustedText text={status.line} />
          </p>
          {view.problems.map((problem) => (
            <p key={problem} className="text-fg-muted">
              <UntrustedText text={problem} />
            </p>
          ))}
        </div>
        <Facts>
          <Fact name={ONE_COPY.app}>
            {manual ? ONE_COPY.manualApp : view.app === null ? '—' : CONNECTION_APP_LABELS[view.app]}
          </Fact>
          <Fact name={ONE_COPY.where}>{whereLong(view, home)}</Fact>
          {view.entry === null ? null : (
            <Fact name={ONE_COPY.entry}>
              <span className="break-all font-mono text-(length:--cue-text-ui)">{entryLine(view, home)}</span>
            </Fact>
          )}
          {view.createdAt === null ? null : (
            <Fact name={ONE_COPY.addedOn}>
              <When at={view.createdAt} />
            </Fact>
          )}
        </Facts>
        {running === undefined ? (
          shown.result.state === 'error' ? (
            <p className="text-(length:--cue-text-ui) text-fg-subtle">{ONE_COPY.notShown}</p>
          ) : null
        ) : (
          running.map((gateway) => (
            <div key={`${gateway.pid}`} data-slot="running" className="flex flex-col gap-(--cue-space-1)">
              <span className="font-medium text-fg">
                <UntrustedText text={ONE_COPY.runningFor(gateway.client)} />
              </span>
              <ul className="flex flex-col gap-(--cue-space-1)">
                {gateway.parts.map((part) => (
                  <li key={part.server} className="text-fg-muted">
                    <UntrustedText
                      text={`${partName(part.server, part.label)}: ${ONE_COPY.partState[part.state] ?? part.state}${part.version === null ? '' : ` (${part.version})`}${part.why === null ? '' : ` — ${part.why}`}`}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </Section>

      <Section
        title={ONE_COPY.key}
        action={
          readOnly || !view.readable ? null : (
            <Button size="sm" variant="secondary" aria-expanded={asking === 'key'} onClick={() => open('key')}>
              {ONE_COPY.replace}
            </Button>
          )
        }
      >
        <p className="text-fg">
          {view.key.issuedAt === null ? null : (
            <>
              {`${ONE_COPY.issued} `}
              <When at={view.key.issuedAt} />
            </>
          )}
        </p>
        <KeyWhy name={name} />
        {asking === 'key' ? (
          <Ask title={ONE_COPY.replaceTitle(name)}>
            <p className="text-fg-muted">{manual ? ONE_COPY.replaceManual : ONE_COPY.replaceKnown(app, file)}</p>
            <div className="flex flex-wrap items-center gap-(--cue-space-2)">
              <Button variant="primary" loading={busy} onClick={() => void replaceKey()}>
                {ONE_COPY.replaceButton}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAsking(null);
                  setSaid({ tone: 'quiet', text: ONE_COPY.replaceCancelled });
                }}
              >
                {ONE_COPY.cancel}
              </Button>
              <span className="text-(length:--cue-text-ui) text-fg-subtle">{ONE_COPY.replaceAtOnce}</span>
            </div>
          </Ask>
        ) : null}
        {snippets === null ? null : (
          <Ask title={ONE_COPY.newSnippet}>
            <Snippets snippets={snippets} />
            <p className="text-fg-muted">{ONE_COPY.newSnippetNote}</p>
            <div>
              <Button size="sm" variant="ghost" onClick={() => setSnippets(null)}>
                {ONE_COPY.hideSnippet}
              </Button>
            </div>
          </Ask>
        )}
      </Section>

      <Section
        title={ONE_COPY.parts}
        action={
          readOnly || !view.readable ? null : (
            <Button
              size="sm"
              variant="secondary"
              aria-expanded={editing}
              disabled={partsWaiting !== null}
              onClick={() => {
                setSaid(null);
                setEditing(!editing);
              }}
            >
              {editing ? ONE_COPY.doneEditing : ONE_COPY.change}
            </Button>
          )
        }
      >
        {editing ? (
          <>
            <p className="text-(length:--cue-text-ui) text-fg-subtle">{ONE_COPY.editLead}</p>
            <PartsEditor
              choices={choices}
              accounts={accounts}
              settings={settings}
              disabled={busy || partsWaiting !== null}
              onChange={(server, setting) => void changeParts(server, setting)}
            />
          </>
        ) : (
          <>
            <ul className="flex flex-col">
              {partLines(view).map(({ server, line }) => (
                <li
                  key={server}
                  data-part={server}
                  className="flex flex-wrap items-baseline gap-x-(--cue-space-4) border-border border-t py-(--cue-space-2) first:border-t-0"
                >
                  <span className="w-40 shrink-0 font-medium text-fg">{line.name}</span>
                  <span className="min-w-0 flex-1 text-fg-muted">{line.detail}</span>
                </li>
              ))}
            </ul>
            {view.parts
              .filter((part) => !part.available && part.why !== null)
              .map((part) => (
                <p key={part.server} className="text-warn">
                  <UntrustedText text={`${partName(part.server, part.label)}: ${part.why}`} />
                </p>
              ))}
            {notIncluded.length === 0 ? null : (
              <p className="text-(length:--cue-text-ui) text-fg-subtle">
                {ONE_COPY.notIncluded(notIncluded.map((choice) => choice.name).join(', '))}
              </p>
            )}
          </>
        )}
        {partsWaiting === null ? null : (
          <div className="flex flex-col gap-(--cue-space-2)">
            <p className="text-fg">{ONE_COPY.partsLead(name)}</p>
            <ul className="flex list-disc flex-col gap-(--cue-space-1) ps-(--cue-space-5)">
              {partsWaiting.grants.map((grant) => (
                <li key={grant} className="text-fg">
                  {grant}
                </li>
              ))}
            </ul>
            <ChangePreview
              key={partsWaiting.outcome.approvalId}
              change={partsWaiting.outcome}
              onDone={(result) => {
                if (result === 'cancelled') {
                  setPartsWaiting(null);
                  setSaid({ tone: 'quiet', text: MCP_COPY.cancelled });
                  return;
                }
                setPartsWaiting(null);
                setSaid({ tone: 'quiet', text: MCP_COPY.inTerminal });
              }}
              inApp={
                approveHere
                  ? {
                      title: ONE_COPY.partsAsk(name),
                      approve: MCP_COPY.approve,
                      call: {
                        kind: 'connectionChange',
                        connectionId: view.id,
                        parts: partsWaiting.parts,
                        appApproval: partsWaiting.outcome.approvalId,
                      },
                      failed: ONE_COPY.partsNotChanged,
                      onApproved: () => {
                        setPartsWaiting(null);
                        setSaid({ tone: 'ok', text: ONE_COPY.partsApproved(name, app) });
                        void reload();
                      },
                      onVoid: () => {
                        const asked = partsWaiting;
                        setPartsWaiting(null);
                        void change
                          .run({ kind: 'connectionChange', connectionId: view.id, parts: asked.parts })
                          .then((outcome) => {
                            if (outcome.state === 'needsTerminal') {
                              setPartsWaiting({ ...asked, outcome });
                              setSaid({ tone: 'quiet', text: MCP_COPY.prepareAgain });
                            } else if (outcome.state === 'failed') {
                              refuse(ONE_COPY.partsNotChanged(outcome.message), outcome.hint);
                            } else void reload();
                          });
                      },
                      onRefused: () => void reload(),
                    }
                  : undefined
              }
            />
          </div>
        )}
      </Section>

      <Section title={ONE_COPY.recent}>
        <p className="text-fg">
          {view.lastUsed === null ? (
            ONE_COPY.neverUsed(app)
          ) : (
            <>
              {`${ONE_COPY.lastUsed} `}
              <Ago at={view.lastUsed} />
              {'.'}
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <span className="flex-1 text-(length:--cue-text-ui) text-fg-subtle">{ONE_COPY.usedBy(name)}</span>
          <Button size="sm" variant="ghost" onClick={onActivity}>
            {ONE_COPY.allActivity}
          </Button>
        </div>
      </Section>

      {readOnly || manual || !view.readable ? null : (
        <Section title={ONE_COPY.undoTitle}>
          <p className="text-fg-muted">{ONE_COPY.undoLead(app)}</p>
          <PrepareAndApprove
            button={ONE_COPY.undoButton}
            prepare={{ kind: 'connectionMigrateUndo', connectionId: view.id }}
            approve={(approvalId) => ({
              kind: 'connectionMigrateUndo',
              connectionId: view.id,
              appApproval: approvalId,
            })}
            title={ONE_COPY.undoAsk(name)}
            approveHere={approveHere}
            failed={ONE_COPY.notUndone}
            onApproved={(data) => onGone(undoneLine(data))}
            onSaid={setSaid}
          />
        </Section>
      )}

      {readOnly ? null : (
        <Section
          title={ONE_COPY.remove}
          action={
            <Button size="sm" variant="danger" aria-expanded={asking === 'remove'} onClick={() => open('remove')}>
              {ONE_COPY.removeButton}
            </Button>
          }
        >
          <p className="text-(length:--cue-text-ui) text-fg-subtle">{ONE_COPY.removeLead(App)}</p>
          {removeWaiting === null ? null : (
            <div className="flex flex-col gap-(--cue-space-2)">
              <p className="text-fg">{ONE_COPY.removeWider}</p>
              <ChangePreview
                key={removeWaiting.approvalId}
                change={removeWaiting}
                onDone={(result) => {
                  setRemoveWaiting(null);
                  setSaid({ tone: 'quiet', text: result === 'cancelled' ? MCP_COPY.cancelled : MCP_COPY.inTerminal });
                }}
                inApp={
                  approveHere
                    ? {
                        title: ONE_COPY.removeAsk(name),
                        approve: MCP_COPY.approve,
                        call: {
                          kind: 'connectionRemove',
                          connectionId: view.id,
                          appApproval: removeWaiting.approvalId,
                        },
                        failed: ONE_COPY.notRemoved,
                        onApproved: (result) => {
                          setRemoveWaiting(null);
                          gone(result.data, true);
                        },
                        onVoid: () => {
                          setRemoveWaiting(null);
                          void change.run({ kind: 'connectionRemove', connectionId: view.id }).then((outcome) => {
                            if (outcome.state === 'needsTerminal') {
                              setRemoveWaiting(outcome);
                              setSaid({ tone: 'quiet', text: MCP_COPY.prepareAgain });
                            } else if (outcome.state === 'failed') {
                              refuse(ONE_COPY.notRemoved(outcome.message), outcome.hint);
                            } else gone(outcome.data, false);
                          });
                        },
                        onRefused: () => void reload(),
                      }
                    : undefined
                }
              />
            </div>
          )}
          {asking === 'remove' ? (
            <Ask title={ONE_COPY.removeTitle(name)}>
              <p className="text-fg-muted">{manual ? ONE_COPY.removeManual : ONE_COPY.removeKnown(App, file)}</p>
              <div className="flex flex-wrap items-center gap-(--cue-space-2)">
                <Button variant="danger" loading={busy} onClick={() => void remove()}>
                  {ONE_COPY.removeConfirm}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setAsking(null);
                    setSaid({ tone: 'quiet', text: ONE_COPY.removeCancelled(name) });
                  }}
                >
                  {ONE_COPY.cancel}
                </Button>
                <span className="text-(length:--cue-text-ui) text-fg-subtle">
                  {manual ? ONE_COPY.removeAtOnce : ONE_COPY.removeAtOnceKnown(app)}
                </span>
              </div>
            </Ask>
          ) : null}
        </Section>
      )}
    </section>
  );
}

/** The page's lines of parts: each part the connection has, and first, when it has none, that Agent Comms isn't one. */
function partLines(view: ConnectionView): { server: string; line: { name: string; detail: string } }[] {
  const lines = view.parts.map((part) => ({ server: part.server, line: partLine(part) }));
  return hasCore(view)
    ? lines
    : [{ server: CORE_PART, line: { name: partName(CORE_PART), detail: ONE_COPY.noCore } }, ...lines];
}

/** What core's undo came to, in a line for the list: each part as the entry it is again. */
function undoneLine(data: unknown): string {
  const { registered } = readUndone(data);
  return ONE_COPY.undone(
    registered
      .map((each) => `${partName(each.server)} as “${each.name}”${each.applied ? '' : ' (not registered)'}`)
      .join('; ') || 'its parts are entries of their own again',
  );
}

/**
 * The parts of a change that reach more than the connection does now: a part added, an account let go or moved, or
 * read-only off — what the person is asked to approve.
 */
function reachingMore(view: ConnectionView, parts: readonly ConnectionPartRequest[]): ConnectionPartRequest[] {
  return parts.filter((part) => {
    const now = view.parts.find((each) => each.server === part.server);
    if (now === undefined) return true;
    if (now.account !== null && (part.account ?? null) !== now.account) return true;
    return now.readOnly && part.readOnly !== true;
  });
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
      <div className="flex items-center gap-(--cue-space-2)">
        <h3 className="flex-1 font-semibold text-fg">{title}</h3>
        {action}
      </div>
      {children}
    </Panel>
  );
}

function Ask({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-(--cue-space-2) rounded-control bg-surface-2 px-(--cue-space-4) py-(--cue-space-3)"
    >
      <p className="font-semibold text-fg">{title}</p>
      {children}
    </section>
  );
}

function SaidLine({ said }: { said: Said | null }) {
  if (said === null) return null;
  if (said.tone === 'refused') {
    return (
      <div className="flex flex-col gap-(--cue-space-1)">
        <p role="alert" className="text-danger">
          <UntrustedText text={said.text} />
        </p>
        {said.hint === null ? null : (
          <p className="text-fg-muted">
            <UntrustedText text={said.hint} />
          </p>
        )}
      </div>
    );
  }
  return (
    <p
      role="status"
      className={`rounded-control px-(--cue-space-3) py-(--cue-space-2) text-fg ${said.tone === 'ok' ? 'bg-ok-soft' : 'bg-surface-2'}`}
    >
      {said.text}
    </p>
  );
}
