/**
 * Analyse (0.33.0, design §3.3, the prototype's RuleAnalyse): suggestions for the rule, or for the draft being edited,
 * each with what it was, what it would be and why, to apply or skip. Analyse runs only when the person presses it, and
 * applies nothing: Apply and review… puts the applied ones into the editor, and the person still approves the version.
 * A line says where the model ran, on the provider the person picks among those with a key, and another says what was
 * sent, in the event service's own words. What it counted is shown too: each sending domain is the sender's choice,
 * and arrives — and is shown — as outside text. Before and after are a rule author's words or a model's: text only.
 */
import { Button, Chip, Link, Panel, SegmentedControl, Spinner } from '@cueplusplus/ui';
import { useEffect, useState } from 'react';
import type { AccountNames } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import type { Loadable } from '../../data.tsx';
import { ANALYSE_PROVIDERS, type AnalyseProvider, errorMessage } from '../../ipc.ts';
import { useNavigate } from '../../navigation.tsx';
import {
  type AnalyseResult,
  applicable,
  applySuggestions,
  isRuleTextPart,
  partWords,
  readAnalyse,
  type Suggestion,
  valueParts,
} from '../../rule-editor/analyse.ts';
import { ANALYSE_COPY as COPY } from '../../rule-editor/copy.ts';
import type { JsonObject } from '../../rule-editor/model.ts';
import { BackTo, Problem, Sentence } from './parts.tsx';

const PROVIDER_WORDS: Readonly<Record<AnalyseProvider, string>> = { openrouter: 'OpenRouter', anthropic: 'Anthropic' };

/** One suggestion: where it is, Apply or Skip, before and after, and why. A note has only its why. */
function SuggestionCard({
  suggestion,
  applied,
  onApplied,
  names,
}: {
  suggestion: Suggestion;
  applied: boolean;
  onApplied: (applied: boolean) => void;
  names: AccountNames;
}) {
  const where = partWords(suggestion.part);
  const canApply = applicable(suggestion);
  const type = isRuleTextPart(suggestion.part) ? 'font-mono text-(length:--cue-text-ui) whitespace-pre-wrap' : '';
  return (
    <section aria-label={where} data-suggestion={suggestion.part}>
      <Panel
        className={`flex flex-col gap-(--cue-space-2) p-(--cue-space-4) ${canApply && applied ? 'ring-2 ring-accent-subtle' : ''}`}
      >
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <span className="font-semibold text-(length:--cue-text-label) text-fg-subtle uppercase">{where}</span>
          {suggestion.evidence.by === 'model' ? <Chip tone="accent">{COPY.byModel}</Chip> : null}
          {canApply ? (
            <SegmentedControl
              indicator
              aria-label={COPY.keepThis}
              size="sm"
              className="ml-auto"
              value={applied ? 'apply' : 'skip'}
              items={[
                { value: 'apply', label: COPY.apply },
                { value: 'skip', label: COPY.skip },
              ]}
              onValueChange={(value) => onApplied(value === 'apply')}
            />
          ) : null}
        </div>
        {canApply ? (
          <>
            <div
              data-slot="before"
              className={`rounded-control bg-danger-subtle px-(--cue-space-2) py-(--cue-space-1) text-fg-muted line-through ${type}`}
            >
              <Sentence parts={valueParts(suggestion.before)} names={names} />
            </div>
            <div
              data-slot="after"
              className={`rounded-control bg-ok-subtle px-(--cue-space-2) py-(--cue-space-1) text-fg ${type}`}
            >
              <Sentence parts={valueParts(suggestion.after)} names={names} />
            </div>
          </>
        ) : null}
        {suggestion.why === '' ? null : (
          <p data-slot="why" className="text-fg-muted">
            <UntrustedText text={suggestion.why} />
          </p>
        )}
      </Panel>
    </section>
  );
}

/** Where the model ran, or why it did not; and the provider to run it on, among those with a key. */
function HowMade({ result, onProvider }: { result: AnalyseResult; onProvider: (provider: AnalyseProvider) => void }) {
  const navigate = useNavigate();
  const { model, counts } = result;
  const ran =
    model.ran && model.name !== null
      ? COPY.ranOn(model.name, model.model)
      : model.reason === 'NO_KEY'
        ? COPY.noKey
        : model.reason === 'NO_MODEL_PARTS'
          ? COPY.noModelParts
          : COPY.noModel;
  const withKeys = ANALYSE_PROVIDERS.filter((each) => !model.noKey.includes(each));
  return (
    <section aria-label={COPY.howMadeTitle}>
      <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
        <p className="text-fg-muted">{COPY.howMade}</p>
        <p data-slot="ran-on" className="text-(length:--cue-text-label) text-fg">
          <UntrustedText text={ran} />
          {model.reason === 'NO_KEY' && navigate !== null ? (
            <>
              {' '}
              <Link
                href="#ai-providers"
                onClick={(event) => {
                  event.preventDefault();
                  navigate({ screen: 'settings', section: 'ai-providers' });
                }}
              >
                {COPY.addKey}
              </Link>
            </>
          ) : null}
        </p>
        {model.sent === null ? null : (
          <p data-slot="sent" className="text-(length:--cue-text-label) text-fg-subtle">
            <UntrustedText text={model.sent} />
          </p>
        )}
        {withKeys.length < 2 ? null : (
          <div className="flex flex-wrap items-center gap-(--cue-space-2)">
            <span className="text-(length:--cue-text-label) text-fg-muted">{COPY.runOn}</span>
            <SegmentedControl
              indicator
              aria-label={COPY.runOn}
              size="sm"
              value={model.provider ?? ''}
              items={ANALYSE_PROVIDERS.map((each) => ({ value: each, label: PROVIDER_WORDS[each] }))}
              onValueChange={(value) => onProvider(value as AnalyseProvider)}
            />
          </div>
        )}
        {counts.decisions === null ? null : (
          <p className="text-(length:--cue-text-label) text-fg-muted">
            {COPY.counted(counts.decisions, counts.windowDays ?? 30)}
          </p>
        )}
        {counts.domains.length === 0 ? null : (
          <ul aria-label={COPY.domains} className="flex flex-col gap-(--cue-space-1)">
            {counts.domains.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the domains come in the event service's order.
              <li key={index} data-slot="domain" className="flex flex-wrap items-center gap-(--cue-space-2)">
                <UntrustedText text={entry.domain} />
                <span className="text-(length:--cue-text-label) text-fg-muted">
                  {COPY.domainCounts(entry.judged, entry.yes, entry.no)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

export function RuleAnalyse({
  ruleId,
  document,
  draft,
  names,
  onBack,
  onApply,
}: {
  ruleId: string;
  document: JsonObject;
  /** Whether the editor's document is a draft, not a stored version: Analyse then reads it from stdin. */
  draft: boolean;
  names: AccountNames;
  onBack: () => void;
  /** The document with the applied suggestions in it, and how many could not be applied. */
  onApply: (document: JsonObject, notApplied: number) => void;
}) {
  const bridge = useBridge();
  const [read, setRead] = useState<Loadable<AnalyseResult>>({ state: 'loading' });
  const [provider, setProvider] = useState<AnalyseProvider | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  // Analyse runs when the person pressed it — this view opening — and again when they pick another provider.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it reads the document it opened with.
  useEffect(() => {
    let cancelled = false;
    setRead({ state: 'loading' });
    setSkipped(new Set());
    void (async () => {
      let next: Loadable<AnalyseResult>;
      try {
        const result = await bridge.cli({
          kind: 'eventsRuleAnalyse',
          ruleId,
          ...(draft ? { draft: document } : {}),
          ...(provider === null ? {} : { provider }),
        });
        if (result.status === 'ok') {
          const analysed = readAnalyse(result.data);
          next = analysed === null ? { state: 'error', message: COPY.unreadable } : { state: 'ready', value: analysed };
        } else next = { state: 'error', message: result.status === 'failed' ? result.message : COPY.unreadable };
      } catch (error) {
        next = { state: 'error', message: errorMessage(error) };
      }
      if (!cancelled) setRead(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, provider]);

  const suggestions = read.state === 'ready' ? read.value.suggestions : [];
  const offered = suggestions.filter(applicable);
  const applied = suggestions.filter((suggestion, index) => applicable(suggestion) && !skipped.has(index));
  return (
    <section aria-label={COPY.title(ruleId)} className="mx-auto flex w-full max-w-3xl flex-col gap-(--cue-space-3)">
      <BackTo label={COPY.backToEditing} onBack={onBack} />
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">
          <UntrustedText text={COPY.title(ruleId)} />
        </h2>
        {read.state === 'ready' ? <Chip tone="accent">{COPY.suggestions(offered.length)}</Chip> : null}
      </div>
      {read.state === 'ready' ? <HowMade result={read.value} onProvider={setProvider} /> : null}
      {read.state === 'loading' ? <Spinner label={COPY.analysing} /> : null}
      {read.state === 'error' ? <Problem message={read.message} /> : null}
      {read.state === 'ready' && suggestions.length === 0 ? <p className="text-fg-muted">{COPY.none}</p> : null}
      {suggestions.map((suggestion, index) => (
        <SuggestionCard
          // biome-ignore lint/suspicious/noArrayIndexKey: the suggestions come in Analyse's order and never move.
          key={index}
          suggestion={suggestion}
          applied={!skipped.has(index)}
          names={names}
          onApplied={(on) =>
            setSkipped((before) => {
              const next = new Set(before);
              if (on) next.delete(index);
              else next.add(index);
              return next;
            })
          }
        />
      ))}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-(--cue-space-2) bg-bg py-(--cue-space-3)">
        <span className="flex-1 text-(length:--cue-text-label) text-fg-muted">
          {COPY.willApply(applied.length, offered.length)}
        </span>
        <Button variant="ghost" onClick={onBack}>
          {COPY.backToEditing}
        </Button>
        <Button
          variant="primary"
          disabled={read.state !== 'ready' || applied.length === 0}
          onClick={() => {
            const result = applySuggestions(document, applied);
            onApply(result.document, result.notApplied.length);
          }}
        >
          {COPY.applyAndReview}
        </Button>
      </div>
    </section>
  );
}
