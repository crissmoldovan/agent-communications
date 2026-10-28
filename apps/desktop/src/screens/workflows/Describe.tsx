/**
 * Describe it (workflows design §11.4, W21, the approved prototype's Describe board): in the designer, the person says
 * what should happen in their own words, and picks who drafts it — their own Claude subscription (`claude` on this Mac,
 * signed in), the default, or OpenRouter or Anthropic with the key kept for Analyse. What is sent is said under the box
 * before anything is sent. The draft comes back into the three views like any edit, with where each step came from —
 * the person's words it quotes, or "Added by the model, not from your words." — its questions with their choices, and
 * its checks. An answer goes into the next round with the current draft, so each round changes only what it must.
 *
 * Nothing is saved: the draft becomes a version only when the person saves it, and runs only once they approve it.
 * Everything the model wrote — the draft, its notes, its questions and their choices — is outside text, shown as such.
 */
import {
  Button,
  Chip,
  Field,
  FieldDescription,
  FieldLabel,
  Panel,
  Radio,
  RadioGroup,
  Spinner,
  Textarea,
} from '@cueplusplus/ui';
import { Sparkles } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { type DescribeAnswer, type DescribeProvider, type DescribeRequest, errorMessage } from '../../ipc.ts';
import { isObject, type JsonObject } from '../../rule-editor/model.ts';
import { parseRuleText, printRuleText } from '../../rule-text.ts';
import { readDescribe, type WorkflowDescribeResultV1 } from '../../workflows/types.ts';
import { FromOutsideMark, Problem, SenderText } from '../events/parts.tsx';

export const DESCRIBE_COPY = {
  open: 'Describe it…',
  title: 'Describe it',
  lead: 'Say what should happen, in your words.',
  words: 'Your words',
  wordsHint: 'Which messages, what should happen to them, and what you want to hear back. At most 4,000 characters.',
  example: 'An example message, if it helps',
  exampleHint:
    'Pasted text is sent marked as an example, inside the untrusted-content envelope: never as instructions.',
  who: 'Who drafts it',
  providers: {
    'claude-cli': 'Your Claude subscription: Claude Code on this Mac, signed in',
    openrouter: 'OpenRouter, with the key kept for Analyse',
    anthropic: 'Anthropic, with the key kept for Analyse',
  } satisfies Record<DescribeProvider, string>,
  sent: 'What is sent',
  sentLine:
    'Your words and your answers; a fixed brief and the workflow text’s words; the names a draft may use — your accounts, lanes, judges, targets, projects and namespaces, the step event words, and the Linear teams, labels and states your workflows name; and, when you ask again, the current draft, its folders, addresses and templates replaced by placeholders that are put back in what comes back. A draft that does not read as a workflow goes as you wrote it, for the model to fix.',
  neverLine:
    'Never a message, unless you paste one above, and then marked as an example. Never a project’s profile or folders, a count, an address, a template, a subscriber or a key.',
  draft: 'Draft it',
  again: 'Draft it again',
  drafting: 'Drafting… your Claude can take up to two minutes.',
  drafted: (provider: string) =>
    `Drafted by ${provider}. It is in the canvas, the text and the JSON; nothing is saved until you save it.`,
  byProvider: {
    'claude-cli': 'your Claude subscription',
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic',
  } satisfies Record<DescribeProvider, string>,
  steps: 'Where each step came from',
  fromWords: 'From your words:',
  added: 'Added by the model, not from your words.',
  questions: 'Its questions',
  answer: 'Your answer',
  answered: (count: number) =>
    count === 1 ? '1 answer goes with the next draft.' : `${count} answers go with the next draft.`,
  mistakes: 'The draft does not read as a workflow yet',
  mistake: (line: number) => `Line ${line}:`,
  problems: 'To fix before it can run',
  raw: 'The model’s text',
  close: 'Close',
  tooMany: 'At most 4,000 characters.',
  unreadable: 'The draft could not be read.',
} as const;

const PROVIDERS: readonly DescribeProvider[] = ['claude-cli', 'openrouter', 'anthropic'];
const WORDS_MAX = 4000;
const ANSWERS_MAX = 5;

const WORD_END = /[\p{L}\p{N}\p{M}]$/u;
const WORD_START = /^[\p{L}\p{N}\p{M}]/u;

/**
 * Whether a note's words are the person's own (security review of 0.36.0, L7), as the event service reads them: at
 * least 12 characters and three words, found at word boundaries in `sources` — the person's description and the answers
 * they typed. A choice the model offered is never among them, so a step quoting one is "Added by the model".
 */
export function quotesPerson(words: string, sources: readonly string[]): boolean {
  const quote = words.trim();
  if ([...quote].length < 12 || quote.split(/\s+/u).length < 3) return false;
  return sources.some((source) => {
    for (let at = source.indexOf(quote); at !== -1; at = source.indexOf(quote, at + 1))
      if (!WORD_END.test(source.slice(0, at)) && !WORD_START.test(source.slice(at + quote.length))) return true;
    return false;
  });
}

/** A document's steps: its flow's, in the order written. */
function stepIdsOf(document: JsonObject): string[] {
  return isObject(document.flow) && isObject(document.flow.steps) ? Object.keys(document.flow.steps) : [];
}

export function Describe({
  ruleId,
  version,
  document,
  onDraft,
  startOpen = false,
}: {
  ruleId: string;
  version: number;
  /** The workflow as it stands: sent along when asking again. */
  document: JsonObject;
  /** Puts a draft into the editor, as any edit: it is saved nowhere. */
  onDraft: (next: JsonObject) => void;
  startOpen?: boolean;
}) {
  const bridge = useBridge();
  const titleId = useId();
  const [open, setOpen] = useState(startOpen);
  const [words, setWords] = useState('');
  const [example, setExample] = useState('');
  const [provider, setProvider] = useState<DescribeProvider>('claude-cli');
  const [answers, setAnswers] = useState<DescribeAnswer[]>([]);
  const [result, setResult] = useState<WorkflowDescribeResultV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<string[]>([]);
  /** What the person wrote for the round shown: their words, and the answers they typed rather than picked. */
  const [ownWords, setOwnWords] = useState<string[]>([]);

  // A new round starts from the answers the person gave this one.
  useEffect(() => {
    if (result !== null) setAnswers([]);
  }, [result]);

  const tooLong = [...words].length > WORDS_MAX || [...example].length > WORDS_MAX;
  const ready = words.trim() !== '' && !tooLong && !busy;

  const draft = async () => {
    setBusy(true);
    setProblem(null);
    const sent = answers.slice(0, ANSWERS_MAX);
    // An answer that is one of the choices the model offered is the model's words, not the person's (L7).
    const typed = sent.filter(
      (entry) =>
        !(result?.questions ?? []).some(
          (question) => question.question === entry.question && question.choices.includes(entry.answer),
        ),
    );
    const request: DescribeRequest = {
      words,
      ...(example.trim() === '' ? {} : { example }),
      ...(sent.length === 0 ? {} : { answers: sent }),
      // Asking again sends the current draft, so the next round changes only what it must.
      ...(result === null ? {} : { draft: printRuleText(document) }),
    };
    try {
      const reply = await bridge.cli({ kind: 'eventsWorkflowDescribe', request, provider });
      if (reply.status !== 'ok') {
        setProblem(
          reply.status === 'failed' ? [reply.message, reply.hint].filter(Boolean).join(' ') : DESCRIBE_COPY.unreadable,
        );
        return;
      }
      let read: WorkflowDescribeResultV1;
      try {
        read = readDescribe(reply.data);
      } catch {
        setProblem(DESCRIBE_COPY.unreadable);
        return;
      }
      setOwnWords([words, ...typed.map((entry) => entry.answer)]);
      setResult(read);
      const parsed = read.parse.ok ? parseRuleText(read.text) : null;
      if (parsed?.ok === true) {
        // The draft keeps this workflow's name and its next version, whatever the model wrote at its top.
        const next = { ...(parsed.doc as JsonObject), ruleId, version };
        setDrafted(stepIdsOf(next));
        onDraft(next);
      } else setDrafted([]);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const answer = (question: string, value: string) => {
    const rest = answers.filter((entry) => entry.question !== question);
    setAnswers(value.trim() === '' ? rest : [...rest, { question, answer: value }].slice(0, ANSWERS_MAX));
  };

  if (!open)
    return (
      <div>
        <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => setOpen(true)}>
          {DESCRIBE_COPY.open}
        </Button>
      </div>
    );

  const notes = new Map((result?.notes ?? []).map((note) => [note.step, note.words]));
  const steps =
    drafted.length > 0
      ? drafted
      : [...new Set([...(result?.notes ?? []).map((note) => note.step), ...(result?.unnoted ?? [])])];
  return (
    <section aria-labelledby={titleId}>
      <Panel className="flex flex-col gap-(--cue-space-4) p-(--cue-space-4)">
        <div className="flex items-center gap-(--cue-space-2)">
          <h3 id={titleId} className="font-semibold text-fg">
            {DESCRIBE_COPY.title}
          </h3>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(false)}>
            {DESCRIBE_COPY.close}
          </Button>
        </div>
        <p className="text-fg">{DESCRIBE_COPY.lead}</p>
        <Field name="describe-words" invalid={[...words].length > WORDS_MAX}>
          <FieldLabel>{DESCRIBE_COPY.words}</FieldLabel>
          <Textarea rows={4} value={words} onChange={(event) => setWords(event.target.value)} />
          <FieldDescription>{DESCRIBE_COPY.wordsHint}</FieldDescription>
        </Field>
        <Field name="describe-example" invalid={[...example].length > WORDS_MAX}>
          <FieldLabel>{DESCRIBE_COPY.example}</FieldLabel>
          <Textarea rows={2} value={example} onChange={(event) => setExample(event.target.value)} />
          <FieldDescription>{DESCRIBE_COPY.exampleHint}</FieldDescription>
        </Field>
        <RadioGroup
          aria-label={DESCRIBE_COPY.who}
          value={provider}
          onValueChange={(value) => setProvider(value as DescribeProvider)}
        >
          {PROVIDERS.map((each) => (
            <Radio key={each} value={each} label={DESCRIBE_COPY.providers[each]} />
          ))}
        </RadioGroup>
        <section
          aria-label={DESCRIBE_COPY.sent}
          className="flex flex-col gap-(--cue-space-1) rounded-control bg-surface-2 p-(--cue-space-3)"
        >
          <h4 className="font-medium text-(length:--cue-text-label) text-fg-muted">{DESCRIBE_COPY.sent}</h4>
          <p className="text-(length:--cue-text-ui) text-fg">{DESCRIBE_COPY.sentLine}</p>
          <p className="text-(length:--cue-text-ui) text-fg-muted">{DESCRIBE_COPY.neverLine}</p>
        </section>
        {tooLong ? <p className="text-warn">{DESCRIBE_COPY.tooMany}</p> : null}
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void draft()}>
            {result === null ? DESCRIBE_COPY.draft : DESCRIBE_COPY.again}
          </Button>
          {answers.length === 0 ? null : (
            <span className="text-(length:--cue-text-label) text-fg-muted">
              {DESCRIBE_COPY.answered(answers.length)}
            </span>
          )}
        </div>
        {busy ? <Spinner size="sm" label={DESCRIBE_COPY.drafting} /> : null}
        {problem === null ? null : <Problem message={problem} />}
        {result === null ? null : (
          <div className="flex flex-col gap-(--cue-space-4)" data-slot="describe-result">
            {drafted.length > 0 ? (
              <p role="status" className="text-fg">
                {DESCRIBE_COPY.drafted(DESCRIBE_COPY.byProvider[result.model.provider])}
                {result.model.model === null ? null : (
                  <>
                    {' '}
                    <Chip tone="neutral" variant="tag">
                      <UntrustedText text={result.model.model} />
                    </Chip>
                  </>
                )}
              </p>
            ) : null}
            {steps.length === 0 ? null : (
              <section aria-label={DESCRIBE_COPY.steps} className="flex flex-col gap-(--cue-space-2)">
                <h4 className="flex items-center gap-(--cue-space-2) font-medium text-(length:--cue-text-label) text-fg-muted">
                  {DESCRIBE_COPY.steps} <FromOutsideMark />
                </h4>
                <ul className="flex flex-col gap-(--cue-space-1)">
                  {steps.map((step) => {
                    const noted = notes.get(step);
                    const said = noted !== undefined && quotesPerson(noted, ownWords) ? noted : undefined;
                    return (
                      <li
                        key={step}
                        data-describe-step={step}
                        className="flex flex-wrap items-baseline gap-x-(--cue-space-2)"
                      >
                        <span className="font-mono text-fg">
                          <UntrustedText text={step} />
                        </span>
                        {said === undefined ? (
                          <span className="text-warn">{DESCRIBE_COPY.added}</span>
                        ) : (
                          <span className="text-fg-muted">
                            {DESCRIBE_COPY.fromWords} <SenderText text={said} />
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {result.questions.length === 0 ? null : (
              <section aria-label={DESCRIBE_COPY.questions} className="flex flex-col gap-(--cue-space-3)">
                <h4 className="flex items-center gap-(--cue-space-2) font-medium text-(length:--cue-text-label) text-fg-muted">
                  {DESCRIBE_COPY.questions} <FromOutsideMark />
                </h4>
                {result.questions.map((question) => {
                  const given = answers.find((entry) => entry.question === question.question)?.answer ?? '';
                  return (
                    <div key={question.question} data-describe-question className="flex flex-col gap-(--cue-space-2)">
                      <p className="text-fg">
                        <SenderText text={question.question} />
                      </p>
                      {question.choices.length === 0 ? null : (
                        <div className="flex flex-wrap gap-(--cue-space-2)">
                          {question.choices.map((choice) => (
                            <button
                              key={choice}
                              type="button"
                              aria-pressed={given === choice}
                              onClick={() => answer(question.question, given === choice ? '' : choice)}
                              className="rounded-control border border-border px-(--cue-space-2) py-(--cue-space-1) text-(length:--cue-text-label) text-fg hover:bg-surface-2 aria-pressed:border-accent aria-pressed:bg-accent-soft"
                            >
                              <SenderText text={choice} />
                            </button>
                          ))}
                        </div>
                      )}
                      <Textarea
                        aria-label={`${DESCRIBE_COPY.answer}: ${question.question}`}
                        rows={1}
                        value={given}
                        onChange={(event) => answer(question.question, event.target.value)}
                      />
                    </div>
                  );
                })}
              </section>
            )}
            {result.parse.ok ? null : (
              <section aria-label={DESCRIBE_COPY.mistakes} className="flex flex-col gap-(--cue-space-1)">
                <h4 className="font-medium text-warn">{DESCRIBE_COPY.mistakes}</h4>
                <ul className="flex flex-col gap-(--cue-space-1)">
                  {result.parse.errors.map((error) => (
                    <li key={`${error.line}:${error.column}`} className="text-fg">
                      {DESCRIBE_COPY.mistake(error.line)} <UntrustedText text={error.message} />
                    </li>
                  ))}
                </ul>
                <p className="flex items-center gap-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
                  {DESCRIBE_COPY.raw} <FromOutsideMark />
                </p>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-control bg-sunken p-(--cue-space-2) font-mono text-(length:--cue-text-label)">
                  <SenderText text={result.text} />
                </pre>
              </section>
            )}
            {result.check === null || result.check.ok ? null : (
              <section aria-label={DESCRIBE_COPY.problems} className="flex flex-col gap-(--cue-space-1)">
                <h4 className="font-medium text-warn">{DESCRIBE_COPY.problems}</h4>
                <ul className="flex flex-col gap-(--cue-space-1)">
                  {result.check.problems.map((each, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the problems come in the check's order.
                    <li key={index} className="text-fg">
                      <UntrustedText text={each.message} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
