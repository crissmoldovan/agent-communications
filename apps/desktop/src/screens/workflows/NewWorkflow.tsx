/**
 * New workflow… (workflows design §11.2, the approved prototype's Workflows): its name first, which it keeps for good,
 * then where it starts — from the person's own words, an empty canvas, or a copy of one of their workflows — and the
 * designer. Nothing is stored until the person saves it there, and nothing runs until they approve it.
 */
import {
  Button,
  Dialog,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Radio,
  RadioGroup,
  Select,
} from '@cueplusplus/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { COPY } from '../../copy.ts';
import { isRuleId } from '../../grammar.ts';

export const NEW_WORKFLOW_COPY = {
  newWorkflow: 'New workflow…',
  title: 'New workflow',
  body: 'Name the workflow: letters, digits and . _ : @ -. Agents and the event service know it by this name, and it cannot change.',
  name: 'Name',
  taken: 'A workflow has this name already.',
  wrong: 'Use letters, digits and . _ : @ - only, starting with a letter or a digit.',
  startFrom: 'Start from',
  words: 'Your own words',
  wordsBody: 'Say what should happen; a model drafts the steps and asks what it can’t tell.',
  empty: 'An empty canvas',
  emptyBody: 'Drag steps on, and connect them.',
  copy: 'A copy of another workflow',
  copyBody: 'Change its trigger and its steps.',
  copyOf: 'Copy of',
  start: 'Start',
} as const;

export type NewStart = 'words' | 'empty' | { copy: string };

export function NewWorkflow({
  taken,
  workflows,
  onStart,
}: {
  taken: ReadonlySet<string>;
  /** The workflows a new one may be a copy of. */
  workflows: readonly string[];
  onStart: (ruleId: string, from: NewStart) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [start, setStart] = useState<'words' | 'empty' | 'copy'>('empty');
  const [copyOf, setCopyOf] = useState<string | null>(null);
  const id = name.trim();
  const wrong = id !== '' && !isRuleId(id);
  const used = taken.has(id);
  const ready = id !== '' && !wrong && !used && (start !== 'copy' || copyOf !== null);
  const C = NEW_WORKFLOW_COPY;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setStart('empty');
          setCopyOf(null);
        }
      }}
    >
      <Dialog.Trigger
        render={
          <Button size="sm" icon={Plus}>
            {C.newWorkflow}
          </Button>
        }
      />
      <Dialog.Content width="sm" showCloseButton={false}>
        <Dialog.Title>{C.title}</Dialog.Title>
        <Dialog.Description>{C.body}</Dialog.Description>
        <Field name="workflow-name" invalid={wrong || used}>
          <FieldLabel>{C.name}</FieldLabel>
          <Input value={name} spellCheck={false} autoComplete="off" onValueChange={(value: string) => setName(value)} />
          <FieldDescription>{C.body.split('.')[0]}.</FieldDescription>
          <FieldError issues={wrong ? [{ message: C.wrong }] : used ? [{ message: C.taken }] : []} />
        </Field>
        <RadioGroup aria-label={C.startFrom} value={start} onValueChange={(value) => setStart(value as typeof start)}>
          <Radio value="words" label={`${C.words}: ${C.wordsBody}`} />
          <Radio value="empty" label={`${C.empty}: ${C.emptyBody}`} />
          <Radio value="copy" label={`${C.copy}: ${C.copyBody}`} disabled={workflows.length === 0} />
        </RadioGroup>
        {start === 'copy' ? (
          <Select
            aria-label={C.copyOf}
            value={copyOf}
            placeholder={C.copyOf}
            items={workflows.map((each) => ({ value: each, label: each }))}
            onValueChange={(value) => setCopyOf(value)}
          />
        ) : null}
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost">{COPY.cancel}</Button>} />
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              setOpen(false);
              onStart(
                id,
                start === 'copy' && copyOf !== null ? { copy: copyOf } : start === 'words' ? 'words' : 'empty',
              );
            }}
          >
            {C.start}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
