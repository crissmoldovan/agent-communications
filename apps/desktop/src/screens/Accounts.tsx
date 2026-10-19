import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Panel,
  PanelHeader,
  Row,
  Table,
} from '@cueplusplus/ui';
import { Plus } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
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
import { ScreenFrame } from './Screen.tsx';

/** Each channel with accounts to add: what it calls one, and what its section says. */
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

/** The features this screen fills that a later CLI brings (DA12): both 0.22.0 today, so one line says so. */
const LATER: readonly Feature[] = ['behaviour', 'profiles'];

/** What the screen shares with each section: whether the later parts are there, and the two reads that fill them. */
interface Shared {
  profiles: boolean;
  behaviour: Loadable<BehaviourReport> | null;
  label: Loadable<LabelReport>;
}

/**
 * Every account on this machine, by channel (DA5.2): its mode and policies as its channel names them, the label its
 * agent messages carry, what agents may do there (0.22.0), and its writing profile (0.22.0), which opens in the
 * default editor after `profile init` makes it. Adding an account, and signing in again, happen only in Terminal: the
 * app never handles a password or a token.
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
  };

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
      {present.includes('gmail') ? <GmailAccounts shared={shared} /> : null}
      {present.includes('slack') ? <SlackAccounts shared={shared} /> : null}
      {present.includes('resend') ? <ResendAccounts shared={shared} /> : null}
      {present.includes('whatsapp') ? <WhatsappAccounts shared={shared} /> : null}
    </ScreenFrame>
  );
}

/** The person's own profile, `user.md`, which every message an agent writes starts from. */
function OwnProfile() {
  const opening = useProfile();
  return (
    <Panel>
      <PanelHeader title="Writing profiles" />
      <Row>
        <div className="flex flex-col gap-(--cue-space-1)">
          <span className="text-fg">
            Your own profile applies to every message an agent writes for you; each account's adds to it.
          </span>
          {opening.said}
        </div>
        <div className="ml-auto">
          <Button size="sm" loading={opening.busy} onClick={() => void opening.open(undefined)}>
            Open your own writing profile
          </Button>
        </div>
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
            <UntrustedText text={`${opened.created ? 'Created' : 'Opened'} ${opened.path}`} />
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

/** A read's loading and error states padded inside its panel; its value, a table or an empty state, edge to edge. */
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

/** One account's row: its name and what its channel says of it, then the columns every channel has. */
interface AccountRow {
  account: string;
  /** Its address, or its workspace's name, which the workspace wrote. */
  detail?: string | undefined;
  /** Something to know at once, such as a mailbox that needs attention. */
  flag?: string | undefined;
  /** This channel's own columns, in `headers` order. */
  values: ReactNode[];
}

function ChannelPanel({
  product,
  title,
  caption,
  heading,
  headers,
  list,
  empty,
  add,
  shared,
  again,
}: {
  product: Product;
  title: string;
  caption: string;
  heading: string;
  headers: string[];
  list: Loadable<AccountRow[]>;
  empty: string;
  add?: ReactNode;
  shared: Shared;
  again: boolean;
}) {
  return (
    <Panel>
      <PanelHeader title={title} actions={add} />
      <PanelState value={list}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={empty} />
          ) : (
            <Table.Root>
              <Table.Caption className="sr-only">{caption}</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{heading}</Table.Head>
                  {headers.map((header) => (
                    <Table.Head key={header}>{header}</Table.Head>
                  ))}
                  <Table.Head>Label</Table.Head>
                  {shared.behaviour === null ? null : <Table.Head>Agents may</Table.Head>}
                  <Table.Head>
                    <span className="sr-only">Actions</span>
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row key={row.account}>
                    <Table.Cell>
                      <div className="flex flex-col gap-(--cue-space-1)">
                        <span className="text-fg">{row.account}</span>
                        {row.detail === undefined ? null : (
                          <span className="text-fg-muted">
                            <UntrustedText text={row.detail} />
                          </span>
                        )}
                        {row.flag === undefined ? null : (
                          <span>
                            <Chip tone="warn" variant="tag">
                              {row.flag}
                            </Chip>
                          </span>
                        )}
                      </div>
                    </Table.Cell>
                    {row.values.map((value, index) => (
                      <Table.Cell key={headers[index] ?? index}>{value}</Table.Cell>
                    ))}
                    <Table.Cell>
                      <LabelStyle label={shared.label} account={row.account} />
                    </Table.Cell>
                    {shared.behaviour === null ? null : (
                      <Table.Cell>
                        <AgentsMay behaviour={shared.behaviour} account={row.account} />
                      </Table.Cell>
                    )}
                    <Table.Cell>
                      <AccountActions
                        product={product}
                        account={row.account}
                        again={again}
                        profiles={shared.profiles}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )
        }
      </PanelState>
    </Panel>
  );
}

/** A channel's accounts, read from its own launcher, and read again when the person comes back from Terminal. */
function useAccounts<T>(product: AccountsProduct, rowsOf: (data: T) => AccountRow[]): Loadable<AccountRow[]> {
  const { result, reload } = useCall<T>({ kind: 'accounts', product });
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

function GmailAccounts({ shared }: { shared: Shared }) {
  const channel = CHANNELS.gmail;
  const list = useAccounts<InboxView[]>('gmail', (inboxes) =>
    inboxes.map((inbox) => ({
      account: inbox.alias,
      detail: inbox.email,
      flag: inbox.health === 'needs-attention' ? 'needs attention' : undefined,
      values: [
        policy(inbox.sendPolicy, inbox.sendPolicyInherited),
        policy(inbox.changePolicy, inbox.changePolicyInherited),
      ],
    })),
  );
  return (
    <ChannelPanel
      product="gmail"
      title={channel.title}
      caption={channel.caption}
      heading="Mailbox"
      headers={['Send policy', 'Change policy']}
      list={list}
      empty={channel.empty}
      add={<AddAccount product="gmail" />}
      shared={shared}
      again={channel.again}
    />
  );
}

function SlackAccounts({ shared }: { shared: Shared }) {
  const channel = CHANNELS.slack;
  const list = useAccounts<WorkspaceView[]>('slack', (workspaces) =>
    workspaces.map((workspace) => ({
      account: workspace.alias,
      detail: workspace.workspaceName,
      values: [workspace.mode],
    })),
  );
  return (
    <ChannelPanel
      product="slack"
      title={channel.title}
      caption={channel.caption}
      heading="Workspace"
      headers={['Mode']}
      list={list}
      empty={channel.empty}
      add={<AddAccount product="slack" />}
      shared={shared}
      again={channel.again}
    />
  );
}

function ResendAccounts({ shared }: { shared: Shared }) {
  const channel = CHANNELS.resend;
  const list = useAccounts<{ accounts: ResendAccountView[] }>('resend', ({ accounts }) =>
    accounts.map((account) => ({
      account: account.name,
      values: [
        account.mode,
        policy(account.sendPolicy, account.sendPolicyFrom === 'default'),
        policy(account.changePolicy, account.changePolicyFrom === 'default'),
      ],
    })),
  );
  return (
    <ChannelPanel
      product="resend"
      title={channel.title}
      caption={channel.caption}
      heading="Account"
      headers={['Mode', 'Send policy', 'Change policy']}
      list={list}
      empty={channel.empty}
      add={<AddAccount product="resend" />}
      shared={shared}
      again={channel.again}
    />
  );
}

/** WhatsApp's accounts, from its status, which stands as its doctor: whether this machine can read each one's chats. */
function WhatsappAccounts({ shared }: { shared: Shared }) {
  const { result, reload } = useCall<WhatsappStatusResult>({ kind: 'doctor', product: 'whatsapp' });
  useReloadOnReturn(reload);
  const list = rowsOrError('WhatsApp', result, (status) =>
    status.accounts.map((each) => ({
      account: each.account,
      values: [
        <div key="access" className="flex flex-col gap-(--cue-space-1)">
          <span className="text-fg">{each.access.state}</span>
          {each.access.message === undefined ? null : (
            <span className="text-fg-muted">
              <UntrustedText text={each.access.message} />
            </span>
          )}
          {each.access.hint === undefined ? null : (
            <span className="text-fg-muted">
              <UntrustedText text={each.access.hint} />
            </span>
          )}
        </div>,
      ],
    })),
  );
  return (
    <ChannelPanel
      product="whatsapp"
      title="WhatsApp"
      caption="WhatsApp accounts"
      heading="Account"
      headers={['Access']}
      list={list}
      empty="No WhatsApp account is set up."
      shared={shared}
      again={false}
    />
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
    <div className="flex flex-col gap-(--cue-space-1)">
      <span className="text-fg">{actsText(view.allowed)}</span>
      {view.conversations.map((each) => (
        <span key={each.conversation} className="text-fg-muted">
          <UntrustedText text={`${each.conversation}: ${actsText(each.allowed)}`} />
        </span>
      ))}
    </div>
  );
}

/** A row's own buttons: its writing profile (0.22.0), and signing in again (Gmail and Slack), each in Terminal. */
function AccountActions({
  product,
  account,
  again,
  profiles,
}: {
  product: Product;
  account: string;
  again: boolean;
  profiles: boolean;
}) {
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
  if (!profiles && !again) return null;
  return (
    <div className="flex flex-col items-end gap-(--cue-space-1)">
      <div className="flex gap-(--cue-space-2)">
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
      {opening.said}
      {signedIn === null ? null : <TerminalResult outcome={signedIn} />}
      {problem === null ? null : <Problem message={problem} />}
    </div>
  );
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
