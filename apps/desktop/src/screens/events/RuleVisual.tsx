/**
 * The visual rule editor (0.33.0, the approved prototype's RuleEdit): five sections — when, which messages, ask a
 * judge, then do, and what's kept and the limit — each reading its part of the canonical rule document and writing back
 * only the fields it has a control for (`rule-editor/model.ts`). A part with no control here says "Edited as text" and
 * is left exactly as it is. Every value the rule's author wrote is shown in a field, or as text, never as markup.
 */
import {
  Button,
  Chip,
  IconButton,
  Input,
  Link,
  Panel,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Textarea,
  Toggle,
} from '@cueplusplus/ui';
import { X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import type { AccountNames } from '../../account-aliases.ts';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { judgeName } from '../../events-rules.ts';
import { isLaneName } from '../../grammar.ts';
import { useCall } from '../../hooks/use-call.ts';
import type { LinearState } from '../../integrations.ts';
import { EDITOR_COPY as COPY } from '../../rule-editor/copy.ts';
import {
  ACTION_KINDS,
  type ActionKind,
  type ConditionLine,
  changeTarget,
  EVENTS,
  FIELDS,
  freshTargetId,
  isObject,
  type JsonObject,
  JUDGE_INPUTS,
  judgeView,
  KEPT_FIELDS,
  keepWords,
  keptView,
  NEW_LINE,
  newTarget,
  setAccount,
  setEvent,
  setFolder,
  setJudge,
  setJudgeField,
  setKept,
  setRateCap,
  setTargets,
  setWhich,
  TESTS,
  targetsIn,
  whenView,
  whichView,
} from '../../rule-editor/model.ts';
import {
  type ContextView,
  linearView,
  SESSION_MODE_WORDS,
  SESSION_MODES,
  type SessionView,
  sessionView,
  setLinear,
  setSession,
} from '../../rule-editor/targets.ts';
import { DAY_MS, HOUR_MS } from '../../rule-editor/time.ts';
import { AuthorText, Problem } from './parts.tsx';

/**
 * A judge the person may choose — every live one `judges list` names — with its document once `judge show` gave it,
 * or null until then.
 */
export interface JudgeChoice {
  judgeId: string;
  version: number;
  kind: string;
  provider: string;
  document: JsonObject | null;
}

/** What the visual editor knows beside the document. */
export interface VisualContext {
  names: AccountNames;
  judges: readonly JudgeChoice[];
  /** Ask `choice` (its document read with `judge show` first, when it is not yet), or no judge. */
  onChooseJudge: (choice: JudgeChoice | null) => void;
  /** A judge's document is being read. */
  judgeReading: boolean;
  /** Why the judge chosen could not be read, in words to show. */
  judgeProblem: string | null;
  linear: LinearState | null;
  /** Every target id the event service has, so a new target gets one of its own. */
  takenTargetIds: ReadonlySet<string>;
  onEditAsText: () => void;
  onIntegrations: (() => void) | null;
}

/** A numbered section, as the prototype draws it. */
function Section({
  number,
  title,
  action,
  children,
}: {
  number: number;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <div className="flex items-center gap-(--cue-space-2)">
          <span
            aria-hidden="true"
            className="flex size-(--cue-icon-md) items-center justify-center rounded-control bg-accent-subtle text-(length:--cue-text-label) text-accent"
          >
            {number}
          </span>
          <h3 id={id} className="font-semibold text-fg">
            {title}
          </h3>
          {action === undefined ? null : <span className="ml-auto">{action}</span>}
        </div>
        {children}
      </Panel>
    </section>
  );
}

/** A part with no control here: it stays as it is, and the person changes it in Text. */
export function AsText({ onEditAsText }: { onEditAsText: () => void }) {
  return (
    <div data-slot="edited-as-text" className="flex flex-wrap items-center gap-(--cue-space-2)">
      <Chip tone="neutral" variant="tag">
        {COPY.asText}
      </Chip>
      <span className="text-fg-muted">{COPY.asTextBody}</span>
      <Button size="sm" variant="ghost" onClick={onEditAsText}>
        {COPY.editInText}
      </Button>
    </div>
  );
}

/** A label and its control, in the prototype's two columns. */
export function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-(--cue-space-2) sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <span className="text-(length:--cue-text-label) text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-(--cue-space-2)">{children}</div>
    </div>
  );
}

export function When({
  document,
  onChange,
  context,
}: {
  document: JsonObject;
  onChange: (next: JsonObject) => void;
  context: VisualContext;
}) {
  const view = whenView(document);
  const accounts = [...context.names.entries()].map(([id, name]) => ({ id, name }));
  const events = EVENTS.filter((each) => each.channel === (view.channel ?? 'gmail'));
  return (
    <Section number={1} title={COPY.sections.when}>
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <span>{COPY.whenLine.when}</span>
        <Select
          aria-label={COPY.event}
          value={view.eventType}
          items={events.map((each) => ({ value: each.type, label: each.words }))}
          onValueChange={(type) => type !== null && onChange(setEvent(document, type))}
        />
        <span>{COPY.whenLine.in}</span>
        <Select
          aria-label={COPY.account}
          value={view.accountId}
          items={[
            ...accounts.map(({ id, name }) => ({ value: id, label: name.alias })),
            ...(view.accountId !== null && !context.names.has(view.accountId)
              ? [{ value: view.accountId, label: view.accountId }]
              : []),
          ]}
          onValueChange={(id) => {
            const name = id === null ? undefined : context.names.get(id);
            if (id !== null && name !== undefined) onChange(setAccount(document, id, name.channel));
          }}
        />
        {view.channel === 'gmail' && view.folder !== null ? (
          <>
            <span>{COPY.whenLine.in}</span>
            <SegmentedControl
              indicator
              aria-label={COPY.folder}
              size="sm"
              value={view.folder}
              items={[
                { value: 'inbox', label: COPY.folders.inbox },
                { value: 'any', label: COPY.folders.any },
              ]}
              onValueChange={(folder) => onChange(setFolder(document, folder as 'inbox' | 'any'))}
            />
          </>
        ) : null}
      </div>
      {view.asText ? <AsText onEditAsText={context.onEditAsText} /> : null}
    </Section>
  );
}

function ConditionRow({
  line,
  index,
  only,
  onLine,
  onRemove,
}: {
  line: ConditionLine;
  index: number;
  only: boolean;
  onLine: (line: ConditionLine) => void;
  onRemove: () => void;
}) {
  const fields = FIELDS.some((each) => each.path === line.path)
    ? FIELDS
    : [...FIELDS, { path: line.path, words: line.path }];
  return (
    <div data-slot="condition" className="flex flex-wrap items-center gap-(--cue-space-2)">
      <Select
        aria-label={`${COPY.field} ${index + 1}`}
        value={line.path}
        items={fields.map((each) => ({ value: each.path, label: each.words }))}
        onValueChange={(path) => path !== null && onLine({ ...line, path })}
      />
      <Select
        aria-label={`${COPY.test} ${index + 1}`}
        value={line.op}
        items={TESTS.map((each) => ({ value: each.op, label: each.words }))}
        onValueChange={(op) => op !== null && onLine({ ...line, op })}
      />
      <Input
        aria-label={`${COPY.value} ${index + 1}`}
        className="min-w-40 flex-1"
        value={line.value}
        spellCheck={false}
        onValueChange={(value: string) => onLine({ ...line, value })}
      />
      <IconButton
        icon={X}
        aria-label={COPY.removeCondition}
        variant="ghost"
        size="sm"
        disabled={only}
        onClick={onRemove}
      />
    </div>
  );
}

export function Which({
  document,
  onChange,
  context,
}: {
  document: JsonObject;
  onChange: (next: JsonObject) => void;
  context: VisualContext;
}) {
  const view = whichView(document);
  return (
    <Section number={2} title={COPY.sections.which}>
      {view === null ? (
        <AsText onEditAsText={context.onEditAsText} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-(--cue-space-2)">
            <span>{COPY.passOn}</span>
            <SegmentedControl
              indicator
              aria-label="Match"
              size="sm"
              value={view.match}
              items={[
                { value: 'any', label: COPY.matchWords.any },
                { value: 'all', label: COPY.matchWords.all },
              ]}
              onValueChange={(match) => onChange(setWhich(document, { ...view, match: match as 'any' | 'all' }))}
            />
            <span>{COPY.ofThese}</span>
          </div>
          {view.lines.map((line, index) => (
            <ConditionRow
              // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place in the list, which the editor keeps.
              key={index}
              line={line}
              index={index}
              only={view.lines.length === 1}
              onLine={(next) =>
                onChange(
                  setWhich(document, { ...view, lines: view.lines.map((each, at) => (at === index ? next : each)) }),
                )
              }
              onRemove={() =>
                onChange(setWhich(document, { ...view, lines: view.lines.filter((_, at) => at !== index) }))
              }
            />
          ))}
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange(
                  setWhich(document, {
                    match: view.lines.length === 1 ? 'any' : view.match,
                    lines: [...view.lines, { ...NEW_LINE }],
                  }),
                )
              }
            >
              {COPY.addCondition}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

const PROVIDER_WORDS: Readonly<Record<string, string>> = { openrouter: 'OpenRouter', typesafe: 'TypeSafe' };

function judgeLabel(choice: JudgeChoice): string {
  const name = judgeName(choice.kind);
  const through =
    choice.provider !== choice.kind && choice.provider !== ''
      ? `, through ${PROVIDER_WORDS[choice.provider] ?? choice.provider}`
      : '';
  return `${name}${through}, version ${choice.version}`;
}

export function Judge({
  document,
  onChange,
  context,
}: {
  document: JsonObject;
  onChange: (next: JsonObject) => void;
  context: VisualContext;
}) {
  const view = judgeView(document);
  const usable = context.judges;
  const current = view === null ? null : `${view.judgeId}@${view.judgeVersion}`;
  const toggle = (
    <Switch
      aria-label={COPY.askAJudge}
      checked={view !== null}
      disabled={view === null && (usable.length === 0 || context.judgeReading)}
      onCheckedChange={(on: boolean) => {
        const first = usable[0];
        if (on && first !== undefined) context.onChooseJudge(first);
        else if (!on) onChange(setJudge(document, null));
      }}
    />
  );
  return (
    <Section number={3} title={COPY.sections.judge} action={toggle}>
      {context.judgeReading ? <p className="text-fg-muted">{COPY.judgeReading}</p> : null}
      {context.judgeProblem === null ? null : <Problem message={context.judgeProblem} />}
      {view === null ? (
        usable.length === 0 ? (
          <p className="text-fg-muted">{COPY.noJudgeKnown}</p>
        ) : null
      ) : (
        <div className="flex flex-col gap-(--cue-space-3)">
          <Line label={COPY.judge}>
            <Select
              aria-label={COPY.judge}
              value={current}
              items={[
                ...context.judges.map((choice) => ({
                  value: `${choice.judgeId}@${choice.version}`,
                  label: judgeLabel(choice),
                  disabled: context.judgeReading,
                })),
                ...(context.judges.some((choice) => `${choice.judgeId}@${choice.version}` === current)
                  ? []
                  : [{ value: current ?? '', label: `${judgeName(view.kind)}, version ${view.judgeVersion ?? '?'}` }]),
              ]}
              onValueChange={(value) => {
                const choice = context.judges.find((each) => `${each.judgeId}@${each.version}` === value);
                if (choice !== undefined && value !== current) context.onChooseJudge(choice);
              }}
            />
          </Line>
          <Line label={COPY.question}>
            <Textarea
              aria-label={COPY.question}
              className="w-full"
              rows={2}
              value={view.question}
              onChange={(event) => onChange(setJudgeField(document, 'question', event.target.value))}
            />
          </Line>
          <Line label={COPY.looksAt}>
            {JUDGE_INPUTS.map((input) => (
              <Toggle
                key={input.path}
                size="sm"
                pressed={view.inputs.includes(input.path)}
                onPressedChange={(pressed: boolean) =>
                  onChange(
                    setJudgeField(
                      document,
                      'inputs',
                      pressed ? [...view.inputs, input.path] : view.inputs.filter((each) => each !== input.path),
                    ),
                  )
                }
              >
                {input.words}
              </Toggle>
            ))}
          </Line>
          {view.threshold === null ? null : (
            <Line label={COPY.yesWhen}>
              <Slider
                aria-label={COPY.yesWhen}
                className="min-w-40 flex-1"
                min={0.5}
                max={0.95}
                step={0.05}
                value={view.threshold}
                onValueChange={(value: number | readonly number[]) => {
                  const next = typeof value === 'number' ? value : value[0];
                  if (typeof next === 'number')
                    onChange(setJudgeField(document, 'threshold', Math.round(next * 100) / 100));
                }}
              />
              <span className="font-medium tabular-nums">{view.threshold.toFixed(2)}</span>
            </Line>
          )}
          <Line label={COPY.ifUnsure}>
            <SegmentedControl
              indicator
              aria-label={COPY.ifUnsure}
              size="sm"
              value={view.onUncertain ?? 'no-match'}
              items={[
                { value: 'no-match', label: COPY.unsure['no-match'] },
                { value: 'hold', label: COPY.unsure.hold },
              ]}
              onValueChange={(value) => onChange(setJudgeField(document, 'onUncertain', value))}
            />
          </Line>
          {view.callsPerRollingHour === null ? null : (
            <p className="text-(length:--cue-text-label) text-fg-muted">{COPY.judgeLimits(view.callsPerRollingHour)}</p>
          )}
        </div>
      )}
    </Section>
  );
}

/** A retention choice: the ones offered, and the one the target has when it is another. */
function KeepFor({
  label,
  value,
  offered,
  onChange,
}: {
  label: string;
  value: number;
  offered: readonly number[];
  onChange: (ms: number) => void;
}) {
  const choices = offered.includes(value) ? offered : [...offered, value];
  return (
    <SegmentedControl
      indicator
      aria-label={label}
      size="sm"
      value={String(value)}
      items={choices.map((ms) => ({ value: String(ms), label: keepWords(ms) }))}
      onValueChange={(ms) => onChange(Number(ms))}
    />
  );
}

/** One action's card, with its heading and its Remove. */
function ActionCard({
  kind,
  title,
  extra,
  onRemove,
  children,
}: {
  kind: string;
  title: string;
  extra?: ReactNode;
  onRemove: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-action={kind} className="rounded-control bg-surface-2 p-(--cue-space-3)">
      <div className="mb-(--cue-space-2) flex flex-wrap items-center gap-(--cue-space-2)">
        <h4 id={id} className="font-semibold text-fg">
          {title}
        </h4>
        {extra}
        <IconButton
          icon={X}
          aria-label={COPY.remove(title.toLowerCase())}
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onRemove}
        />
      </div>
      <div className="flex flex-col gap-(--cue-space-2)">{children}</div>
    </section>
  );
}

const QUEUE_KEEPS = [7 * DAY_MS, 30 * DAY_MS] as const;
const DRY_RUN_KEEPS = [HOUR_MS, 12 * HOUR_MS, DAY_MS] as const;

export function QueueAction({ target, onTarget }: { target: JsonObject; onTarget: (next: JsonObject) => void }) {
  const lane = isObject(target.lane) && typeof target.lane.name === 'string' ? target.lane.name : '';
  const retention = typeof target.retentionMs === 'number' ? target.retentionMs : 7 * DAY_MS;
  return (
    <>
      <Line label={COPY.lane}>
        <Input
          aria-label={COPY.lane}
          value={lane}
          spellCheck={false}
          onValueChange={(value: string) => {
            const next = { ...target };
            if (value === '') delete next.lane;
            else next.lane = { name: value };
            onTarget(next);
          }}
        />
        {lane !== '' && !isLaneName(lane) ? (
          <span className="text-danger">A lane is 1 to 40 lowercase letters, digits and -.</span>
        ) : null}
      </Line>
      <Line label={COPY.keepFor}>
        <KeepFor
          label={COPY.keepFor}
          value={retention}
          offered={QUEUE_KEEPS}
          onChange={(retentionMs) => onTarget({ ...target, retentionMs })}
        />
      </Line>
    </>
  );
}

export function DryRunAction({ target, onTarget }: { target: JsonObject; onTarget: (next: JsonObject) => void }) {
  const retention = typeof target.retentionMs === 'number' ? target.retentionMs : DAY_MS;
  return (
    <Line label={COPY.keepFor}>
      <KeepFor
        label={COPY.keepFor}
        value={retention}
        offered={DRY_RUN_KEEPS}
        onChange={(retentionMs) => onTarget({ ...target, retentionMs })}
      />
    </Line>
  );
}

const CONTEXT_FIELDS: readonly { path: string; words: string; key: string }[] = [
  { path: '/from', words: 'Sender', key: 'from' },
  { path: '/subject', words: 'Subject', key: 'subject' },
  { path: '/snippet', words: 'First 300 characters', key: 'snippet' },
  { path: '/messageId', words: 'Link to the message', key: 'messageId' },
];

function ContextPart({
  part,
  index,
  kept,
  onPart,
  onRemove,
}: {
  part: ContextView;
  index: number;
  kept: readonly string[] | null;
  onPart: (part: ContextView) => void;
  onRemove: () => void;
}) {
  const label = COPY.context[part.kind];
  let body: ReactNode;
  switch (part.kind) {
    case 'fields':
      body = CONTEXT_FIELDS.filter((field) => kept === null || kept.includes(field.key)).map((field) => (
        <Toggle
          key={field.path}
          size="sm"
          pressed={part.fields.includes(field.path)}
          onPressedChange={(pressed: boolean) =>
            onPart({
              kind: 'fields',
              fields: pressed ? [...part.fields, field.path] : part.fields.filter((each) => each !== field.path),
            })
          }
        >
          {field.words}
        </Toggle>
      ));
      break;
    case 'text':
      body = (
        <Textarea
          aria-label={`${label} ${index + 1}`}
          className="w-full"
          rows={2}
          value={part.text}
          onChange={(event) => onPart({ kind: 'text', text: event.target.value })}
        />
      );
      break;
    case 'generate':
      body = (
        <div className="flex w-full flex-col gap-(--cue-space-1)">
          <span className="text-(length:--cue-text-label) text-fg-muted">
            <UntrustedText text={[part.provider, part.model].filter(Boolean).join(' · ') || 'A model'} />
          </span>
          <Input
            aria-label={`${COPY.instruction} ${index + 1}`}
            value={part.instruction}
            onValueChange={(instruction: string) => onPart({ ...part, instruction })}
          />
        </div>
      );
      break;
    case 'file':
      body = (
        <Input
          aria-label={`${COPY.filePath} ${index + 1}`}
          className="min-w-40 flex-1"
          value={part.path}
          spellCheck={false}
          onValueChange={(path: string) => onPart({ kind: 'file', path })}
        />
      );
      break;
  }
  return (
    <div
      data-slot="context-part"
      className="flex items-start gap-(--cue-space-2) rounded-control bg-surface p-(--cue-space-2)"
    >
      <span className="min-w-28 pt-(--cue-space-1) font-semibold text-(length:--cue-text-label) text-fg-subtle uppercase">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-(--cue-space-1)">{body}</div>
      <IconButton icon={X} aria-label={COPY.removePart} variant="ghost" size="sm" onClick={onRemove} />
    </div>
  );
}

function SessionAction({
  target,
  kept,
  onTarget,
  onEditAsText,
}: {
  target: JsonObject;
  kept: readonly string[] | null;
  onTarget: (next: JsonObject) => void;
  onEditAsText: () => void;
}) {
  const view = sessionView(target);
  if (view === null) return <AsText onEditAsText={onEditAsText} />;
  const set = (next: Partial<SessionView>) => onTarget(setSession(target, { ...view, ...next }));
  return (
    <>
      <Line label={COPY.find}>
        <SegmentedControl
          indicator
          aria-label={COPY.find}
          size="sm"
          value={view.findBy}
          items={[
            { value: 'folder', label: COPY.findBy.folder },
            { value: 'lane', label: COPY.findBy.lane },
          ]}
          onValueChange={(findBy) => set({ findBy: findBy as 'folder' | 'lane', windowOnly: false })}
        />
        <Input
          aria-label={view.findBy === 'lane' ? COPY.findLane : COPY.findFolder}
          className="min-w-40 flex-1"
          value={view.where}
          spellCheck={false}
          onValueChange={(where: string) => set({ where })}
        />
      </Line>
      {view.windowOnly ? (
        <p className="text-fg-muted">{COPY.windowOnly}</p>
      ) : (
        <>
          <Line label={COPY.ifNone}>
            <SegmentedControl
              indicator
              aria-label={COPY.ifNone}
              size="sm"
              value={view.ifNone}
              items={[
                { value: 'start', label: COPY.none.start },
                { value: 'queue-only', label: COPY.none['queue-only'] },
              ]}
              onValueChange={(ifNone) => set({ ifNone: ifNone as SessionView['ifNone'] })}
            />
            <SegmentedControl
              indicator
              aria-label={COPY.with}
              size="sm"
              value={view.provider}
              items={[
                { value: 'claude', label: COPY.providers.claude },
                { value: 'codex', label: COPY.providers.codex },
              ]}
              onValueChange={(provider) => set({ provider: provider as SessionView['provider'] })}
            />
          </Line>
          <Line label={COPY.ifBusy}>
            <SegmentedControl
              indicator
              aria-label={COPY.ifBusy}
              size="sm"
              value={view.ifBusy}
              items={[
                { value: 'queue', label: COPY.busy.queue },
                { value: 'queue-only', label: COPY.busy['queue-only'] },
              ]}
              onValueChange={(ifBusy) => set({ ifBusy: ifBusy as SessionView['ifBusy'] })}
            />
          </Line>
          <Line label={COPY.mode}>
            <SegmentedControl
              indicator
              aria-label={COPY.mode}
              size="sm"
              value={view.mode}
              items={SESSION_MODES.map((mode) => ({ value: mode, label: COPY.modes[mode] }))}
              onValueChange={(mode) => set({ mode: mode as SessionView['mode'] })}
            />
            <span className="text-(length:--cue-text-label) text-fg-muted">{SESSION_MODE_WORDS[view.mode]}</span>
          </Line>
          <Line label={COPY.giveIt}>
            {view.context === null ? (
              <AsText onEditAsText={onEditAsText} />
            ) : (
              <div className="flex w-full flex-col gap-(--cue-space-1)">
                {view.context.map((part, index) => (
                  <ContextPart
                    // biome-ignore lint/suspicious/noArrayIndexKey: a part is its place in the list, which the editor keeps.
                    key={index}
                    part={part}
                    index={index}
                    kept={kept}
                    onPart={(next) =>
                      set({ context: (view.context ?? []).map((each, at) => (at === index ? next : each)) })
                    }
                    onRemove={() => set({ context: (view.context ?? []).filter((_, at) => at !== index) })}
                  />
                ))}
                <div className="flex flex-wrap items-center gap-(--cue-space-1)">
                  <span className="text-(length:--cue-text-label) text-fg-muted">{COPY.addContext}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => set({ context: [...(view.context ?? []), { kind: 'text', text: '' }] })}
                  >
                    {COPY.addContextKinds.text}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => set({ context: [...(view.context ?? []), { kind: 'file', path: '' }] })}
                  >
                    {COPY.addContextKinds.file}
                  </Button>
                  <Button size="sm" variant="ghost" disabled title={COPY.laterRelease}>
                    {COPY.addContextKinds.url}
                  </Button>
                  <Button size="sm" variant="ghost" disabled title={COPY.laterRelease}>
                    {COPY.addContextKinds.command}
                  </Button>
                </div>
              </div>
            )}
          </Line>
          {view.instruction === null ? null : (
            // What the session is told last has no control here: shown as its author wrote it, and kept as it was.
            <Line label={COPY.toldLast}>
              <div data-slot="instruction" className="flex w-full flex-col gap-(--cue-space-1)">
                <AuthorText text={view.instruction} />
                <AsText onEditAsText={onEditAsText} />
              </div>
            </Line>
          )}
        </>
      )}
    </>
  );
}

/**
 * A Linear issue's labels: the team's own and the workspace's, as `integration show linear --team` lists them, each to
 * set or not; the ones the target names already are kept, read or not. A label's name is Linear's text: text only.
 */
function LinearLabels({
  team,
  chosen,
  onChosen,
}: {
  team: string | null;
  chosen: readonly { id: string; name: string }[];
  onChosen: (labels: { id: string; name: string }[]) => void;
}) {
  const read = useCall<unknown>(team === null ? null : { kind: 'integrationShow', integration: 'linear', team }).result;
  const listed =
    read.state === 'ready' && isObject(read.value) && Array.isArray(read.value.labels)
      ? read.value.labels.flatMap((label) =>
          isObject(label) && typeof label.id === 'string' && typeof label.name === 'string'
            ? [{ id: label.id, name: label.name }]
            : [],
        )
      : [];
  const all = [...listed, ...chosen.filter((label) => !listed.some((each) => each.id === label.id))];
  if (all.length === 0) return <span className="text-fg-muted">{COPY.noLabels}</span>;
  return (
    <>
      {all.map((label) => {
        const on = chosen.some((each) => each.id === label.id);
        return (
          <Toggle
            key={label.id}
            size="sm"
            pressed={on}
            onPressedChange={(pressed: boolean) => {
              const next = pressed ? [...chosen, label] : chosen.filter((each) => each.id !== label.id);
              // As the Linear target keeps them: each once, sorted by id.
              onChosen([...next].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
            }}
          >
            <UntrustedText text={label.name} />
          </Toggle>
        );
      })}
    </>
  );
}

export function LinearAction({
  target,
  linear,
  onTarget,
  onEditAsText,
}: {
  target: JsonObject;
  linear: LinearState | null;
  onTarget: (next: JsonObject) => void;
  onEditAsText: () => void;
}) {
  const view = linearView(target);
  if (view === null) return <AsText onEditAsText={onEditAsText} />;
  const teams = linear?.teams ?? [];
  const items = [
    ...teams.map((team) => ({ value: team.id, label: `${team.key} · ${team.name}` })),
    ...(view.teamId !== '' && !teams.some((team) => team.id === view.teamId)
      ? [{ value: view.teamId, label: view.teamKey || view.teamId }]
      : []),
  ];
  return (
    <>
      <Line label={COPY.team}>
        <Select
          aria-label={COPY.team}
          value={view.teamId === '' ? null : view.teamId}
          placeholder={COPY.team}
          disabled={items.length === 0}
          items={items}
          onValueChange={(id) => {
            const team = teams.find((each) => each.id === id);
            if (team !== undefined) onTarget(setLinear(target, { ...view, teamId: team.id, teamKey: team.key }));
          }}
        />
      </Line>
      <Line label={COPY.title}>
        {view.title === null ? (
          <AsText onEditAsText={onEditAsText} />
        ) : view.title.kind === 'text' ? (
          <Input
            aria-label={COPY.title}
            className="min-w-40 flex-1"
            value={view.title.text}
            onValueChange={(text: string) => onTarget(setLinear(target, { ...view, title: { kind: 'text', text } }))}
          />
        ) : (
          <Input
            aria-label={COPY.title}
            className="min-w-40 flex-1"
            value={view.title.instruction}
            onValueChange={(instruction: string) =>
              view.title?.kind === 'generate' &&
              onTarget(setLinear(target, { ...view, title: { ...view.title, instruction } }))
            }
          />
        )}
      </Line>
      <Line label={COPY.description}>
        {view.description === null || view.description.kind !== 'text' ? (
          <AsText onEditAsText={onEditAsText} />
        ) : (
          <Textarea
            aria-label={COPY.description}
            className="w-full"
            rows={2}
            value={view.description.text}
            onChange={(event) =>
              onTarget(setLinear(target, { ...view, description: { kind: 'text', text: event.target.value } }))
            }
          />
        )}
      </Line>
      <Line label={COPY.labels}>
        {view.labels === null ? (
          <AsText onEditAsText={onEditAsText} />
        ) : (
          <LinearLabels
            team={linear?.connected === true && view.teamKey !== '' ? view.teamKey : null}
            chosen={view.labels}
            onChosen={(labels) => onTarget(setLinear(target, { ...view, labels }))}
          />
        )}
      </Line>
      <Line label={COPY.assignee}>
        {view.assignee === 'someone' ? (
          <AsText onEditAsText={onEditAsText} />
        ) : (
          <SegmentedControl
            indicator
            aria-label={COPY.assignee}
            size="sm"
            value={view.assignee}
            items={[
              { value: 'me', label: COPY.assignees.me },
              { value: 'nobody', label: COPY.assignees.nobody },
            ]}
            onValueChange={(assignee) =>
              onTarget(setLinear(target, { ...view, assignee: assignee as 'me' | 'nobody' }))
            }
          />
        )}
      </Line>
    </>
  );
}

function Then({
  document,
  onChange,
  context,
}: {
  document: JsonObject;
  onChange: (next: JsonObject) => void;
  context: VisualContext;
}) {
  const targets = targetsIn(document);
  const kept = keptView(document);
  const ruleId = typeof document.ruleId === 'string' ? document.ruleId : 'rule';
  const taken = new Set([
    ...context.takenTargetIds,
    ...targets.flatMap((each) => (typeof each.targetId === 'string' ? [each.targetId] : [])),
  ]);
  const add = (kind: Exclude<ActionKind, 'webhook'>) =>
    onChange(setTargets(document, [...targets, newTarget(kind, freshTargetId(ruleId, kind, taken))]));
  const remove = (index: number) =>
    onChange(
      setTargets(
        document,
        targets.filter((_, at) => at !== index),
      ),
    );
  const linearOff = context.linear !== null && !context.linear.connected;
  return (
    <Section number={4} title={COPY.sections.thenDo}>
      {targets.map((target, index) => {
        const kind = typeof target.kind === 'string' ? target.kind : 'other';
        const title = COPY.actions[kind as keyof typeof COPY.actions] ?? COPY.actions.other;
        const onTarget = (next: JsonObject) => onChange(changeTarget(document, index, () => next));
        const key = `${String(target.targetId)}-${index}`;
        switch (kind) {
          case 'queue':
            return (
              <ActionCard key={key} kind={kind} title={title} onRemove={() => remove(index)}>
                <QueueAction target={target} onTarget={onTarget} />
              </ActionCard>
            );
          case 'dry-run':
            return (
              <ActionCard key={key} kind={kind} title={title} onRemove={() => remove(index)}>
                <DryRunAction target={target} onTarget={onTarget} />
              </ActionCard>
            );
          case 'session':
            return (
              <ActionCard key={key} kind={kind} title={title} onRemove={() => remove(index)}>
                <SessionAction target={target} kept={kept} onTarget={onTarget} onEditAsText={context.onEditAsText} />
              </ActionCard>
            );
          case 'linear':
            return (
              <ActionCard
                key={key}
                kind={kind}
                title={title}
                onRemove={() => remove(index)}
                extra={linearOff ? <Chip tone="warn">{COPY.linearNotConnected}</Chip> : undefined}
              >
                <LinearAction
                  target={target}
                  linear={context.linear}
                  onTarget={onTarget}
                  onEditAsText={context.onEditAsText}
                />
                {linearOff ? (
                  <p className="text-(length:--cue-text-label) text-fg-muted">
                    {context.onIntegrations === null ? (
                      COPY.connectFirst
                    ) : (
                      <>
                        Connect Linear in{' '}
                        <Link
                          href="#integrations"
                          onClick={(event) => {
                            event.preventDefault();
                            context.onIntegrations?.();
                          }}
                        >
                          {COPY.openIntegrations}
                        </Link>{' '}
                        first.
                      </>
                    )}
                  </p>
                ) : null}
              </ActionCard>
            );
          case 'webhook':
          case 'sse':
            return (
              <ActionCard key={key} kind={kind} title={title} onRemove={() => remove(index)}>
                <p className="text-fg-muted">{COPY.setAtTerminal}</p>
              </ActionCard>
            );
          default:
            return (
              <ActionCard key={key} kind="other" title={title} onRemove={() => remove(index)}>
                <AsText onEditAsText={context.onEditAsText} />
              </ActionCard>
            );
        }
      })}
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <span className="text-(length:--cue-text-label) text-fg-muted">{COPY.add}</span>
        {ACTION_KINDS.map((kind) =>
          kind === 'webhook' ? (
            <Button key={kind} size="sm" variant="ghost" disabled title={COPY.webhookAtTerminal}>
              {COPY.addWords.webhook}
            </Button>
          ) : (
            <Button key={kind} size="sm" variant="ghost" onClick={() => add(kind)}>
              {COPY.addWords[kind]}
            </Button>
          ),
        )}
      </div>
    </Section>
  );
}

export function Kept({
  document,
  onChange,
  context,
}: {
  document: JsonObject;
  onChange: (next: JsonObject) => void;
  context: VisualContext;
}) {
  const kept = keptView(document);
  const cap = typeof document.deliveryRateCap === 'number' ? document.deliveryRateCap : null;
  return (
    <Section number={5} title={COPY.sections.kept}>
      <Line label={COPY.keep}>
        {kept === null ? (
          <AsText onEditAsText={context.onEditAsText} />
        ) : (
          KEPT_FIELDS.map((field) => (
            <Toggle
              key={field.key}
              size="sm"
              pressed={kept.includes(field.key)}
              onPressedChange={(pressed: boolean) =>
                onChange(setKept(document, pressed ? [...kept, field.key] : kept.filter((each) => each !== field.key)))
              }
            >
              {field.words}
            </Toggle>
          ))
        )}
      </Line>
      <Line label={COPY.atMost}>
        <Input
          aria-label={COPY.atMost}
          className="w-20"
          inputMode="numeric"
          value={cap === null ? '' : String(cap)}
          onValueChange={(value: string) => {
            const next = Number(value);
            if (/^[1-9][0-9]{0,5}$/u.test(value) && Number.isSafeInteger(next)) onChange(setRateCap(document, next));
          }}
        />
        <span>{COPY.anHour}</span>
      </Line>
    </Section>
  );
}

/** The five sections, in the prototype's order. */
export function RuleVisual({
  document,
  onChange,
  context,
}: {
  document: JsonObject;
  onChange: (next: JsonObject) => void;
  context: VisualContext;
}) {
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      <When document={document} onChange={onChange} context={context} />
      <Which document={document} onChange={onChange} context={context} />
      <Judge document={document} onChange={onChange} context={context} />
      <Then document={document} onChange={onChange} context={context} />
      <Kept document={document} onChange={onChange} context={context} />
    </div>
  );
}
