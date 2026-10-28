/**
 * A step's Events (workflows design W23–W24, Appendix W): one tick per event its kind can raise, every one off until
 * the person ticks it. A tick is part of the workflow, so it is in what they approve; the full name each is raised as
 * is shown beside it. The first tick also says where the workflow's events are named: the trigger account's
 * organisation and the workflow's id, or a name the person gives when the id is not one an event name can carry.
 */
import { Button, Field, FieldDescription, FieldError, FieldLabel, Input, Toggle } from '@cueplusplus/ui';
import { useState } from 'react';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import type { JsonObject } from '../../rule-editor/model.ts';
import { SETTINGS_COPY as COPY } from '../../workflows/copy.ts';
import { isEventSegment } from '../../workflows/flow.ts';

/** Where the events are named, and whether the document says so yet. */
export interface Naming {
  readonly namespace: string;
  readonly workflow: string | null;
  readonly written: boolean;
}

/**
 * The ticks: `words` the step can raise, `ticked` those on. `onTick` is given the names to write on the first tick —
 * the defaults, or the name the person typed.
 */
export function EventTicks({
  stepId,
  words,
  ticked,
  naming,
  onTick,
  title = COPY.events,
}: {
  stepId: string;
  words: readonly string[];
  ticked: readonly string[];
  naming: Naming;
  onTick: (word: string, on: boolean, names: { namespace: string; workflow: string }) => void;
  title?: string;
}) {
  const [name, setName] = useState('');
  const typed = name.trim();
  const needsName = naming.workflow === null;
  const wrong = typed !== '' && !isEventSegment(typed);
  const workflow = naming.workflow ?? (isEventSegment(typed) ? typed : null);
  if (words.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-(--cue-space-2)">
      <h4 className="font-semibold text-(length:--cue-text-label) text-fg">{title}</h4>
      <p className="text-(length:--cue-text-label) text-fg-muted">{COPY.eventsOff}</p>
      {needsName ? (
        <Field name="event-name" invalid={wrong}>
          <FieldLabel>{COPY.nameEvents}</FieldLabel>
          <Input value={name} spellCheck={false} autoComplete="off" onValueChange={(value: string) => setName(value)} />
          <FieldDescription>{COPY.nameEventsBody}</FieldDescription>
          <FieldError issues={wrong ? [{ message: COPY.segment }] : []} />
        </Field>
      ) : null}
      <div className="flex flex-wrap gap-(--cue-space-1)">
        {words.map((word) => (
          <Toggle
            key={word}
            size="sm"
            data-event={word}
            pressed={ticked.includes(word)}
            disabled={workflow === null && !ticked.includes(word)}
            onPressedChange={(pressed: boolean) =>
              workflow !== null && onTick(word, pressed, { namespace: naming.namespace, workflow })
            }
          >
            {word}
          </Toggle>
        ))}
      </div>
      {workflow === null ? null : (
        <p data-slot="event-name" className="text-(length:--cue-text-label) text-fg-muted">
          {COPY.raisedAs}{' '}
          <span className="font-mono">
            <UntrustedText text={`${naming.namespace}.${workflow}.${stepId}.<event>`} />
          </span>
        </p>
      )}
    </section>
  );
}

/** Where a workflow's events are named, as its settings edit it: the namespace and the workflow's name. */
export function EventNamesField({
  naming,
  onNames,
}: {
  naming: Naming;
  onNames: (names: { namespace: string; workflow: string }) => void;
}) {
  const [namespace, setNamespace] = useState(naming.namespace);
  const [workflow, setWorkflow] = useState(naming.workflow ?? '');
  const okNamespace = isEventSegment(namespace) && namespace !== 'agentcomms' && namespace !== 'com';
  const okWorkflow = isEventSegment(workflow);
  const changed = !naming.written || namespace !== naming.namespace || workflow !== naming.workflow;
  return (
    <div className="flex flex-col gap-(--cue-space-2)">
      <Field name="event-namespace" invalid={!okNamespace}>
        <FieldLabel>{COPY.namespace}</FieldLabel>
        <Input value={namespace} spellCheck={false} onValueChange={(value: string) => setNamespace(value.trim())} />
        <FieldError issues={okNamespace ? [] : [{ message: COPY.namespaceWrong }]} />
      </Field>
      <Field name="event-workflow" invalid={workflow !== '' && !okWorkflow}>
        <FieldLabel>{COPY.workflowName}</FieldLabel>
        <Input value={workflow} spellCheck={false} onValueChange={(value: string) => setWorkflow(value.trim())} />
        <FieldError issues={workflow !== '' && !okWorkflow ? [{ message: COPY.segment }] : []} />
      </Field>
      {naming.written ? (
        <div>
          <Button
            size="sm"
            disabled={!okNamespace || !okWorkflow || !changed}
            onClick={() => onNames({ namespace, workflow })}
          >
            {COPY.rename}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The ticked words of a step, as its `emit` holds them. */
export function tickedOf(step: JsonObject): string[] {
  return Array.isArray(step.emit) ? step.emit.filter((word): word is string => typeof word === 'string') : [];
}
