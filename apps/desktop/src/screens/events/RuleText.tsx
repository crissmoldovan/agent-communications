/**
 * The rule as text, and as its canonical JSON (0.33.0, design §3.2, the prototype's RuleEditText): the text is the
 * event package's own language, printed from the document and parsed back as the person types; the JSON is what is
 * approved, read-only. The checks beside the text say what the parser and this Mac found, each line as text.
 */
import { Link, Panel, Textarea } from '@cueplusplus/ui';
import { Check as CheckMark, CircleAlert, CircleX } from 'lucide-react';
import type { AccountNames } from '../../account-aliases.ts';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import type { Check } from '../../rule-editor/checks.ts';
import { EDITOR_COPY as COPY } from '../../rule-editor/copy.ts';
import { type JsonObject, prettyJson } from '../../rule-editor/model.ts';
import { Sentence } from './parts.tsx';

export function RuleTextPane({ text, onText }: { text: string; onText: (text: string) => void }) {
  // The editor is the person's to drag and scroll in, its bar and edges included: a sideways swipe over it never changes
  // the Events tab around it (`data-tabs-swipe`, cue-ui 0.34.0), as one over the text itself already does not.
  return (
    <Panel data-tabs-swipe="ignore" className="flex flex-col overflow-hidden">
      <p className="bg-surface-2 px-(--cue-space-3) py-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
        {COPY.textBar}
      </p>
      <Textarea
        aria-label={COPY.ruleText}
        className="min-h-96 w-full rounded-none border-0 font-mono text-(length:--cue-text-ui) leading-relaxed"
        rows={24}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={text}
        onChange={(event) => onText(event.target.value)}
      />
    </Panel>
  );
}

export function RuleJsonPane({ document }: { document: JsonObject }) {
  return (
    <section aria-label={COPY.json}>
      <Panel className="flex flex-col overflow-hidden">
        <p className="bg-surface-2 px-(--cue-space-3) py-(--cue-space-2) text-(length:--cue-text-label) text-fg-muted">
          {COPY.jsonBar}
        </p>
        {/* A long line scrolls sideways; a swipe that reaches its end stays with it rather than changing the tab. */}
        <pre
          data-slot="rule-json"
          data-tabs-swipe="ignore"
          className="m-0 overflow-x-auto p-(--cue-space-4) font-mono text-(length:--cue-text-ui) text-fg"
        >
          <UntrustedText text={prettyJson(document)} />
        </pre>
      </Panel>
    </section>
  );
}

const ICONS = { ok: CheckMark, warn: CircleAlert, error: CircleX } as const;
const TONES = { ok: 'text-ok', warn: 'text-warn', error: 'text-danger' } as const;

/** The checks, as you type: each a line, its mark and its words, and a way to fix it when that is elsewhere. */
export function RuleChecks({
  checks,
  names,
  onIntegrations,
}: {
  checks: readonly Check[];
  names: AccountNames;
  onIntegrations: (() => void) | null;
}) {
  return (
    <section aria-label={COPY.checks}>
      <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
        <h3 className="font-semibold text-(length:--cue-text-label) text-fg">{COPY.checks}</h3>
        <ul className="flex flex-col gap-(--cue-space-1)">
          {checks.map((check, index) => {
            const Icon = ICONS[check.tone];
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the checks come in a fixed order for one document.
              <li key={index} data-check={check.tone} className="flex items-start gap-(--cue-space-2)">
                <Icon aria-hidden="true" className={`mt-0.5 size-(--cue-icon-sm) shrink-0 ${TONES[check.tone]}`} />
                <span className="text-fg">
                  <Sentence parts={check.parts} names={names} />
                  {check.fix === 'integrations' && onIntegrations !== null ? (
                    <>
                      {' '}
                      <Link
                        href="#integrations"
                        onClick={(event) => {
                          event.preventDefault();
                          onIntegrations();
                        }}
                      >
                        {COPY.connectIt}
                      </Link>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </Panel>
    </section>
  );
}
