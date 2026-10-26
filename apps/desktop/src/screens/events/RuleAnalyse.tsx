/**
 * Analyse (0.33.0, design §3.3, the prototype's RuleAnalyse): suggestions for the rule, or for the draft being edited,
 * each with what it was, what it would be and why, to apply or skip. Analyse runs only when the person presses it, and
 * applies nothing: Apply and review… puts the applied ones into the editor, and the person still approves the version.
 * A line says where the model ran, and that only the rule and its counts were sent. Before and after are text — a
 * rule author's, or a model's — and are shown as text.
 */
import { Button, Chip, Panel, SegmentedControl, Spinner } from '@cueplusplus/ui';
import { useEffect, useState } from 'react';
import type { AccountNames } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import type { Loadable } from '../../data.tsx';
import { errorMessage } from '../../ipc.ts';
import {
  type AnalyseResult,
  applySuggestions,
  partWords,
  readAnalyse,
  type Suggestion,
  valueParts,
} from '../../rule-editor/analyse.ts';
import { ANALYSE_COPY as COPY } from '../../rule-editor/copy.ts';
import type { JsonObject } from '../../rule-editor/model.ts';
import { BackTo, Problem, Sentence } from './parts.tsx';

const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  typesafe: 'TypeSafe',
};

/** One suggestion: where it is, Apply or Skip, before and after, and why. */
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
  return (
    <section aria-label={where} data-suggestion={suggestion.part}>
      <Panel
        className={`flex flex-col gap-(--cue-space-2) p-(--cue-space-4) ${applied ? 'ring-2 ring-accent-subtle' : ''}`}
      >
        <div className="flex flex-wrap items-center gap-(--cue-space-2)">
          <span className="font-semibold text-(length:--cue-text-label) text-fg-subtle uppercase">{where}</span>
          <SegmentedControl
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
        </div>
        <div
          data-slot="before"
          className="rounded-control bg-danger-subtle px-(--cue-space-2) py-(--cue-space-1) text-fg-muted line-through"
        >
          <Sentence parts={valueParts(suggestion.part, suggestion.before)} names={names} />
        </div>
        <div data-slot="after" className="rounded-control bg-ok-subtle px-(--cue-space-2) py-(--cue-space-1) text-fg">
          <Sentence parts={valueParts(suggestion.part, suggestion.after)} names={names} />
        </div>
        {suggestion.why === '' ? null : (
          <p data-slot="why" className="text-fg-muted">
            <Sentence parts={[{ text: suggestion.why, kind: 'plain' }]} names={names} />
          </p>
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
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  // Analyse runs once, when the person pressed it: this view opening is that press.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it reads the document it opened with, once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let next: Loadable<AnalyseResult>;
      try {
        const result = await bridge.cli(
          draft ? { kind: 'eventsRuleAnalyse', ruleId, draft: document } : { kind: 'eventsRuleAnalyse', ruleId },
        );
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
  }, [bridge]);

  const suggestions = read.state === 'ready' ? read.value.suggestions : [];
  const applied = suggestions.filter((_, index) => !skipped.has(index));
  return (
    <section aria-label={COPY.title(ruleId)} className="mx-auto flex w-full max-w-3xl flex-col gap-(--cue-space-3)">
      <BackTo label={COPY.backToEditing} onBack={onBack} />
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">{COPY.title(ruleId)}</h2>
        {read.state === 'ready' ? <Chip tone="accent">{COPY.suggestions(suggestions.length)}</Chip> : null}
      </div>
      <section aria-label="How this was made">
        <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
          <p className="text-fg-muted">{COPY.howMade}</p>
          {read.state === 'ready' ? (
            <p data-slot="ran-on" className="text-(length:--cue-text-label) text-fg-subtle">
              {read.value.provider === null
                ? COPY.ranHere
                : COPY.ranOn(PROVIDER_WORDS[read.value.provider] ?? read.value.provider, read.value.model)}
            </p>
          ) : null}
        </Panel>
      </section>
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
          {COPY.willApply(applied.length, suggestions.length)}
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
