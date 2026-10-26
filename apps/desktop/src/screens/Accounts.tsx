import {
  Avatar,
  Button,
  Chip,
  DescriptionList,
  Dialog,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  InfoTip,
  Input,
  Link,
  Panel,
  Row,
  Tabs,
} from '@cueplusplus/ui';
import { ChevronRight, Plus } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import type {
  BehaviourReport,
  InboxView,
  LabelReport,
  ResendAccountView,
  WhatsappStatusResult,
  WorkspaceView,
} from '../cli-types.ts';
import { NeedsNewerCli } from '../components/NeedsNewerCli.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { TerminalResult } from '../components/TerminalResult.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { type Feature, GATES, supports } from '../gates.ts';
import { accountNameSchema, isAccountName } from '../grammar.ts';
import { useCall } from '../hooks/use-call.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { type AccountsProduct, errorMessage, type Product, type TerminalOutcome } from '../ipc.ts';
import { takeDestination } from '../navigation.tsx';
import { AccountPage } from './accounts/AccountPage.tsx';
import { ScreenFrame } from './Screen.tsx';

/** Each channel with accounts to add: what it calls one, and what its tab says. */
const CHANNELS: Readonly<
  Record<AccountsProduct, { title: string; caption: string; add: string; whose: string; empty: string; again: boolean }>
> = {
  gmail: {
    title: 'Gmail',
    caption: 'Gmail mailboxes',
    add: 'Add a mailbox',
    whose: "A mailbox's",
    empty: 'No mailboxes yet.',
    again: true,
  },
  slack: {
    title: 'Slack',
    caption: 'Slack workspaces',
    add: 'Add a workspace',
    whose: "A workspace's",
    empty: 'No workspaces yet.',
    again: true,
  },
  // A Resend key is added again, not signed in again: Rust refuses `again` for it.
  resend: {
    title: 'Resend',
    caption: 'Resend accounts',
    add: 'Add a Resend account',
    whose: "A Resend account's",
    empty: 'No Resend accounts yet.',
    again: false,
  },
};

/** A channel the screen has a tab for: the three with accounts to add, and WhatsApp, read from its status. */
type Channel = AccountsProduct | 'whatsapp';

/** The tabs, in the order the app lists its products (D7: one tab per channel). */
const ORDER: readonly Channel[] = ['gmail', 'slack', 'resend', 'whatsapp'];

/** What each channel's tab and list are called, and what its list says when it is empty. */
const TABS: Readonly<Record<Channel, { title: string; caption: string; empty: string }>> = {
  gmail: CHANNELS.gmail,
  slack: CHANNELS.slack,
  resend: CHANNELS.resend,
  whatsapp: { title: 'WhatsApp', caption: 'WhatsApp accounts', empty: 'No WhatsApp account is set up.' },
};

/** The features this screen fills that a later CLI brings (DA12): both 0.22.0 today, so one line says so. */
const LATER: readonly Feature[] = ['behaviour', 'profiles'];

/**
 * What the screen shares with each section: whether the later parts are there, and the two reads that fill them, which
 * an account page (0.34.0) reads again after a change.
 */
interface Shared {
  profiles: boolean;
  behaviour: Loadable<BehaviourReport> | null;
  label: Loadable<LabelReport>;
  reloadBehaviour(): Promise<void>;
  reloadLabel(): Promise<void>;
}

/** What a writing profile is, said once beside it rather than as a line of its own (D3). */
export const PROFILE_HINT =
  "Your own profile applies to every message an agent writes for you; each account's adds to it.";

/**
 * Every account on this machine, one tab per channel (DA5.2, D7): its mode and policies as its channel names them, the
 * label its agent messages carry, what agents may do there (0.22.0), and its writing profile (0.22.0), which opens in
 * the default editor after `profile init` makes it. Adding an account, and signing in again, happen only in Terminal:
 * the app never handles a password or a token. Every channel's list is read when the screen opens, so a tab whose list
 * holds an account that needs a look says how many before it is chosen.
 */
export function Accounts() {
  const { installation } = useAppData();
  const found = installation.state === 'ready' ? installation.value : null;
  const version = found?.version ?? null;
  const present = found?.present ?? [];
  const label = useCall<LabelReport>({ kind: 'label' });
  const behaviourSupported = supports(version, 'behaviour');
  const behaviour = useCall<BehaviourReport>(behaviourSupported ? { kind: 'behaviour' } : null);
  useReloadOnReturn(async () => {
    await Promise.all([label.reload(), behaviour.reload()]);
  });
  const shared: Shared = {
    profiles: supports(version, 'profiles'),
    behaviour: behaviourSupported ? behaviour.result : null,
    label: label.result,
    reloadBehaviour: behaviour.reload,
    reloadLabel: label.reload,
  };
  // An account another screen asked for, by its name (`navigation.tsx`, 0.34.0): read once, as the screen opens.
  const [requested] = useState(() => {
    const account = takeDestination('accounts')?.account ?? null;
    return account !== null && isAccountName(account) ? account : null;
  });
  // Only a channel whose launcher is here is asked anything.
  const lists: Record<Channel, Loadable<AccountRow[]>> = {
    gmail: useGmail(present.includes('gmail')),
    slack: useSlack(present.includes('slack')),
    resend: useResend(present.includes('resend')),
    whatsapp: useWhatsapp(present.includes('whatsapp')),
  };
  const channels = ORDER.filter((channel) => present.includes(channel));

  // One update line for each later version the screen waits for, not one per row.
  const waiting = [...new Map(LATER.filter((f) => !supports(version, f)).map((f) => [GATES[f], f])).values()];

  return (
    <ScreenFrame title="Accounts">
      <section aria-label="Writing profiles and what agents may do">
        {waiting.length > 0 ? (
          waiting.map((feature) => <NeedsNewerCli key={feature} feature={feature} installed={version} />)
        ) : (
          <OwnProfile />
        )}
      </section>
      {shared.label.state === 'error' ? (
        <p role="alert" className="text-danger">
          <UntrustedText text={`The label could not be read: ${shared.label.message}`} />
        </p>
      ) : null}
      {shared.behaviour?.state === 'error' ? (
        <p role="alert" className="text-danger">
          <UntrustedText text={`What agents may do could not be read: ${shared.behaviour.message}`} />
        </p>
      ) : null}
      {channels.length === 0 ? null : (
        <ChannelTabs channels={channels} lists={lists} shared={shared} requested={requested} />
      )}
    </ScreenFrame>
  );
}

/**
 * The channels' tab bar (D7), with the chosen channel's Add beside it, and its accounts below — or, once one is opened
 * from its row (0.34.0), that account's page. A tab whose list has an account that needs a look, or could not be read,
 * carries the count, so nothing waits unseen behind a tab. An account another screen asked for opens on its channel's
 * tab once that channel's list has it; one no list has leaves the lists as they are.
 */
function ChannelTabs({
  channels,
  lists,
  shared,
  requested,
}: {
  channels: readonly Channel[];
  lists: Record<Channel, Loadable<AccountRow[]>>;
  shared: Shared;
  requested: string | null;
}) {
  const [chosen, setChosen] = useState<Channel | null>(null);
  const [opened, setOpened] = useState<Partial<Record<Channel, string>>>({});
  const [looking, setLooking] = useState(requested);
  const current = chosen !== null && channels.includes(chosen) ? chosen : (channels[0] as Channel);
  const open = useCallback(
    (channel: Channel, account: string | null) =>
      setOpened((now) => {
        const next = { ...now };
        if (account === null) delete next[channel];
        else next[channel] = account;
        return next;
      }),
    [],
  );
  useEffect(() => {
    if (looking === null) return;
    const found = channels.find((channel) => {
      const list = lists[channel];
      return list.state === 'ready' && list.value.some((row) => row.account === looking);
    });
    if (found !== undefined) {
      setChosen(found);
      open(found, looking);
      setLooking(null);
    } else if (channels.every((channel) => lists[channel].state !== 'loading')) {
      setLooking(null);
    }
  }, [looking, channels, lists, open]);
  return (
    <Tabs.Root swipe value={current} onValueChange={(value) => setChosen(value as Channel)}>
      <div className="flex flex-wrap items-center justify-between gap-(--cue-space-3)">
        <Tabs.List aria-label="Channels">
          {channels.map((channel) => {
            const count = needsALook(lists[channel]);
            return (
              <Tabs.Tab key={channel} value={channel} aria-label={tabName(TABS[channel].title, count)}>
                {TABS[channel].title}
                <NeedsALook count={count} />
              </Tabs.Tab>
            );
          })}
          <Tabs.Indicator />
        </Tabs.List>
        {current === 'whatsapp' ? null : <AddAccount key={current} product={current} />}
      </div>
      {/* Kept mounted, as Agent's and Events' are: a row's sign-in still opening, and what it or its profile came to,
          stay through a change of tab, so a second sign-in cannot start while the first is still opening. */}
      {channels.map((channel) => (
        <Tabs.Panel key={channel} value={channel} keepMounted>
          <ChannelPanel
            channel={channel}
            list={lists[channel]}
            shared={shared}
            opened={opened[channel] ?? null}
            onOpen={(account) => open(channel, account)}
          />
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

/** How many of a channel's accounts need a look: each with a warning, or the one list that could not be read. */
function needsALook(list: Loadable<AccountRow[]>): number {
  if (list.state === 'error') return 1;
  if (list.state === 'loading') return 0;
  return list.value.filter((row) => row.warning).length;
}

/** A tab's name: its channel's, and how many there need a look, in words, when any do. */
function tabName(title: string, count: number): string {
  return count === 0 ? title : `${title}, ${count} ${count === 1 ? 'needs' : 'need'} a look`;
}

/** A tab's count of what needs a look there, as a number; the tab's name says it in words. */
function NeedsALook({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span aria-hidden="true" data-slot="needs-a-look">
      <Chip tone="warn">{count}</Chip>
    </span>
  );
}

/** The person's own profile, `user.md`, which every message an agent writes starts from. */
function OwnProfile() {
  const opening = useProfile();
  return (
    <Panel>
      <Row>
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
          <span className="flex items-center gap-(--cue-space-2) font-medium text-fg">
            Writing profiles
            <InfoTip label="About writing profiles" text={PROFILE_HINT} />
          </span>
          {opening.said}
        </div>
        <Button size="sm" loading={opening.busy} onClick={() => void opening.open(undefined)}>
          Open your own writing profile
        </Button>
      </Row>
    </Panel>
  );
}

/** Opens a writing profile, and says which file: `Created <path>` when `profile init` made it. */
function useProfile(): { busy: boolean; said: ReactNode; open(account: string | undefined): Promise<void> } {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ReactNode>(null);
  return {
    busy,
    said,
    async open(account) {
      if (account !== undefined && !isAccountName(account)) {
        setSaid(<Problem message="This account's name cannot be passed on safely." />);
        return;
      }
      setBusy(true);
      try {
        const opened = await bridge.openProfile(account === undefined ? {} : { account });
        setSaid(
          <p role="status" className="text-fg-muted">
            {opened.created ? 'Created ' : 'Opened '}
            <span className="font-mono">
              <UntrustedText text={opened.path} />
            </span>
          </p>,
        );
      } catch (error) {
        setSaid(<Problem message={errorMessage(error)} />);
      } finally {
        setBusy(false);
      }
    },
  };
}

function Problem({ message }: { message: string }) {
  return (
    <p role="alert" className="text-danger">
      <UntrustedText text={message} />
    </p>
  );
}

/** A read's loading and error states padded inside its panel; its value, a list or an empty state, edge to edge. */
function PanelState<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  if (value.state !== 'ready') {
    return (
      <div className="p-(--cue-space-4)">
        <ScreenState value={value}>{() => null}</ScreenState>
      </div>
    );
  }
  return <>{children(value.value)}</>;
}

/** One fact about an account, under the name its channel gives it. */
interface Fact {
  term: string;
  value: ReactNode;
}

/** One account's row: its name and what its channel says of it, then the facts every channel has. */
interface AccountRow {
  account: string;
  /** Its address, or its workspace's name, which the workspace wrote. */
  detail?: string | undefined;
  /** Something to know at once, such as a mailbox that needs attention. */
  flag?: string | undefined;
  /** Whether it needs a look: its tab counts it. */
  warning: boolean;
  /** This channel's own facts, in its order. */
  facts: Fact[];
  /** What its channel says it would take, under the facts. */
  notes?: string[];
  /** What it is connected to do, in a sentence: its page says it under its name (0.34.0). */
  summary?: string | undefined;
}

/** Whether a channel's accounts sign in again in Terminal: Gmail's and Slack's. */
function signsInAgain(channel: Channel): boolean {
  return channel === 'whatsapp' ? false : CHANNELS[channel].again;
}

/**
 * A channel's tab: its list, or the page of the account opened from it (0.34.0). An account the list no longer has
 * shows the list again; while the list is read again, or could not be, the page stays as it was, so a preview waiting
 * on it is never revoked by a read.
 */
function ChannelPanel({
  channel,
  list,
  shared,
  opened,
  onOpen,
}: {
  channel: Channel;
  list: Loadable<AccountRow[]>;
  shared: Shared;
  opened: string | null;
  onOpen: (account: string | null) => void;
}) {
  const last = useRef<AccountRow | null>(null);
  const found =
    opened === null
      ? undefined
      : list.state === 'ready'
        ? list.value.find((each) => each.account === opened)
        : last.current?.account === opened
          ? last.current
          : undefined;
  last.current = found ?? null;
  const row = found;
  if (row === undefined) return <ChannelList channel={channel} list={list} shared={shared} onOpen={onOpen} />;
  return (
    <AccountPage
      key={row.account}
      channel={channel}
      channelTitle={TABS[channel].title}
      head={row}
      about={<AboutAccount product={channel} row={row} again={signsInAgain(channel)} shared={shared} />}
      behaviour={{ result: shared.behaviour ?? { state: 'loading' }, reload: shared.reloadBehaviour }}
      label={{ result: shared.label, reload: shared.reloadLabel }}
      onBack={() => onOpen(null)}
    />
  );
}

/** A channel's accounts in a soft panel: one row each, or what the list came to when it has none. */
function ChannelList({
  channel,
  list,
  shared,
  onOpen,
}: {
  channel: Channel;
  list: Loadable<AccountRow[]>;
  shared: Shared;
  onOpen: (account: string) => void;
}) {
  const { caption, empty } = TABS[channel];
  const again = signsInAgain(channel);
  return (
    <Panel>
      <PanelState value={list}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={empty} />
          ) : (
            <ul aria-label={caption} className="flex flex-col">
              {rows.map((row) => (
                <AccountItem
                  key={row.account}
                  product={channel}
                  row={row}
                  again={again}
                  shared={shared}
                  onOpen={() => onOpen(row.account)}
                />
              ))}
            </ul>
          )
        }
      </PanelState>
    </Panel>
  );
}

/** An account's facts: its channel's own, then its label and what agents may do there. */
function factsOf(row: AccountRow, shared: Shared): Fact[] {
  return [
    ...row.facts,
    { term: 'Label', value: <LabelStyle label={shared.label} account={row.account} /> },
    ...(shared.behaviour === null
      ? []
      : [{ term: 'Agents may', value: <AgentsMay behaviour={shared.behaviour} account={row.account} /> }]),
  ];
}

/** An account's facts side by side, then what its channel says it would take. */
function AccountFacts({ row, shared }: { row: AccountRow; shared: Shared }) {
  return (
    <>
      <DescriptionList.Root
        layout="stacked"
        className="grid auto-cols-fr grid-flow-col gap-x-(--cue-space-5) gap-y-(--cue-space-2)"
      >
        {factsOf(row, shared).map((fact) => (
          <div key={fact.term} className="flex min-w-0 flex-col gap-(--cue-space-1)">
            <DescriptionList.Term>{fact.term}</DescriptionList.Term>
            <DescriptionList.Detail>{fact.value}</DescriptionList.Detail>
          </div>
        ))}
      </DescriptionList.Root>
      {row.notes === undefined || row.notes.length === 0 ? null : (
        <div className="flex flex-col gap-(--cue-space-1) text-fg-muted">
          {row.notes.map((note, index) => (
            // A channel's message and its hint may say the same; their place is what tells them apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: the notes are never reordered.
            <span key={index}>
              <UntrustedText text={note} />
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** An account page's About (0.34.0): its facts, as its row has them, and its own buttons. */
function AboutAccount({
  product,
  row,
  again,
  shared,
}: {
  product: Product;
  row: AccountRow;
  again: boolean;
  shared: Shared;
}) {
  const actions = useAccountActions(product, row.account, again, shared.profiles);
  return (
    <Panel className="flex flex-col gap-(--cue-space-4) p-(--cue-space-5)">
      <AccountFacts row={row} shared={shared} />
      {actions.buttons}
      {actions.said}
    </Panel>
  );
}

/**
 * One account: its initial, its name — which opens its page (0.34.0) — with what its channel says of it, its facts, and
 * its own buttons, with what each came to under the facts.
 */
function AccountItem({
  product,
  row,
  again,
  shared,
  onOpen,
}: {
  product: Product;
  row: AccountRow;
  again: boolean;
  shared: Shared;
  onOpen: () => void;
}) {
  const actions = useAccountActions(product, row.account, again, shared.profiles);
  return (
    <li>
      <Row className="items-start">
        <span aria-hidden="true" className="flex shrink-0">
          <Avatar fallback={row.account.charAt(0)} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2)">
          <div className="flex min-h-control-md flex-wrap items-center gap-x-(--cue-space-3) gap-y-(--cue-space-1)">
            <Link
              variant="plain"
              render={<button type="button" />}
              onClick={onOpen}
              aria-label={`Open ${row.account}`}
              className="inline-flex items-center gap-(--cue-space-1) font-medium text-fg"
            >
              <span>{row.account}</span>
              <ChevronRight aria-hidden="true" className="size-(--cue-icon-sm) text-fg-subtle" />
            </Link>
            {row.detail === undefined ? null : (
              <span className="text-fg-muted">
                <UntrustedText text={row.detail} />
              </span>
            )}
            {row.flag === undefined ? null : (
              <Chip tone="warn" variant="tag">
                {row.flag}
              </Chip>
            )}
            {actions.buttons === null ? null : <div className="ml-auto">{actions.buttons}</div>}
          </div>
          <AccountFacts row={row} shared={shared} />
          {actions.said}
        </div>
      </Row>
    </li>
  );
}

/** A channel's accounts, read from its own launcher when it is here, and read again when the person comes back. */
function useAccounts<T>(
  product: AccountsProduct,
  here: boolean,
  rowsOf: (data: T) => AccountRow[],
): Loadable<AccountRow[]> {
  const { result, reload } = useCall<T>(here ? { kind: 'accounts', product } : null);
  useReloadOnReturn(reload);
  return rowsOrError(CHANNELS[product].title, result, rowsOf);
}

/** A read's rows, or — for an answer in a shape this app cannot read — an error saying so, rather than a broken screen. */
function rowsOrError<T>(title: string, result: Loadable<T>, rowsOf: (data: T) => AccountRow[]): Loadable<AccountRow[]> {
  if (result.state !== 'ready') return result;
  try {
    return { state: 'ready', value: rowsOf(result.value) };
  } catch {
    return { state: 'error', message: `${title} answered in a shape this app cannot read.` };
  }
}

/** A policy, and whether it is the account's own or the default. */
function policy(value: string, inherited: boolean): string {
  return inherited ? `${value} (default)` : value;
}

/** What a send policy means for each email, as an account page says it under its name. */
const SENDING: Readonly<Record<InboxView['sendPolicy'], string>> = {
  chat: 'Every send waits for your yes in the chat.',
  confirm: 'Every send waits for your yes at your terminal.',
  never: 'Nothing is sent from it.',
};

function useGmail(here: boolean): Loadable<AccountRow[]> {
  return useAccounts<InboxView[]>('gmail', here, (inboxes) =>
    inboxes.map((inbox) => ({
      account: inbox.alias,
      detail: inbox.email,
      flag: inbox.health === 'needs-attention' ? 'needs attention' : undefined,
      warning: inbox.health === 'needs-attention',
      summary: SENDING[inbox.sendPolicy],
      facts: [
        { term: 'Send policy', value: policy(inbox.sendPolicy, inbox.sendPolicyInherited) },
        { term: 'Change policy', value: policy(inbox.changePolicy, inbox.changePolicyInherited) },
      ],
    })),
  );
}

function useSlack(here: boolean): Loadable<AccountRow[]> {
  return useAccounts<WorkspaceView[]>('slack', here, (workspaces) =>
    workspaces.map((workspace) => ({
      account: workspace.alias,
      detail: workspace.workspaceName,
      warning: false,
      summary: workspace.mode === 'send' ? 'Connected to read and post.' : 'Connected to read only.',
      facts: [{ term: 'Mode', value: workspace.mode }],
    })),
  );
}

function useResend(here: boolean): Loadable<AccountRow[]> {
  return useAccounts<{ accounts: ResendAccountView[] }>('resend', here, ({ accounts }) =>
    accounts.map((account) => ({
      account: account.name,
      warning: false,
      summary: account.mode === 'read' ? 'Connected to read only.' : SENDING[account.sendPolicy],
      facts: [
        { term: 'Mode', value: account.mode },
        { term: 'Send policy', value: policy(account.sendPolicy, account.sendPolicyFrom === 'default') },
        { term: 'Change policy', value: policy(account.changePolicy, account.changePolicyFrom === 'default') },
      ],
    })),
  );
}

/**
 * Whether WhatsApp's access needs a look, as Doctor reads the same status: readable is fine and not-checked is
 * skipped; waiting is a warning, and missing, denied, unreadable or a state this app does not know is a failure.
 */
function accessNeedsALook(state: string): boolean {
  return state !== 'readable' && state !== 'not-checked';
}

/** WhatsApp's accounts, from its status, which stands as its doctor: whether this machine can read each one's chats. */
function useWhatsapp(here: boolean): Loadable<AccountRow[]> {
  const { result, reload } = useCall<WhatsappStatusResult>(here ? { kind: 'doctor', product: 'whatsapp' } : null);
  useReloadOnReturn(reload);
  return rowsOrError('WhatsApp', result, (status) =>
    status.accounts.map((each) => {
      const warning = accessNeedsALook(each.access.state);
      return {
        account: each.account,
        warning,
        facts: [
          {
            term: 'Access',
            value: <span className={warning ? 'text-warn' : undefined}>{each.access.state}</span>,
          },
        ],
        notes: [each.access.message, each.access.hint].filter((note): note is string => note !== undefined),
      };
    }),
  );
}

/** How an account's agent messages are labelled (`label`): Slack's style, or who mail appears to come from. */
function LabelStyle({ label, account }: { label: Loadable<LabelReport>; account: string }) {
  if (label.state !== 'ready') return <span className="text-fg-subtle">—</span>;
  const view = label.value.accounts.find((each) => each.account === account);
  if (view === undefined) return <span className="text-fg-subtle">—</span>;
  if (view.style !== undefined) {
    return (
      <div className="flex flex-col gap-(--cue-space-1)">
        <span className="text-fg">{view.style}</span>
        {view.appRoute === false && view.note !== undefined ? (
          <span className="text-fg-muted">
            <UntrustedText text={view.note} />
          </span>
        ) : null}
      </div>
    );
  }
  if (view.kinds.length === 0) return <span className="text-fg-muted">{view.note ?? '—'}</span>;
  const identities = new Set(view.kinds.map((kind) => kind.identity));
  const text =
    identities.size > 1
      ? 'labelled, but sent as you where a rule says'
      : identities.has('me')
        ? 'as you, with no label'
        : view.phrase === null
          ? 'labelled'
          : `labelled ${view.phrase}`;
  return (
    <span className="text-fg">
      <UntrustedText text={text} />
    </span>
  );
}

/** What an agent may start, as the behaviour report says it: everything, nothing, or the acts listed. */
function actsText(allowed: readonly string[] | 'all'): string {
  if (allowed === 'all') return 'all';
  return allowed.length === 0 ? 'nothing' : allowed.join(', ');
}

/** What agents may do on an account (`behaviour`, 0.22.0): across it, then in each conversation a rule names. */
function AgentsMay({ behaviour, account }: { behaviour: Loadable<BehaviourReport>; account: string }) {
  if (behaviour.state !== 'ready') return <span className="text-fg-subtle">—</span>;
  const view = behaviour.value.accounts.find((each) => each.account === account);
  // Not an account that acts on other people: WhatsApp only drafts.
  if (view === undefined) return <span className="text-fg-subtle">—</span>;
  return (
    <div className="flex flex-wrap gap-x-(--cue-space-3) gap-y-(--cue-space-1)">
      <span className="text-fg">{actsText(view.allowed)}</span>
      {view.conversations.map((each) => (
        <span key={each.conversation} className="text-fg-muted">
          <UntrustedText text={`${each.conversation}: ${actsText(each.allowed)}`} />
        </span>
      ))}
    </div>
  );
}

/**
 * A row's own buttons — its writing profile (0.22.0), and signing in again (Gmail and Slack), each in Terminal — and
 * what each came to, which the row shows under its facts.
 */
function useAccountActions(
  product: Product,
  account: string,
  again: boolean,
  profiles: boolean,
): { buttons: ReactNode; said: ReactNode } {
  const bridge = useBridge();
  const opening = useProfile();
  const [signing, setSigning] = useState(false);
  const [signedIn, setSignedIn] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const signInAgain = async () => {
    setProblem(null);
    if (!isAccountName(account)) {
      setProblem("This account's name cannot be passed on safely.");
      return;
    }
    setSigning(true);
    try {
      setSignedIn(await bridge.openInTerminal({ kind: 'signIn', product, account, again: true }));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSigning(false);
    }
  };
  const buttons =
    !profiles && !again ? null : (
      <div className="flex shrink-0 gap-(--cue-space-1)">
        {profiles ? (
          <Button size="sm" variant="ghost" loading={opening.busy} onClick={() => void opening.open(account)}>
            Open writing profile
          </Button>
        ) : null}
        {again ? (
          <Button size="sm" variant="ghost" loading={signing} onClick={() => void signInAgain()}>
            Sign in again
          </Button>
        ) : null}
      </div>
    );
  const said =
    opening.said === null && signedIn === null && problem === null ? null : (
      <div className="flex flex-col gap-(--cue-space-1)">
        {opening.said}
        {signedIn === null ? null : <TerminalResult outcome={signedIn} />}
        {problem === null ? null : <Problem message={problem} />}
      </div>
    );
  return { buttons, said };
}

/** Why a name cannot be used for an account of `product`: the grammar's refusal, or a name for another channel. */
function nameIssues(product: AccountsProduct, name: string): { message: string }[] {
  const parsed = accountNameSchema.safeParse(name);
  if (!parsed.success) return parsed.error.issues.map((issue) => ({ message: issue.message }));
  // A version-2 name says what it is after its slash, and the CLI checks that against the account.
  const [, rest] = name.split('/');
  if (rest !== undefined && rest.split('-')[0] !== product) {
    return [{ message: `${CHANNELS[product].whose} name ends in /${product}, such as example/${product}.` }];
  }
  return [];
}

/**
 * Adding an account (DA5): a name, checked here against the grammar Rust checks again, then the sign-in opened in
 * Terminal, where the person gives the password, the token or the key. Nothing secret passes through the app.
 */
function AddAccount({ product }: { product: AccountsProduct }) {
  const channel = CHANNELS[product];
  const bridge = useBridge();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [issues, setIssues] = useState<{ message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TerminalOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setIssues([]);
    setOutcome(null);
    setProblem(null);
  };

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const found = nameIssues(product, name);
    setIssues(found);
    if (found.length > 0) return;
    setBusy(true);
    try {
      setOutcome(await bridge.openInTerminal({ kind: 'signIn', product, account: name, again: false }));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Dialog.Trigger
        render={
          <Button size="sm" icon={Plus}>
            {channel.add}
          </Button>
        }
      />
      <Dialog.Content width="sm" showCloseButton={false}>
        <Dialog.Title>{channel.add}</Dialog.Title>
        <Dialog.Description>
          The sign-in runs in Terminal, where you give the password, token or key: this app never sees it.
        </Dialog.Description>
        <form noValidate onSubmit={(event) => void run(event)} className="flex flex-col gap-(--cue-space-3)">
          <Field name="account" invalid={issues.length > 0}>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              placeholder={`example/${product}`}
              onChange={(event) => {
                setName(event.target.value);
                setIssues([]);
              }}
            />
            <FieldDescription>{`organisation/${product}, with -qualifier for a second one: example/${product}-work.`}</FieldDescription>
            <FieldError issues={issues} />
          </Field>
          {outcome === null ? null : <TerminalResult outcome={outcome} />}
          {problem === null ? null : <Problem message={problem} />}
          <Dialog.Footer>
            <Dialog.Close render={<Button variant="ghost">Close</Button>} />
            <Button type="submit" variant="primary" loading={busy}>
              {COPY.runInTerminal}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
