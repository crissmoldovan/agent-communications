import { Button, Chip, Panel, StatusDot } from '@cueplusplus/ui';
import { useMemo, useState } from 'react';
import { useAppBuild } from '../../app-build.ts';
import { setupsAtTerminal } from '../../components/DoInTerminal.tsx';
import { ScreenState } from '../../components/ScreenState.tsx';
import { SectionPanel } from '../../components/SectionPanel.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { Ago } from '../../components/When.tsx';
import { readUpdateCheck, type UpdateCheckView } from '../../connections.ts';
import type { Screen } from '../../copy.ts';
import { type Loadable, useAppData } from '../../data.tsx';
import { supports } from '../../gates.ts';
import { useCall } from '../../hooks/use-call.ts';
import { useReloadOnReturn } from '../../hooks/use-reload-on-return.ts';
import {
  type AccountChoice,
  appName,
  type ChannelsForConnections,
  type ConnectionView,
  countLine,
  nameOf,
  partChips,
  readAccountChoices,
  readConnectionList,
  readMigrated,
  readPartChoices,
  samePlace,
  statusOf,
  whereShort,
} from '../../mcp-connections.ts';
import { UpToDate } from '../Connections.tsx';
import { ScreenFrame } from '../Screen.tsx';
import { AddConnection } from './AddConnection.tsx';
import { AppMark, type Outcome, PrepareAndApprove } from './bits.tsx';
import { ConnectionPage } from './ConnectionPage.tsx';
import { MCP_COPY } from './copy.ts';

type Page = { kind: 'list' } | { kind: 'add' } | { kind: 'one'; id: string };

/** What the list reads, each read into the shape the screen shows. */
interface Reads {
  connections: { connections: ConnectionView[]; problems: string[] };
  channels: ChannelsForConnections;
  accounts: AccountChoice[];
}

/**
 * MCP connections (0.35.0, single-server design §11; the McpServers board): one card per place an app uses Agent
 * Comms, several per app, each with its name, where it is, its parts and accounts, how it stands and when it was last
 * used; Add a connection… step by step; one connection opened on a page of its own; Move to one entry… for the apps
 * that still start Agent Comms as separate entries, approved first, and Undo beside what it moved; and Bring everything
 * up to date, as 0.34.0 offered it. Reads `connection list`, `channels` (the parts, D20), `label` (the accounts a part
 * can be kept to) and `update --check`. The test build only shows.
 */
export function McpConnections({ onScreen }: { onScreen: (screen: Screen) => void }) {
  const { installation } = useAppData();
  const ready = installation.state === 'ready' ? installation.value : null;
  const version = ready?.version ?? null;
  const home = ready?.home ?? null;
  const eventsInstalled = ready?.present.includes('events-daemon') === true;
  const list = useCall<unknown>({ kind: 'connectionList' });
  const channels = useCall<unknown>({ kind: 'channels' });
  const label = useCall<unknown>({ kind: 'label' });
  const updates = supports(version, 'bringUpToDate');
  const checked = useCall<unknown>(updates ? { kind: 'updateCheck' } : null);
  const reload = async () => {
    await Promise.all([list.reload(), channels.reload(), label.reload()]);
  };
  useReloadOnReturn(reload);
  // The test build changes no app's settings: its core would write the person's real client configs (0.32.0). Rust
  // refuses every connection change there too; here there is nothing to press.
  const readOnly = useAppBuild()?.isTest === true;
  // Where nothing attests the app as the person's (Windows and Linux), core takes no approval from it: each loosening is
  // approved in Terminal there, as 0.32–0.34 do.
  const approveHere = !setupsAtTerminal();
  const [page, setPage] = useState<Page>({ kind: 'list' });
  const [said, setSaid] = useState<Outcome | null>(null);
  const [moved, setMoved] = useState<{ id: string; name: string }[]>([]);

  const reads = useMemo((): Loadable<Reads> => {
    if (list.result.state !== 'ready') return list.result;
    if (channels.result.state !== 'ready') return channels.result;
    const connections = readConnectionList(list.result.value);
    if (connections === null) return { state: 'error', message: MCP_COPY.notRead };
    const parts = readPartChoices(channels.result.value);
    if (parts === null) return { state: 'error', message: MCP_COPY.partsNotRead };
    const accounts = label.result.state === 'ready' ? (readAccountChoices(label.result.value) ?? []) : [];
    return { state: 'ready', value: { connections, channels: parts, accounts } };
  }, [list.result, channels.result, label.result]);
  const check = useMemo((): Loadable<UpdateCheckView> | null => {
    if (!updates) return null;
    if (checked.result.state !== 'ready') return checked.result;
    const read = readUpdateCheck(checked.result.value);
    return read === null
      ? { state: 'error', message: 'its answer could not be read' }
      : { state: 'ready', value: read };
  }, [updates, checked.result]);

  const toList = (line: Outcome | null) => {
    setSaid(line);
    setPage({ kind: 'list' });
    void reload();
  };

  return (
    <ScreenFrame title={MCP_COPY.title}>
      <ScreenState value={reads}>
        {(value) => {
          const views = value.connections.connections;
          if (page.kind === 'add' && !readOnly) {
            return (
              <AddConnection
                choices={value.channels.parts}
                accounts={value.accounts}
                existing={views}
                home={home}
                eventsInstalled={eventsInstalled}
                approveHere={approveHere}
                onCancel={() => setPage({ kind: 'list' })}
                onFinished={(added) =>
                  toList(
                    added === null
                      ? null
                      : {
                          tone: 'ok',
                          text: MCP_COPY.addedSaid(added.name, appName(added.app), added.app === 'manual'),
                        },
                  )
                }
                onOpen={(id) => {
                  setPage({ kind: 'one', id });
                  void reload();
                }}
              />
            );
          }
          const one = page.kind === 'one' ? views.find((view) => view.id === page.id) : undefined;
          if (one !== undefined) {
            return (
              <ConnectionPage
                key={one.id}
                view={one}
                choices={value.channels.parts}
                accounts={value.accounts}
                home={home}
                approveHere={approveHere}
                readOnly={readOnly}
                onBack={() => setPage({ kind: 'list' })}
                onGone={(line) => toList({ tone: 'ok', text: line })}
                onChanged={reload}
                onActivity={() => onScreen('activity')}
              />
            );
          }
          return (
            <List
              views={views}
              problems={value.connections.problems}
              standalone={value.channels.standalone.length > 0}
              home={home}
              readOnly={readOnly}
              approveHere={approveHere}
              said={said}
              moved={moved}
              check={check}
              onAdd={() => {
                setSaid(null);
                setPage({ kind: 'add' });
              }}
              onOpen={(id) => {
                setSaid(null);
                setPage({ kind: 'one', id });
              }}
              onSaid={setSaid}
              onMoved={(data) => {
                const result = readMigrated(data);
                setMoved(result.migrated.map((each) => ({ id: each.id, name: each.name })));
                setSaid({
                  tone: 'ok',
                  text: [
                    ...result.migrated.map((each) => MCP_COPY.moved(each.name, each.app, each.replaced)),
                    ...result.left.map((each) => MCP_COPY.left(each.name, each.path, each.why)),
                    MCP_COPY.moveAfter,
                  ].join(' '),
                });
                void reload();
              }}
              onUndone={(name, line) => {
                setMoved((now) => now.filter((each) => each.name !== name));
                setSaid({ tone: 'ok', text: line });
                void reload();
              }}
              reload={reload}
              recheck={checked.reload}
            />
          );
        }}
      </ScreenState>
    </ScreenFrame>
  );
}

function List({
  views,
  problems,
  standalone,
  home,
  readOnly,
  approveHere,
  said,
  moved,
  check,
  onAdd,
  onOpen,
  onSaid,
  onMoved,
  onUndone,
  reload,
  recheck,
}: {
  views: readonly ConnectionView[];
  problems: readonly string[];
  /** Whether any app starts one of our servers on its own, outside a connection: then Move to one entry is offered. */
  standalone: boolean;
  home: string | null;
  readOnly: boolean;
  approveHere: boolean;
  said: Outcome | null;
  moved: readonly { id: string; name: string }[];
  check: Loadable<UpdateCheckView> | null;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onSaid: (said: Outcome) => void;
  onMoved: (data: unknown) => void;
  onUndone: (name: string, line: string) => void;
  reload: () => Promise<void>;
  recheck: () => Promise<void>;
}) {
  const unreadable = views.filter((view) => !view.readable).length;
  return (
    <>
      <div className="flex flex-col gap-(--cue-space-1)">
        <p className="text-fg-muted">{MCP_COPY.sub}</p>
        <p className="text-(length:--cue-text-ui) text-fg-subtle">{MCP_COPY.faint}</p>
      </div>
      {readOnly ? (
        <p role="note" className="rounded-control bg-warn-soft px-(--cue-space-3) py-(--cue-space-2) text-warn">
          {MCP_COPY.testBanner}
        </p>
      ) : null}
      {said === null ? null : said.tone === 'refused' ? (
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
      ) : (
        <p
          role="status"
          className={`rounded-control px-(--cue-space-3) py-(--cue-space-2) text-fg ${said.tone === 'ok' ? 'bg-ok-soft' : 'bg-surface-2'}`}
        >
          <UntrustedText text={said.text} />
        </p>
      )}
      {moved.length === 0 || readOnly ? null : (
        <div className="flex flex-wrap items-start gap-(--cue-space-3)">
          {moved.map((each) => (
            <PrepareAndApprove
              key={each.id}
              button={MCP_COPY.undo}
              buttonLabel={MCP_COPY.undoLabel(each.name)}
              prepare={{ kind: 'connectionMigrateUndo', connectionId: each.id }}
              approve={(approvalId) => ({
                kind: 'connectionMigrateUndo',
                connectionId: each.id,
                appApproval: approvalId,
              })}
              title={MCP_COPY.undoAsk(each.name)}
              approveHere={approveHere}
              failed={MCP_COPY.notMoved}
              onApproved={() => onUndone(each.name, MCP_COPY.undone(each.name))}
              onSaid={onSaid}
            />
          ))}
        </div>
      )}
      {views.length === 0 ? (
        <Panel className="flex flex-col items-start gap-(--cue-space-2) p-(--cue-space-5)">
          <p className="font-semibold text-(length:--cue-text-title) text-fg">{MCP_COPY.helloLine}</p>
          <p className="text-fg-muted">{MCP_COPY.hello}</p>
          {readOnly ? null : (
            <Button variant="primary" onClick={onAdd}>
              {MCP_COPY.add}
            </Button>
          )}
        </Panel>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-(--cue-space-3)">
            <span className="flex-1 text-fg-muted">{countLine(views)}</span>
            {readOnly ? null : (
              <Button variant="primary" onClick={onAdd}>
                {MCP_COPY.add}
              </Button>
            )}
          </div>
          <ul aria-label={MCP_COPY.title} className="flex flex-col gap-(--cue-space-3)">
            {views.map((view) => (
              <li key={view.id}>
                <Card
                  view={view}
                  home={home}
                  twin={views.find((other) => other.id !== view.id && samePlace(view, other))}
                  onOpen={() => onOpen(view.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {unreadable === 0 && problems.length === 0 ? null : (
        <div className="flex flex-col gap-(--cue-space-1)">
          {unreadable === 0 ? null : <p className="text-warn">{MCP_COPY.unreadable(unreadable)}</p>}
          {problems.map((problem) => (
            <p key={problem} className="text-fg-muted">
              <UntrustedText text={problem} />
            </p>
          ))}
        </div>
      )}
      {standalone && !readOnly ? (
        <SectionPanel title={MCP_COPY.moveTitle}>
          <p className="text-fg-muted">{MCP_COPY.moveLead}</p>
          <PrepareAndApprove
            button={MCP_COPY.moveButton}
            prepare={{ kind: 'connectionMigrate' }}
            approve={(approvalId) => ({ kind: 'connectionMigrate', appApproval: approvalId })}
            title={MCP_COPY.moveAsk}
            approveHere={approveHere}
            failed={MCP_COPY.notMoved}
            onApproved={onMoved}
            onSaid={onSaid}
          />
        </SectionPanel>
      ) : null}
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
      <p className="text-(length:--cue-text-ui) text-fg-subtle">{MCP_COPY.footer}</p>
      <SectionPanel title={MCP_COPY.reach}>
        <div className="flex flex-col gap-(--cue-space-2)">
          <div className="flex items-start gap-(--cue-space-2)">
            <Chip tone="ok" variant="tinted">
              {MCP_COPY.yes}
            </Chip>
            <p className="text-fg">{MCP_COPY.yesLine}</p>
          </div>
          <div className="flex items-start gap-(--cue-space-2)">
            <Chip tone="neutral" variant="tinted">
              {MCP_COPY.no}
            </Chip>
            <p className="text-fg">{MCP_COPY.noLine}</p>
          </div>
        </div>
      </SectionPanel>
    </>
  );
}

/** The ink a card's state is said in: plain when all is well, a caution's or a fault's when not. */
const STATUS_INK = { ok: 'text-fg', idle: 'text-fg-muted', warn: 'text-warn', danger: 'text-danger' } as const;

/** One connection's card: its mark, name and place, its parts, how it stands and when it was last used, and Open. */
function Card({
  view,
  home,
  twin,
  onOpen,
}: {
  view: ConnectionView;
  home: string | null;
  twin: ConnectionView | undefined;
  onOpen: () => void;
}) {
  const name = nameOf(view);
  const status = statusOf(view, home);
  const chips = partChips(view);
  return (
    <Panel className="flex items-start gap-(--cue-space-3) p-(--cue-space-4)" data-connection={view.id}>
      <AppMark app={view.app} />
      <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <h3 className="font-semibold text-fg">{name}</h3>
        <span className="text-fg-muted">{whereShort(view, home)}</span>
        <div className="flex flex-wrap gap-(--cue-space-1)" data-slot="part-chips">
          {chips.length === 0 ? (
            <span className="text-(length:--cue-text-ui) text-fg-subtle">{MCP_COPY.onItsOwn}</span>
          ) : (
            chips.map((chip) => (
              <Chip key={chip} tone="neutral" variant="tinted">
                {chip}
              </Chip>
            ))
          )}
        </div>
        <span
          className="flex flex-wrap items-center gap-(--cue-space-2) text-(length:--cue-text-ui)"
          data-slot="connection-state"
        >
          <StatusDot tone={status.tone} label={status.word} />
          <span className={STATUS_INK[status.tone]}>{status.word}</span>
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
        {twin === undefined ? null : (
          <span className="text-(length:--cue-text-ui) text-warn">
            {MCP_COPY.twice(nameOf(twin), appName(view.app))}
          </span>
        )}
      </div>
      <Button size="sm" variant="secondary" aria-label={MCP_COPY.openLabel(name)} onClick={onOpen}>
        {MCP_COPY.open}
      </Button>
    </Panel>
  );
}
