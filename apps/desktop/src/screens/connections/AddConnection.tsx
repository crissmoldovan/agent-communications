import { Breadcrumb, Button, Field, FieldLabel, Input, Panel } from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import { ChangePreview } from '../../components/ChangePreview.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { type ChangeOutcome, useChange } from '../../hooks/use-change.ts';
import { CONNECTION_APPS, type ConnectionAddCall, type ConnectionApp } from '../../ipc.ts';
import { shownFolder } from '../../lanes.ts';
import {
  type AccountChoice,
  type AddedConnection,
  accountsOf,
  CONNECTION_APP_LABELS,
  CONNECTION_APP_LINES,
  type ConnectionView,
  grantsFor,
  nameOf,
  nameProblem,
  type PartChoice,
  type PartSettings,
  partName,
  partsRequest,
  readAdded,
  samePlace,
  startingParts,
  type WhereView,
  wholeFolder,
  writtenLine,
} from '../../mcp-connections.ts';
import { AppMark, KeyWhy } from './bits.tsx';
import { ADD_COPY, MCP_COPY } from './copy.ts';
import { PartsEditor } from './PartsEditor.tsx';
import { Snippets } from './Snippets.tsx';

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;
type Step = 'type' | 'where' | 'name' | 'parts' | 'review' | 'done';
type Place = 'all' | 'project' | 'profile' | 'this' | 'home';

/** The places each app with more than one offers (D18): Claude Code's three, Codex's two. */
const PLACES: Partial<Record<ConnectionApp, readonly Place[]>> = {
  'claude-code': ['all', 'project', 'profile'],
  codex: ['this', 'home'],
};

/** Whether a place takes a folder: a project's, or another profile's or Codex home's. */
const takesFolder = (place: Place | null): boolean => place === 'project' || place === 'profile' || place === 'home';

/** A folder's last step, without a leading dot: what an automatic name says of it. */
const base = (folder: string): string => (folder.split(/[\\/]/).pop() ?? folder).replace(/^\./, '');

/**
 * Add a connection (§11; the AddConnection board), step by step: the app; where it has Agent Comms (Claude Code's every
 * folder, one project or another profile; Codex's own or another home), or for Manual the app's name; the connection's
 * name; its parts and accounts; then core's preview of exactly that, approved in the app (`--app-approval`, macOS), or
 * in Terminal where nothing attests the app. Nothing is written until it is approved. Done says where its entry was
 * written and what to do next — and, for Manual, the snippet with its key, shown this once and never kept.
 */
export function AddConnection({
  choices,
  accounts,
  existing,
  home,
  eventsInstalled,
  approveHere,
  onCancel,
  onFinished,
  onOpen,
}: {
  choices: readonly PartChoice[];
  accounts: readonly AccountChoice[];
  existing: readonly ConnectionView[];
  home: string | null;
  eventsInstalled: boolean;
  approveHere: boolean;
  onCancel: () => void;
  /** The person is done: back to the list, which says it was added (or, after Terminal, reads it again). */
  onFinished: (added: { name: string; app: ConnectionApp } | null) => void;
  onOpen: (id: string) => void;
}) {
  const change = useChange();
  const [step, setStep] = useState<Step>('type');
  const [app, setApp] = useState<ConnectionApp | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [folderTyped, setFolderTyped] = useState('');
  const [manualApp, setManualApp] = useState('');
  const [typedName, setTypedName] = useState<string | null>(null);
  const [parts, setParts] = useState<PartSettings>(() => startingParts(choices, accounts, eventsInstalled));
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  // The answer core gave once it was approved: for Manual, with the snippet and its key, kept only while Done shows it.
  const [added, setAdded] = useState<AddedConnection | null>(null);

  const places = app === null ? null : (PLACES[app] ?? null);
  const folder = takesFolder(place) ? wholeFolder(folderTyped, home) : null;
  const appWord = app === null ? '' : app === 'manual' ? manualApp.trim() || 'the app' : CONNECTION_APP_LABELS[app];
  const where: WhereView = {
    scope: place === 'project' ? 'local' : 'user',
    folder: place === 'project' ? folder : null,
    configDir: place === 'profile' || place === 'home' ? folder : null,
  };
  const autoName = (): string => {
    if (app === null) return '';
    if (app === 'manual') return manualApp.trim() || 'Another app';
    if (place === 'all') return 'Claude Code — every folder';
    if (place === 'this') return 'Codex';
    if (place !== null && folder !== null) return `${CONNECTION_APP_LABELS[app]} — ${base(folder)}`;
    return CONNECTION_APP_LABELS[app];
  };
  const name = typedName ?? autoName();
  const order: Step[] =
    places !== null || app === 'manual'
      ? ['type', 'where', 'name', 'parts', 'review']
      : ['type', 'name', 'parts', 'review'];
  const at = step === 'done' ? order.length : order.indexOf(step);
  const go = (next: Step) => {
    setProblem(null);
    setSaid(null);
    setStep(next);
  };

  // Where this one would go is where another already is: the app would start both (the boards' `dup`).
  const taken = app === null || app === 'manual' ? undefined : existing.find((view) => samePlace(view, { app, where }));
  const wide =
    taken === undefined && app === 'claude-code' && place === 'project' && folder !== null
      ? existing.find((view) => samePlace(view, { app, where: { scope: 'user', folder: null, configDir: null } }))
      : undefined;

  const call = (): ConnectionAddCall | null => {
    if (app === null) return null;
    return {
      kind: 'connectionAdd',
      app,
      name,
      parts: partsRequest(choices, parts),
      ...(place === 'project' && folder !== null ? { folder } : {}),
      ...((place === 'profile' || place === 'home') && folder !== null ? { profile: folder } : {}),
    };
  };

  const prepare = async (again = false) => {
    const asked = call();
    if (asked === null) return;
    setBusy(true);
    setProblem(null);
    setOpened(false);
    if (!again) setSaid(null);
    try {
      const outcome = await change.run(asked);
      if (outcome.state === 'needsTerminal') {
        setWaiting(outcome);
        if (again) setSaid(MCP_COPY.prepareAgain);
        setStep('review');
        return;
      }
      setWaiting(null);
      if (outcome.state === 'applied') {
        setAdded(readAdded(outcome.data));
        setStep('done');
        return;
      }
      setProblem({ message: ADD_COPY.notAdded(outcome.message), hint: outcome.hint });
      setStep('review');
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (step === 'type') return go(places !== null || app === 'manual' ? 'where' : 'name');
    if (step === 'where') {
      if (app === 'manual') {
        if (manualApp.trim() === '') return setProblem({ message: ADD_COPY.manualProblem, hint: null });
        return go('name');
      }
      if (takesFolder(place) && folder === null) return setProblem({ message: ADD_COPY.folderProblem, hint: null });
      return go('name');
    }
    if (step === 'name') {
      const wrong = nameProblem(name);
      if (wrong !== null) return setProblem({ message: wrong, hint: null });
      if (existing.some((view) => nameOf(view).toLowerCase() === name.toLowerCase()))
        return setProblem({ message: ADD_COPY.nameTaken(name), hint: null });
      return go('parts');
    }
    if (step === 'parts') return void prepare();
  };
  const back = () => {
    // Leaving the review takes its preview away, which revokes its approval (`ChangePreview`).
    setWaiting(null);
    go(order[Math.max(0, order.indexOf(step) - 1)] ?? 'type');
  };

  const asked = call();
  const grants = grantsFor(
    asked?.parts ?? [],
    (server) => accountsOf(server, accounts),
    (server) => partName(server, choices.find((choice) => choice.server === server)?.name),
  );
  const shownFolderName = folder === null ? '' : shownFolder(folder, home);
  const inWords =
    app === 'claude-code'
      ? place === 'project'
        ? `Agents in Claude Code, in ${shownFolderName},`
        : place === 'profile'
          ? `Agents in Claude Code, under the profile in ${shownFolderName},`
          : 'Agents in Claude Code, in every folder,'
      : app === 'codex' && place === 'home'
        ? `Agents in Codex, under ${shownFolderName},`
        : `Agents in ${appWord}`;
  const after =
    app === 'manual'
      ? ADD_COPY.afterManual(appWord)
      : place === 'project'
        ? ADD_COPY.afterProject(shownFolderName)
        : ADD_COPY.afterKnown(appWord);

  const reset = () => {
    setStep('type');
    setApp(null);
    setPlace(null);
    setFolderTyped('');
    setManualApp('');
    setTypedName(null);
    setParts(startingParts(choices, accounts, eventsInstalled));
    setProblem(null);
    setWaiting(null);
    setSaid(null);
    setOpened(false);
    setAdded(null);
  };

  return (
    <section aria-label={ADD_COPY.title} className="flex flex-col gap-(--cue-space-4)">
      <Breadcrumb
        label="Where you are"
        separator="›"
        items={[{ label: MCP_COPY.title, onClick: onCancel }, { label: ADD_COPY.crumb }]}
      />
      <div className="flex flex-col gap-(--cue-space-1)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">{ADD_COPY.title}</h2>
        <p className="text-fg-muted">{ADD_COPY.sub}</p>
      </div>
      <ol aria-label={ADD_COPY.stepsLabel} className="flex flex-wrap gap-(--cue-space-2)">
        {order.map((each, index) => (
          <li
            key={each}
            aria-current={index === at ? 'step' : undefined}
            className={`flex items-center gap-(--cue-space-2) rounded-control px-(--cue-space-2) py-(--cue-space-1) text-(length:--cue-text-ui) ${index === at ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg-subtle'}`}
          >
            <span aria-hidden="true" className="font-semibold">
              {index < at ? '✓' : String(index + 1)}
            </span>
            {each === 'where' && app === 'manual'
              ? ADD_COPY.steps.which
              : ADD_COPY.steps[each as keyof typeof ADD_COPY.steps]}
          </li>
        ))}
      </ol>

      {step === 'type' ? (
        <Card title={ADD_COPY.whichApp} lead={ADD_COPY.whichAppLead}>
          <div className="grid grid-cols-1 gap-(--cue-space-2) sm:grid-cols-2">
            {CONNECTION_APPS.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={each === app}
                onClick={() => {
                  setApp(each);
                  setPlace(PLACES[each]?.[0] ?? null);
                  setFolderTyped('');
                  setTypedName(null);
                  setProblem(null);
                }}
                className={`flex items-start gap-(--cue-space-3) rounded-surface border px-(--cue-space-3) py-(--cue-space-3) text-left ${each === 'manual' ? 'sm:col-span-2' : ''} ${each === app ? 'border-accent bg-accent-soft' : 'border-transparent bg-surface-2 hover:bg-surface-3'}`}
              >
                <AppMark app={each} />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-fg">
                    {each === 'manual' ? 'Manual / another app' : CONNECTION_APP_LABELS[each]}
                  </span>
                  <span className="text-(length:--cue-text-ui) text-fg-subtle">{CONNECTION_APP_LINES[each]}</span>
                </span>
              </button>
            ))}
          </div>
          {taken !== undefined && places === null ? (
            <Duplicate text={ADD_COPY.duplicate(nameOf(taken), appWord)} other={taken} onOpen={onOpen} />
          ) : null}
          <Actions>
            <Button variant="primary" disabled={app === null} onClick={next}>
              {ADD_COPY.continue}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              {ADD_COPY.cancel}
            </Button>
          </Actions>
        </Card>
      ) : null}

      {step === 'where' && app === 'manual' ? (
        <Card title={ADD_COPY.manualTitle} lead={ADD_COPY.manualLead}>
          <Field name="manual-app" className="max-w-80">
            <FieldLabel>{ADD_COPY.manualLabel}</FieldLabel>
            <Input
              value={manualApp}
              autoComplete="off"
              placeholder={ADD_COPY.manualPlaceholder}
              onValueChange={(value: string) => {
                setManualApp(value);
                setTypedName(null);
              }}
            />
          </Field>
          <Problem problem={problem} />
          <Actions>
            <Button variant="primary" onClick={next}>
              {ADD_COPY.continue}
            </Button>
            <Button variant="ghost" onClick={back}>
              {ADD_COPY.back}
            </Button>
          </Actions>
        </Card>
      ) : null}

      {step === 'where' && app !== null && places !== null ? (
        <Card
          title={ADD_COPY.whereTitle(CONNECTION_APP_LABELS[app])}
          lead={app === 'codex' ? ADD_COPY.whereLeadCodex : ADD_COPY.whereLeadCode}
        >
          <div className="flex flex-col gap-(--cue-space-2)">
            {places.map((each) => (
              <div key={each} className="flex flex-col gap-(--cue-space-2)">
                <button
                  type="button"
                  aria-pressed={each === place}
                  onClick={() => {
                    setPlace(each);
                    setFolderTyped('');
                    setTypedName(null);
                    setProblem(null);
                  }}
                  className={`flex flex-col items-start rounded-surface border px-(--cue-space-3) py-(--cue-space-2) text-left ${each === place ? 'border-accent bg-accent-soft' : 'border-transparent bg-surface-2 hover:bg-surface-3'}`}
                >
                  <span className="font-medium text-fg">{ADD_COPY.places[each].name}</span>
                  <span className="text-(length:--cue-text-ui) text-fg-subtle">{ADD_COPY.places[each].line}</span>
                </button>
                {each === place && takesFolder(each) ? (
                  <Field
                    name="folder"
                    className="max-w-xl ps-(--cue-space-4)"
                    invalid={folderTyped !== '' && folder === null}
                  >
                    <FieldLabel>{ADD_COPY.folderLabel}</FieldLabel>
                    <Input
                      value={folderTyped}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={ADD_COPY.folderPlaceholder}
                      onValueChange={(value: string) => {
                        setFolderTyped(value);
                        setTypedName(null);
                      }}
                    />
                  </Field>
                ) : null}
              </div>
            ))}
          </div>
          {taken !== undefined ? (
            <Duplicate text={ADD_COPY.duplicate(nameOf(taken), appWord)} other={taken} onOpen={onOpen} />
          ) : wide !== undefined ? (
            <Duplicate text={ADD_COPY.wide(nameOf(wide), shownFolderName)} other={wide} onOpen={onOpen} />
          ) : null}
          <Problem problem={problem} />
          <Actions>
            <Button variant="primary" onClick={next}>
              {ADD_COPY.continue}
            </Button>
            <Button variant="ghost" onClick={back}>
              {ADD_COPY.back}
            </Button>
          </Actions>
        </Card>
      ) : null}

      {step === 'name' ? (
        <Card title={ADD_COPY.nameTitle} lead={ADD_COPY.nameLead(name)}>
          <Field name="connection-name" className="max-w-80">
            <FieldLabel>{ADD_COPY.nameLabel}</FieldLabel>
            <Input value={name} autoComplete="off" onValueChange={(value: string) => setTypedName(value)} />
          </Field>
          <Problem problem={problem} />
          <Actions>
            <Button variant="primary" onClick={next}>
              {ADD_COPY.continue}
            </Button>
            <Button variant="ghost" onClick={back}>
              {ADD_COPY.back}
            </Button>
          </Actions>
        </Card>
      ) : null}

      {step === 'parts' ? (
        <Card title={ADD_COPY.partsTitle(name)} lead={ADD_COPY.partsLead}>
          <PartsEditor
            choices={choices}
            accounts={accounts}
            settings={parts}
            disabled={busy}
            onChange={(server, setting) => setParts((now) => ({ ...now, [server]: setting }))}
          />
          {said === null ? null : (
            <p role="status" className="text-fg-muted">
              {said}
            </p>
          )}
          <Problem problem={problem} />
          <Actions>
            <Button variant="primary" loading={busy} onClick={next}>
              {ADD_COPY.continue}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={back}>
              {ADD_COPY.back}
            </Button>
          </Actions>
        </Card>
      ) : null}

      {step === 'review' ? (
        <Card title={ADD_COPY.reviewTitle}>
          <div className="flex flex-col gap-(--cue-space-1)">
            <span className="text-(length:--cue-text-ui) text-fg-subtle">{ADD_COPY.grantsLabel}</span>
            <p className="text-fg">{ADD_COPY.reviewLead(inWords)}</p>
            <ul
              aria-label={ADD_COPY.grantsLabel}
              className="flex list-disc flex-col gap-(--cue-space-1) ps-(--cue-space-5)"
            >
              {grants.map((grant) => (
                <li key={grant} className="text-fg">
                  {grant}
                </li>
              ))}
            </ul>
            <p className="text-fg-muted">{ADD_COPY.stillCant}</p>
          </div>
          {app === 'manual' ? (
            <div className="flex flex-col gap-(--cue-space-1)">
              <span className="text-(length:--cue-text-ui) text-fg-subtle">{ADD_COPY.whereLabel}</span>
              <p className="text-fg">{ADD_COPY.whereManual(appWord)}</p>
            </div>
          ) : null}
          {said === null ? null : (
            <p role="status" className="text-fg">
              {said}
            </p>
          )}
          {waiting === null ? null : (
            <ChangePreview
              key={waiting.approvalId}
              change={waiting}
              onDone={(result) => {
                if (result === 'cancelled') {
                  setWaiting(null);
                  setStep('parts');
                  setProblem(null);
                  setSaid(MCP_COPY.cancelled);
                  return;
                }
                setOpened(true);
              }}
              inApp={
                approveHere
                  ? {
                      title: ADD_COPY.askTitle(name),
                      approve: MCP_COPY.approve,
                      call: { ...(asked as ConnectionAddCall), appApproval: waiting.approvalId },
                      failed: ADD_COPY.notAdded,
                      onApproved: (result) => {
                        setWaiting(null);
                        setAdded(readAdded(result.data));
                        setStep('done');
                      },
                      onVoid: () => {
                        setWaiting(null);
                        void prepare(true);
                      },
                    }
                  : undefined
              }
            />
          )}
          <Problem problem={problem} />
          {opened ? (
            <div className="flex flex-col gap-(--cue-space-2)">
              <p className="text-fg-muted">{app === 'manual' ? ADD_COPY.terminalManual : ADD_COPY.terminalKnown}</p>
              <Actions>
                <Button onClick={() => onFinished(null)}>{ADD_COPY.terminalDone}</Button>
              </Actions>
            </div>
          ) : (
            <>
              <p className="text-(length:--cue-text-ui) text-fg-subtle">{after}</p>
              {approveHere ? null : <p className="text-(length:--cue-text-ui) text-fg-subtle">{ADD_COPY.elsewhere}</p>}
              <Actions>
                <Button variant="ghost" disabled={busy} onClick={back}>
                  {ADD_COPY.back}
                </Button>
              </Actions>
            </>
          )}
        </Card>
      ) : null}

      {step === 'done' && added !== null && app !== null ? (
        <Card title={ADD_COPY.doneTitle(added.connection === null ? name : nameOf(added.connection))}>
          <p role="status" className="rounded-control bg-ok-soft px-(--cue-space-3) py-(--cue-space-2) text-fg">
            {app === 'manual'
              ? ADD_COPY.doneManual(appWord)
              : place === 'project'
                ? ADD_COPY.doneProject(shownFolderName)
                : ADD_COPY.doneKnown(appWord)}
          </p>
          {app === 'manual' ? (
            <>
              <ol className="flex list-decimal flex-col gap-(--cue-space-1) ps-(--cue-space-5)">
                {ADD_COPY.howManual(appWord).map((line) => (
                  <li key={line} className="text-fg">
                    {line}
                  </li>
                ))}
              </ol>
              {added.snippets === null ? null : <Snippets snippets={added.snippets} />}
            </>
          ) : (
            <>
              {added.connection === null ? null : (
                <p className="text-fg-muted">{writtenLine(added.connection, home)}</p>
              )}
              {added.verification === 'failed' ? (
                <p role="alert" className="text-warn">
                  <UntrustedText text={ADD_COPY.notStarted(added.verifyDetail ?? '')} />
                </p>
              ) : null}
              <p className="text-fg-muted">{ADD_COPY.nothingToPaste(appWord)}</p>
            </>
          )}
          <KeyWhy name={added.connection === null ? name : nameOf(added.connection)} />
          <Actions>
            <Button
              variant="primary"
              onClick={() => onFinished({ name: added.connection === null ? name : nameOf(added.connection), app })}
            >
              {ADD_COPY.done}
            </Button>
            {added.connection === null ? null : (
              <Button onClick={() => onOpen(added.connection?.id ?? '')}>{ADD_COPY.openIt}</Button>
            )}
            <Button variant="ghost" onClick={reset}>
              {ADD_COPY.again}
            </Button>
          </Actions>
        </Card>
      ) : null}

      <p className="text-(length:--cue-text-ui) text-fg-subtle">{ADD_COPY.footer}</p>
    </section>
  );
}

/** One step's card: its question, what it means, and its body. */
function Card({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
      <div className="flex flex-col gap-(--cue-space-1)">
        <h3 className="font-semibold text-fg">{title}</h3>
        {lead === undefined ? null : <p className="text-(length:--cue-text-ui) text-fg-subtle">{lead}</p>}
      </div>
      {children}
    </Panel>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-(--cue-space-2)">{children}</div>;
}

function Problem({ problem }: { problem: { message: string; hint: string | null } | null }) {
  if (problem === null) return null;
  return (
    <div className="flex flex-col gap-(--cue-space-1)">
      <p role="alert" className="text-danger">
        <UntrustedText text={problem.message} />
      </p>
      {problem.hint === null ? null : (
        <p className="text-fg-muted">
          <UntrustedText text={problem.hint} />
        </p>
      )}
    </div>
  );
}

/** Another connection in the same place, said beside the choice, with a way to open it instead. */
function Duplicate({ text, other, onOpen }: { text: string; other: ConnectionView; onOpen: (id: string) => void }) {
  return (
    <div
      role="note"
      className="flex flex-col items-start gap-(--cue-space-1) rounded-control bg-warn-soft px-(--cue-space-3) py-(--cue-space-2)"
    >
      <span className="text-fg">{text}</span>
      <Button size="sm" variant="ghost" onClick={() => onOpen(other.id)}>
        {ADD_COPY.openOther(nameOf(other))}
      </Button>
    </div>
  );
}
