/**
 * Add a subscriber… (workflows design W29, W30, §11.2): a new subscriber, given namespaces and the patterns it receives
 * inside them, live on this Mac or by signed webhook. Each pattern is checked as the person types it, with the event
 * service's own `canonicalEventPattern`, so a pattern outside the namespaces given is refused before anything is sent.
 * Adding stores an inert version: it receives nothing until the person approves it (Approve…). Its token, signing secret
 * and secret URL are made at a terminal, never here.
 *
 * Everything typed here is the person's own: an id, a port, origins, an address, names and patterns.
 */
import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Panel,
  Radio,
  RadioGroup,
  Textarea,
} from '@cueplusplus/ui';
import { useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { isSubscriberId } from '../../grammar.ts';
import { errorMessage, type JsonDocument } from '../../ipc.ts';
import { canonicalEventPattern, isEventSegment, RESERVED_NAMESPACES } from '../../workflows/patterns.ts';
import { BackTo, Problem } from './parts.tsx';

export const ADD_SUBSCRIBER_COPY = {
  title: 'Add a subscriber',
  back: 'Subscribers',
  intro:
    'A program that receives the events your workflows raise: one on this Mac, live, or one elsewhere, by a signed webhook. It receives nothing until you approve what it asks for.',
  id: 'Its name',
  idHint: 'Letters, digits, ., _, :, @ and -: it keeps this name for good.',
  idWrong: 'Letters, digits, ., _, :, @ and -, starting with a letter or digit.',
  idTaken: 'A subscriber has this name already.',
  where: 'Where it receives them',
  live: 'Live on this Mac: a page or a program here, sent each event as it happens',
  webhook: 'By signed webhook: a program elsewhere, at its address',
  port: 'Its port on this Mac',
  portHint: 'It listens on 127.0.0.1 at this port.',
  portWrong: 'A port from 1 to 65535.',
  origins: 'The pages that may connect',
  originsHint: 'One exact origin a line, such as http://localhost:3000. None: no browser page may connect.',
  originWrong: (line: number) => `Line ${line} is not an exact http or https origin.`,
  replay: 'It may catch up on the last',
  replayHint: 'Hours, from 1 to 168: what it missed while away, sent again when it reconnects.',
  replayWrong: 'From 1 to 168 hours.',
  url: 'Its address',
  urlHint: 'https://…, or http:// to 127.0.0.1 on this Mac. A secret address is set at your terminal once it is added.',
  urlWrong: 'An https address, or http to 127.0.0.1 or [::1].',
  addresses: 'The addresses it may resolve to',
  addressesHint: 'One IP address a line: Agent Comms posts only to these.',
  addressesWrong: 'At least one IP address, one a line.',
  retries: 'Tries before it gives up',
  retriesWrong: 'From 1 to 20.',
  namespaces: 'Its namespaces',
  namespacesHint:
    'One a line, such as acme: the first part of an event’s name. It receives events from these namespaces and no other.',
  namespaceWrong: (line: number) =>
    `Line ${line}: lowercase letters, digits, _ and -, starting with a letter; not one kept for Agent Comms (agentcomms, com).`,
  namespacesCount: 'From 1 to 8 namespaces.',
  patterns: 'What it receives',
  patternsHint:
    'One pattern a line: namespace.workflow.step.event, where * stands for one part. acme.client-asks.*.* is every event of client-asks; *.*.*.failed every failed step.',
  patternWrong: (line: number, why: string) => `Line ${line}: ${why}.`,
  patternsCount: 'From 1 to 32 patterns.',
  content: 'It may receive what senders wrote',
  contentHint:
    'Only where a workflow’s Raise an event step declares it, inside the untrusted-content envelope. Off: closed values only.',
  add: 'Add it',
  cancel: 'Cancel',
  unreadable: 'That answer could not be read.',
} as const;

/** The lines of a text box, each trimmed, the empty ones left out, with the line each was on. */
function lines(text: string): { line: number; value: string }[] {
  return text
    .split('\n')
    .flatMap((value, index) => (value.trim() === '' ? [] : [{ line: index + 1, value: value.trim() }]));
}

/** Sorted and unique, as the event service keeps every list of a subscriber. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function exactOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === value;
  } catch {
    return false;
  }
}

function webhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  } catch {
    return false;
  }
}

const whole = (value: string, least: number, most: number): number | null => {
  if (!/^\d{1,6}$/u.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= least && n <= most ? n : null;
};

const HOUR_MS = 3_600_000;

export function AddSubscriber({
  taken,
  onClose,
  onAdded,
}: {
  taken: ReadonlySet<string>;
  onClose: () => void;
  onAdded: (subscriberId: string) => Promise<void>;
}) {
  const bridge = useBridge();
  const [id, setId] = useState('');
  const [kind, setKind] = useState<'sse' | 'webhook'>('sse');
  const [port, setPort] = useState('4801');
  const [origins, setOrigins] = useState('');
  const [replay, setReplay] = useState('24');
  const [url, setUrl] = useState('');
  const [addresses, setAddresses] = useState('');
  const [retries, setRetries] = useState('5');
  const [namespaces, setNamespaces] = useState('');
  const [patterns, setPatterns] = useState('');
  const [content, setContent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const name = id.trim();
  const idWrong = name !== '' && !isSubscriberId(name);
  const idTaken = taken.has(name);
  const portValue = whole(port, 1, 65_535);
  const originLines = lines(origins);
  const badOrigin = originLines.find((each) => !exactOrigin(each.value));
  const replayHours = whole(replay, 1, 168);
  const urlWrong = url.trim() !== '' && !webhookUrl(url.trim());
  const addressLines = lines(addresses);
  const addressesWrong = addressLines.some((each) => /\s/u.test(each.value));
  const retryLimit = whole(retries, 1, 20);
  const namespaceLines = lines(namespaces);
  const badNamespace = namespaceLines.find(
    (each) => !isEventSegment(each.value) || (RESERVED_NAMESPACES as readonly string[]).includes(each.value),
  );
  const givenNamespaces = sortedUnique(namespaceLines.map((each) => each.value));
  const namespacesCount = givenNamespaces.length < 1 || givenNamespaces.length > 8;
  // Each pattern is checked as it is typed, against the namespaces given: the event service's own check.
  const patternLines = lines(patterns).map((each) => ({
    ...each,
    checked: canonicalEventPattern(each.value, givenNamespaces),
  }));
  const badPattern = patternLines.find((each) => !each.checked.ok);
  const givenPatterns = sortedUnique(patternLines.map((each) => each.value));
  const patternsCount = givenPatterns.length < 1 || givenPatterns.length > 32;

  const where =
    kind === 'sse'
      ? portValue !== null && badOrigin === undefined && replayHours !== null
      : url.trim() !== '' && !urlWrong && addressLines.length > 0 && !addressesWrong && retryLimit !== null;
  const ready =
    name !== '' &&
    !idWrong &&
    !idTaken &&
    where &&
    badNamespace === undefined &&
    !namespacesCount &&
    badPattern === undefined &&
    !patternsCount;

  const document = (): JsonDocument => {
    const events = { namespaces: givenNamespaces, patterns: givenPatterns, content: content ? 'enveloped' : 'none' };
    if (kind === 'sse')
      return {
        subscriberId: name,
        version: 1,
        kind: 'sse',
        authority: { host: '127.0.0.1', port: portValue },
        origins: sortedUnique(originLines.map((each) => each.value)),
        retentionMs: (replayHours ?? 24) * HOUR_MS,
        events,
      };
    return {
      subscriberId: name,
      version: 1,
      kind: 'webhook',
      url: { kind: 'plain', value: url.trim() },
      approvedAddressSet: sortedUnique(addressLines.map((each) => each.value)),
      signing: 'standard-webhooks',
      retryLimit,
      events,
    };
  };

  const add = async () => {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.cli({ kind: 'eventsSubscriberAdd', document: document() });
      if (result.status !== 'ok') {
        setProblem(result.status === 'failed' ? result.message : ADD_SUBSCRIBER_COPY.unreadable);
        return;
      }
      await onAdded(name);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const C = ADD_SUBSCRIBER_COPY;
  return (
    <section aria-label={C.title} className="flex flex-col gap-(--cue-space-4)">
      <BackTo label={C.back} onBack={onClose} />
      <h2 className="font-semibold text-(length:--cue-text-title) text-fg">{C.title}</h2>
      <p className="text-fg-muted">{C.intro}</p>
      <Panel className="flex flex-col gap-(--cue-space-4) p-(--cue-space-4)">
        <Field name="subscriber-id" invalid={idWrong || idTaken}>
          <FieldLabel>{C.id}</FieldLabel>
          <Input value={id} spellCheck={false} autoComplete="off" onValueChange={(value: string) => setId(value)} />
          <FieldDescription>{C.idHint}</FieldDescription>
          <FieldError issues={idWrong ? [{ message: C.idWrong }] : idTaken ? [{ message: C.idTaken }] : []} />
        </Field>
        <RadioGroup aria-label={C.where} value={kind} onValueChange={(value) => setKind(value as 'sse' | 'webhook')}>
          <Radio value="sse" label={C.live} />
          <Radio value="webhook" label={C.webhook} />
        </RadioGroup>
        {kind === 'sse' ? (
          <>
            <Field name="subscriber-port" invalid={portValue === null}>
              <FieldLabel>{C.port}</FieldLabel>
              <Input
                className="w-28"
                inputMode="numeric"
                value={port}
                onValueChange={(value: string) => setPort(value)}
              />
              <FieldDescription>{C.portHint}</FieldDescription>
              <FieldError issues={portValue === null ? [{ message: C.portWrong }] : []} />
            </Field>
            <Field name="subscriber-origins" invalid={badOrigin !== undefined}>
              <FieldLabel>{C.origins}</FieldLabel>
              <Textarea
                aria-label={C.origins}
                className="w-full font-mono"
                rows={2}
                spellCheck={false}
                value={origins}
                onChange={(event) => setOrigins(event.target.value)}
              />
              <FieldDescription>{C.originsHint}</FieldDescription>
              <FieldError issues={badOrigin === undefined ? [] : [{ message: C.originWrong(badOrigin.line) }]} />
            </Field>
            <Field name="subscriber-replay" invalid={replayHours === null}>
              <FieldLabel>{C.replay}</FieldLabel>
              <Input
                className="w-28"
                inputMode="numeric"
                value={replay}
                onValueChange={(value: string) => setReplay(value)}
              />
              <FieldDescription>{C.replayHint}</FieldDescription>
              <FieldError issues={replayHours === null ? [{ message: C.replayWrong }] : []} />
            </Field>
          </>
        ) : (
          <>
            <Field name="subscriber-url" invalid={urlWrong}>
              <FieldLabel>{C.url}</FieldLabel>
              <Input
                value={url}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(value: string) => setUrl(value)}
              />
              <FieldDescription>{C.urlHint}</FieldDescription>
              <FieldError issues={urlWrong ? [{ message: C.urlWrong }] : []} />
            </Field>
            <Field name="subscriber-addresses" invalid={addressesWrong}>
              <FieldLabel>{C.addresses}</FieldLabel>
              <Textarea
                aria-label={C.addresses}
                className="w-full font-mono"
                rows={2}
                spellCheck={false}
                value={addresses}
                onChange={(event) => setAddresses(event.target.value)}
              />
              <FieldDescription>{C.addressesHint}</FieldDescription>
              <FieldError issues={addressesWrong ? [{ message: C.addressesWrong }] : []} />
            </Field>
            <Field name="subscriber-retries" invalid={retryLimit === null}>
              <FieldLabel>{C.retries}</FieldLabel>
              <Input
                className="w-28"
                inputMode="numeric"
                value={retries}
                onValueChange={(value: string) => setRetries(value)}
              />
              <FieldError issues={retryLimit === null ? [{ message: C.retriesWrong }] : []} />
            </Field>
          </>
        )}
        <Field name="subscriber-namespaces" invalid={badNamespace !== undefined}>
          <FieldLabel>{C.namespaces}</FieldLabel>
          <Textarea
            aria-label={C.namespaces}
            className="w-full font-mono"
            rows={2}
            spellCheck={false}
            value={namespaces}
            onChange={(event) => setNamespaces(event.target.value)}
          />
          <FieldDescription>{C.namespacesHint}</FieldDescription>
          <FieldError
            issues={
              badNamespace !== undefined
                ? [{ message: C.namespaceWrong(badNamespace.line) }]
                : namespaceLines.length > 0 && namespacesCount
                  ? [{ message: C.namespacesCount }]
                  : []
            }
          />
        </Field>
        <Field name="subscriber-patterns" invalid={badPattern !== undefined}>
          <FieldLabel>{C.patterns}</FieldLabel>
          <Textarea
            aria-label={C.patterns}
            className="w-full font-mono"
            rows={3}
            spellCheck={false}
            value={patterns}
            onChange={(event) => setPatterns(event.target.value)}
          />
          <FieldDescription>{C.patternsHint}</FieldDescription>
          <FieldError
            issues={
              badPattern !== undefined && !badPattern.checked.ok
                ? [{ message: C.patternWrong(badPattern.line, badPattern.checked.message) }]
                : patternLines.length > 0 && patternsCount
                  ? [{ message: C.patternsCount }]
                  : []
            }
          />
        </Field>
        <div className="flex flex-col gap-(--cue-space-1)">
          <Checkbox label={C.content} checked={content} onCheckedChange={(checked: boolean) => setContent(checked)} />
          <p className="text-(length:--cue-text-label) text-fg-muted">{C.contentHint}</p>
        </div>
        {problem === null ? null : <Problem message={problem} />}
        <div className="flex gap-(--cue-space-2)">
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void add()}>
            {C.add}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {C.cancel}
          </Button>
        </div>
      </Panel>
    </section>
  );
}
