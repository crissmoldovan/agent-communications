/**
 * The settings of what is selected on the canvas (workflows design §11.3, the prototype's settings panel): a step's
 * own controls, one part per kind, its label, its Events (one tick per Appendix W event, all off), where it comes
 * from and goes on to, what the checks found, and Remove; a gate box's, the rule editor's own controls for when it
 * starts, which messages, its judge and what it keeps (`RuleVisual`); and with nothing selected, the workflow's.
 *
 * Each control writes back only the field it is for (`applyStep`); a field with no control here says "Edited as
 * text" and is left exactly as it was. A deliver step's settings edit its target, so Save makes that target a new
 * version (`save.ts`). Everything the workflow's author wrote is shown in a field or as text, never as markup.
 */
import {
  Button,
  Chip,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Panel,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  Toggle,
} from '@cueplusplus/ui';
import { type ReactNode, useEffect, useState } from 'react';
import type { AccountNames } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import type { LinearState } from '../../integrations.ts';
import { copyOf, isObject, type Json, type JsonObject, TESTS, targetsIn } from '../../rule-editor/model.ts';
import { applyDelete, applyStep, flowOfDocument, GATE, stepTitle, targetOf } from '../../workflows/canvas.ts';
import type { DesignerProblem } from '../../workflows/checks.ts';
import { SETTINGS_COPY as COPY, outcomeWords } from '../../workflows/copy.ts';
import {
  type FlowStep,
  isEventSegment,
  outcomesOf,
  STANDARD_STEP_EVENTS,
  type StepKind,
} from '../../workflows/flow.ts';
import { mappedPointers, WAIT_DEFAULTS } from '../../workflows/palette.ts';
import {
  DAY,
  eventNames,
  HOUR,
  MINUTE,
  setEventNames,
  spanWords,
  tickEvent,
  ticksOf,
} from '../../workflows/settings.ts';
import { type ProjectV1, readProjects } from '../../workflows/types.ts';
import {
  DryRunAction,
  Judge,
  type JudgeChoice,
  Kept,
  LinearAction,
  QueueAction,
  type VisualContext,
  When,
  Which,
} from '../events/RuleVisual.tsx';
import { EventTicks, tickedOf } from './EventTicks.tsx';
import { WorkflowSettings } from './WorkflowSettings.tsx';

/** What a step's settings know beside the document. */
export interface SettingsContext {
  readonly names: AccountNames;
  readonly judges: readonly JudgeChoice[];
  /** A judge's whole document, read with `judge show` when it is not yet; null when it cannot be read. */
  readonly readJudge: (choice: JudgeChoice) => Promise<JsonObject | null>;
  readonly linear: LinearState | null;
  readonly webhooks: readonly JsonObject[];
  /** The rule editor's own context, for the gate's boxes. */
  readonly visual: VisualContext;
  readonly onEditAsText: () => void;
}

type Change = (step: JsonObject) => JsonObject;

const SPANS = [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 12 * HOUR, DAY, 3 * DAY] as const;

function SpanSelect({ label, value, onValue }: { label: string; value: number; onValue: (ms: number) => void }) {
  const offered = SPANS.some((each) => each === value) ? [...SPANS] : [...SPANS, value].sort((a, b) => a - b);
  return (
    <Select
      aria-label={label}
      value={String(value)}
      items={offered.map((each) => ({ value: String(each), label: spanWords(each) }))}
      onValueChange={(chosen) => chosen !== null && onValue(Number(chosen))}
    />
  );
}

/** A label and its control, stacked, as the prototype's settings draw them. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1) border-border border-t pt-(--cue-space-2)">
      <span className="font-medium text-(length:--cue-text-label) text-fg-subtle">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-(--cue-space-2)">{children}</div>
    </div>
  );
}

function AsText({ onEditAsText }: { onEditAsText: () => void }) {
  return (
    <div data-slot="edited-as-text" className="flex flex-wrap items-center gap-(--cue-space-2)">
      <Chip tone="neutral" variant="tag">
        {COPY.asText}
      </Chip>
      <span className="text-fg-muted">{COPY.asTextBody}</span>
      <Button size="sm" variant="ghost" onClick={onEditAsText}>
        Edit in Text
      </Button>
    </div>
  );
}

/** Every step of the flow, by id. */
function stepsOf(document: JsonObject): [string, JsonObject][] {
  const steps = flowOfDocument(document).flow.steps as unknown as Record<string, Json>;
  return Object.entries(steps ?? {}).flatMap(([id, step]) =>
    isObject(step) ? [[id, step] as [string, JsonObject]] : [],
  );
}

/** The ids of the steps of `kinds`, or of the deliver steps whose target is of `targetKind`. */
function idsOf(document: JsonObject, take: (step: JsonObject) => boolean): string[] {
  return stepsOf(document)
    .filter(([, step]) => take(step))
    .map(([id]) => id);
}

/** A choice among some steps, by id. */
function StepChoice({
  label,
  ids,
  value,
  onValue,
}: {
  label: string;
  ids: readonly string[];
  value: string;
  onValue: (id: string) => void;
}) {
  const items = [...ids, ...(value !== '' && !ids.includes(value) ? [value] : [])].map((id) => ({
    value: id,
    label: id,
  }));
  return (
    <Select
      aria-label={label}
      value={value === '' ? null : value}
      placeholder={label}
      disabled={items.length === 0}
      items={items}
      onValueChange={(id) => id !== null && onValue(id)}
    />
  );
}

/** The mapped fields as a condition reads them (`/fields/…`), from the workflow's mapping. */
const fieldsOf = (document: JsonObject) => mappedPointers(document).map((pointer) => `/fields${pointer}`);

function ConditionPart({ step, document, change, onEditAsText }: PartProps) {
  const when = isObject(step.when) ? step.when : {};
  const leaf = typeof when.path === 'string' && typeof when.op === 'string' && when.path.startsWith('/fields/');
  if (!leaf || !TESTS.some((test) => test.op === when.op)) return <AsText onEditAsText={onEditAsText} />;
  const fields = fieldsOf(document);
  const path = when.path as string;
  const op = when.op as string;
  const items = [...fields, ...(fields.includes(path) ? [] : [path])].map((each) => ({
    value: each,
    label: each.slice('/fields/'.length).replaceAll('/', '.'),
  }));
  const set = (next: JsonObject) => change((before) => ({ ...before, when: next }));
  const valued = op !== 'exists' && op !== 'in' && op !== 'gt' && op !== 'gte' && op !== 'lt' && op !== 'lte';
  return (
    <>
      <Row label={COPY.condition.field}>
        <Select
          aria-label={COPY.condition.field}
          value={path}
          items={items}
          onValueChange={(chosen) => chosen !== null && set({ ...when, path: chosen })}
        />
        <Select
          aria-label={COPY.condition.test}
          value={op}
          items={TESTS.map((test) => ({ value: test.op, label: test.words }))}
          onValueChange={(chosen) =>
            chosen !== null &&
            set(
              chosen === 'domainIs'
                ? { path, op: chosen, value: typeof when.value === 'string' ? when.value : '', includeSubdomains: true }
                : { path, op: chosen, value: typeof when.value === 'string' ? when.value : '', caseSensitive: false },
            )
          }
        />
      </Row>
      {valued ? (
        <Row label={COPY.condition.value}>
          <Input
            aria-label={COPY.condition.value}
            className="min-w-40 flex-1"
            value={typeof when.value === 'string' ? when.value : String(when.value ?? '')}
            onValueChange={(value: string) => set({ ...when, value })}
          />
        </Row>
      ) : null}
    </>
  );
}

/** A judge's settings, as a judge step's `ask` or a route's `judge` holds them. */
function AskPart({
  ask,
  document,
  context,
  onAsk,
}: {
  ask: JsonObject;
  document: JsonObject;
  context: SettingsContext;
  onAsk: (ask: JsonObject) => void;
}) {
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const judge = isObject(ask.judge) ? ask.judge : null;
  const chosen = judge === null ? null : `${String(judge.judgeId)}@${String(judge.version)}`;
  const items = context.judges.map((each) => ({
    value: `${each.judgeId}@${each.version}`,
    label: `${each.judgeId}, version ${each.version}`,
  }));
  const inputs = Array.isArray(ask.inputs) ? ask.inputs.filter((each): each is string => typeof each === 'string') : [];
  const threshold = typeof ask.threshold === 'number' ? ask.threshold : 0.7;
  return (
    <>
      <Row label={COPY.judge.judge}>
        {items.length === 0 ? (
          <span className="text-fg-muted">{COPY.judge.noJudges}</span>
        ) : (
          <Select
            aria-label={COPY.judge.judge}
            value={chosen}
            placeholder={COPY.judge.none}
            disabled={reading}
            items={[
              ...items,
              ...(chosen !== null && !items.some((item) => item.value === chosen)
                ? [{ value: chosen, label: chosen }]
                : []),
            ]}
            onValueChange={async (key) => {
              const choice = context.judges.find((each) => `${each.judgeId}@${each.version}` === key);
              if (choice === undefined) return;
              setReading(true);
              setProblem(null);
              const read = await context.readJudge(choice).finally(() => setReading(false));
              if (read === null) setProblem('That judge’s details could not be read.');
              else onAsk({ ...ask, judge: read });
            }}
          />
        )}
        {problem === null ? null : <span className="text-danger">{problem}</span>}
      </Row>
      <Row label={COPY.judge.question}>
        <Textarea
          aria-label={COPY.judge.question}
          className="w-full"
          rows={2}
          value={typeof ask.question === 'string' ? ask.question : ''}
          onChange={(event) => onAsk({ ...ask, question: event.target.value })}
        />
      </Row>
      <Row label={COPY.judge.looksAt}>
        {mappedPointers(document).map((pointer) => (
          <Toggle
            key={pointer}
            size="sm"
            pressed={inputs.includes(pointer)}
            onPressedChange={(pressed: boolean) =>
              onAsk({ ...ask, inputs: pressed ? [...inputs, pointer] : inputs.filter((each) => each !== pointer) })
            }
          >
            {pointer.slice(1).replaceAll('/', '.')}
          </Toggle>
        ))}
      </Row>
      <Row label={COPY.judge.yesAt}>
        <Input
          aria-label={COPY.judge.yesAt}
          className="w-20"
          inputMode="decimal"
          value={String(threshold)}
          onValueChange={(value: string) => {
            const number = Number(value);
            if (/^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/u.test(value) && number >= 0 && number <= 1)
              onAsk({ ...ask, threshold: number });
          }}
        />
      </Row>
      <Row label={COPY.judge.unsure}>
        <SegmentedControl
          indicator
          aria-label={COPY.judge.unsure}
          size="sm"
          value={ask.onUncertain === 'hold' ? 'hold' : 'no-match'}
          items={[
            { value: 'no-match', label: COPY.judge.unsureWords['no-match'] },
            { value: 'hold', label: COPY.judge.unsureWords.hold },
          ]}
          onValueChange={(value) => onAsk({ ...ask, onUncertain: value })}
        />
      </Row>
    </>
  );
}

function JudgePart({ step, document, change, context }: PartProps) {
  const ask = isObject(step.ask) ? step.ask : {};
  return (
    <AskPart
      ask={ask}
      document={document}
      context={context}
      onAsk={(next) => change((before) => ({ ...before, ask: next }))}
    />
  );
}

/** The projects the event service knows (`projects list`), read when a route's settings open. */
function useProjects(): ProjectV1[] | null {
  const bridge = useBridge();
  const [projects, setProjects] = useState<ProjectV1[] | null>(null);
  useEffect(() => {
    let live = true;
    void bridge
      .cli({ kind: 'eventsProjectsList' })
      .then((result) => {
        if (!live || result.status !== 'ok') return;
        try {
          setProjects(readProjects(result.data).projects);
        } catch {
          setProjects(null);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);
  return projects;
}

function RoutePart({ step, document, change, context }: PartProps) {
  const projects = useProjects();
  const candidates = Array.isArray(step.candidates) ? step.candidates.filter(isObject) : [];
  const chosen = new Set(candidates.map((candidate) => candidate.projectId));
  const by = Array.isArray(step.by) ? step.by.join(' ') : 'hints';
  const candidate = (project: ProjectV1): JsonObject => ({
    projectId: project.projectId,
    name: project.name,
    folders: project.folders.filter((folder) => folder.kind === 'checkout').map((folder) => folder.folder),
    worktreeRoot: project.folders.find((folder) => folder.worktreeRoot !== null)?.worktreeRoot ?? null,
  });
  return (
    <>
      <Row label={COPY.route.projects}>
        {projects === null || projects.length === 0 ? (
          <span className="text-fg-muted">{COPY.route.noProjects}</span>
        ) : (
          projects.map((project) => (
            <Toggle
              key={project.projectId}
              size="sm"
              pressed={chosen.has(project.projectId)}
              onPressedChange={(pressed: boolean) =>
                change((before) => ({
                  ...before,
                  candidates: pressed
                    ? [...candidates, candidate(project)]
                    : candidates.filter((each) => each.projectId !== project.projectId),
                }))
              }
            >
              <UntrustedText text={project.name} />
            </Toggle>
          ))
        )}
      </Row>
      <Row label={COPY.route.by}>
        <SegmentedControl
          indicator
          aria-label={COPY.route.by}
          size="sm"
          value={by}
          items={(['hints', 'hints judge', 'judge'] as const).map((value) => ({
            value,
            label: COPY.route.byWords[value],
          }))}
          onValueChange={(value) =>
            change((before) => {
              const next: JsonObject = { ...before, by: value.split(' ') };
              if (value === 'hints') delete next.judge;
              else if (!isObject(next.judge)) next.judge = stepDefaultsAsk(document);
              return next;
            })
          }
        />
      </Row>
      {by === 'hints' ? null : (
        <AskPart
          ask={isObject(step.judge) ? step.judge : {}}
          document={document}
          context={context}
          onAsk={(judge) => change((before) => ({ ...before, judge }))}
        />
      )}
    </>
  );
}

/** A new judge's settings for a route that asks one: the judge step's defaults, looking at what the workflow keeps. */
function stepDefaultsAsk(document: JsonObject): JsonObject {
  return {
    question: '',
    inputs: mappedPointers(document),
    threshold: 0.7,
    onUncertain: 'no-match',
    callsPerRollingHour: 60,
    inputTokensPerRolling30Days: 1_000_000,
    concurrency: 1,
    maxInputTokens: 2000,
    maxOutputTokens: 16,
  };
}

type PlaceKind = 'project' | 'worktree' | 'folder' | 'lane' | 'thread';

function PlacePart({ step, document, change, finds }: PartProps & { finds: boolean }) {
  const place = isObject(step.in) ? step.in : {};
  const kind = (Object.keys(place)[0] ?? 'folder') as PlaceKind;
  const routes = idsOf(document, (each) => each.kind === 'route');
  const worktrees = idsOf(document, (each) => each.kind === 'worktree');
  const kinds: PlaceKind[] = ['project', 'worktree', 'folder', 'lane', ...(finds ? (['thread'] as const) : [])];
  const provider = step.provider === 'codex' ? 'codex' : 'claude';
  const value = (key: string) => (typeof place[key] === 'string' ? (place[key] as string) : '');
  const setPlace = (next: JsonObject) =>
    change((before) => ({ ...before, in: next, ...(Object.hasOwn(next, 'thread') ? { provider: 'claude' } : {}) }));
  return (
    <>
      <Row label={COPY.place.where}>
        <SegmentedControl
          indicator
          aria-label={COPY.place.where}
          size="sm"
          value={kind}
          items={kinds.map((each) => ({ value: each, label: COPY.place.words[each] }))}
          onValueChange={(chosen) => {
            const next = chosen as PlaceKind;
            if (next === 'thread') setPlace({ thread: true });
            else if (next === 'project') setPlace({ project: routes.at(-1) ?? '' });
            else if (next === 'worktree') setPlace({ worktree: worktrees.at(-1) ?? '' });
            else setPlace({ [next]: '' });
          }}
        />
      </Row>
      {kind === 'project' ? (
        <Row label={COPY.place.route}>
          <StepChoice
            label={COPY.place.route}
            ids={routes}
            value={value('project')}
            onValue={(id) => setPlace({ project: id })}
          />
        </Row>
      ) : kind === 'worktree' ? (
        <Row label={COPY.place.worktree}>
          <StepChoice
            label={COPY.place.worktree}
            ids={worktrees}
            value={value('worktree')}
            onValue={(id) => setPlace({ worktree: id })}
          />
        </Row>
      ) : kind === 'folder' || kind === 'lane' ? (
        <Row label={COPY.place[kind]}>
          <Input
            aria-label={COPY.place[kind]}
            className="min-w-40 flex-1"
            spellCheck={false}
            value={value(kind)}
            onValueChange={(text: string) => setPlace({ [kind]: text })}
          />
        </Row>
      ) : (
        <p className="text-(length:--cue-text-label) text-fg-muted">{COPY.place.threadBody}</p>
      )}
      <Row label={COPY.place.with}>
        <SegmentedControl
          indicator
          aria-label={COPY.place.with}
          size="sm"
          value={provider}
          items={[
            { value: 'claude', label: COPY.place.providers.claude },
            { value: 'codex', label: COPY.place.providers.codex, disabled: kind === 'thread' },
          ]}
          onValueChange={(chosen) => kind !== 'thread' && change((before) => ({ ...before, provider: chosen }))}
        />
      </Row>
    </>
  );
}

function FindPart(props: PartProps) {
  const { step, change } = props;
  return (
    <>
      <PlacePart {...props} finds />
      <Row label={COPY.place.onlyIdle}>
        <Switch
          aria-label={COPY.place.onlyIdle}
          checked={step.only === 'idle'}
          onCheckedChange={(on: boolean) =>
            change((before) => {
              const next = { ...before };
              if (on) next.only = 'idle';
              else delete next.only;
              return next;
            })
          }
        />
      </Row>
    </>
  );
}

function StartPart(props: PartProps) {
  const { step, change } = props;
  const inWorktree = isObject(step.in) && Object.hasOwn(step.in, 'worktree');
  return (
    <>
      <PlacePart {...props} finds={false} />
      <Row label={COPY.place.mode}>
        <SegmentedControl
          indicator
          aria-label={COPY.place.mode}
          size="sm"
          value={typeof step.mode === 'string' ? step.mode : 'manual'}
          items={(['manual', 'acceptEdits', 'plan'] as const).map((value) => ({
            value,
            label: COPY.place.modes[value],
            disabled: value === 'acceptEdits' && !inWorktree,
          }))}
          onValueChange={(mode) => change((before) => ({ ...before, mode }))}
        />
        {inWorktree ? null : (
          <span className="text-(length:--cue-text-label) text-fg-muted">{COPY.place.acceptEditsOnly}</span>
        )}
      </Row>
    </>
  );
}

function WorktreePart({ step, document, change }: PartProps) {
  const routes = idsOf(document, (each) => each.kind === 'route');
  const base = isObject(step.base) && typeof step.base.branch === 'string' ? step.base.branch : null;
  return (
    <>
      <Row label={COPY.worktree.project}>
        <StepChoice
          label={COPY.worktree.project}
          ids={routes}
          value={typeof step.project === 'string' ? step.project : ''}
          onValue={(project) => change((before) => ({ ...before, project }))}
        />
      </Row>
      <Row label={COPY.worktree.branch}>
        <Input
          aria-label={COPY.worktree.branch}
          className="min-w-40 flex-1 font-mono"
          spellCheck={false}
          value={typeof step.branch === 'string' ? step.branch : ''}
          onValueChange={(branch: string) => change((before) => ({ ...before, branch }))}
        />
      </Row>
      <Row label={COPY.worktree.from}>
        <Input
          aria-label={COPY.worktree.from}
          placeholder={COPY.worktree.fromDefault}
          className="min-w-40 flex-1 font-mono"
          spellCheck={false}
          value={base ?? ''}
          onValueChange={(branch: string) =>
            change((before) => ({ ...before, base: branch.trim() === '' ? 'default' : { branch: branch.trim() } }))
          }
        />
      </Row>
      <Row label={COPY.worktree.cleanup}>
        <SegmentedControl
          indicator
          aria-label={COPY.worktree.cleanup}
          size="sm"
          value={step.cleanup === 'remove-if-clean' ? 'remove-if-clean' : 'keep'}
          items={(['keep', 'remove-if-clean'] as const).map((value) => ({
            value,
            label: COPY.worktree.cleanupWords[value],
          }))}
          onValueChange={(cleanup) => change((before) => ({ ...before, cleanup }))}
        />
      </Row>
    </>
  );
}

/** The document with the target step `stepId` delivers to changed by `onTarget`; its version is Save's to make. */
function changeTargetOf(document: JsonObject, step: JsonObject, next: JsonObject): JsonObject {
  const target = targetOf(document, step);
  if (target === null) return document;
  return {
    ...document,
    targets: targetsIn(document).map((each) => (each === target ? next : each)),
  };
}

function DeliverPart({ stepId, step, document, change, onDocument, context }: PartProps) {
  const target = targetOf(document, step);
  const kind = typeof target?.kind === 'string' ? target.kind : null;
  const onTarget = (next: JsonObject) => onDocument(changeTargetOf(document, step, next));
  const webhooks = context.webhooks;
  const sessions = idsOf(document, (each) => each.kind === 'find-session' || each.kind === 'start-session').filter(
    (id) => id !== stepId,
  );
  const issues = idsOf(document, (each) => each.kind === 'deliver' && targetOf(document, each)?.kind === 'linear');
  const to = isObject(step.to) ? step.to : {};
  const toSession = Array.isArray(to.session)
    ? to.session.filter((each): each is string => typeof each === 'string')
    : [];
  const report = Array.isArray(step.report)
    ? step.report.filter((each): each is string => typeof each === 'string')
    : [];
  if (target === null) {
    if (webhooks.length === 0) return <p className="text-fg-muted">{COPY.deliver.noWebhooks}</p>;
    return (
      <Row label={COPY.deliver.webhook}>
        <Select
          aria-label={COPY.deliver.webhook}
          value={null}
          placeholder={COPY.deliver.noTarget}
          items={webhooks.map((each) => ({
            value: `${String(each.targetId)}@${String(each.version)}`,
            label: `${String(each.targetId)}, version ${String(each.version)}`,
          }))}
          onValueChange={(key) => {
            const chosen = webhooks.find((each) => `${String(each.targetId)}@${String(each.version)}` === key);
            if (chosen === undefined) return;
            const known = targetsIn(document).some(
              (each) => each.targetId === chosen.targetId && each.version === chosen.version,
            );
            const withTarget = known ? document : { ...document, targets: [...targetsIn(document), copyOf(chosen)] };
            onDocument(
              applyStep(withTarget, stepId, (before) => ({
                ...before,
                target: { targetId: chosen.targetId as string, version: chosen.version as number },
              })),
            );
          }}
        />
      </Row>
    );
  }
  return (
    <>
      <Row label={COPY.deliver.target}>
        <span className="font-mono text-fg-muted">
          <UntrustedText text={`${String(target.targetId)}, version ${String(target.version)}`} />
        </span>
      </Row>
      {kind === 'queue' ? (
        <QueueAction target={target} onTarget={onTarget} />
      ) : kind === 'dry-run' ? (
        <DryRunAction target={target} onTarget={onTarget} />
      ) : kind === 'linear' ? (
        <LinearAction target={target} linear={context.linear} onTarget={onTarget} onEditAsText={context.onEditAsText} />
      ) : kind === 'session' ? (
        <>
          <Row label={COPY.deliver.sessions}>
            {sessions.map((id) => (
              <Toggle
                key={id}
                size="sm"
                pressed={toSession.includes(id)}
                onPressedChange={(pressed: boolean) =>
                  change((before) => {
                    const next = pressed ? [...toSession, id] : toSession.filter((each) => each !== id);
                    const changed: JsonObject = { ...before };
                    if (next.length === 0) delete changed.to;
                    else changed.to = { session: next };
                    return changed;
                  })
                }
              >
                {id}
              </Toggle>
            ))}
          </Row>
          <Row label={COPY.deliver.report}>
            {(['done', 'needs-the-person', 'not-mine', 'blocked'] as const).map((word) => (
              <Toggle
                key={word}
                size="sm"
                pressed={report.includes(word)}
                onPressedChange={(pressed: boolean) =>
                  change((before) => {
                    const next = pressed ? [...report, word] : report.filter((each) => each !== word);
                    const changed: JsonObject = { ...before };
                    if (next.length === 0) delete changed.report;
                    else changed.report = [...next].sort();
                    return changed;
                  })
                }
              >
                {COPY.deliver.reportWords[word]}
              </Toggle>
            ))}
          </Row>
          <AsText onEditAsText={context.onEditAsText} />
        </>
      ) : kind === 'linear-change' ? (
        <>
          <Row label={COPY.deliver.issue}>
            <StepChoice
              label={COPY.deliver.issue}
              ids={issues}
              value={typeof to.issue === 'string' ? to.issue : ''}
              onValue={(issue) => change((before) => ({ ...before, to: { issue } }))}
            />
          </Row>
          {isObject(target.comment) ? (
            <Row label={COPY.deliver.comment}>
              <Textarea
                aria-label={COPY.deliver.comment}
                className="w-full"
                rows={2}
                value={typeof target.comment.text === 'string' ? target.comment.text : ''}
                onChange={(event) => onTarget({ ...target, comment: { text: event.target.value } })}
              />
            </Row>
          ) : null}
          <AsText onEditAsText={context.onEditAsText} />
        </>
      ) : (
        <AsText onEditAsText={context.onEditAsText} />
      )}
    </>
  );
}

function WaitPart({ step, document, change }: PartProps) {
  const waitsFor = isObject(step.for) ? step.for : {};
  const kind = (Object.keys(waitsFor)[0] ?? 'time') as 'turnEnd' | 'sessionIdle' | 'time';
  const turns = idsOf(document, (each) => each.kind === 'deliver' && targetOf(document, each)?.kind === 'session');
  const finds = idsOf(document, (each) => each.kind === 'find-session');
  const timeout = typeof step.timeoutMs === 'number' ? step.timeoutMs : WAIT_DEFAULTS[kind];
  const time =
    isObject(waitsFor.time) && typeof waitsFor.time.afterMs === 'number' ? waitsFor.time.afterMs : WAIT_DEFAULTS.time;
  return (
    <>
      <Row label={COPY.wait.for}>
        <SegmentedControl
          indicator
          aria-label={COPY.wait.for}
          size="sm"
          value={kind}
          items={(['turnEnd', 'sessionIdle', 'time'] as const).map((value) => ({
            value,
            label: COPY.wait.forWords[value],
          }))}
          onValueChange={(chosen) =>
            change((before) => {
              const next = chosen as typeof kind;
              const target =
                next === 'turnEnd' ? (turns.at(-1) ?? '') : next === 'sessionIdle' ? (finds.at(-1) ?? '') : null;
              // Its arrows name the outcomes of what it waited for before: only `otherwise` goes with it.
              const arrows = isObject(before.next) ? before.next : {};
              return {
                ...before,
                for: target === null ? { time: { afterMs: WAIT_DEFAULTS.time } } : { [next]: target },
                timeoutMs: WAIT_DEFAULTS[next],
                next: arrows.otherwise === undefined ? {} : { otherwise: arrows.otherwise },
              };
            })
          }
        />
      </Row>
      {kind === 'turnEnd' ? (
        <Row label={COPY.wait.turnOf}>
          <StepChoice
            label={COPY.wait.turnOf}
            ids={turns}
            value={typeof waitsFor.turnEnd === 'string' ? waitsFor.turnEnd : ''}
            onValue={(id) => change((before) => ({ ...before, for: { turnEnd: id } }))}
          />
        </Row>
      ) : kind === 'sessionIdle' ? (
        <Row label={COPY.wait.sessionOf}>
          <StepChoice
            label={COPY.wait.sessionOf}
            ids={finds}
            value={typeof waitsFor.sessionIdle === 'string' ? waitsFor.sessionIdle : ''}
            onValue={(id) => change((before) => ({ ...before, for: { sessionIdle: id } }))}
          />
        </Row>
      ) : (
        <Row label={COPY.wait.after}>
          <SpanSelect
            label={COPY.wait.after}
            value={time}
            onValue={(afterMs) => change((before) => ({ ...before, for: { time: { afterMs } } }))}
          />
        </Row>
      )}
      <Row label={COPY.wait.atMost}>
        <SpanSelect
          label={COPY.wait.atMost}
          value={timeout}
          onValue={(timeoutMs) => change((before) => ({ ...before, timeoutMs }))}
        />
      </Row>
    </>
  );
}

function NotifyPart({ step, change }: PartProps) {
  return (
    <Row label={COPY.notify.text}>
      <Textarea
        aria-label={COPY.notify.text}
        className="w-full"
        rows={2}
        value={typeof step.text === 'string' ? step.text : ''}
        onChange={(event) => change((before) => ({ ...before, text: event.target.value }))}
      />
    </Row>
  );
}

function RaisePart({ step, document, change }: PartProps) {
  const name = typeof step.name === 'string' ? step.name : '';
  const wrong = name !== '' && (!isEventSegment(name) || (STANDARD_STEP_EVENTS as readonly string[]).includes(name));
  const fields = Array.isArray(step.fields)
    ? step.fields.filter((each): each is string => typeof each === 'string')
    : [];
  return (
    <>
      <Field name="raise-name" invalid={wrong}>
        <FieldLabel>{COPY.raise.name}</FieldLabel>
        <Input
          value={name}
          spellCheck={false}
          onValueChange={(value: string) => change((before) => ({ ...before, name: value.trim() }))}
        />
        <FieldError issues={wrong ? [{ message: COPY.raise.nameWrong }] : []} />
      </Field>
      <Row label={COPY.raise.fields}>
        {mappedPointers(document).map((pointer) => (
          <Toggle
            key={pointer}
            size="sm"
            pressed={fields.includes(pointer)}
            onPressedChange={(pressed: boolean) =>
              change((before) => {
                const next = pressed ? [...fields, pointer] : fields.filter((each) => each !== pointer);
                const changed: JsonObject = { ...before };
                if (next.length === 0) delete changed.fields;
                else changed.fields = next;
                return changed;
              })
            }
          >
            {pointer.slice(1).replaceAll('/', '.')}
          </Toggle>
        ))}
      </Row>
    </>
  );
}

function SplitPart({ step }: PartProps) {
  const branches = Array.isArray(step.branches)
    ? step.branches.filter((each): each is string => typeof each === 'string')
    : [];
  return (
    <Row label={COPY.split.branches}>
      {branches.map((branch) => (
        <Chip key={branch} tone="neutral">
          <UntrustedText text={branch} />
        </Chip>
      ))}
    </Row>
  );
}

interface PartProps {
  readonly stepId: string;
  readonly step: JsonObject;
  readonly document: JsonObject;
  readonly change: (change: Change) => void;
  readonly onDocument: (next: JsonObject) => void;
  readonly context: SettingsContext;
  readonly onEditAsText: () => void;
}

const PARTS: Readonly<Record<StepKind, (props: PartProps) => ReactNode>> = {
  condition: ConditionPart,
  judge: JudgePart,
  route: RoutePart,
  'find-session': FindPart,
  'start-session': StartPart,
  worktree: WorktreePart,
  deliver: DeliverPart,
  wait: WaitPart,
  notify: NotifyPart,
  split: SplitPart,
  raise: RaisePart,
};

const ACTS: ReadonlySet<string> = new Set(['deliver', 'start-session', 'worktree', 'raise']);

/** Where a step's wires come from and go to, each a chip that selects that step. */
function Wires({
  document,
  stepId,
  step,
  onSelect,
}: {
  document: JsonObject;
  stepId: string;
  step: JsonObject;
  onSelect: (id: string) => void;
}) {
  const ins = stepsOf(document).flatMap(([id, each]) => {
    if (each.kind === 'split')
      return Array.isArray(each.branches) && each.branches.includes(stepId) ? [{ id, words: id }] : [];
    const next = isObject(each.next) ? each.next : {};
    return Object.entries(next).flatMap(([outcome, to]) =>
      to === stepId ? [{ id, words: `${id} · ${outcomeWords(outcome)}` }] : [],
    );
  });
  const next = isObject(step.next) ? step.next : {};
  const outs =
    step.kind === 'split'
      ? (Array.isArray(step.branches) ? step.branches : []).flatMap((to) =>
          typeof to === 'string' ? [{ id: to, words: to }] : [],
        )
      : Object.entries(next).flatMap(([outcome, to]) =>
          typeof to === 'string' && to !== 'end' ? [{ id: to, words: `${outcomeWords(outcome)} → ${to}` }] : [],
        );
  const flow = flowOfDocument(document).flow;
  const fromGate = flow.start === stepId;
  return (
    <>
      <Row label={COPY.comesFrom}>
        {ins.length === 0 && !fromGate ? <span className="text-fg-muted">{COPY.nothingYet}</span> : null}
        {fromGate ? <Chip tone="neutral">Keep</Chip> : null}
        {ins.map((wire) => (
          <Button key={wire.words} size="sm" variant="ghost" onClick={() => onSelect(wire.id)}>
            <UntrustedText text={wire.words} />
          </Button>
        ))}
      </Row>
      {outs.length === 0 ? null : (
        <Row label={COPY.goesOnTo}>
          {outs.map((wire) => (
            <Button key={wire.words} size="sm" variant="ghost" onClick={() => onSelect(wire.id)}>
              <UntrustedText text={wire.words} />
            </Button>
          ))}
        </Row>
      )}
    </>
  );
}

function LabelField({ step, change }: { step: JsonObject; change: (change: Change) => void }) {
  const label = typeof step.label === 'string' ? step.label : '';
  const wrong = [...label].length > 60 || /[\r\n]/u.test(label);
  return (
    <Field name="step-label" invalid={wrong}>
      <FieldLabel>{COPY.label}</FieldLabel>
      <Input
        value={label}
        onValueChange={(value: string) =>
          change((before) => {
            const next = { ...before };
            if (value === '') delete next.label;
            else next.label = value;
            return next;
          })
        }
      />
      <FieldError issues={wrong ? [{ message: COPY.labelWrong }] : []} />
    </Field>
  );
}

/** A step's settings. */
function StepPanel({
  document,
  stepId,
  problems,
  onChange,
  onSelect,
  context,
}: {
  document: JsonObject;
  stepId: string;
  problems: readonly DesignerProblem[];
  onChange: (next: JsonObject) => void;
  onSelect: (id: string | null) => void;
  context: SettingsContext;
}) {
  const step = stepsOf(document).find(([id]) => id === stepId)?.[1];
  if (step === undefined) return null;
  const kind = typeof step.kind === 'string' && Object.hasOwn(PARTS, step.kind) ? (step.kind as StepKind) : null;
  const change = (how: Change) => onChange(applyStep(document, stepId, how));
  const Part = kind === null ? null : PARTS[kind];
  const naming = eventNames(document, context.names);
  const words = ticksOf(document, step);
  const mine = problems.filter((problem) => problem.stepId === stepId);
  const outcomes = kind === null || kind === 'split' ? [] : outcomesOf(step as unknown as FlowStep);
  return (
    <Panel
      aria-label={stepTitle(document, step)}
      className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)"
      data-settings={stepId}
    >
      <div className="flex flex-col gap-(--cue-space-1)">
        <h3 className="font-semibold text-fg">{stepTitle(document, step)}</h3>
        <span className="font-mono text-(length:--cue-text-label) text-fg-muted">
          <UntrustedText text={stepId} />
        </span>
        <span>
          <Chip tone={kind !== null && ACTS.has(kind) ? 'warn' : 'neutral'}>
            {kind !== null && ACTS.has(kind) ? COPY.acts : COPY.stays}
          </Chip>
        </span>
      </div>
      {mine.length === 0 ? null : (
        <section aria-label={COPY.toFix} className="flex flex-col gap-(--cue-space-1)">
          {mine.map((problem, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the checks come in a fixed order for one document.
            <p key={index} className="flex items-start gap-(--cue-space-2) text-fg">
              <Chip tone="warn">!</Chip>
              <UntrustedText text={problem.message} />
            </p>
          ))}
        </section>
      )}
      {Part === null ? (
        <AsText onEditAsText={context.onEditAsText} />
      ) : (
        <Part
          stepId={stepId}
          step={step}
          document={document}
          change={change}
          onDocument={onChange}
          context={context}
          onEditAsText={context.onEditAsText}
        />
      )}
      <LabelField step={step} change={change} />
      <EventTicks
        stepId={stepId}
        words={words}
        ticked={tickedOf(step)}
        naming={naming}
        onTick={(word, on, names) => {
          const next = tickEvent(document, stepId, word, on, names);
          if (next !== null) onChange(next);
        }}
      />
      <Wires document={document} stepId={stepId} step={step} onSelect={onSelect} />
      {outcomes.length === 0 ? null : (
        <p className="text-(length:--cue-text-label) text-fg-muted">{outcomes.map(outcomeWords).join(' · ')}</p>
      )}
      <div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange(applyDelete(document, stepId));
            onSelect(null);
          }}
        >
          {COPY.remove}
        </Button>
      </div>
    </Panel>
  );
}

/** A gate box's settings: the rule editor's own controls for that part of the workflow. */
function GatePanel({
  document,
  gate,
  onChange,
  context,
}: {
  document: JsonObject;
  gate: string;
  onChange: (next: JsonObject) => void;
  context: SettingsContext;
}) {
  const visual = context.visual;
  return gate === GATE.trigger ? (
    <When document={document} onChange={onChange} context={visual} />
  ) : gate === GATE.condition ? (
    <Which document={document} onChange={onChange} context={visual} />
  ) : gate === GATE.judge ? (
    <Judge document={document} onChange={onChange} context={visual} />
  ) : (
    <Kept document={document} onChange={onChange} context={visual} />
  );
}

/** The settings of what is selected: a step's, a gate box's, or the workflow's. */
export function SettingsPanel({
  document,
  selected,
  problems,
  onChange,
  onSelect,
  context,
}: {
  document: JsonObject;
  selected: string | null;
  problems: readonly DesignerProblem[];
  onChange: (next: JsonObject) => void;
  onSelect: (id: string | null) => void;
  context: SettingsContext;
}) {
  if (selected?.startsWith('gate:'))
    return <GatePanel document={document} gate={selected} onChange={onChange} context={context} />;
  if (selected !== null)
    return (
      <StepPanel
        document={document}
        stepId={selected}
        problems={problems}
        onChange={onChange}
        onSelect={onSelect}
        context={context}
      />
    );
  return (
    <WorkflowSettings
      document={document}
      problems={problems}
      onChange={onChange}
      names={context.names}
      onNames={(names) => onChange(setEventNames(document, names))}
    />
  );
}
