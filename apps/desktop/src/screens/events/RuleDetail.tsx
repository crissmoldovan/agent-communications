/**
 * One rule's page (owner feedback 0.32.0, §3.4): its sentence; six panels — what it watches, which messages, the
 * judge, where they go, what's kept, and the limit — read from its document; its last 7 days in counts; its versions,
 * with their times and what changed; and, collapsed, the ids, each said in plain words.
 *
 * Turn off and Remove… are tightenings the app applies itself (DA10), Remove… once its dialog is answered. Switching
 * a rule on is the person's approval, never the app's: a rule not switched on points at Approvals. Editing a rule and
 * trying it on a recent message come in a later release.
 */
import { AlertDialog, Button, Chip, Collapsible, Panel, Spinner } from '@cueplusplus/ui';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY, type Screen } from '../../copy.ts';
import {
  changedSections,
  currentVersion,
  dryRunOnly,
  judgeLine,
  judgeName,
  limitLine,
  type PanelLine,
  type RuleVersionView,
  type VersionState,
  watches,
  weekCounts,
  whatsKept,
  whereTheyGo,
  whichMessages,
} from '../../events-rules.ts';
import { type Call, errorMessage } from '../../ipc.ts';
import type { EventsLists, EventsNav } from './lists.ts';
import { BackTo, DRY_RUN, Problem, Sentence, Short, StatusChip, statusOf } from './parts.tsx';

/** The page's words, in sentence case. */
export const RULE_COPY = {
  allRules: 'All rules',
  inPlainWords: 'In plain words',
  panels: {
    watches: 'What it watches',
    which: 'Which messages',
    judge: 'The judge',
    where: 'Where they go',
    kept: "What's kept",
    limit: 'The limit',
  },
  week: 'The last 7 days',
  seeDeliveries: 'See its deliveries',
  versions: 'Versions',
  versionWords: { active: 'on', superseded: 'replaced', revoked: 'off', none: 'not switched on' },
  newVersion:
    'To change a rule, ask an agent to write a new version. It waits for your approval, and this one keeps running until then.',
  notSwitchedOn: 'Not switched on. If an agent asked for it, its approval is in Approvals.',
  openApprovals: 'Open Approvals',
  technical: 'Technical details',
  turnOff: 'Turn off',
  remove: 'Remove…',
  removeTitle: (id: string) => `Remove ${id}?`,
  removeBody:
    'It stops at once, and anything it had waiting to be passed on is cancelled. Using it again needs your approval.',
  removeAction: 'Remove',
  unreadable: 'That answer could not be read.',
} as const;

/** A version's state, as its chip says it beside its number. */
function versionWord(state: VersionState): string {
  return state === null ? RULE_COPY.versionWords.none : RULE_COPY.versionWords[state];
}

/** A panel of the page: its heading, and each of its lines with the quieter one beneath. */
function Facet({ title, lines, names }: { title: string; lines: PanelLine[]; names: EventsLists['names'] }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel className="flex h-full flex-col gap-(--cue-space-1) p-(--cue-space-4)">
        <h3 id={id} className="font-medium text-(length:--cue-text-label) text-fg-muted">
          {title}
        </h3>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a panel's lines come in the document's order and never move.
          <div key={index} className="flex flex-col gap-(--cue-space-1)">
            <p className="text-fg">
              <Sentence parts={line.main} names={names} />
            </p>
            {line.detail.length === 0 ? null : (
              <p className="text-(length:--cue-text-label) text-fg-muted">
                <Sentence parts={line.detail} names={names} />
              </p>
            )}
          </div>
        ))}
      </Panel>
    </section>
  );
}

/** A titled section of the page, in a panel. */
function Part({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <div className="flex items-center gap-(--cue-space-2)">
          <h3 id={id} className="font-medium text-(length:--cue-text-label) text-fg-muted">
            {title}
          </h3>
          {action === undefined ? null : <span className="ml-auto">{action}</span>}
        </div>
        {children}
      </Panel>
    </section>
  );
}

/** One count of the last 7 days: the number, then what it counts. */
function Count({ value, label }: { value: number; label: string }) {
  return (
    <div data-slot="rule-count" className="flex flex-col">
      <span data-slot="rule-count-value" className="font-semibold text-(length:--cue-text-title) text-fg tabular-nums">
        {value}
      </span>
      <span className="text-(length:--cue-text-label) text-fg-muted">{label}</span>
    </div>
  );
}

/** When a version ran, in a sentence: since when it is on, from when to when it ran, or that it never did. */
function VersionTimes({ version }: { version: RuleVersionView }) {
  const { state, activatedAt, supersededAt, revokedAt } = version;
  if (state === null) return <>{RULE_COPY.notSwitchedOn}</>;
  if (state === 'active') {
    return activatedAt === null ? (
      <>On.</>
    ) : (
      <>
        On since <Short at={activatedAt} />.
      </>
    );
  }
  if (state === 'superseded') {
    if (activatedAt === null || supersededAt === null) return <>Replaced by a newer version.</>;
    return (
      <>
        On from <Short at={activatedAt} /> to <Short at={supersededAt} />, then replaced by a newer version.
      </>
    );
  }
  if (revokedAt === null) return <>Turned off.</>;
  return activatedAt === null ? (
    <>
      Turned off on <Short at={revokedAt} />.
    </>
  ) : (
    <>
      On from <Short at={activatedAt} /> until it was turned off on <Short at={revokedAt} />.
    </>
  );
}

const VERSION_TONES = { active: 'ok', superseded: 'neutral', revoked: 'neutral' } as const;

/** Each version, newest first, with its times and what changed from the one before it. */
function Versions({
  versions,
  on,
  onApprovals,
}: {
  versions: readonly RuleVersionView[];
  /** Whether a version is on: only then does a new one wait while this one keeps running. */
  on: boolean;
  onApprovals?: () => void;
}) {
  const newestFirst = [...versions].reverse();
  return (
    <Part title={RULE_COPY.versions}>
      <ul className="flex flex-col gap-(--cue-space-3)">
        {newestFirst.map((version) => {
          const before = versions.filter((each) => each.version < version.version).at(-1);
          const changed = before === undefined ? [] : changedSections(before.document, version.document);
          return (
            <li key={version.version} className="flex flex-wrap items-start gap-(--cue-space-3)">
              <Chip tone={version.state === null ? 'warn' : VERSION_TONES[version.state]}>
                {`Version ${version.version} · ${versionWord(version.state)}`}
              </Chip>
              <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
                <p className="text-fg">
                  <VersionTimes version={version} />
                </p>
                {before === undefined || changed.length === 0 ? null : (
                  <p className="text-(length:--cue-text-label) text-fg-muted">
                    {`Changed from version ${before.version}: ${changed.join(', ')}.`}
                  </p>
                )}
                {version.state === null && onApprovals !== undefined ? (
                  <div>
                    <Button size="sm" variant="ghost" onClick={onApprovals}>
                      {RULE_COPY.openApprovals}
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {on ? <p className="text-(length:--cue-text-label) text-fg-muted">{RULE_COPY.newVersion}</p> : null}
    </Part>
  );
}

/** One id of the technical details: what it is, the value as it is, and what it is for, in a few words. */
function Technical({ name, value, means }: { name: string; value: string | null; means: string }) {
  return (
    <>
      <dt className="text-(length:--cue-text-label) text-fg-muted">{name}</dt>
      <dd className="flex min-w-0 flex-col">
        <span className="break-all font-mono text-(length:--cue-text-label) text-fg">
          <UntrustedText text={value ?? '-'} />
        </span>
        <span className="text-(length:--cue-text-label) text-fg-muted">{means}</span>
      </dd>
    </>
  );
}

/** The ids of each version, collapsed: for audit, each explained in plain words. */
function TechnicalDetails({ id, versions }: { id: string; versions: readonly RuleVersionView[] }) {
  return (
    <Panel>
      <Collapsible.Root>
        <Collapsible.Trigger>{RULE_COPY.technical}</Collapsible.Trigger>
        <Collapsible.Panel>
          <section aria-label={RULE_COPY.technical} className="flex flex-col gap-(--cue-space-4)">
            {[...versions].reverse().map((version) => (
              <div key={version.version} className="flex flex-col gap-(--cue-space-2)">
                <h4 className="font-medium text-fg">{`Version ${version.version}`}</h4>
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-(--cue-space-4) gap-y-(--cue-space-2)">
                  <Technical
                    name="Rule id"
                    value={id}
                    means="the rule's name, as agents and the event service use it"
                  />
                  <Technical
                    name="State"
                    value={version.state ?? 'none'}
                    means="where this version stands, in the event service's own word"
                  />
                  <Technical
                    name="Fingerprint"
                    value={version.digest}
                    means="identifies this exact version (its digest)"
                  />
                  <Technical
                    name="Approval"
                    value={version.approvalId}
                    means="the record of your yes to this exact version"
                  />
                  <Technical
                    name="Activation"
                    value={version.activationId}
                    means="ties that yes to this version, from when the event service started using it"
                  />
                </dl>
              </div>
            ))}
          </section>
        </Collapsible.Panel>
      </Collapsible.Root>
    </Panel>
  );
}

/** The last 7 days, in counts: what matched, what the judge said, what was passed on, and what went wrong. */
function Week({ versions, onDeliveries }: { versions: readonly RuleVersionView[]; onDeliveries: () => void }) {
  const counts = weekCounts(versions);
  if (counts === null) return null;
  const current = currentVersion(versions);
  const agentic = current?.document?.agentic;
  const judge =
    typeof agentic === 'object' && agentic !== null
      ? judgeName((agentic as { judge?: { kind?: unknown } }).judge?.kind)
      : null;
  return (
    <Part
      title={RULE_COPY.week}
      action={
        <Button size="sm" variant="ghost" icon={ChevronRight} onClick={onDeliveries}>
          {RULE_COPY.seeDeliveries}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-(--cue-space-3) sm:grid-cols-5">
        <Count value={counts.matched} label="matched" />
        {judge === null ? null : <Count value={counts.judgedYes} label={`${judge} said yes`} />}
        {judge === null ? null : <Count value={counts.judgedNo} label={`${judge} said no`} />}
        {counts.held === 0 ? null : <Count value={counts.held} label="waited for you" />}
        <Count value={counts.delivered} label="passed on" />
        <Count value={counts.failed} label={counts.failed === 1 ? 'problem' : 'problems'} />
      </div>
    </Part>
  );
}

/** Turn off and Remove…, while the rule is on; and what the last of them came to when it failed. */
function Actions({
  id,
  onChanged,
  onProblem,
}: {
  id: string;
  onChanged: () => Promise<void>;
  onProblem: (problem: string | null) => void;
}) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const apply = async (call: Call) => {
    setBusy(true);
    onProblem(null);
    try {
      const result = await bridge.cli(call);
      if (result.status === 'ok') await onChanged();
      else onProblem(result.status === 'failed' ? result.message : RULE_COPY.unreadable);
    } catch (error) {
      onProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ml-auto flex flex-wrap gap-(--cue-space-2)">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        loading={busy}
        onClick={() => void apply({ kind: 'eventsRuleDisable', ruleId: id })}
      >
        {RULE_COPY.turnOff}
      </Button>
      <AlertDialog.Root>
        <AlertDialog.Trigger
          render={
            <Button size="sm" variant="danger-outline" disabled={busy}>
              {RULE_COPY.remove}
            </Button>
          }
        />
        <AlertDialog.Content>
          <AlertDialog.Title>{RULE_COPY.removeTitle(id)}</AlertDialog.Title>
          <AlertDialog.Description>{RULE_COPY.removeBody}</AlertDialog.Description>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
            <AlertDialog.Action tone="danger" onClick={() => void apply({ kind: 'eventsRuleRemove', ruleId: id })}>
              {RULE_COPY.removeAction}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </span>
  );
}

export function RuleDetail({
  id,
  lists,
  nav,
  onScreen,
}: {
  id: string;
  lists: EventsLists;
  nav: EventsNav;
  onScreen?: ((screen: Screen) => void) | undefined;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const read = lists.versions.get(id) ?? { state: 'loading' as const };
  const row = lists.rules.state === 'ready' ? lists.rules.value.find((each) => each.id === id) : undefined;
  const versions = read.state === 'ready' ? read.value : null;
  const status = statusOf(row?.status ?? null, versions);
  const current = versions === null ? null : currentVersion(versions);
  const document = current?.document ?? null;
  const panels: [string, PanelLine[]][] = [
    [RULE_COPY.panels.watches, [watches(document, (each) => each)]],
    [RULE_COPY.panels.which, [whichMessages(document)]],
    [RULE_COPY.panels.judge, [judgeLine(document)]],
    [RULE_COPY.panels.where, whereTheyGo(document)],
    [RULE_COPY.panels.kept, [whatsKept(document)]],
    [RULE_COPY.panels.limit, [limitLine(document)]],
  ];
  return (
    <section aria-label={`Rule ${id}`} className="flex flex-col gap-(--cue-space-4)">
      <BackTo label={RULE_COPY.allRules} onBack={() => nav.openRule(null)} />
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">
          <UntrustedText text={id} />
        </h2>
        {status === null ? null : <StatusChip status={status} />}
        {document !== null && dryRunOnly(document) ? <Chip tone="accent">{DRY_RUN}</Chip> : null}
        {status === 'on' ? <Actions id={id} onChanged={lists.reloadRules} onProblem={setProblem} /> : null}
      </div>
      {problem === null ? null : <Problem message={problem} />}
      {read.state === 'loading' ? <Spinner label={COPY.loading} /> : null}
      {read.state === 'error' ? <Problem message={read.message} /> : null}
      {versions === null ? null : (
        <>
          {current?.summary == null ? null : (
            <section aria-label={RULE_COPY.inPlainWords}>
              <Panel className="p-(--cue-space-4)">
                <p className="text-(length:--cue-text-emphasis) text-fg">
                  <Sentence parts={current.summary} names={lists.names} />
                </p>
              </Panel>
            </section>
          )}
          <div className="grid grid-cols-1 gap-(--cue-space-3) md:grid-cols-2">
            {panels.map(([title, lines]) => (
              <Facet key={title} title={title} lines={lines} names={lists.names} />
            ))}
          </div>
          {status === 'not-switched-on' ? null : (
            <Week versions={versions} onDeliveries={() => nav.showDeliveriesOf(id)} />
          )}
          <Versions
            versions={versions}
            on={status === 'on'}
            {...(onScreen === undefined ? {} : { onApprovals: () => onScreen('approvals') })}
          />
          <TechnicalDetails id={id} versions={versions} />
        </>
      )}
    </section>
  );
}
