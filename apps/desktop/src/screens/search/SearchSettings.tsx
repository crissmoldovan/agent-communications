import {
  AlertDialog,
  Button,
  Chip,
  DescriptionList,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Row as Line,
  Panel,
  SectionHeader,
  Select,
  Switch,
} from '@cueplusplus/ui';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { CopyButton } from '../../components/CopyButton.tsx';
import { Fact, Facts } from '../../components/Facts.tsx';
import { NeedsNewerCli } from '../../components/NeedsNewerCli.tsx';
import { ScreenState } from '../../components/ScreenState.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY } from '../../copy.ts';
import { useAppData } from '../../data.tsx';
import { isAccountName, isSearchModelAddress } from '../../grammar.ts';
import { errorMessage, SEARCH_MODELS, type SearchModelName } from '../../ipc.ts';
import { takeDestination } from '../../navigation.tsx';
import {
  readDeleteResult,
  readIndexRun,
  readSettingsChange,
  type SearchChannelWord,
  type SearchStatusView,
} from '../../search.ts';
import { useFlow } from '../accounts/change-flow.tsx';
import { SEARCH_COPY, sizeWords, SEARCH_SETTINGS_COPY as WORDS } from './copy.ts';
import { LocalLine, useIndexOnOpen, useSearchStatus, useSearchSupported } from './parts.tsx';

/** Where Settings → Search on this Mac is, for a link to land on it. */
export const SEARCH_SETTINGS_SECTION = 'search-settings';

/** How long each step of Rebuild may make vectors for, in seconds, and how many steps it takes at most. */
const REBUILD_STEP = 20;
const REBUILD_STEPS = 30;

/** The padding of what a panel holds that is not one of its rows, so it lines up with them. */
const INSET = 'px-(--cue-pad-row-x) py-(--cue-space-3)';

/**
 * Settings → Search on this Mac (0.35.0, design 2026-10-26-local-search §8, board `SettingsSearch`): off until the
 * person switches it on, which is a loosening they approve — in the app on a Mac, at a terminal elsewhere (S1); the
 * accounts it keeps, each added the same way and taken out at once; how long, which is Activity's (S12); the local
 * model of the reviewed list, run by the person's own Ollama, never a cloud API (S9); Rebuild; and Delete everything,
 * after a confirm (§7). What is kept and what is not encrypted is said in plain words (S11).
 */
export function SearchSettings() {
  const { installation } = useAppData();
  const { supported, installed } = useSearchSupported();
  const sectionRef = useRef<HTMLElement>(null);
  // A link from Search or People lands here: the section is scrolled to, and focus moves to it.
  useEffect(() => {
    if (takeDestination('settings', (destination) => destination.section === 'search') === null) return;
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
    sectionRef.current?.focus();
  }, []);
  if (installation.state !== 'ready' || !installation.value.installed) return null;
  return (
    <section
      ref={sectionRef}
      id={SEARCH_SETTINGS_SECTION}
      aria-label={WORDS.title}
      tabIndex={-1}
      className="outline-none"
    >
      <SectionHeader label={WORDS.title}>
        <p className="mb-(--cue-space-3) text-fg-muted">{WORDS.about}</p>
        {supported ? <SearchSettingsView /> : <NeedsNewerCli feature="search" installed={installed} />}
      </SectionHeader>
    </section>
  );
}

function SearchSettingsView() {
  const { status, reload } = useSearchStatus(true);
  useIndexOnOpen(true, () => void reload());
  return <ScreenState value={status}>{(value) => <Shown status={value} reload={reload} />}</ScreenState>;
}

/** A Gmail mailbox or a Slack workspace Search may keep, as `accounts` lists it. */
interface Keepable {
  alias: string;
  channel: SearchChannelWord;
  /** The mailbox's address, or the workspace's name. */
  detail: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const word = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The Gmail mailboxes and Slack workspaces the app can list, each once; a list that fails to read adds none. */
function useKeepable(): Keepable[] {
  const bridge = useBridge();
  const { installation } = useAppData();
  const present = installation.state === 'ready' ? installation.value.present.join(',') : '';
  const [found, setFound] = useState<Keepable[]>([]);
  useEffect(() => {
    let live = true;
    const products = present.split(',');
    const list = async (product: SearchChannelWord): Promise<Keepable[]> => {
      if (!products.includes(product)) return [];
      try {
        const result = await bridge.cli({ kind: 'accounts', product });
        if (result.status !== 'ok' || !Array.isArray(result.data)) return [];
        return result.data.filter(isRecord).flatMap((account) => {
          const alias = word(account.alias);
          if (alias === null) return [];
          const detail =
            product === 'gmail' ? word(account.email) : (word(account.workspaceName) ?? word(account.workspaceId));
          return [{ alias, channel: product, detail }];
        });
      } catch {
        return [];
      }
    };
    void Promise.all([list('gmail'), list('slack')]).then(([gmail, slack]) => {
      if (live) setFound([...gmail, ...slack]);
    });
    return () => {
      live = false;
    };
  }, [bridge, present]);
  return found;
}

/** A row's name, and a quiet line or more beneath it. */
function RowText({ id, title, children }: { id?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
      <span id={id} className="font-medium text-fg">
        {title}
      </span>
      {children}
    </div>
  );
}

function Shown({ status, reload }: { status: SearchStatusView; reload: () => Promise<void> }) {
  const switchId = useId();
  const onOff = useFlow(reload);
  const kept = status.kept;
  const empty = kept.messages === 0 && kept.waiting === 0;
  const toggle = (on: boolean) =>
    on
      ? void onOff.run(
          'on',
          { kind: 'searchOn' },
          {
            applied: WORDS.askOn.approved,
            asking: { ...WORDS.askOn, approve: (approvalId) => ({ kind: 'searchOn', appApproval: approvalId }) },
          },
        )
      : void onOff.run('off', { kind: 'searchOff' }, { applied: WORDS.switchedOff });
  return (
    <div className="flex flex-col gap-(--cue-space-4)">
      <Panel>
        <Line className="items-start py-(--cue-space-3)">
          <RowText id={switchId} title={WORDS.switchLabel}>
            {status.on ? (
              <span className="flex flex-wrap items-center gap-(--cue-space-2) text-fg-muted">
                <Chip tone={empty ? 'neutral' : 'ok'} variant="tinted">
                  {empty ? WORDS.empty : WORDS.on}
                </Chip>
                <span data-slot="search-kept">
                  {empty
                    ? WORDS.emptyLine
                    : WORDS.keptLine(kept.messages, kept.people, sizeWords(kept.bytes), kept.oldestDay)}
                </span>
              </span>
            ) : (
              <span className="text-fg-muted" data-slot="search-off">
                {WORDS.off} {kept.messages === 0 ? WORDS.offEmpty : WORDS.offKept}
              </span>
            )}
            {kept.waiting > 0 ? <span className="text-fg-muted">{WORDS.waiting(kept.waiting)}</span> : null}
          </RowText>
          <Switch
            aria-labelledby={switchId}
            size="lg"
            checked={status.on}
            disabled={onOff.busy !== null}
            onCheckedChange={toggle}
          />
        </Line>
        <div className={INSET}>
          <LocalLine why={WORDS.localWhy} />
        </div>
        {onOff.view === null ? null : <div className={INSET}>{onOff.view}</div>}
      </Panel>
      {status.words === 'needs-newer-node' ? <p className="text-warn">{WORDS.needsNode}</p> : null}
      <Kept status={status} reload={reload} />
      <HowLong days={status.retentionDays} />
      <Model status={status} reload={reload} />
      <StartAgain status={status} reload={reload} />
      <WhereKept status={status} />
    </div>
  );
}

/** What is kept, and from which accounts (S2, S3, S11). */
function Kept({ status, reload }: { status: SearchStatusView; reload: () => Promise<void> }) {
  const flow = useFlow(reload);
  const listed = useKeepable();
  const kept = new Set(status.accounts.map((account) => account.alias));
  // Every account Search keeps is shown, listed or not; then every Gmail mailbox and Slack workspace it could keep.
  const rows: Keepable[] = [
    ...listed,
    ...status.accounts
      .filter((account) => !listed.some((each) => each.alias === account.alias))
      .map((account) => ({ alias: account.alias, channel: account.channel, detail: null })),
  ];
  const flip = (row: Keepable, on: boolean) => {
    if (on) {
      const asking = WORDS.askAccount(row.alias);
      void flow.run(
        `add:${row.alias}`,
        { kind: 'searchAccountsAdd', account: row.alias },
        {
          applied: asking.approved,
          asking: {
            ...asking,
            approve: (approvalId) => ({ kind: 'searchAccountsAdd', account: row.alias, appApproval: approvalId }),
          },
        },
      );
      return;
    }
    void flow.run(
      `remove:${row.alias}`,
      { kind: 'searchAccountsRemove', account: row.alias },
      { applied: (data) => WORDS.accountRemoved(row.alias, readSettingsChange(data)?.deleted ?? 0) },
    );
  };
  return (
    <section aria-label={WORDS.kept}>
      <Panel>
        <div className={`${INSET} flex flex-col gap-(--cue-space-3)`}>
          <h3 className="font-semibold text-fg">{WORDS.kept}</h3>
          <DescriptionList.Root>
            {WORDS.keptRows.map(({ term, detail }) => (
              <DescriptionRow key={term} term={term} detail={detail} />
            ))}
          </DescriptionList.Root>
          <p className="rounded-control bg-surface-2 px-(--cue-space-3) py-(--cue-space-2) text-fg-muted">
            {WORDS.coverage}
          </p>
          <span className="text-(length:--cue-text-label) font-medium text-fg-subtle">{WORDS.accounts}</span>
        </div>
        {rows.length === 0 ? (
          <p className={`${INSET} text-fg-muted`}>{WORDS.noAccounts}</p>
        ) : (
          rows.map((row) => (
            <AccountRow
              key={row.alias}
              row={row}
              on={kept.has(row.alias)}
              busy={flow.busy !== null}
              onChange={(on) => flip(row, on)}
            />
          ))
        )}
        {flow.view === null ? null : <div className={INSET}>{flow.view}</div>}
      </Panel>
    </section>
  );
}

function DescriptionRow({ term, detail }: { term: string; detail: string }) {
  return (
    <>
      <DescriptionList.Term>{term}</DescriptionList.Term>
      <DescriptionList.Detail>{detail}</DescriptionList.Detail>
    </>
  );
}

function AccountRow({
  row,
  on,
  busy,
  onChange,
}: {
  row: Keepable;
  on: boolean;
  busy: boolean;
  onChange: (on: boolean) => void;
}) {
  const labelId = useId();
  return (
    <Line className="items-center py-(--cue-space-2)" data-account={row.alias}>
      <RowText id={labelId} title={row.alias}>
        <span className="text-fg-muted">
          {row.channel === 'gmail' ? WORDS.gmailLine(row.detail) : WORDS.slackLine(row.detail)}
        </span>
      </RowText>
      <Switch
        aria-label={WORDS.accountSwitch(row.alias)}
        checked={on}
        disabled={busy || !isAccountName(row.alias)}
        onCheckedChange={onChange}
      />
    </Line>
  );
}

/** How long: Activity's days (S12). */
function HowLong({ days }: { days: number }) {
  return (
    <section aria-label={WORDS.howLong}>
      <Panel className={`${INSET} flex flex-col gap-(--cue-space-2)`}>
        <h3 className="font-semibold text-fg">{WORDS.howLong}</h3>
        <p className="text-fg">{WORDS.howLongLine(days)}</p>
        <p className="text-fg-muted">{WORDS.howLongChange}</p>
      </Panel>
    </section>
  );
}

/** The model a name stands for on the reviewed list, or null for one the app does not offer. */
function reviewed(name: string): SearchModelName | null {
  return SEARCH_MODELS.find((model) => model === name) ?? null;
}

/** How it's made searchable (S9): the person's own Ollama, at a loopback address, with a model of the reviewed list. */
function Model({ status, reload }: { status: SearchStatusView; reload: () => Promise<void> }) {
  const flow = useFlow(reload);
  const model = status.model;
  const offered = status.models.filter((each) => reviewed(each.name) !== null);
  const [chosen, setChosen] = useState<SearchModelName>(
    () => reviewed(model?.name ?? '') ?? reviewed(offered[0]?.name ?? '') ?? SEARCH_MODELS[0],
  );
  const [address, setAddress] = useState(model?.address ?? WORDS.defaultAddress);
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const use = () => {
    const given = address.trim();
    if (!isSearchModelAddress(given)) {
      setAddressProblem(WORDS.addressRefused);
      return;
    }
    setAddressProblem(null);
    const asking = WORDS.askModel(chosen, given);
    void flow.run(
      'set',
      { kind: 'searchModelSet', address: given, model: chosen },
      {
        applied: asking.approved,
        asking: {
          ...asking,
          approve: (approvalId) => ({ kind: 'searchModelSet', address: given, model: chosen, appApproval: approvalId }),
        },
      },
    );
  };
  return (
    <section aria-label={WORDS.model}>
      <Panel>
        <div className={`${INSET} flex flex-col gap-(--cue-space-3)`}>
          <h3 className="font-semibold text-fg">{WORDS.model}</h3>
          <p className="text-fg-muted">{WORDS.modelAbout}</p>
          {model === null ? (
            <p className="text-fg" data-slot="search-model-none">
              {WORDS.modelNone}
            </p>
          ) : (
            <>
              <Facts>
                <Fact name={WORDS.theModel}>
                  <span className="font-mono">{model.name}</span>
                </Fact>
                <Fact name={WORDS.where}>
                  <span className="font-mono">{model.address}</span>
                </Fact>
                <Fact name={WORDS.its}>
                  <span className="flex flex-col gap-(--cue-space-1)" data-slot="search-model-state">
                    <span className={model.state === 'running' ? 'text-ok' : 'text-warn'}>
                      {WORDS.states[model.state]}
                    </span>
                    {model.detail === '' ? null : (
                      <span className="text-fg-muted">
                        <UntrustedText text={model.detail} />
                      </span>
                    )}
                  </span>
                </Fact>
              </Facts>
              {model.state === 'missing' ? (
                <div className="flex flex-wrap items-center gap-(--cue-space-2)">
                  <span className="text-fg-muted">{WORDS.getIt}</span>
                  <code className="rounded-control bg-surface-2 px-(--cue-space-2) py-(--cue-space-1) font-mono">
                    {model.pull}
                  </code>
                  <CopyButton text={model.pull} />
                </div>
              ) : null}
              {model.localOnly ? null : <p className="text-warn">{WORDS.localOnlyOff}</p>}
              <div className="flex flex-wrap gap-(--cue-space-2)">
                <Button size="sm" variant="secondary" onClick={() => void reload()}>
                  {WORDS.checkAgain}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={flow.busy !== null}
                  loading={flow.busy === 'none'}
                  onClick={() =>
                    void flow.run('none', { kind: 'searchModelNone' }, { applied: WORDS.wordsOnlyApplied })
                  }
                >
                  {WORDS.wordsOnly}
                </Button>
              </div>
            </>
          )}
          <div className="flex flex-wrap items-end gap-(--cue-space-3)">
            <Field name="search-model">
              <FieldLabel>{WORDS.choose}</FieldLabel>
              <Select
                aria-label={WORDS.choose}
                size="sm"
                items={offered.map((each, index) => ({
                  value: each.name,
                  label: `${each.name} · ${WORDS.download(each.download, each.licence)}${index === 0 ? ` · ${WORDS.defaultModel}` : ''}`,
                }))}
                value={chosen}
                onValueChange={(value) => setChosen(reviewed(value ?? '') ?? chosen)}
              />
            </Field>
            <Field name="search-model-address" invalid={addressProblem !== null}>
              <FieldLabel>{WORDS.address}</FieldLabel>
              <Input
                size="sm"
                value={address}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(value: string) => {
                  setAddress(value);
                  setAddressProblem(null);
                }}
              />
              <FieldDescription>{addressProblem ?? WORDS.addressHint}</FieldDescription>
            </Field>
            <Button
              size="sm"
              variant="primary"
              disabled={flow.busy !== null || offered.length === 0}
              loading={flow.busy === 'set'}
              onClick={use}
            >
              {WORDS.use}
            </Button>
          </div>
        </div>
        {flow.view === null ? null : <div className={INSET}>{flow.view}</div>}
      </Panel>
    </section>
  );
}

type Rebuilding =
  | { state: 'running'; made: number; pending: number }
  | { state: 'done' }
  | { state: 'paused'; pending: number }
  | { state: 'busy' }
  | { state: 'failed'; message: string };

/** Rebuild, with its progress; and Delete everything, after its confirm (§7). */
function StartAgain({ status, reload }: { status: SearchStatusView; reload: () => Promise<void> }) {
  const bridge = useBridge();
  const flow = useFlow(reload);
  const [rebuilding, setRebuilding] = useState<Rebuilding | null>(null);
  const stop = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, []);
  const running = rebuilding?.state === 'running';
  const rebuild = async () => {
    stop.current = false;
    setRebuilding({ state: 'running', made: 0, pending: status.kept.messages });
    let made = 0;
    try {
      for (let step = 0; step < REBUILD_STEPS; step += 1) {
        const result = await bridge.cli(
          step === 0 ? { kind: 'searchRebuild', budget: REBUILD_STEP } : { kind: 'searchIndex', budget: REBUILD_STEP },
        );
        if (!alive.current) return;
        const run = result.status === 'ok' ? readIndexRun(result.data) : null;
        if (run === null) {
          setRebuilding({
            state: 'failed',
            message: result.status === 'failed' ? result.message : SEARCH_COPY.unreadable,
          });
          return;
        }
        if (run.busy) {
          setRebuilding({ state: 'busy' });
          return;
        }
        if (run.model !== null && run.model.state !== 'running') {
          setRebuilding({ state: 'failed', message: run.model.detail });
          return;
        }
        made += run.embedded;
        if (run.pending === 0) {
          setRebuilding({ state: 'done' });
          return;
        }
        if (stop.current) {
          setRebuilding({ state: 'paused', pending: run.pending });
          return;
        }
        setRebuilding({ state: 'running', made, pending: run.pending });
      }
      setRebuilding((now) => (now?.state === 'running' ? { state: 'paused', pending: now.pending } : now));
    } catch (error) {
      if (alive.current) setRebuilding({ state: 'failed', message: errorMessage(error) });
    } finally {
      if (alive.current) void reload();
    }
  };
  const noModel = status.model === null;
  return (
    <section aria-label={WORDS.again}>
      <Panel className={`${INSET} flex flex-col gap-(--cue-space-3)`}>
        <h3 className="font-semibold text-fg">{WORDS.again}</h3>
        <div className="flex flex-wrap items-center gap-(--cue-space-3)">
          <Button
            size="sm"
            disabled={noModel || running || flow.busy !== null}
            loading={running}
            onClick={() => void rebuild()}
          >
            {WORDS.rebuild}
          </Button>
          {running ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                stop.current = true;
              }}
            >
              {WORDS.stop}
            </Button>
          ) : null}
          <span className="flex-1 text-fg-muted">{noModel ? WORDS.rebuildNeedsModel : WORDS.rebuildWhy}</span>
        </div>
        {rebuilding === null ? null : (
          <p
            role="status"
            className={rebuilding.state === 'failed' ? 'text-danger' : 'text-fg'}
            data-slot="search-rebuild"
          >
            {rebuilding.state === 'running' ? WORDS.rebuilding(rebuilding.made, rebuilding.pending) : null}
            {rebuilding.state === 'done' ? WORDS.rebuilt : null}
            {rebuilding.state === 'paused' ? WORDS.rebuildPaused(rebuilding.pending) : null}
            {rebuilding.state === 'busy' ? WORDS.rebuildBusy : null}
            {rebuilding.state === 'failed' ? <UntrustedText text={rebuilding.message} /> : null}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-(--cue-space-3)">
          <AlertDialog.Root>
            <AlertDialog.Trigger
              render={
                <Button
                  size="sm"
                  variant="danger-outline"
                  disabled={running || flow.busy !== null}
                  loading={flow.busy === 'delete'}
                >
                  {WORDS.deleteAll}
                </Button>
              }
            />
            <AlertDialog.Content>
              <AlertDialog.Title>{WORDS.deleteTitle}</AlertDialog.Title>
              <AlertDialog.Description>{WORDS.deleteBody(status.kept.messages)}</AlertDialog.Description>
              <AlertDialog.Footer>
                <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
                <AlertDialog.Action
                  tone="danger"
                  onClick={() =>
                    void flow.run(
                      'delete',
                      { kind: 'searchDeleteAll' },
                      {
                        applied: (data) => {
                          const deleted = readDeleteResult(data);
                          return WORDS.deleted(deleted?.files ?? 0, deleted?.keyDeleted ?? false);
                        },
                      },
                    )
                  }
                >
                  {WORDS.deleteAction}
                </AlertDialog.Action>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog.Root>
          <span className="flex-1 text-fg-muted">{WORDS.deleteWhy}</span>
        </div>
        {flow.view}
      </Panel>
    </section>
  );
}

/** Where it's kept, and what about it is and is not protected (S11): content-free, as doctor says it. */
function WhereKept({ status }: { status: SearchStatusView }) {
  return (
    <section aria-label={WORDS.whereKept}>
      <Panel className={`${INSET} flex flex-col gap-(--cue-space-3)`}>
        <h3 className="font-semibold text-fg">{WORDS.whereKept}</h3>
        <Facts>
          <Fact name={WORDS.folder}>
            <span className="font-mono break-all">
              <UntrustedText text={status.folder} />
            </span>
          </Fact>
          <Fact name={WORDS.backups}>{WORDS.backupStates[status.backups]}</Fact>
          <Fact name={WORDS.disk}>{WORDS.diskStates[status.diskEncryption]}</Fact>
          <Fact name={WORDS.key}>{WORDS.keyStores[status.keyStore]}</Fact>
        </Facts>
        <ul className="flex flex-col gap-(--cue-space-1)" data-slot="search-notes">
          {status.notes.map((note) => (
            <li key={note} className="text-fg-muted">
              <UntrustedText text={note} />
            </li>
          ))}
        </ul>
        {status.problems.map((problem) => (
          <p key={problem} role="alert" className="text-warn">
            <UntrustedText text={problem} />
          </p>
        ))}
        {status.lastCaptureFailure === null ? null : (
          <p className="text-fg-muted">
            {WORDS.lastFailure} <UntrustedText text={status.lastCaptureFailure.message} />
          </p>
        )}
      </Panel>
    </section>
  );
}
