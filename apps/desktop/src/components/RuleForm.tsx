import {
  Button,
  Checkbox,
  CheckboxGroup,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  InfoTip,
  Input,
  SectionHeader,
  Select,
} from '@cueplusplus/ui';
import { type FormEvent, useState } from 'react';
import { accountNameSchema, actsSchema, conversationSchema, KNOWN_ACTS } from '../grammar.ts';
import { type Call, formatActs } from '../ipc.ts';

type Issue = { message: string };

type BehaviourAllow = Extract<Call, { kind: 'behaviourAllow' }>;

/** What a conversation may be: said on hover or focus beside its label, since the placeholder shows the forms. */
export const CONVERSATION_HINT = 'A Slack channel or person id, or an address or @domain.';

/** What the acts are: said on hover or focus beside their label. */
export const ACTS_HINT = 'What an agent may start there.';

const NONE: { account: Issue[]; conversation: Issue[]; acts: Issue[] } = { account: [], conversation: [], acts: [] };

function issuesOf(schema: typeof accountNameSchema, value: string): Issue[] {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => ({ message: issue.message }));
}

/**
 * Adds a behaviour rule, or changes the one a place has (DA5.4): an account, an optional conversation, and the acts an
 * agent may start there — none ticked allows nothing. Every value is checked against the grammars Rust checks again,
 * and nothing is sent until each passes. Whether it applies here or waits for Terminal is the CLI's to say, and the
 * screen's to show: this only builds `behaviourAllow`.
 */
export function RuleForm({
  accounts,
  onSubmit,
}: {
  /** The accounts that act on other people, as `behaviour` lists them. */
  accounts: readonly string[];
  onSubmit: (call: BehaviourAllow) => Promise<void>;
}) {
  const [account, setAccount] = useState<string | null>(null);
  const [conversation, setConversation] = useState('');
  const [acts, setActs] = useState<string[]>([]);
  const [issues, setIssues] = useState(NONE);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // In the list's order, each once: the same rule is asked for the same way however it was ticked.
    const ordered = formatActs(KNOWN_ACTS.filter((act) => acts.includes(act)));
    const place = conversation.trim();
    const found = {
      account: account === null ? [{ message: 'Choose an account.' }] : issuesOf(accountNameSchema, account),
      conversation: place === '' ? [] : issuesOf(conversationSchema, place),
      acts: issuesOf(actsSchema, ordered),
    };
    setIssues(found);
    if (account === null || found.account.length + found.conversation.length + found.acts.length > 0) return;
    setBusy(true);
    try {
      await onSubmit({
        kind: 'behaviourAllow',
        account,
        acts: ordered,
        ...(place === '' ? {} : { conversation: place }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label="Add or change a rule"
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-(--cue-space-4) p-(--cue-space-5)"
    >
      <SectionHeader label="Add or change a rule" />
      <div className="grid grid-cols-2 gap-(--cue-space-4)">
        <Field name="account" invalid={issues.account.length > 0}>
          <FieldLabel>Account</FieldLabel>
          <Select
            aria-label="Account"
            items={accounts.map((each) => ({ value: each, label: each }))}
            value={account}
            placeholder="Choose an account"
            onValueChange={(value) => {
              setAccount(value);
              setIssues((current) => ({ ...current, account: [] }));
            }}
          />
          <FieldError issues={issues.account} />
        </Field>
        <Field name="conversation" invalid={issues.conversation.length > 0}>
          <span className="flex items-center gap-(--cue-space-2)">
            <FieldLabel>Conversation</FieldLabel>
            <InfoTip label="About the conversation" text={CONVERSATION_HINT} />
          </span>
          <Input
            value={conversation}
            placeholder="C0123ABCD, someone@example.com or @example.com"
            onChange={(event) => {
              setConversation(event.target.value);
              setIssues((current) => ({ ...current, conversation: [] }));
            }}
          />
          <FieldDescription>Optional. Leave it empty for the whole account.</FieldDescription>
          <FieldError issues={issues.conversation} />
        </Field>
      </div>
      <Field name="acts" invalid={issues.acts.length > 0}>
        <span className="flex items-center gap-(--cue-space-2)">
          <FieldLabel>Acts</FieldLabel>
          <InfoTip label="About the acts" text={ACTS_HINT} />
        </span>
        <CheckboxGroup
          aria-label="Acts"
          className="flex-row flex-wrap gap-x-(--cue-space-5)"
          value={acts}
          onValueChange={(value) => setActs([...value])}
        >
          {KNOWN_ACTS.map((act) => (
            <Checkbox key={act} value={act} label={act} />
          ))}
        </CheckboxGroup>
        <FieldDescription>Tick none to allow nothing.</FieldDescription>
        <FieldError issues={issues.acts} />
      </Field>
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          Save rule
        </Button>
      </div>
    </form>
  );
}
