/**
 * The workflow's settings, with nothing selected on the canvas (workflows design §11.3, §7.5, W23, W24, W33, W34):
 * its limits, each refused above its ceiling; where its events are named, and the run's own events to tick; the events
 * of other workflows that start it (a chain); and shadow, where every effect is a dry run. Each is part of the
 * document, so a change here is a new version, approved again. A straight line has none of these until a change makes
 * it a workflow with steps.
 */
import { Field, FieldError, FieldLabel, Input, Panel, Switch, Textarea } from '@cueplusplus/ui';
import { useState } from 'react';
import type { AccountNames } from '../../account-aliases.ts';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { isObject, type JsonObject } from '../../rule-editor/model.ts';
import type { DesignerProblem } from '../../workflows/checks.ts';
import { SETTINGS_COPY as COPY } from '../../workflows/copy.ts';
import { FLOW_BOUNDS, FLOW_LIMIT_DEFAULTS, type FlowLimits, RUN_EVENTS } from '../../workflows/flow.ts';
import {
  eventNames,
  LIMIT_KEYS,
  setChain,
  setLimit,
  setShadow,
  spanWords,
  tickRunEvent,
} from '../../workflows/settings.ts';
import { EventNamesField, EventTicks } from './EventTicks.tsx';

/** One limit: a whole number, refused above its ceiling, the document changed only when it is one. */
function LimitField({
  document,
  name,
  value,
  onChange,
}: {
  document: JsonObject;
  name: keyof FlowLimits;
  value: number;
  onChange: (next: JsonObject) => void;
}) {
  const shown = name === 'runMs' ? value / 3_600_000 : value;
  const [text, setText] = useState(String(shown));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Field name={`limit-${name}`} invalid={problem !== null}>
      <FieldLabel>{COPY.limitWords[name]}</FieldLabel>
      <Input
        className="w-24"
        inputMode="numeric"
        value={text}
        onValueChange={(typed: string) => {
          setText(typed);
          const next = setLimit(document, name, typed.trim());
          if (typeof next === 'string') setProblem(next);
          else {
            setProblem(null);
            onChange(next);
          }
        }}
      />
      <FieldError issues={problem === null ? [] : [{ message: problem }]} />
    </Field>
  );
}

const WITHIN = [3_600_000, 86_400_000, 7 * 86_400_000] as const;

export function WorkflowSettings({
  document,
  problems,
  onChange,
  names,
  onNames,
}: {
  document: JsonObject;
  problems: readonly DesignerProblem[];
  onChange: (next: JsonObject) => void;
  names: AccountNames;
  onNames: (names: { namespace: string; workflow: string }) => void;
}) {
  const flow = isObject(document.flow) ? document.flow : null;
  const limits = (flow !== null && isObject(flow.limits) ? flow.limits : FLOW_LIMIT_DEFAULTS) as unknown as FlowLimits;
  const naming = eventNames(document, names);
  const events = flow !== null && isObject(flow.events) ? flow.events : null;
  const run = Array.isArray(events?.run) ? events.run.filter((each): each is string => typeof each === 'string') : [];
  const on = flow !== null && isObject(flow.on) ? flow.on : null;
  const patterns = Array.isArray(on?.raised)
    ? on.raised.filter((each): each is string => typeof each === 'string')
    : [];
  const within = typeof on?.withinMs === 'number' ? on.withinMs : FLOW_BOUNDS.onWithinDefaultMs;
  const [chainText, setChainText] = useState(patterns.join('\n'));
  const general = problems.filter((problem) => problem.stepId === null);
  return (
    <Panel aria-label={COPY.workflowSettings} className="flex flex-col gap-(--cue-space-4) p-(--cue-space-4)">
      <div className="flex flex-col gap-(--cue-space-1)">
        <h3 className="font-semibold text-fg">{COPY.workflowSettings}</h3>
        <p className="text-(length:--cue-text-label) text-fg-muted">
          {flow === null ? COPY.straightLine : COPY.workflowSettingsBody}
        </p>
      </div>
      {general.length === 0 ? null : (
        <section aria-label={COPY.toFix} className="flex flex-col gap-(--cue-space-1)">
          {general.map((problem, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the checks come in a fixed order for one document.
            <p key={index} className="text-warn">
              <UntrustedText text={problem.message} />
            </p>
          ))}
        </section>
      )}
      <section aria-label={COPY.limits} className="flex flex-col gap-(--cue-space-2)">
        <h4 className="font-semibold text-(length:--cue-text-label) text-fg">{COPY.limits}</h4>
        <div className="grid grid-cols-1 gap-(--cue-space-2) sm:grid-cols-2">
          {LIMIT_KEYS.map((key) => (
            <LimitField key={key} document={document} name={key} value={limits[key]} onChange={onChange} />
          ))}
        </div>
      </section>
      <section aria-label={COPY.events} className="flex flex-col gap-(--cue-space-2)">
        <h4 className="font-semibold text-(length:--cue-text-label) text-fg">{COPY.events}</h4>
        <EventNamesField naming={naming} onNames={onNames} />
        <EventTicks
          stepId="run"
          title={COPY.runEvents}
          words={RUN_EVENTS}
          ticked={run}
          naming={naming}
          onTick={(word, ticked, chosen) => {
            const next = tickRunEvent(document, word as (typeof RUN_EVENTS)[number], ticked, chosen);
            if (next !== null) onChange(next);
          }}
        />
      </section>
      <section aria-label={COPY.chain} className="flex flex-col gap-(--cue-space-2)">
        <h4 className="font-semibold text-(length:--cue-text-label) text-fg">{COPY.chain}</h4>
        <p className="text-(length:--cue-text-label) text-fg-muted">{COPY.chainBody}</p>
        <Textarea
          aria-label={COPY.chainPatterns}
          className="w-full font-mono"
          rows={2}
          spellCheck={false}
          value={chainText}
          onChange={(event) => {
            setChainText(event.target.value);
            const typed = event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== '');
            onChange(setChain(document, typed, within));
          }}
        />
        {patterns.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-(--cue-space-2)">
            <span className="text-(length:--cue-text-label) text-fg-muted">{COPY.within}</span>
            {WITHIN.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={within === each}
                className="rounded-control px-(--cue-space-2) py-(--cue-space-1) text-(length:--cue-text-label) text-fg hover:bg-surface-2 aria-pressed:bg-accent-soft aria-pressed:text-accent"
                onClick={() => onChange(setChain(document, patterns, each))}
              >
                {spanWords(each)}
              </button>
            ))}
          </div>
        )}
      </section>
      <section aria-label={COPY.shadow} className="flex flex-col gap-(--cue-space-2)">
        <Switch
          label={COPY.shadow}
          checked={flow !== null && flow.shadow === true}
          onCheckedChange={(checked: boolean) => onChange(setShadow(document, checked))}
        />
        <p className="text-(length:--cue-text-label) text-fg-muted">{COPY.shadowBody}</p>
      </section>
    </Panel>
  );
}
