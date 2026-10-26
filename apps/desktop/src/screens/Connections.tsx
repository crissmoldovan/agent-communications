import { Button, Checkbox, CheckboxGroup, Chip, Table } from '@cueplusplus/ui';
import { useId, useMemo, useState } from 'react';
import { readSessions, type SessionView } from '../activity.ts';
import { useAppBuild } from '../app-build.ts';
import { useBridge } from '../bridge-context.tsx';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { setupsAtTerminal } from '../components/DoInTerminal.tsx';
import { NeedsNewerCli } from '../components/NeedsNewerCli.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { Ago } from '../components/When.tsx';
import {
  APP_LABELS,
  type AppRow,
  type Cell,
  type ConnectionsView,
  changePlan,
  lastUsedByApp,
  readChannels,
  recentWindows,
  SERVER_LABELS,
} from '../connections.ts';
import { needsLine, type Screen } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { atLeast, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { MCP_SERVERS, type McpClient, type McpServer } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/** The first core with `mcp uninstall` (`connections.rs`, `MCP_UNINSTALL_VERSION`). */
export const MCP_UNINSTALL_VERSION = '0.32.0';

/**
 * The first core whose `mcp install` takes the app's own approval (`connections.rs`, `MCP_APP_APPROVAL_VERSION`): an
 * older one is approved in Terminal, as before.
 */
export const MCP_APP_APPROVAL_VERSION = '0.32.0';

/** The screen's words (the prototype's, row 5, screen 1). */
export const CONNECTIONS_COPY = {
  title: 'Connections',
  intro:
    'The apps on this Mac that can use Agent Comms, and which parts each one has. An app sees a change after you restart it.',
  apps: 'Apps',
  tableCaption: 'Apps, and the parts each one has',
  everyFolder: 'Every folder',
  someFolders: 'Some folders',
  notConnected: 'Not connected',
  lastUsedNote:
    '“Used” is the last time a window of that app used an account here, going by the name the window reported for itself.',
  change: 'Change…',
  add: 'Add…',
  editHint: 'Removing a part applies at once. Adding one shows you what it lets agents do, first.',
  /** The header over core's preview of an addition, approved here. */
  approveHere: 'What this lets agents do',
  approveAndAdd: 'Approve and add',
  save: 'Save',
  cancel: 'Cancel',
  unreadable: 'Settings that could not be read, so what they hold is not known',
  reach: 'Who can reach them',
  yesLine:
    'Agent windows on this Mac, in the apps above. That includes a Claude Code window on this Mac that you drive from your phone with Remote Control.',
  noLine:
    'Cloud sessions, such as Claude on the web or Claude Code in the cloud. They run on other computers, and these servers run only on this Mac.',
  recent: 'Used recently',
  seeActivity: 'See Activity ›',
  noRecent: 'No agent window has used an account here in the last 30 days.',
  notRead: "Core's answer about its servers could not be read.",
  /** The test build's line: its core is the test profile's, but the configs it would write are the person's real ones. */
  testBuildOnly: "In the test build, Connections only shows. Changing it would edit your real apps' settings.",
} as const;

const whichParts = (app: string) => `${app}: which parts?`;
const removedLine = (server: string, app: string) =>
  `${server} was taken away from ${app}. Restart ${app} to see the change.`;
const notRemovedLine = (server: string, app: string) => `${server} was not taken away from ${app}`;
const addTitle = (server: string, app: string) => `Add ${server} to ${app}`;
const addedLine = (server: string, app: string) => `${server} was added to ${app}. Restart ${app} to use it.`;
const notAddedLine = (server: string, app: string) => `${server} was not added to ${app}`;
const cancelledLine = (server: string, app: string) => `Cancelled: ${server} was not added to ${app}.`;
const confirmLine = (app: string) => `Confirm it in Terminal, then restart ${app} to use it.`;
const unfinishedLine = (server: string, app: string, why: string | null) =>
  `${server} was not fully added to ${app}${why === null ? '' : `: ${why}`}. Doctor says what to do.`;
const removeNeedsLine = (installed: string | null) =>
  `Taking a part away ${needsLine(MCP_UNINSTALL_VERSION, installed).replace(/^Needs/, 'needs')}`;

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/** What a save came to, said under the table: a line, or what core refused and its hint. */
type Said = { tone: 'ok'; text: string } | { tone: 'refused'; text: string; hint: string | null };

/** An addition waiting for the person's approval: its preview, and whether Terminal was opened for it. */
interface Adding {
  client: McpClient;
  server: McpServer;
  change: Waiting;
  opened: boolean;
}

/**
 * Connections (0.32.0, spec §3.3): the apps on this machine by the servers each has, from core's `channels`; when each
 * was last used, as its windows reported; who can reach the servers; and the agent windows used recently. Change… (or
 * Add…) ticks an app's servers: one unticked is taken away at once (`mcp uninstall`, a tightening); one ticked is
 * asked for (`mcp install`), and waits for the person's approval in Terminal, as every change the app prepares does
 * (DA10). Nothing is added without it.
 */
export function Connections({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const { installation } = useAppData();
  const ready = installation.state === 'ready' ? installation.value : null;
  const version = ready?.version ?? null;
  const home = ready?.home ?? null;
  const activity = supports(version, 'activity');
  const channels = useCall<unknown>({ kind: 'channels' });
  const sessions = useCall<unknown>(activity ? { kind: 'activitySessions', since: '30d' } : null);
  useReloadOnReturn(async () => {
    await Promise.all([channels.reload(), sessions.reload()]);
  });

  const view = useMemo((): Loadable<ConnectionsView> => {
    if (channels.result.state !== 'ready') return channels.result;
    const read = readChannels(channels.result.value, home);
    return read === null ? { state: 'error', message: CONNECTIONS_COPY.notRead } : { state: 'ready', value: read };
  }, [channels.result, home]);
  const windows = useMemo((): Loadable<SessionView[]> => {
    if (sessions.result.state !== 'ready') return sessions.result;
    const read = readSessions(sessions.result.value);
    return read === null
      ? { state: 'error', message: 'The agent windows could not be read.' }
      : { state: 'ready', value: read.sessions };
  }, [sessions.result]);
  const lastUsed = activity && windows.state === 'ready' ? lastUsedByApp(windows.value) : {};
  // The test build changes no app's settings (0.32.0): its core would write the person's real client configs. Rust
  // refuses the calls there too; here there is nothing to press.
  const readOnly = useAppBuild()?.isTest === true;

  return (
    <ScreenFrame title={CONNECTIONS_COPY.title}>
      <p className="text-fg-muted">{CONNECTIONS_COPY.intro}</p>
      <SectionPanel title={CONNECTIONS_COPY.apps}>
        <ScreenState value={view}>
          {(value) => (
            <Apps
              view={value}
              lastUsed={lastUsed}
              canRemove={atLeast(version, MCP_UNINSTALL_VERSION)}
              // Where nothing attests the app as the person's (Windows and Linux), core takes no approval from it (0.33.0):
              // an install is approved in the terminal there, as before 0.32.0.
              approveHere={atLeast(version, MCP_APP_APPROVAL_VERSION) && !setupsAtTerminal()}
              readOnly={readOnly}
              installed={version}
              reload={channels.reload}
            />
          )}
        </ScreenState>
      </SectionPanel>
      <SectionPanel title={CONNECTIONS_COPY.reach}>
        <div className="flex flex-col gap-(--cue-space-2)">
          <div className="flex items-start gap-(--cue-space-2)">
            <Chip tone="ok" variant="tinted">
              Yes
            </Chip>
            <p className="text-fg">{CONNECTIONS_COPY.yesLine}</p>
          </div>
          <div className="flex items-start gap-(--cue-space-2)">
            <Chip tone="neutral" variant="tinted">
              No
            </Chip>
            <p className="text-fg">{CONNECTIONS_COPY.noLine}</p>
          </div>
        </div>
      </SectionPanel>
      <SectionPanel
        title={CONNECTIONS_COPY.recent}
        actions={
          <Button size="sm" variant="ghost" onClick={() => onScreen('activity')}>
            {CONNECTIONS_COPY.seeActivity}
          </Button>
        }
      >
        {activity ? (
          <ScreenState value={windows}>{(value) => <Recent sessions={value} />}</ScreenState>
        ) : (
          <NeedsNewerCli feature="activity" installed={version} />
        )}
      </SectionPanel>
    </ScreenFrame>
  );
}

/** The table, the editor of the app being changed, what the last save came to, and the configs core could not read. */
function Apps({
  view,
  lastUsed,
  canRemove,
  approveHere,
  readOnly,
  installed,
  reload,
}: {
  view: ConnectionsView;
  lastUsed: Partial<Record<McpClient, string>>;
  canRemove: boolean;
  /** Whether core takes the app's own approval of an install (0.32.0); before it, Approve in Terminal. */
  approveHere: boolean;
  /** The test build: the table only, with nothing to change (0.32.0). */
  readOnly: boolean;
  installed: string | null;
  reload: () => Promise<void>;
}) {
  const bridge = useBridge();
  const change = useChange();
  const [editing, setEditing] = useState<McpClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said[]>([]);
  const [adding, setAdding] = useState<Adding[]>([]);
  const row = view.apps.find((each) => each.client === editing) ?? null;

  const save = async (app: AppRow, ticked: readonly McpServer[]) => {
    const plan = changePlan(app, ticked);
    if (plan.add.length === 0 && plan.remove.length === 0) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setSaid([]);
    const lines: Said[] = [];
    const waiting: Adding[] = [];
    try {
      // Taking away first: each is a tightening, applied at once.
      for (const server of plan.remove) {
        const name = SERVER_LABELS[server];
        const outcome = await change.run({ kind: 'mcpUninstall', client: app.client, server });
        if (outcome.state === 'applied') {
          lines.push({ tone: 'ok', text: removedLine(name, app.label) });
        } else if (outcome.state === 'failed') {
          lines.push({
            tone: 'refused',
            text: `${notRemovedLine(name, app.label)}: ${outcome.message}`,
            hint: outcome.hint,
          });
        } else {
          // A removal is never one to approve: what came back waiting is not done, and its approval is not left behind.
          lines.push({ tone: 'refused', text: `${notRemovedLine(name, app.label)}.`, hint: null });
          await bridge.cli({ kind: 'approvalRevoke', approvalId: outcome.approvalId }).catch(() => undefined);
        }
      }
      // Then each one to add, asked for: core answers with what it lets agents do, for the person to approve.
      for (const server of plan.add) {
        const name = SERVER_LABELS[server];
        const outcome = await change.run({ kind: 'mcpInstall', client: app.client, server });
        if (outcome.state === 'needsTerminal') {
          waiting.push({ client: app.client, server, change: outcome, opened: false });
        } else if (outcome.state === 'applied') {
          lines.push({ tone: 'ok', text: addedLine(name, app.label) });
        } else {
          lines.push({
            tone: 'refused',
            text: `${notAddedLine(name, app.label)}: ${outcome.message}`,
            hint: outcome.hint,
          });
        }
      }
    } finally {
      setSaid(lines);
      setAdding((current) => [...current, ...waiting]);
      setEditing(null);
      setBusy(false);
    }
    await reload();
  };

  const settle = (item: Adding, result: 'cancelled' | 'opened' | { approved: { exit: number; data: unknown } }) => {
    const app = APP_LABELS[item.client];
    const server = SERVER_LABELS[item.server];
    const key = item.change.approvalId;
    if (result === 'cancelled') {
      setAdding((current) => current.filter((each) => each.change.approvalId !== key));
      setSaid((current) => [...current, { tone: 'ok', text: cancelledLine(server, app) }]);
      return;
    }
    if (result === 'opened') {
      setAdding((current) =>
        current.map((each) => (each.change.approvalId === key ? { ...each, opened: true } : each)),
      );
      return;
    }
    // Approved here and applied: said, and the table read again. An install that ended unfinished says so.
    setAdding((current) => current.filter((each) => each.change.approvalId !== key));
    const data = result.approved.data as { notApplied?: unknown } | null;
    const why = typeof data?.notApplied === 'string' ? data.notApplied : null;
    setSaid((current) => [
      ...current,
      result.approved.exit === 0
        ? { tone: 'ok', text: addedLine(server, app) }
        : { tone: 'refused', text: unfinishedLine(server, app, why), hint: null },
    ]);
    void reload();
  };

  return (
    <div className="flex flex-col gap-(--cue-space-4)">
      <Table.Root>
        <Table.Caption className="sr-only">{CONNECTIONS_COPY.tableCaption}</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head>App</Table.Head>
            {MCP_SERVERS.map((server) => (
              <Table.Head key={server} className="text-center">
                {SERVER_LABELS[server]}
              </Table.Head>
            ))}
            {readOnly ? null : (
              <Table.Head>
                <span className="sr-only">Actions</span>
              </Table.Head>
            )}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {view.apps.map((app) => (
            <Table.Row key={app.client}>
              <Table.Cell>
                <AppName app={app} lastUsed={lastUsed[app.client]} />
              </Table.Cell>
              {MCP_SERVERS.map((server) => (
                <Table.Cell key={server} className="text-center">
                  <CellMark cell={app.cells[server]} />
                </Table.Cell>
              ))}
              {readOnly ? null : (
                <Table.Cell className="text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-expanded={editing === app.client}
                    onClick={() => setEditing(app.client)}
                  >
                    {app.servers.length === 0 ? CONNECTIONS_COPY.add : CONNECTIONS_COPY.change}
                  </Button>
                </Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <p className="text-(length:--cue-text-ui) text-fg-subtle">{CONNECTIONS_COPY.lastUsedNote}</p>
      {readOnly ? <p className="text-warn">{CONNECTIONS_COPY.testBuildOnly}</p> : null}
      {row === null || readOnly ? null : (
        <Editor
          key={row.client}
          app={row}
          busy={busy}
          canRemove={canRemove}
          installed={installed}
          onCancel={() => setEditing(null)}
          onSave={(ticked) => void save(row, ticked)}
        />
      )}
      {said.length === 0 ? null : (
        <div className="flex flex-col gap-(--cue-space-2)">
          {said.map((line) =>
            line.tone === 'ok' ? (
              <p key={line.text} role="status" className="text-fg">
                {line.text}
              </p>
            ) : (
              <div key={line.text} className="flex flex-col gap-(--cue-space-1)">
                <p role="alert" className="text-danger">
                  <UntrustedText text={line.text} />
                </p>
                {line.hint === null ? null : (
                  <p className="text-fg-muted">
                    <UntrustedText text={line.hint} />
                  </p>
                )}
              </div>
            ),
          )}
        </div>
      )}
      {adding.map((item) => (
        <AddPreview
          key={item.change.approvalId}
          item={item}
          here={approveHere}
          onDone={(result) => settle(item, result)}
        />
      ))}
      {view.unreadable.length === 0 ? null : <Unreadable view={view} />}
    </div>
  );
}

/** An app's name, and under it where its entries reach and when it was last used, as its windows reported. */
function AppName({ app, lastUsed }: { app: AppRow; lastUsed: string | undefined }) {
  const reach =
    app.reach === 'every-folder'
      ? CONNECTIONS_COPY.everyFolder
      : app.reach === 'some-folders'
        ? CONNECTIONS_COPY.someFolders
        : CONNECTIONS_COPY.notConnected;
  return (
    <div className="flex flex-col">
      <span data-slot="app-name" className="font-medium text-fg">
        {app.label}
      </span>
      <span className="text-(length:--cue-text-ui) text-fg-subtle">
        {reach}
        {lastUsed === undefined ? null : (
          <>
            {' · used '}
            <Ago at={lastUsed} />
          </>
        )}
      </span>
    </div>
  );
}

/** One cell: a tick, a dash for none, and any note under it. A note alone says the entry there needs looking at. */
function CellMark({ cell }: { cell: Cell }) {
  if (!cell.registered) {
    return (
      <span className="text-fg-subtle">
        <span aria-hidden="true">–</span>
        <span className="sr-only">No</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-center gap-(--cue-space-1)">
      {cell.ok ? (
        <span className="font-semibold text-ok">
          <span aria-hidden="true">✓</span>
          <span className="sr-only">Yes</span>
        </span>
      ) : null}
      {cell.notes.map((note) => (
        <span key={note} className={`text-(length:--cue-text-ui) ${cell.ok ? 'text-fg-subtle' : 'text-warn'}`}>
          {note}
        </span>
      ))}
    </span>
  );
}

/** One app's servers, as boxes to tick: Save takes away the unticked and asks for the ticked. */
function Editor({
  app,
  busy,
  canRemove,
  installed,
  onCancel,
  onSave,
}: {
  app: AppRow;
  busy: boolean;
  canRemove: boolean;
  installed: string | null;
  onCancel: () => void;
  onSave: (ticked: McpServer[]) => void;
}) {
  const heading = useId();
  const [ticked, setTicked] = useState<McpServer[]>(app.servers);
  return (
    <fieldset
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-(--cue-space-3) rounded-surface bg-surface-2 px-(--cue-space-4) py-(--cue-space-3)"
    >
      <p id={heading} className="font-medium text-fg">
        {whichParts(app.label)}
      </p>
      <CheckboxGroup
        aria-label="Parts"
        className="grid grid-cols-3 gap-(--cue-space-2)"
        value={ticked}
        onValueChange={(value) => setTicked(MCP_SERVERS.filter((server) => value.includes(server)))}
      >
        {MCP_SERVERS.map((server) => (
          <Checkbox
            key={server}
            value={server}
            label={SERVER_LABELS[server]}
            // A core without `mcp uninstall` cannot take one away: what is there stays ticked.
            disabled={busy || (!canRemove && app.servers.includes(server))}
          />
        ))}
      </CheckboxGroup>
      {canRemove ? null : <p className="text-fg-muted">{removeNeedsLine(installed)}</p>}
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <p className="text-(length:--cue-text-ui) text-fg-subtle">{CONNECTIONS_COPY.editHint}</p>
        <span className="ms-auto flex gap-(--cue-space-2)">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {CONNECTIONS_COPY.cancel}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onSave(ticked)}>
            {CONNECTIONS_COPY.save}
          </Button>
        </span>
      </div>
    </fieldset>
  );
}

/**
 * One server to add, waiting: core's preview of what it lets agents do, with its confirm and Cancel. Approved here, in
 * the app (0.32.0, DA10's note of 2026-10-26): only the person's press of Approve and add answers the approval, through
 * core's app channel, for this install alone. On an older core it is Approve in Terminal, as before.
 */
function AddPreview({
  item,
  here,
  onDone,
}: {
  item: Adding;
  here: boolean;
  onDone: (result: 'cancelled' | 'opened' | { approved: { exit: number; data: unknown } }) => void;
}) {
  const app = APP_LABELS[item.client];
  const server = SERVER_LABELS[item.server];
  return (
    <section aria-label={addTitle(server, app)} className="flex flex-col gap-(--cue-space-2)">
      <p className="font-medium text-fg">{addTitle(server, app)}</p>
      <ChangePreview
        change={item.change}
        onDone={(result) => onDone(result === 'cancelled' ? 'cancelled' : 'opened')}
        inApp={
          here
            ? {
                title: CONNECTIONS_COPY.approveHere,
                approve: CONNECTIONS_COPY.approveAndAdd,
                call: {
                  kind: 'mcpInstallApproved',
                  client: item.client,
                  server: item.server,
                  approvalId: item.change.approvalId,
                },
                failed: (message) => `${notAddedLine(server, app)}: ${message}`,
                onApproved: (result) => onDone({ approved: result }),
              }
            : undefined
        }
      />
      {item.opened ? <p className="text-fg-muted">{confirmLine(app)}</p> : null}
    </section>
  );
}

/** The client configs core found and could not read. */
function Unreadable({ view }: { view: ConnectionsView }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1)">
      <p className="text-warn">{CONNECTIONS_COPY.unreadable}:</p>
      <ul aria-label={CONNECTIONS_COPY.unreadable} className="flex flex-col gap-(--cue-space-1)">
        {view.unreadable.map((each) => (
          <li key={`${each.client}\u0000${each.path}`} className="text-fg">
            <span className="font-medium">{each.label}</span>
            {' · '}
            <span className="font-mono text-(length:--cue-text-ui)">{each.path}</span>
            {each.reason === '' ? null : (
              <>
                {' · '}
                <UntrustedText text={each.reason} />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The agent windows used recently: folder, app, channels and when. A name no app gives is shown as it came. */
function Recent({ sessions }: { sessions: readonly SessionView[] }) {
  const windows = recentWindows(sessions);
  if (windows.length === 0) return <p className="text-fg-muted">{CONNECTIONS_COPY.noRecent}</p>;
  return (
    <ul className="flex flex-col gap-(--cue-space-2)">
      {windows.map((window) => (
        <li key={window.key} className="flex flex-wrap items-center gap-(--cue-space-3)">
          <span data-slot="window-folder" className="min-w-0 flex-1 break-words font-mono text-fg">
            {window.folder ?? 'A folder that was not read'}
          </span>
          <span className="text-(length:--cue-text-ui) text-fg-subtle">
            {window.app !== null ? (
              APP_LABELS[window.app]
            ) : window.client !== null ? (
              <UntrustedText text={window.client} />
            ) : (
              'An app that gave no name'
            )}
            {window.channels.length === 0 ? null : ` · ${window.channels.join(', ')}`}
          </span>
          <span className="w-24 text-right text-(length:--cue-text-ui) text-fg-subtle">
            <Ago at={window.at} />
          </span>
        </li>
      ))}
    </ul>
  );
}
