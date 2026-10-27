/**
 * Events → Rules (owner feedback 0.32.0, §3.4): one card per rule, not per version — its id as its name, where it
 * stands, its sentence in plain words, and a line of facts — filtered by All, On, Not switched on and Off. A card opens
 * the rule's page (`RuleDetail`). Everything shown is read: nothing here changes a rule.
 */
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Panel,
  Row,
  SegmentedControl,
  Spinner,
} from '@cueplusplus/ui';
import { ChevronRight, Plus } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY, type Screen } from '../../copy.ts';
import { madeAt } from '../../events-deliveries.ts';
import {
  currentVersion,
  deliveryRetentionOf,
  dryRunOnly,
  type RuleRow,
  type RuleStatus,
  type RuleVersionView,
  watches,
  weekCounts,
} from '../../events-rules.ts';
import { supports } from '../../gates.ts';
import { isRuleId } from '../../grammar.ts';
import { useCall } from '../../hooks/use-call.ts';
import type { Call } from '../../ipc.ts';
import { EDITOR_COPY } from '../../rule-editor/copy.ts';
import { type EventsLists, type EventsNav, readVersions } from './lists.ts';
import { Day, DRY_RUN, FactsLine, Problem, Sentence, Short, STATUS_WORDS, StatusChip, statusOf } from './parts.tsx';
import { RuleDetail } from './RuleDetail.tsx';
import { RuleEditor } from './RuleEditor.tsx';

const EVENTS_VERSION: Call = { kind: 'version', product: 'events-daemon' };

/**
 * The designer (0.36.0), loaded only when a workflow is opened in it: React Flow and its stylesheets come with this
 * chunk, never with the app's first.
 */
const WorkflowEditor = lazy(() =>
  import('../workflows/WorkflowEditor.tsx').then((module) => ({ default: module.WorkflowEditor })),
);

/** Which editor this machine's event service has: none, the rule editor (0.33.0), or the designer (0.36.0). */
function useEditor(): 'none' | 'rules' | 'workflows' {
  const { result } = useCall<string>(EVENTS_VERSION);
  if (result.state !== 'ready') return 'none';
  if (supports(result.value, 'workflows')) return 'workflows';
  return supports(result.value, 'ruleEditor') ? 'rules' : 'none';
}

/** New rule…: its name first, which the rule keeps for good; then the editor. */
function NewRule({ taken, onStart }: { taken: ReadonlySet<string>; onStart: (ruleId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const id = name.trim();
  const wrong = id !== '' && !isRuleId(id);
  const used = taken.has(id);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setName('');
      }}
    >
      <Dialog.Trigger
        render={
          <Button size="sm" icon={Plus}>
            {EDITOR_COPY.newRule}
          </Button>
        }
      />
      <Dialog.Content width="sm" showCloseButton={false}>
        <Dialog.Title>{EDITOR_COPY.newRuleTitle}</Dialog.Title>
        <Dialog.Description>{EDITOR_COPY.newRuleBody}</Dialog.Description>
        <Field name="rule-name" invalid={wrong || used}>
          <FieldLabel>{EDITOR_COPY.ruleName}</FieldLabel>
          <Input value={name} spellCheck={false} autoComplete="off" onValueChange={(value: string) => setName(value)} />
          <FieldDescription>{EDITOR_COPY.newRuleBody.split('.')[0]}.</FieldDescription>
          <FieldError
            issues={
              wrong ? [{ message: EDITOR_COPY.ruleNameWrong }] : used ? [{ message: EDITOR_COPY.ruleNameTaken }] : []
            }
          />
        </Field>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost">{COPY.cancel}</Button>} />
          <Button
            variant="primary"
            disabled={id === '' || wrong || used}
            onClick={() => {
              setOpen(false);
              onStart(id);
            }}
          >
            {EDITOR_COPY.start}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** The tab's words (the approved prototype, row 2), in sentence case. */
export const RULES_COPY = {
  intro:
    'A rule watches one account, picks out the messages it cares about, and passes them on. An agent writes a rule when you ask it to; you approve each one before it starts. Open a rule to see everything about it.',
  introEditing:
    'A rule watches one account, picks out the messages it cares about, and passes them on. Write one here, or ask an agent to; you approve each one before it starts. Open a rule to see everything about it, or edit it.',
  show: 'Show',
  all: 'All',
  status: STATUS_WORDS,
  dryRun: DRY_RUN,
  empty: 'No rules yet.',
  noneHere: 'No rules here.',
  approvalWaits: 'Its approval is in Approvals, if an agent asked for it',
  turnedOff: 'Turned off',
} as const;

type Filter = 'all' | RuleStatus;
const FILTERS: readonly Filter[] = ['all', 'on', 'not-switched-on', 'off'];

/** The newest time one of a rule's deliveries was made, from the deliveries list. */
function lastPassedOn(lists: EventsLists, ruleId: string, versions: readonly RuleVersionView[] | null): number | null {
  if (lists.deliveries.state !== 'ready') return null;
  const retention = (version: number | null) =>
    deliveryRetentionOf(versions?.find((each) => each.version === version)?.document ?? null);
  const times = lists.deliveries.value
    .filter((row) => row.ruleId === ruleId)
    .flatMap((row) => {
      const at = madeAt(row, retention(row.ruleVersion));
      return at === null ? [] : [at];
    });
  return times.length === 0 ? null : Math.max(...times);
}

/** A card's facts: its last 7 days, its problems and its last delivery while on; how to switch it on; when it went off. */
function facts(status: RuleStatus, versions: readonly RuleVersionView[] | null, last: number | null): ReactNode[] {
  const counts = versions === null ? null : weekCounts(versions);
  if (status === 'not-switched-on') return [RULES_COPY.approvalWaits];
  if (status === 'off') {
    const revoked = versions
      ?.flatMap((each) => (each.revokedAt === null ? [] : [each.revokedAt]))
      .sort((a, b) => b - a)[0];
    return [
      revoked === undefined ? (
        RULES_COPY.turnedOff
      ) : (
        <>
          {RULES_COPY.turnedOff} on <Day at={revoked} />
        </>
      ),
    ];
  }
  const active = versions?.find((each) => each.state === 'active');
  return [
    counts === null ? null : `${counts.matched} matched in the last 7 days`,
    counts === null ? null : `${counts.failed} ${counts.failed === 1 ? 'problem' : 'problems'}`,
    last === null ? null : (
      <>
        latest delivery <Short at={last} />
      </>
    ),
    active?.activatedAt == null ? null : (
      <>
        on since <Day at={active.activatedAt} />
      </>
    ),
  ];
}

/** One rule's card: the whole card opens its page, when its id is one the allow-list takes. */
function RuleCard({ rule, lists, onOpen }: { rule: RuleRow; lists: EventsLists; onOpen: () => void }) {
  const read = lists.versions.get(rule.id);
  const versions = readVersions(lists, rule.id);
  const current = versions === null ? null : currentVersion(versions);
  const status = statusOf(rule.status, versions) ?? rule.status;
  const body = (
    <>
      <span className="flex w-full flex-wrap items-center gap-(--cue-space-2)">
        <span className="font-semibold text-(length:--cue-text-emphasis) text-fg">
          <UntrustedText text={rule.id} />
        </span>
        <StatusChip status={status} />
        {current !== null && dryRunOnly(current.document) ? <Chip tone="accent">{RULES_COPY.dryRun}</Chip> : null}
        {rule.openable ? (
          <ChevronRight
            data-slot="opens"
            aria-hidden="true"
            className="ml-auto size-(--cue-icon-sm) shrink-0 text-fg-subtle"
          />
        ) : null}
      </span>
      {read === undefined || read.state === 'loading' ? (
        rule.openable ? (
          <Spinner size="sm" label={COPY.loading} />
        ) : null
      ) : read.state === 'error' ? (
        <span className="text-danger">
          <UntrustedText text={read.message} />
        </span>
      ) : current?.summary != null ? (
        <span data-slot="rule-sentence" className="block text-fg-muted">
          <Sentence parts={current.summary} names={lists.names} />
        </span>
      ) : current !== null && current.document !== null ? (
        <span className="block text-fg-muted">
          <Sentence parts={watches(current.document, (id) => id).main} names={lists.names} />
        </span>
      ) : null}
      <span data-slot="rule-facts" className="block">
        <FactsLine facts={facts(status, versions, lastPassedOn(lists, rule.id, versions))} />
      </span>
    </>
  );
  const layout = 'flex-col items-start gap-(--cue-space-2) py-(--cue-space-3) text-left';
  return (
    <li>
      <Panel>
        {rule.openable ? (
          <Row interactive data-rule={rule.id} onClick={onOpen} className={layout}>
            {body}
          </Row>
        ) : (
          <Row data-rule={rule.id} className={layout}>
            {body}
          </Row>
        )}
      </Panel>
    </li>
  );
}

/** The list of rules, or one rule's page when one is open. */
export function RulesTab({
  lists,
  nav,
  onScreen,
}: {
  lists: EventsLists;
  nav: EventsNav;
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const editor = useEditor();
  const canEdit = editor !== 'none';
  const editing = nav.editing;
  if (editing !== null && editor === 'workflows')
    return (
      <Suspense fallback={<Spinner label={COPY.loading} />}>
        <WorkflowEditor
          key={`${editing.kind}:${editing.ruleId}`}
          target={editing}
          lists={lists}
          onClose={() => {
            nav.edit(null);
            if (editing.kind === 'edit') nav.openRule(editing.ruleId);
          }}
          onApproved={(ruleId) => {
            nav.edit(null);
            nav.openRule(ruleId);
            void lists.reloadRules();
          }}
        />
      </Suspense>
    );
  if (editing !== null)
    return (
      <RuleEditor
        key={`${editing.kind}:${editing.ruleId}`}
        target={editing}
        lists={lists}
        onClose={() => {
          nav.edit(null);
          if (editing.kind === 'edit') nav.openRule(editing.ruleId);
        }}
        onApproved={(ruleId) => {
          nav.edit(null);
          nav.openRule(ruleId);
          void lists.reloadRules();
        }}
      />
    );
  if (nav.rule !== null) {
    const ruleId = nav.rule;
    return (
      <RuleDetail
        id={ruleId}
        lists={lists}
        nav={nav}
        onScreen={onScreen}
        {...(canEdit ? { onEdit: () => nav.edit({ kind: 'edit', ruleId }) } : {})}
      />
    );
  }
  const { rules } = lists;
  const taken = new Set(rules.state === 'ready' ? rules.value.map((rule) => rule.id) : []);
  return (
    <section aria-label="Rules" className="flex flex-col gap-(--cue-space-4)">
      <div className="flex flex-wrap items-start gap-(--cue-space-3)">
        <p className="min-w-60 flex-1 text-fg-muted">{canEdit ? RULES_COPY.introEditing : RULES_COPY.intro}</p>
        {canEdit ? <NewRule taken={taken} onStart={(ruleId) => nav.edit({ kind: 'new', ruleId })} /> : null}
      </div>
      {rules.state === 'loading' ? (
        <Spinner label={COPY.loading} />
      ) : rules.state === 'error' ? (
        <Panel className="p-(--cue-space-4)">
          <Problem message={rules.message} />
        </Panel>
      ) : rules.value.length === 0 ? (
        <Panel>
          <EmptyState title={RULES_COPY.empty} />
        </Panel>
      ) : (
        <RuleCards rules={rules.value} lists={lists} nav={nav} filter={filter} onFilter={setFilter} />
      )}
    </section>
  );
}

function RuleCards({
  rules,
  lists,
  nav,
  filter,
  onFilter,
}: {
  rules: readonly RuleRow[];
  lists: EventsLists;
  nav: EventsNav;
  filter: Filter;
  onFilter: (filter: Filter) => void;
}) {
  const statuses = rules.map((rule) => ({
    rule,
    status: statusOf(rule.status, readVersions(lists, rule.id)) ?? rule.status,
  }));
  const count = (each: Filter) =>
    each === 'all' ? statuses.length : statuses.filter(({ status }) => status === each).length;
  const shown = statuses.filter(({ status }) => filter === 'all' || status === filter);
  return (
    <>
      <SegmentedControl
        indicator
        aria-label={RULES_COPY.show}
        size="sm"
        className="self-start"
        items={FILTERS.map((each) => ({
          value: each,
          label: `${each === 'all' ? RULES_COPY.all : RULES_COPY.status[each]} ${count(each)}`,
        }))}
        value={filter}
        onValueChange={(value) => onFilter(value as Filter)}
      />
      {shown.length === 0 ? (
        <Panel>
          <EmptyState title={RULES_COPY.noneHere} />
        </Panel>
      ) : (
        <ul className="flex flex-col gap-(--cue-space-3)">
          {shown.map(({ rule }) => (
            <RuleCard key={rule.id} rule={rule} lists={lists} onOpen={() => nav.openRule(rule.id)} />
          ))}
        </ul>
      )}
    </>
  );
}
