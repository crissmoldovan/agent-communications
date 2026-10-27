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
  installServers,
  lastUsedByApp,
  readChannels,
  readUpdateCheck,
  recentWindows,
  SERVER_LABELS,
  serverNames,
  type UpdateCheckView,
} from '../connections.ts';
import { needsLine, type Screen } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { atLeast, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { MCP_SERVERS, type McpClient, type McpServer } from '../ipc.ts';
import { McpConnections } from './connections/McpConnections.tsx';
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
  title: 'MCP connections',
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
  /** Bring everything up to date (0.34.0): `update`, approved in the app, for every app at once. */
  bringUpToDate: 'Bring everything up to date',
  bringLead:
    'Updates Agent Comms for every app on this Mac at once. What agents may do in each account stays as it is.',
  updateTitle: 'Bring Agent Comms up to date for every app? Approve it',
  approveAndUpdate: 'Approve and update',
  updated: 'Everything was brought up to date. Restart your apps to use it.',
  alreadyUpToDate: 'Everything is up to date already.',
  updateCancelled: 'Cancelled: nothing was changed.',
  updateConfirm: 'Confirm it in Terminal, then restart your apps to use it.',
  /** The test build changes nothing, and `update` is refused there: the button is shown, and cannot be pressed. */
  updateNotHere: 'The test build brings nothing up to date: use your own Agent Comms for that.',
  prepareAgain: 'That approval could no longer be used, so it was prepared again: approve this one.',
} as const;

/**
 * The test build's banner (0.34.0): its core is the test profile's, but the apps start the person's real Agent Comms,
 * and the configs it would write are the person's real ones.
 */
export const testBanner = (version: string | null) =>
  `Test build: your apps start your real Agent Comms${version === null ? '' : ` (${version})`}, not this test, and nothing can be changed here.`;

/** What `update --check` could not say. */
const checkFailedLine = (message: string) =>
  `Whether your apps start the latest Agent Comms could not be checked: ${message}`;
const notUpdatedLine = (message: string) => `Nothing was brought up to date: ${message}`;
const unfinishedUpdateLine = (status: string | null) =>
  `Not everything was brought up to date${status === null ? '' : ` (${status})`}. Doctor says what to do.`;

const whichParts = (app: string) => `${app}: which parts?`;
const removedLine = (server: string, app: string) =>
  `${server} was taken away from ${app}. Restart ${app} to see the change.`;
const notRemovedLine = (server: string, app: string) => `${server} was not taken away from ${app}`;
/** The lines of an addition: `servers` is one name or several ("Gmail and Slack"), and `several` says which. */
const addTitle = (servers: string, app: string) => `Add ${servers} to ${app}`;
const addedLine = (servers: string, app: string, several = false) =>
  `${servers} ${several ? 'were' : 'was'} added to ${app}. Restart ${app} to use it.`;
const notAddedLine = (servers: string, app: string, several = false) =>
  `${servers} ${several ? 'were' : 'was'} not added to ${app}`;
const cancelledLine = (servers: string, app: string, several = false) =>
  `Cancelled: ${servers} ${several ? 'were' : 'was'} not added to ${app}.`;
const confirmLine = (app: string) => `Confirm it in Terminal, then restart ${app} to use it.`;
const unfinishedLine = (servers: string, app: string, why: string | null) =>
  `${servers} ${servers.includes(' and ') ? 'were' : 'was'} not fully added to ${app}${why === null ? '' : `: ${why}`}. Doctor says what to do.`;
const removeNeedsLine = (installed: string | null) =>
  `Taking a part away ${needsLine(MCP_UNINSTALL_VERSION, installed).replace(/^Needs/, 'needs')}`;

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/** What a save came to, said under the table: a line, or what core refused and its hint. */
type Said = { tone: 'ok'; text: string } | { tone: 'refused'; text: string; hint: string | null };

/**
 * An addition waiting for the person's approval: its servers — one, or from core 0.34.0 several in one approval — its
 * preview, and whether Terminal was opened for it.
 */
interface Adding {
  client: McpClient;
  servers: McpServer[];
  change: Waiting;
  opened: boolean;
}

/**
 * Connections (0.32.0, spec §3.3): the apps on this machine by the servers each has, from core's `channels`; when each
 * was last used, as its windows reported; who can reach the servers; and the agent windows used recently. Change… (or
 * Add…) ticks an app's servers: one unticked is taken away at once (`mcp uninstall`, a tightening); the ticked ones are
 * asked for (`mcp install`, from core 0.34.0 all of them in one approval), and wait for the person's approval, as
 * every change the app prepares does (DA10). Nothing is added without it.
 *
 * From core 0.34.0 the entries that start an older Agent Comms are `update --check`'s answer, said in plain words, and
 * Bring everything up to date runs `update`, approved in the app. The test build only shows, under its banner.
 */
export function Connections({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const { installation } = useAppData();
  const version = installation.state === 'ready' ? installation.value.version : null;
  // From core 0.35.0, MCP connections (single-server design §11): each place an app uses Agent Comms. Before it, the
  // table of apps by server, as 0.34.0 showed it.
  return supports(version, 'connections') ? (
    <McpConnections onScreen={onScreen} />
  ) : (
    <AppsByServer onScreen={onScreen} />
  );
}

/**
 * Connections before core 0.35.0 (0.32.0, spec §3.3): the apps on this machine by the servers each has, from core's
 * `channels`; when each was last used, as its windows reported; who can reach the servers; and the agent windows used
 * recently.
 */
function AppsByServer({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const { installation } = useAppData();
  const ready = installation.state === 'ready' ? installation.value : null;
  const version = ready?.version ?? null;
  const home = ready?.home ?? null;
  const activity = supports(version, 'activity');
  const channels = useCall<unknown>({ kind: 'channels' });
  const sessions = useCall<unknown>(activity ? { kind: 'activitySessions', since: '30d' } : null);
  // What is behind npm's latest release (0.34.0). It asks the registry, so it is read when the screen opens and after a
  // change here, and not each time the window comes back.
  const updates = supports(version, 'bringUpToDate');
  const checked = useCall<unknown>(updates ? { kind: 'updateCheck' } : null);
  useReloadOnReturn(async () => {
    await Promise.all([channels.reload(), sessions.reload()]);
  });

  const check = useMemo((): Loadable<UpdateCheckView> | null => {
    if (!updates) return null;
    if (checked.result.state !== 'ready') return checked.result;
    const read = readUpdateCheck(checked.result.value);
    return read === null
      ? { state: 'error', message: 'its answer could not be read' }
      : { state: 'ready', value: read };
  }, [updates, checked.result]);
  const view = useMemo((): Loadable<ConnectionsView> => {
    if (channels.result.state !== 'ready') return channels.result;
    const read = readChannels(channels.result.value, home, check?.state === 'ready' ? check.value : null);
    return read === null ? { state: 'error', message: CONNECTIONS_COPY.notRead } : { state: 'ready', value: read };
  }, [channels.result, home, check]);
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
              several={supports(version, 'severalServers')}
              check={check}
              reload={channels.reload}
              recheck={checked.reload}
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

/**
 * The table, the editor of the app being changed, what the last save came to, Bring everything up to date, and the
 * configs core could not read.
 */
function Apps({
  view,
  lastUsed,
  canRemove,
  approveHere,
  readOnly,
  installed,
  several,
  check,
  reload,
  recheck,
}: {
  view: ConnectionsView;
  lastUsed: Partial<Record<McpClient, string>>;
  canRemove: boolean;
  /** Whether core takes the app's own approval of an install (0.32.0); before it, Approve in Terminal. */
  approveHere: boolean;
  /** The test build: the table only, with nothing to change (0.32.0). */
  readOnly: boolean;
  installed: string | null;
  /** Whether core adds several servers in one approval (0.34.0); before it, one approval each. */
  several: boolean;
  /** `update --check`'s answer (0.34.0), or null before core 0.34.0, which has no such read here. */
  check: Loadable<UpdateCheckView> | null;
  reload: () => Promise<void>;
  recheck: () => Promise<void>;
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
      // Then the ones to add, asked for: core answers with what they let agents do, for the person to approve — all of
      // them in one approval from core 0.34.0, and one approval each before it.
      const asks = several && plan.add.length > 1 ? [plan.add] : plan.add.map((server) => [server]);
      for (const servers of asks) {
        const name = serverNames(servers);
        const outcome = await change.run({ kind: 'mcpInstall', client: app.client, server: installServers(servers) });
        if (outcome.state === 'needsTerminal') {
          waiting.push({ client: app.client, servers, change: outcome, opened: false });
        } else if (outcome.state === 'applied') {
          lines.push({ tone: 'ok', text: addedLine(name, app.label, servers.length > 1) });
        } else {
          lines.push({
            tone: 'refused',
            text: `${notAddedLine(name, app.label, servers.length > 1)}: ${outcome.message}`,
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

  const settle = (
    item: Adding,
    result: 'cancelled' | 'opened' | 'void' | 'refused' | { approved: { exit: number; data: unknown } },
  ) => {
    const app = APP_LABELS[item.client];
    const server = serverNames(item.servers);
    const many = item.servers.length > 1;
    const key = item.change.approvalId;
    if (result === 'cancelled') {
      setAdding((current) => current.filter((each) => each.change.approvalId !== key));
      setSaid((current) => [...current, { tone: 'ok', text: cancelledLine(server, app, many) }]);
      return;
    }
    if (result === 'refused') {
      // Said in the preview; what was registered before core stopped shows in the table, read again.
      void reload();
      return;
    }
    if (result === 'void') {
      // The approval is void (0.34.0): prepared again, with a preview of its own, for the person to approve.
      void prepareAgain(item);
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
        ? { tone: 'ok', text: addedLine(server, app, many) }
        : { tone: 'refused', text: unfinishedLine(server, app, why), hint: null },
    ]);
    void reload();
    void recheck();
  };

  const prepareAgain = async (item: Adding) => {
    const key = item.change.approvalId;
    const outcome = await change.run({ kind: 'mcpInstall', client: item.client, server: installServers(item.servers) });
    const app = APP_LABELS[item.client];
    const server = serverNames(item.servers);
    const many = item.servers.length > 1;
    if (outcome.state === 'needsTerminal') {
      setAdding((current) =>
        current.map((each) => (each.change.approvalId === key ? { ...item, change: outcome, opened: false } : each)),
      );
      setSaid((current) => [...current, { tone: 'ok', text: CONNECTIONS_COPY.prepareAgain }]);
      return;
    }
    setAdding((current) => current.filter((each) => each.change.approvalId !== key));
    setSaid((current) => [
      ...current,
      outcome.state === 'applied'
        ? { tone: 'ok', text: addedLine(server, app, many) }
        : { tone: 'refused', text: `${notAddedLine(server, app, many)}: ${outcome.message}`, hint: outcome.hint },
    ]);
    void reload();
  };

  return (
    <div className="flex flex-col gap-(--cue-space-4)">
      {readOnly ? (
        <p role="note" className="rounded-control bg-warn/10 px-(--cue-space-3) py-(--cue-space-2) text-warn">
          {testBanner(view.started)}
        </p>
      ) : null}
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
      {check === null ? null : (
        <UpToDate
          check={check}
          readOnly={readOnly}
          here={approveHere}
          onChanged={async () => {
            await Promise.all([reload(), recheck()]);
          }}
        />
      )}
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

/**
 * An app's name, and under it where its entries reach and when it was last used, as its windows reported; and, from
 * core 0.34.0, whether it starts an older Agent Comms, by `update --check`.
 */
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
      {app.older === null ? null : (
        <span data-slot="app-older" className="text-(length:--cue-text-ui) text-warn">
          {app.older}
        </span>
      )}
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
 * One addition waiting — a server, or from core 0.34.0 several in one approval: core's preview of what they let agents
 * do, with its confirm and Cancel. Approved here, in the app (0.32.0, DA10's note of 2026-10-26): only the person's
 * press of Approve and add answers the approval, through core's app channel, for this install alone. On an older core
 * it is Approve in Terminal, as before. An approval core calls void is prepared again (0.34.0).
 */
function AddPreview({
  item,
  here,
  onDone,
}: {
  item: Adding;
  here: boolean;
  onDone: (result: 'cancelled' | 'opened' | 'void' | 'refused' | { approved: { exit: number; data: unknown } }) => void;
}) {
  const app = APP_LABELS[item.client];
  const server = serverNames(item.servers);
  const many = item.servers.length > 1;
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
                  server: installServers(item.servers),
                  approvalId: item.change.approvalId,
                },
                failed: (message) => `${notAddedLine(server, app, many)}: ${message}`,
                onApproved: (result) => onDone({ approved: result }),
                onVoid: () => onDone('void'),
                onRefused: () => onDone('refused'),
              }
            : undefined
        }
      />
      {item.opened ? <p className="text-fg-muted">{confirmLine(app)}</p> : null}
    </section>
  );
}

/**
 * Bring everything up to date (0.34.0): shown when `update --check` finds anything behind npm's latest release. It
 * prepares `update`, whose preview the person approves in the app (`updateApproved`), or in Terminal where nothing
 * attests the app; an approval core calls void is prepared again. The test build shows it and cannot press it: core
 * refuses it there, since it would register the person's real apps again.
 */
export function UpToDate({
  check,
  readOnly,
  here,
  onChanged,
}: {
  check: Loadable<UpdateCheckView>;
  readOnly: boolean;
  /** Whether the app approves it here (macOS); elsewhere, Approve in Terminal. */
  here: boolean;
  onChanged: () => Promise<void>;
}) {
  const change = useChange();
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [opened, setOpened] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);

  const prepare = async (again = false) => {
    setBusy(true);
    setSaid(null);
    setOpened(false);
    try {
      const outcome = await change.run({ kind: 'update' });
      if (outcome.state === 'needsTerminal') {
        setWaiting(outcome);
        if (again) setSaid({ tone: 'ok', text: CONNECTIONS_COPY.prepareAgain });
        return;
      }
      setWaiting(null);
      setSaid(
        outcome.state === 'applied'
          ? { tone: 'ok', text: CONNECTIONS_COPY.alreadyUpToDate }
          : { tone: 'refused', text: notUpdatedLine(outcome.message), hint: outcome.hint },
      );
      if (outcome.state === 'applied') await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const approved = (result: { exit: number; data: unknown }) => {
    setWaiting(null);
    const data = result.data as { ok?: unknown; status?: unknown } | null;
    const done = result.exit === 0 && data?.ok !== false;
    setSaid(
      done
        ? { tone: 'ok', text: CONNECTIONS_COPY.updated }
        : {
            tone: 'refused',
            text: unfinishedUpdateLine(typeof data?.status === 'string' ? data.status : null),
            hint: null,
          },
    );
    void onChanged();
  };

  if (check.state === 'loading') return null;
  if (check.state === 'error') {
    return (
      <p className="text-(length:--cue-text-ui) text-fg-subtle">
        <UntrustedText text={checkFailedLine(check.message)} />
      </p>
    );
  }
  if (!check.value.anyBehind && waiting === null && said === null) return null;
  return (
    <section aria-label={CONNECTIONS_COPY.bringUpToDate} className="flex flex-col gap-(--cue-space-2)">
      {check.value.anyBehind && waiting === null ? (
        <div className="flex flex-wrap items-center gap-(--cue-space-2) rounded-control bg-warn/10 px-(--cue-space-3) py-(--cue-space-2)">
          <Button size="sm" variant="primary" loading={busy} disabled={readOnly} onClick={() => void prepare()}>
            {CONNECTIONS_COPY.bringUpToDate}
          </Button>
          <span className="text-fg-muted">
            {readOnly ? CONNECTIONS_COPY.updateNotHere : CONNECTIONS_COPY.bringLead}
          </span>
        </div>
      ) : null}
      {waiting === null || readOnly ? null : (
        <ChangePreview
          key={waiting.approvalId}
          change={waiting}
          onDone={(result) => {
            if (result === 'cancelled') {
              setWaiting(null);
              setSaid({ tone: 'ok', text: CONNECTIONS_COPY.updateCancelled });
            } else {
              setOpened(true);
            }
          }}
          inApp={
            here
              ? {
                  title: CONNECTIONS_COPY.updateTitle,
                  approve: CONNECTIONS_COPY.approveAndUpdate,
                  call: { kind: 'updateApproved', approvalId: waiting.approvalId },
                  failed: notUpdatedLine,
                  onApproved: approved,
                  onVoid: () => void prepare(true),
                  onRefused: () => void onChanged(),
                }
              : undefined
          }
        />
      )}
      {opened ? <p className="text-fg-muted">{CONNECTIONS_COPY.updateConfirm}</p> : null}
      {said === null ? null : said.tone === 'ok' ? (
        <p role="status" className="text-fg">
          {said.text}
        </p>
      ) : (
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
      )}
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
