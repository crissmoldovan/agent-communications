import {
  Avatar,
  Button,
  Chip,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Row,
  Select,
} from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import type { BehaviourReport, InboxView, LabelReport, LabelRule, WorkspaceView } from '../cli-types.ts';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { NeedsNewerCli } from '../components/NeedsNewerCli.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY, type Screen } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { supports } from '../gates.ts';
import { isAccountName, isConversation } from '../grammar.ts';
import { useCall } from '../hooks/use-call.ts';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { type Call, LABEL_WORDS, type TerminalOutcome } from '../ipc.ts';
import { NavigationProvider, useNavigate } from '../navigation.tsx';
import { ScreenFrame } from './Screen.tsx';

/** The calls this screen changes the label with (0.34.0). */
type LabelChange = Extract<Call, { kind: 'labelWord' | 'labelName' | 'labelRuleAdd' | 'labelRuleRemove' }>;

type Waiting = Extract<ChangeOutcome, { state: 'needsTerminal' }>;

/** The screen's own words (the board `docs/prototypes/2026-10-26-0340-rework/YourAgents.dc.html`). */
export const YOUR_AGENTS_COPY = {
  title: 'Your agents',
  was: 'Called “Agent” before.',
  intro:
    'How the messages your agents write for you look to the people who get them. What agents may do is now set in each account.',
  seen: 'When an agent writes for you, people see this',
  slackCaption:
    'Posted as you, with the tag at the start. Where an account posts as the Agent Comms app instead, Slack shows its APP badge.',
  mailCaption: 'The tag is in the From line, the first thing people read.',
  mailNoName:
    'No name is set here, so the name is the one Gmail’s “Send mail as” gives this address. The tag is in the From line, the first thing people read.',
  sample: 'Thanks, I’ll look at this today.',
  yourName: 'Your name',
  theWord: 'The word after it',
  notSet: 'Not set',
  nameHint: 'Where Slack or Gmail already has a name for you, that one is used; this one is for where they have none.',
  change: 'Change…',
  everyone: 'This changes what everyone you write to sees',
  everyoneApprove: 'This changes what everyone you write to sees. Approve it',
  nameFieldHint:
    'A name can’t hold brackets, quotes, @, commas, colons or semicolons, so nobody can fake a second tag.',
  newName: 'Every message an agent sends from now on carries the new name.',
  newWord: 'Every message an agent sends from now on carries the new word.',
  wordField: 'The word after your name',
  now: 'Now',
  after: 'After',
  next: 'Continue',
  nextHint: 'Next you see exactly what changes, and approve it. On Windows and Linux you approve it in Terminal.',
  approve: 'Approve',
  cancelled: 'Cancelled: nothing was changed.',
  exceptions: 'Exceptions',
  exceptionsIntro:
    'Every message an agent sends carries the tag, except where a line here says to send it as you, with no tag.',
  addException: 'Add an exception…',
  noExceptions: 'None: every message an agent sends is tagged.',
  exceptionsHint:
    'Removing one applies at once. Adding one asks you to approve it, because people would read those messages as if you wrote them yourself.',
  matchesNone: 'matches no account',
  remove: 'Remove',
  asYou: 'Send some messages as you, with no tag?',
  asYouApprove: 'Send some messages as you, with no tag? Approve it',
  takeAway: 'Take this exception away? Approve it',
  which: 'Which messages',
  in: 'In',
  removedAtOnce: 'Removed at once. Those messages carry the tag again.',
  perAccount: 'Per account',
  perAccountIntro:
    'What agents may do in each account, and how their messages look there, is set in that account, under Agents here.',
  open: 'Open in Accounts ›',
  noAccounts: 'No account is connected yet.',
  moved:
    'This screen used to have tabs for behaviour rules and standing approvals. Both are now in each account, under Agents here.',
  confirmInTerminal: 'Confirm it in Terminal. This screen reads it again when you come back to this window.',
  voided: 'That approval had lapsed, so the change was prepared again: look it over, and approve it.',
} as const;

/** The kinds of message an exception may be for, in the board's words: two kinds, or every kind. */
const EXCEPTION_KINDS = [
  { value: 'reaction', label: 'Reactions' },
  { value: 'reply', label: 'Replies' },
  { value: 'all', label: 'Every message' },
] as const;
type ExceptionKind = (typeof EXCEPTION_KINDS)[number]['value'];

/** A kind of message, as a person says it. */
const KIND_WORDS: Record<string, string> = {
  post: 'new posts',
  reply: 'replies',
  reaction: 'reactions',
  edit: 'edits',
  file: 'files',
  send: 'new mail',
};

/** What an agent may start, as a person says it. */
const ACT_VERBS: Record<string, string> = {
  post: 'post',
  reply: 'reply',
  reaction: 'react',
  edit: 'edit',
  delete: 'delete',
  file: 'share files',
  send: 'send',
};

/** `a`, `a and b`, `a, b and c`. */
function listed(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `<name> (<word>)`, with a stand-in where no name is set: the channel's own name for the person. */
function phraseOf(name: string | null, word: string, stand: string): string {
  return `${name ?? stand} (${word})`;
}

/** An exception, in plain words: which messages, where, and whether they go as the person or tagged. */
export function exceptionText(rule: LabelRule): string {
  const where = rule.conversation === undefined ? rule.account : `${rule.account} in ${rule.conversation}`;
  const what = rule.kinds === undefined ? null : listed(rule.kinds.map((kind) => KIND_WORDS[kind] ?? kind));
  if (rule.as === 'me') {
    return what === null
      ? `Every message on ${where} goes as you, without the tag`
      : `${capital(what)} on ${where} go as you, without the tag`;
  }
  return what === null ? `Every message on ${where} carries the tag` : `${capital(what)} on ${where} carry the tag`;
}

/**
 * Your agents (0.34.0, B1; called Agent before): what people see when an agent writes for the person — a Slack message
 * and a mail's From line, made from the label's name and word — then the name and the word, each with Change…; the
 * exceptions to the tag, each with Remove, and Add…; and one line per account, each opening that account.
 *
 * A change goes to core once, without an approval: a tightening — an exception taken away that sent messages untagged —
 * applies there and then; a loosening — a new name or word, an exception that drops the tag — comes back with core's
 * preview, which the person approves here (`ChangePreview`'s `inApp`): the same words again with the approval the app
 * prepared. Where nothing attests the app (Windows and Linux) the preview offers Approve in Terminal instead. An older
 * core shows the label read-only, with the line that asks for an update.
 */
export function YourAgents({ onScreen }: { onScreen: (screen: Screen) => void }) {
  return (
    <NavigationProvider onScreen={onScreen}>
      <Board />
    </NavigationProvider>
  );
}

function Board() {
  const { installation } = useAppData();
  const found = installation.state === 'ready' ? installation.value : null;
  const version = found?.version ?? null;
  const present = found?.present ?? [];
  const canChange = supports(version, 'labelChanges');
  const label = useCall<LabelReport>({ kind: 'label' });
  const behaviour = useCall<BehaviourReport>(supports(version, 'behaviour') ? { kind: 'behaviour' } : null);
  const gmail = useCall<InboxView[]>(present.includes('gmail') ? { kind: 'accounts', product: 'gmail' } : null);
  const slack = useCall<WorkspaceView[]>(present.includes('slack') ? { kind: 'accounts', product: 'slack' } : null);
  useReloadOnReturn(async () => {
    await Promise.all([label.reload(), behaviour.reload(), gmail.reload(), slack.reload()]);
  });
  const inboxes = gmail.result.state === 'ready' && Array.isArray(gmail.result.value) ? gmail.result.value : [];
  const workspaces = slack.result.state === 'ready' && Array.isArray(slack.result.value) ? slack.result.value : [];

  return (
    <ScreenFrame title={YOUR_AGENTS_COPY.title}>
      <p className="text-fg-muted">
        {YOUR_AGENTS_COPY.intro} <span className="text-fg-subtle">{YOUR_AGENTS_COPY.was}</span>
      </p>
      {canChange ? null : <NeedsNewerCli feature="labelChanges" installed={version} />}
      <ScreenState value={label.result}>
        {(report) => (
          <>
            <Seen report={report} inboxes={inboxes} canChange={canChange} reload={label.reload} />
            <Exceptions report={report} canChange={canChange} reload={label.reload} />
            <PerAccount report={report} behaviour={behaviour.result} inboxes={inboxes} workspaces={workspaces} />
            <p className="text-fg-subtle">{YOUR_AGENTS_COPY.moved}</p>
          </>
        )}
      </ScreenState>
    </ScreenFrame>
  );
}

/**
 * One change to the label at a time, and what it came to: applied at once, waiting for the person's approval with
 * core's preview, or refused. `approved` is what the screen says once the person approves it here.
 */
function useLabelChange(reload: () => Promise<void>) {
  const change = useChange();
  const [waiting, setWaiting] = useState<{ change: Waiting; call: LabelChange; approved: string } | null>(null);
  const [said, setSaid] = useState<{ text: string; done: boolean } | null>(null);
  const [refused, setRefused] = useState<{ message: string; hint: string | null } | null>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);

  const clear = () => {
    setSaid(null);
    setRefused(null);
    setOpened(false);
  };

  /** Asks core once; true when it is settled here — applied, or refused — and false while it waits for approval. */
  const run = async (call: LabelChange, words: { applied: string; approved: string }): Promise<boolean> => {
    clear();
    setBusy(true);
    try {
      const outcome = await change.run(call);
      switch (outcome.state) {
        case 'applied': {
          setWaiting(null);
          const data = (typeof outcome.data === 'object' && outcome.data !== null ? outcome.data : {}) as {
            changed?: unknown;
            note?: unknown;
          };
          const note = typeof data.note === 'string' && data.note !== '' ? data.note : null;
          setSaid(
            data.changed === false
              ? { text: note ?? 'Nothing was changed.', done: false }
              : { text: words.applied, done: true },
          );
          await reload();
          return true;
        }
        case 'needsTerminal':
          setWaiting({ change: outcome, call, approved: words.approved });
          return false;
        case 'failed':
          setRefused({ message: outcome.message, hint: outcome.hint });
          return true;
      }
    } finally {
      setBusy(false);
    }
  };

  const preview = (title: string): ReactNode => {
    if (waiting === null) return null;
    const { change: pending, call, approved } = waiting;
    return (
      <div className="flex flex-col gap-(--cue-space-2)">
        <ChangePreview
          key={pending.approvalId}
          change={pending}
          onDone={(done: TerminalOutcome | 'cancelled') => {
            if (done === 'cancelled') {
              setWaiting(null);
              setSaid({ text: YOUR_AGENTS_COPY.cancelled, done: false });
              return;
            }
            setOpened(true);
          }}
          inApp={{
            title,
            approve: YOUR_AGENTS_COPY.approve,
            call: { ...call, appApproval: pending.approvalId },
            failed: (message) => `Nothing was changed: ${message}`,
            onApproved: () => {
              setWaiting(null);
              setSaid({ text: approved, done: true });
              void reload();
            },
            // Spent by core: prepared again, and its new preview shown.
            onVoid: () => {
              setWaiting(null);
              void run(call, { applied: approved, approved }).then((settled) => {
                if (!settled) setSaid({ text: YOUR_AGENTS_COPY.voided, done: false });
              });
            },
          }}
        />
        {opened ? <p className="text-fg-muted">{YOUR_AGENTS_COPY.confirmInTerminal}</p> : null}
      </div>
    );
  };

  const lines = (
    <>
      {said === null ? null : (
        <p
          role="status"
          className={`rounded-control px-(--cue-space-3) py-(--cue-space-2) text-fg ${said.done ? 'bg-ok-subtle' : 'bg-surface-2'}`}
        >
          <UntrustedText text={said.text} />
        </p>
      )}
      {refused === null ? null : (
        <div className="flex flex-col gap-(--cue-space-1)">
          <p role="alert" className="text-danger">
            <UntrustedText text={refused.message} />
          </p>
          {refused.hint === null ? null : (
            <p className="text-fg-muted">
              <UntrustedText text={refused.hint} />
            </p>
          )}
        </div>
      )}
    </>
  );

  return {
    run,
    busy,
    waiting: waiting !== null,
    preview,
    lines,
    cancelled: () => {
      clear();
      setSaid({ text: YOUR_AGENTS_COPY.cancelled, done: false });
    },
    clear,
  };
}

/** A question the screen asks before it prepares a change: its heading, what it means, its fields and buttons. */
function Ask({
  title,
  says,
  children,
  problem,
  busy,
  onNext,
  onCancel,
}: {
  title: string;
  says: string;
  children: ReactNode;
  problem: string | null;
  busy: boolean;
  onNext: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-(--cue-space-3) rounded-surface bg-surface-2 px-(--cue-space-4) py-(--cue-space-4)"
    >
      <div className="flex flex-col gap-(--cue-space-1)">
        <h3 className="font-semibold text-fg">{title}</h3>
        <p className="text-fg-muted">
          <UntrustedText text={says} />
        </p>
      </div>
      {children}
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <Button variant="primary" loading={busy} onClick={onNext}>
          {YOUR_AGENTS_COPY.next}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {COPY.cancel}
        </Button>
        <span className="text-fg-subtle">{YOUR_AGENTS_COPY.nextHint}</span>
      </div>
    </section>
  );
}

/** Now and After, side by side: the tag as it reads, and as it will. */
function NowAfter({ now, after }: { now: string; after: string }) {
  return (
    <div className="grid grid-cols-2 gap-(--cue-space-2)">
      {(
        [
          [YOUR_AGENTS_COPY.now, now],
          [YOUR_AGENTS_COPY.after, after],
        ] as const
      ).map(([term, phrase]) => (
        <div key={term} className="flex min-w-0 flex-col gap-(--cue-space-1)">
          <span className="font-medium text-fg-subtle">{term}</span>
          <span className="rounded-control bg-surface-1 px-(--cue-space-3) py-(--cue-space-2) text-fg">
            <UntrustedText text={`${phrase}: ${YOUR_AGENTS_COPY.sample}`} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** What a name the label cannot carry is, before anything is asked: core says the rest. */
function nameProblem(name: string): string | null {
  if (name === '') return 'Type a name: the tag needs one. Nothing was changed.';
  if (/[()<>"@,;:\\]/.test(name)) return 'A name can’t hold ( ) < > " @ , ; : or \\. Nothing was changed.';
  return null;
}

/**
 * The two previews — a Slack message and a mail's From line — then the name and the word, each with Change…: the
 * question, then core's preview, approved here.
 */
function Seen({
  report,
  inboxes,
  canChange,
  reload,
}: {
  report: LabelReport;
  inboxes: readonly InboxView[];
  canChange: boolean;
  reload: () => Promise<void>;
}) {
  const flow = useLabelChange(reload);
  const [editing, setEditing] = useState<'name' | 'word' | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftWord, setDraftWord] = useState<string>(report.word);
  const [problem, setProblem] = useState<string | null>(null);
  const words = (report.words ?? LABEL_WORDS).filter((word): word is (typeof LABEL_WORDS)[number] =>
    (LABEL_WORDS as readonly string[]).includes(word),
  );

  const slackAccount = report.accounts.find((account) => account.platform === 'slack');
  const mailAccount = report.accounts.find((account) => account.platform === 'gmail');
  const address =
    (mailAccount === undefined ? undefined : inboxes.find((inbox) => inbox.alias === mailAccount.account))?.email ??
    inboxes[0]?.email ??
    'your address';
  const slackPhrase = phraseOf(report.name, report.word, 'Your Slack name');
  const mailPhrase = phraseOf(report.name, report.word, 'Your Gmail name');

  const open = (what: 'name' | 'word') => {
    flow.clear();
    setProblem(null);
    setDraftName(report.name ?? '');
    setDraftWord(report.word);
    setEditing(what);
  };
  const cancel = () => {
    setEditing(null);
    setProblem(null);
    flow.cancelled();
  };
  const next = async () => {
    setProblem(null);
    if (editing === 'name') {
      const name = draftName.trim();
      const wrong = nameProblem(name);
      if (wrong !== null) {
        setProblem(wrong);
        return;
      }
      if (name === report.name) {
        setProblem('Nothing to change: that is your name already.');
        return;
      }
      const reads = phraseOf(name, report.word, name);
      await flow.run(
        { kind: 'labelName', name },
        { applied: `Changed. From now on, agents’ messages read “${reads}”.`, approved: approvedLine(reads) },
      );
      setEditing(null);
      return;
    }
    if (editing === 'word') {
      const word = words.find((each) => each === draftWord);
      if (word === undefined || word === report.word) {
        setProblem('Nothing to change: that is the word already.');
        return;
      }
      const reads = phraseOf(report.name, word, 'Your name');
      await flow.run(
        { kind: 'labelWord', word },
        { applied: `Changed. From now on, agents’ messages read “${reads}”.`, approved: approvedLine(reads) },
      );
      setEditing(null);
    }
  };

  const nowPhrase = phraseOf(report.name, report.word, 'Your name');
  const afterPhrase =
    editing === 'name'
      ? phraseOf(draftName.trim() === '' ? report.name : draftName.trim(), report.word, 'Your name')
      : phraseOf(report.name, draftWord, 'Your name');

  return (
    <SectionPanel title={YOUR_AGENTS_COPY.seen}>
      <div className="grid grid-cols-1 gap-(--cue-space-4) md:grid-cols-2">
        <figure aria-label="In Slack" className="m-0 flex min-w-0 flex-col gap-(--cue-space-2)">
          <span className="font-medium text-fg-subtle">
            {slackAccount === undefined ? 'In Slack' : `In Slack · ${slackAccount.account}`}
          </span>
          <div className="flex items-start gap-(--cue-space-3) rounded-surface bg-surface-2 p-(--cue-space-3)">
            <span aria-hidden="true" className="flex shrink-0">
              <Avatar fallback={(report.name ?? 'Y').charAt(0)} />
            </span>
            <div className="flex min-w-0 flex-col gap-(--cue-space-1)">
              <span className="font-semibold text-fg">
                <UntrustedText text={report.name ?? 'Your Slack name'} />
              </span>
              <span className="text-fg">
                <span className="font-semibold">
                  <UntrustedText text={`${slackPhrase}:`} />
                </span>{' '}
                {YOUR_AGENTS_COPY.sample}
              </span>
            </div>
          </div>
          <figcaption className="text-fg-subtle">{YOUR_AGENTS_COPY.slackCaption}</figcaption>
        </figure>
        <figure aria-label="In mail" className="m-0 flex min-w-0 flex-col gap-(--cue-space-2)">
          <span className="font-medium text-fg-subtle">
            {mailAccount === undefined ? 'In mail' : `In mail · ${mailAccount.account}`}
          </span>
          <div className="flex flex-col gap-(--cue-space-1) rounded-surface bg-surface-2 p-(--cue-space-3)">
            <MailLine term="From">
              <UntrustedText text={`"${mailPhrase}" <${address}>`} />
            </MailLine>
            <MailLine term="To">Someone &lt;someone@example.com&gt;</MailLine>
            <MailLine term="Subject">Re: Thursday’s review</MailLine>
            <span className="mt-(--cue-space-1) border-border border-t pt-(--cue-space-2) text-fg">
              {YOUR_AGENTS_COPY.sample}
            </span>
          </div>
          <figcaption className="text-fg-subtle">
            {report.name === null ? YOUR_AGENTS_COPY.mailNoName : YOUR_AGENTS_COPY.mailCaption}
          </figcaption>
        </figure>
      </div>
      <div className="grid grid-cols-1 gap-(--cue-space-3) md:grid-cols-2">
        <Fact term={YOUR_AGENTS_COPY.yourName}>
          <span className="min-w-0 flex-1 font-medium text-fg">
            {report.name === null ? (
              <span className="text-fg-muted">{YOUR_AGENTS_COPY.notSet}</span>
            ) : (
              <UntrustedText text={report.name} />
            )}
          </span>
          {canChange ? (
            <Button size="sm" disabled={flow.busy} onClick={() => open('name')}>
              {YOUR_AGENTS_COPY.change} <span className="sr-only">your name</span>
            </Button>
          ) : null}
        </Fact>
        <Fact term={YOUR_AGENTS_COPY.theWord}>
          <span className="min-w-0 flex-1 font-medium text-fg">{report.word}</span>
          {canChange ? (
            <Button size="sm" disabled={flow.busy} onClick={() => open('word')}>
              {YOUR_AGENTS_COPY.change} <span className="sr-only">the word</span>
            </Button>
          ) : null}
        </Fact>
      </div>
      <p className="text-fg-subtle">{YOUR_AGENTS_COPY.nameHint}</p>
      {editing === 'name' ? (
        <Ask
          title={YOUR_AGENTS_COPY.everyone}
          says={YOUR_AGENTS_COPY.newName}
          problem={problem}
          busy={flow.busy}
          onNext={() => void next()}
          onCancel={cancel}
        >
          <Field name="name" invalid={problem !== null}>
            <FieldLabel>{YOUR_AGENTS_COPY.yourName}</FieldLabel>
            <Input
              value={draftName}
              onChange={(event) => {
                setDraftName(event.target.value);
                setProblem(null);
              }}
            />
            <FieldDescription>{YOUR_AGENTS_COPY.nameFieldHint}</FieldDescription>
            <FieldError issues={[]} />
          </Field>
          <NowAfter now={nowPhrase} after={afterPhrase} />
        </Ask>
      ) : null}
      {editing === 'word' ? (
        <Ask
          title={YOUR_AGENTS_COPY.everyone}
          says={YOUR_AGENTS_COPY.newWord}
          problem={problem}
          busy={flow.busy}
          onNext={() => void next()}
          onCancel={cancel}
        >
          <Field name="word">
            <FieldLabel>{YOUR_AGENTS_COPY.wordField}</FieldLabel>
            <Select
              aria-label={YOUR_AGENTS_COPY.wordField}
              items={words.map((word) => ({ value: word, label: word }))}
              value={draftWord}
              onValueChange={(value) => {
                if (value !== null) setDraftWord(value);
                setProblem(null);
              }}
            />
          </Field>
          <NowAfter now={nowPhrase} after={afterPhrase} />
        </Ask>
      ) : null}
      {flow.preview(YOUR_AGENTS_COPY.everyoneApprove)}
      {flow.lines}
    </SectionPanel>
  );
}

const approvedLine = (reads: string): string => `Approved. From now on, agents’ messages read “${reads}”.`;

function MailLine({ term, children }: { term: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 gap-(--cue-space-2)">
      <span className="w-14 shrink-0 text-fg-subtle">{term}</span>
      <span className="min-w-0 break-words text-fg">{children}</span>
    </span>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--cue-space-2) rounded-surface bg-surface-2 px-(--cue-space-3) py-(--cue-space-3)">
      <span className="font-medium text-fg-subtle">{term}</span>
      <div className="flex min-h-control-md items-center gap-(--cue-space-2)">{children}</div>
    </div>
  );
}

/** A rule's kinds as `--kinds` takes them, or none for every kind; null when one is not a kind the app passes on. */
function kindsWord(kinds: readonly string[] | undefined): string | undefined | null {
  if (kinds === undefined) return undefined;
  if (kinds.length === 0 || kinds.some((kind) => !(kind in KIND_WORDS))) return null;
  return kinds.join(',');
}

/**
 * The exceptions to the tag (`label rule`): each with Remove — taking one away that sent messages as the person applies
 * at once — and Add an exception…, which sends some messages as the person with no tag, and is approved here first.
 */
function Exceptions({
  report,
  canChange,
  reload,
}: {
  report: LabelReport;
  canChange: boolean;
  reload: () => Promise<void>;
}) {
  const flow = useLabelChange(reload);
  const [adding, setAdding] = useState(false);
  const labelled = report.accounts.filter((account) => account.kinds.length > 0);
  const [account, setAccount] = useState<string | null>(null);
  const [kind, setKind] = useState<ExceptionKind>('reaction');
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // What the change waiting for approval does: an exception added, or one taken away that kept the tag.
  const [asking, setAsking] = useState<'add' | 'remove'>('add');
  const chosen = account ?? labelled[0]?.account ?? null;

  const draft: LabelRule | null =
    chosen === null ? null : { account: chosen, as: 'me', ...(kind === 'all' ? {} : { kinds: [kind] }) };
  const what =
    kind === 'all' ? 'every message agents send' : kind === 'reaction' ? 'agents’ reactions' : 'agents’ replies';
  const says =
    chosen === null
      ? 'No account here labels what agents send.'
      : `People will read ${what} on ${chosen} as if you wrote them yourself, with no “(${report.word})”.`;

  const add = async () => {
    setProblem(null);
    if (draft === null || chosen === null || !isAccountName(chosen)) {
      setProblem('Choose an account.');
      return;
    }
    const view = labelled.find((each) => each.account === chosen);
    if (kind !== 'all' && view !== undefined && !view.kinds.some((each) => each.kind === kind)) {
      setProblem(
        `${view.channel} has no ${KIND_WORDS[kind]} for agents to send. Choose ${kind === 'reaction' ? 'replies' : 'reactions'}, or every message.`,
      );
      return;
    }
    const text = exceptionText(draft);
    setAsking('add');
    await flow.run(
      { kind: 'labelRuleAdd', account: chosen, as: 'me', ...(kind === 'all' ? {} : { kinds: kind }) },
      { applied: `Changed. ${text}.`, approved: `Approved. ${text}.` },
    );
    setAdding(false);
  };

  const remove = async (rule: LabelRule, key: string) => {
    flow.clear();
    setAdding(false);
    const kinds = kindsWord(rule.kinds);
    if (
      !isAccountName(rule.account) ||
      (rule.conversation !== undefined && !isConversation(rule.conversation)) ||
      kinds === null
    ) {
      setProblem('This exception names a place that cannot be passed on safely.');
      return;
    }
    setProblem(null);
    setAsking('remove');
    setRemoving(key);
    try {
      await flow.run(
        {
          kind: 'labelRuleRemove',
          account: rule.account,
          as: rule.as,
          ...(rule.conversation === undefined ? {} : { conversation: rule.conversation }),
          ...(kinds === undefined ? {} : { kinds }),
        },
        {
          applied:
            rule.as === 'me' ? YOUR_AGENTS_COPY.removedAtOnce : `Removed at once. ${exceptionText(rule)} no longer.`,
          approved: `Approved. ${exceptionText(rule)} no longer.`,
        },
      );
    } finally {
      setRemoving(null);
    }
  };

  const adds = canChange && labelled.length > 0;
  return (
    <SectionPanel
      title={YOUR_AGENTS_COPY.exceptions}
      actions={
        adds ? (
          <Button
            size="sm"
            disabled={flow.busy}
            onClick={() => {
              flow.clear();
              setProblem(null);
              setKind('reaction');
              setAccount(null);
              setAdding(true);
            }}
          >
            {YOUR_AGENTS_COPY.addException}
          </Button>
        ) : undefined
      }
    >
      <p className="text-fg-muted">{YOUR_AGENTS_COPY.exceptionsIntro}</p>
      {report.rules.length === 0 ? (
        <p className="rounded-control bg-surface-2 px-(--cue-space-3) py-(--cue-space-2) text-fg-muted">
          {YOUR_AGENTS_COPY.noExceptions}
        </p>
      ) : (
        <ul aria-label={YOUR_AGENTS_COPY.exceptions} className="flex flex-col">
          {report.rules.map((each) => {
            const key = `${each.text}`;
            return (
              <li key={key} className="border-border border-t first:border-t-0">
                <Row>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-(--cue-space-2) text-fg">
                    <UntrustedText text={each.rule === undefined ? each.text : exceptionText(each.rule)} />
                    {each.matches ? null : (
                      <Chip tone="warn" variant="tag">
                        {YOUR_AGENTS_COPY.matchesNone}
                      </Chip>
                    )}
                  </span>
                  {canChange && each.rule !== undefined ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={removing === key}
                      disabled={flow.busy && removing !== key}
                      onClick={() => {
                        if (each.rule !== undefined) void remove(each.rule, key);
                      }}
                    >
                      {YOUR_AGENTS_COPY.remove}
                    </Button>
                  ) : null}
                </Row>
              </li>
            );
          })}
        </ul>
      )}
      {canChange ? <p className="text-fg-subtle">{YOUR_AGENTS_COPY.exceptionsHint}</p> : null}
      {adding ? (
        <Ask
          title={YOUR_AGENTS_COPY.asYou}
          says={says}
          problem={problem}
          busy={flow.busy}
          onNext={() => void add()}
          onCancel={() => {
            setAdding(false);
            setProblem(null);
            flow.cancelled();
          }}
        >
          <div className="grid grid-cols-2 gap-(--cue-space-3)">
            <Field name="kinds">
              <FieldLabel>{YOUR_AGENTS_COPY.which}</FieldLabel>
              <Select
                aria-label={YOUR_AGENTS_COPY.which}
                items={EXCEPTION_KINDS.map((each) => ({ value: each.value, label: each.label }))}
                value={kind}
                onValueChange={(value) => {
                  const found = EXCEPTION_KINDS.find((each) => each.value === value);
                  if (found !== undefined) setKind(found.value);
                  setProblem(null);
                }}
              />
            </Field>
            <Field name="account">
              <FieldLabel>{YOUR_AGENTS_COPY.in}</FieldLabel>
              <Select
                aria-label={YOUR_AGENTS_COPY.in}
                items={labelled.map((each) => ({ value: each.account, label: each.account }))}
                value={chosen}
                onValueChange={(value) => {
                  setAccount(value);
                  setProblem(null);
                }}
              />
            </Field>
          </div>
        </Ask>
      ) : problem === null ? null : (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      )}
      {flow.preview(asking === 'add' ? YOUR_AGENTS_COPY.asYouApprove : YOUR_AGENTS_COPY.takeAway)}
      {flow.lines}
    </SectionPanel>
  );
}

/** What agents may do on an account (`behaviour`), in a sentence; null when it was not read. */
function mayText(behaviour: Loadable<BehaviourReport>, account: string): string | null {
  if (behaviour.state !== 'ready') return null;
  const view = behaviour.value.accounts.find((each) => each.account === account);
  if (view === undefined) return null;
  const acts = (allowed: readonly string[] | 'all', only: boolean): string =>
    allowed === 'all'
      ? 'anything this account allows'
      : allowed.length === 0
        ? 'nothing'
        : `${only ? 'only ' : ''}${listed(allowed.map((act) => ACT_VERBS[act] ?? act))}`;
  const base =
    view.allowed === 'all'
      ? 'Agents may do anything this account allows'
      : view.allowed.length === 0
        ? 'Agents may do nothing here'
        : `Agents may ${acts(view.allowed, false)}`;
  const places = view.conversations.map((each) => `in ${each.conversation}, ${acts(each.allowed, true)}`);
  return `${[base, ...places].join('; ')}.`;
}

/** How agents' messages look on an account (`label`), in a sentence. */
function looksText(view: LabelReport['accounts'][number]): string | null {
  if (view.style !== undefined) {
    if (view.appRoute === false || view.style === 'labelled') return 'Their messages go as you, tagged.';
    return 'Their messages go as the Agent Comms app, with Slack’s APP badge, where it can post; elsewhere as you, tagged.';
  }
  if (view.kinds.length === 0) return view.note ?? null;
  const untagged = view.kinds
    .filter((kind) => kind.identity === 'me')
    .map((kind) => KIND_WORDS[kind.kind] ?? kind.kind);
  if (untagged.length === view.kinds.length) return 'Their messages go as you, with no tag.';
  const tagged =
    view.phrase === null ? 'Their mail carries the tag in the From line' : `The From line reads “${view.phrase}”`;
  return untagged.length === 0 ? `${tagged}.` : `${tagged}, except ${listed(untagged)}, which go as you.`;
}

/** One line per account: what agents may do there and how they look, each opening that account in Accounts. */
function PerAccount({
  report,
  behaviour,
  inboxes,
  workspaces,
}: {
  report: LabelReport;
  behaviour: Loadable<BehaviourReport>;
  inboxes: readonly InboxView[];
  workspaces: readonly WorkspaceView[];
}) {
  const navigate = useNavigate();
  return (
    <SectionPanel title={YOUR_AGENTS_COPY.perAccount}>
      <p className="text-fg-muted">{YOUR_AGENTS_COPY.perAccountIntro}</p>
      {report.accounts.length === 0 ? (
        <p className="text-fg-muted">{YOUR_AGENTS_COPY.noAccounts}</p>
      ) : (
        <ul aria-label={YOUR_AGENTS_COPY.perAccount} className="flex flex-col">
          {report.accounts.map((view) => {
            const detail =
              view.platform === 'gmail'
                ? inboxes.find((inbox) => inbox.alias === view.account)?.email
                : view.platform === 'slack'
                  ? workspaces.find((workspace) => workspace.alias === view.account)?.workspaceName
                  : undefined;
            const summary = [mayText(behaviour, view.account), looksText(view)]
              .filter((part): part is string => part !== null)
              .join(' ');
            return (
              <li key={view.account}>
                <Row
                  interactive
                  className="items-start rounded-control"
                  aria-label={`${view.account}: open in Accounts`}
                  disabled={navigate === null}
                  onClick={() => navigate?.({ screen: 'accounts', account: view.account })}
                >
                  <span aria-hidden="true" className="flex shrink-0">
                    <Avatar fallback={view.account.charAt(0)} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1) text-left">
                    <span className="flex flex-wrap items-center gap-x-(--cue-space-2)">
                      <span className="font-medium text-fg">{view.account}</span>
                      <span className="text-fg-subtle">
                        <UntrustedText text={detail === undefined ? view.channel : `${view.channel} · ${detail}`} />
                      </span>
                    </span>
                    {summary === '' ? null : (
                      <span className="text-fg-muted">
                        <UntrustedText text={summary} />
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true" className="shrink-0 font-medium text-accent">
                    {YOUR_AGENTS_COPY.open}
                  </span>
                </Row>
              </li>
            );
          })}
        </ul>
      )}
    </SectionPanel>
  );
}
