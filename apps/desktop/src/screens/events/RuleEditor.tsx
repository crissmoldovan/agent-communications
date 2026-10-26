/**
 * Editing a rule in the app, or writing a new one (0.33.0, design 2026-10-26-rules-that-act-0330 §3.1–§3.3, the
 * approved prototype's RuleEdit, RuleEditText and RuleAnalyse). The editor holds one thing, the canonical rule
 * document, and shows it three ways: visually, in five sections; as the rule's text, checked as the person types; and,
 * under Advanced, as its JSON, read-only. Switching between them keeps the same document. Analyse suggests changes the
 * person applies or skips.
 *
 * Review and approve… stores what the rule needs — each changed or new target as a version of its own, then the rule's
 * next version — on stdin, prepares its activation, and shows the activation's own preview. Nothing is switched on
 * until the person approves it there (`RuleReview`); the version that runs keeps running until then.
 */
import { Button, Chip, Panel, SegmentedControl, Spinner } from '@cueplusplus/ui';
import { Sparkles } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { aliasOf } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { useAppData } from '../../data.tsx';
import {
  currentVersion,
  judgeLine,
  limitLine,
  type PanelLine,
  type RuleVersionView,
  readRuleShow,
  watches,
  whatsKept,
  whereTheyGo,
  whichMessages,
} from '../../events-rules.ts';
import { useCall } from '../../hooks/use-call.ts';
import { readAgentSessions, readLinear } from '../../integrations.ts';
import { type Call, errorMessage } from '../../ipc.ts';
import { useNavigate } from '../../navigation.tsx';
import { readJudgeShow, readListedJudges } from '../../providers.ts';
import { blocking, type Check, draftChecks, parseChecks } from '../../rule-editor/checks.ts';
import { ANALYSE_COPY, EDITOR_COPY as COPY, REVIEW_COPY } from '../../rule-editor/copy.ts';
import { canonical, isObject, type JsonObject, newRule, nextVersion, setJudge } from '../../rule-editor/model.ts';
import {
  knownTargets,
  readActivation,
  readPreview,
  readTargetVersions,
  targetSteps,
  withStoredTargets,
} from '../../rule-editor/submit.ts';
import { parseRuleText, printRuleText } from '../../rule-text.ts';
import type { EventsLists } from './lists.ts';
import { BackTo, Problem, Sentence } from './parts.tsx';
import { RuleAnalyse } from './RuleAnalyse.tsx';
import { type PreparedReview, RuleReview } from './RuleReview.tsx';
import { RuleChecks, RuleJsonPane, RuleTextPane } from './RuleText.tsx';
import { type JudgeChoice, RuleVisual } from './RuleVisual.tsx';

/** What the editor opens on: a rule's next version, or a new rule by the name the person gave it. */
export type EditTarget = { kind: 'edit'; ruleId: string } | { kind: 'new'; ruleId: string };

type Mode = 'visual' | 'text' | 'json';

/** What a step says when its answer is not one the app can read. */
const UNREADABLE = 'That answer could not be read.';

const JUDGES: Call = { kind: 'judgesList' };
const LANES: Call = { kind: 'laneList' };
const LINEAR: Call = { kind: 'integrationShow', integration: 'linear' };
const SESSIONS: Call = { kind: 'integrationShow', integration: 'agent-sessions' };
const TARGETS: Call = { kind: 'eventsTargetsList' };

/** Every rule document the app read, newest last: where a stored judge's or target's exact copy is found. */
function documentsOf(lists: EventsLists): JsonObject[] {
  return [...lists.versions.values()].flatMap((read) =>
    read.state === 'ready'
      ? read.value.flatMap((version) => (isObject(version.document) ? [version.document as JsonObject] : []))
      : [],
  );
}

/** A judge version's key, `<id>@<version>`, as the picker names it. */
const judgeKey = (judge: { judgeId: string; version: number }) => `${judge.judgeId}@${judge.version}`;

function startDocument(
  target: EditTarget,
  versions: readonly RuleVersionView[] | null,
  lists: EventsLists,
): JsonObject {
  if (target.kind === 'edit' && versions !== null) {
    const current = currentVersion(versions);
    const latest = Math.max(0, ...versions.map((each) => each.version));
    if (current?.document != null) return nextVersion(current.document as JsonObject, latest);
  }
  const first =
    [...lists.names.entries()].find(([, name]) => name.channel === 'gmail') ?? [...lists.names.entries()][0];
  return newRule(target.ruleId, first === undefined ? null : { id: first[0], channel: first[1].channel });
}

function PlainWords({ lines, names }: { lines: PanelLine[]; names: EventsLists['names'] }) {
  return (
    <section aria-label={COPY.inPlainWords}>
      <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
        <h3 className="font-semibold text-(length:--cue-text-label) text-fg">{COPY.inPlainWords}</h3>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines come in the sections' fixed order.
          <p key={index} className="text-fg">
            <Sentence parts={line.main} names={names} />
            {line.detail.length === 0 ? null : (
              <span className="text-fg-muted">
                {' — '}
                <Sentence parts={line.detail} names={names} />
              </span>
            )}
          </p>
        ))}
      </Panel>
    </section>
  );
}

function AnalyseCard({ onAnalyse, disabled }: { onAnalyse: () => void; disabled: boolean }) {
  return (
    <section aria-label={COPY.analyse}>
      <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
        <h3 className="font-semibold text-(length:--cue-text-label) text-fg">{COPY.analyse}</h3>
        <p className="text-fg-muted">{COPY.analyseBody}</p>
        <div>
          <Button size="sm" disabled={disabled} onClick={onAnalyse}>
            {COPY.analyseThis}
          </Button>
        </div>
      </Panel>
    </section>
  );
}

export function RuleEditor({
  target,
  lists,
  onClose,
  onApproved,
}: {
  target: EditTarget;
  lists: EventsLists;
  /** Back to the rule's page, or to the list for a new rule. */
  onClose: () => void;
  /** The review is over — approved in the app, or left for the terminal — so the rule's page reads it again. */
  onApproved: (ruleId: string, version: number) => void;
}) {
  const bridge = useBridge();
  const navigate = useNavigate();
  const { installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const versions = useMemo(() => {
    const read = lists.versions.get(target.ruleId);
    return read?.state === 'ready' ? read.value : null;
  }, [lists.versions, target.ruleId]);
  const running = versions?.find((each) => each.state === 'active') ?? null;
  const [stored] = useState<JsonObject>(() => startDocument(target, versions, lists));
  const [document, setDocument] = useState<JsonObject>(stored);
  const [mode, setMode] = useState<Mode>('visual');
  const [text, setText] = useState<string>('');
  const [textErrors, setTextErrors] = useState<Check[] | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<PreparedReview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const judges = useCall<unknown>(JUDGES).result;
  const lanes = useCall<unknown>(LANES).result;
  const linearRead = useCall<unknown>(LINEAR).result;
  const sessionsRead = useCall<unknown>(SESSIONS).result;
  const targetsRead = useCall<unknown>(TARGETS).result;
  const linear = linearRead.state === 'ready' ? readLinear(linearRead.value) : null;
  const sessions = sessionsRead.state === 'ready' ? readAgentSessions(sessionsRead.value) : null;
  const laneNames =
    lanes.state === 'ready' && isObject(lanes.value) && Array.isArray(lanes.value.lanes)
      ? lanes.value.lanes.flatMap((lane) => (isObject(lane) && typeof lane.name === 'string' ? [lane.name] : []))
      : null;
  const documents = useMemo(() => documentsOf(lists), [lists]);
  // Every live judge `judges list` names is offered; the one chosen is embedded exactly as `judge show` gives its
  // document, read once per version.
  const [judgeDocuments, setJudgeDocuments] = useState<ReadonlyMap<string, JsonObject>>(() => new Map());
  const [judgeReading, setJudgeReading] = useState(false);
  const [judgeProblem, setJudgeProblem] = useState<string | null>(null);
  const judgeChoices: JudgeChoice[] = useMemo(() => {
    const listed = judges.state === 'ready' ? (readListedJudges(judges.value) ?? []) : [];
    return listed
      .filter((judge) => judge.revokedAt === null)
      .map((judge) => ({
        judgeId: judge.judgeId,
        version: judge.version,
        kind: judge.kind,
        provider: judge.provider,
        document: judgeDocuments.get(judgeKey(judge)) ?? null,
      }));
  }, [judgeDocuments, judges]);
  const chooseJudge = useCallback(
    async (choice: JudgeChoice | null) => {
      setJudgeProblem(null);
      if (choice === null) {
        setDocument((current) => setJudge(current, null));
        return;
      }
      let judge = choice.document;
      if (judge === null) {
        setJudgeReading(true);
        try {
          const result = await bridge.cli({ kind: 'judgeShow', judgeId: choice.judgeId, version: choice.version });
          judge = result.status === 'ok' ? (readJudgeShow(result.data, choice) as JsonObject | null) : null;
          if (judge === null) {
            setJudgeProblem(result.status === 'failed' ? result.message : COPY.judgeUnreadable);
            return;
          }
          const read = judge;
          setJudgeDocuments((before) => new Map(before).set(judgeKey(choice), read));
        } catch (error) {
          setJudgeProblem(errorMessage(error));
          return;
        } finally {
          setJudgeReading(false);
        }
      }
      const chosen = judge;
      setDocument((current) => setJudge(current, chosen));
    },
    [bridge],
  );
  const takenTargetIds = useMemo(() => {
    const versionsOf = targetsRead.state === 'ready' ? readTargetVersions(targetsRead.value) : null;
    return new Set(versionsOf?.keys() ?? []);
  }, [targetsRead]);

  const version = typeof document.version === 'number' ? document.version : 1;
  const changed = canonical(document) !== canonical(stored);
  const draft = target.kind === 'new' || changed;
  const checkContext = { accounts: lists.names, lanes: laneNames, linear, sessions, home };
  const checks = textErrors ?? draftChecks(document, checkContext);
  const toIntegrations = navigate === null ? null : () => navigate({ screen: 'settings', section: 'integrations' });

  const toMode = (next: Mode) => {
    if (next === mode) return;
    // Text that does not read yet holds the person there: the other views show the document it reads to.
    if (mode === 'text' && textErrors !== null) return;
    if (next === 'text') {
      setText(printRuleText(document));
      setTextErrors(null);
    }
    setMode(next);
  };

  const onText = (value: string) => {
    setText(value);
    const parsed = parseRuleText(value);
    if (parsed.ok) {
      setTextErrors(null);
      setDocument(parsed.doc as JsonObject);
    } else setTextErrors(parseChecks(parsed.errors));
  };

  const fail = (message: string) => {
    setProblem(message);
    setPreparing(false);
  };

  /** Each step of Review and approve…, in order; the first that fails stops it, and says why. */
  const prepare = async () => {
    setPreparing(true);
    setProblem(null);
    setNotice(null);
    try {
      const listed = await bridge.cli(TARGETS);
      if (listed.status !== 'ok') return fail(listed.status === 'failed' ? listed.message : UNREADABLE);
      const targetVersions = readTargetVersions(listed.data) ?? new Map<string, number>();
      let next = document;
      // The rule's version, past any another session made meanwhile.
      if (target.kind === 'edit') {
        const shown = await bridge.cli({ kind: 'eventsRuleShow', ruleId: target.ruleId });
        const latest = shown.status === 'ok' ? (readRuleShow(shown.data) ?? []) : [];
        const highest = Math.max(0, ...latest.map((each) => each.version));
        if (highest >= version) next = { ...next, version: highest + 1 };
      }
      const steps = targetSteps(next, knownTargets(documents), targetVersions);
      const storedTargets = new Map<number, JsonObject>();
      for (const step of steps) {
        const result = await bridge.cli({ kind: step.call, document: step.document });
        if (result.status !== 'ok') return fail(result.status === 'failed' ? result.message : UNREADABLE);
        const made =
          isObject(result.data) && isObject(result.data.document)
            ? (result.data.document as JsonObject)
            : step.document;
        storedTargets.set(step.index, made);
      }
      next = withStoredTargets(next, storedTargets);
      const nextVersionNumber = typeof next.version === 'number' ? next.version : version;
      const saved = await bridge.cli({
        kind: target.kind === 'new' ? 'eventsRuleCreate' : 'eventsRuleUpdate',
        document: next,
      });
      if (saved.status !== 'ok') return fail(saved.status === 'failed' ? saved.message : UNREADABLE);
      setDocument(next);
      const enabled = await bridge.cli({ kind: 'eventsRuleEnable', ruleId: target.ruleId, version: nextVersionNumber });
      if (enabled.status !== 'ok') return fail(enabled.status === 'failed' ? enabled.message : UNREADABLE);
      const activation = readActivation(enabled.data);
      if (activation === null) return fail('The activation could not be read.');
      const viewed = await bridge.cli({ kind: 'eventsApprovalView', ...activation });
      const preview =
        viewed.status === 'ok'
          ? readPreview(viewed.data)
          : { rule: null, problem: viewed.status === 'failed' ? viewed.message : 'The preview could not be read.' };
      if (preview.rule === null) {
        await bridge.revokePreview(activation.approvalId).catch(() => undefined);
        return fail(preview.problem);
      }
      setReview({
        ruleId: target.ruleId,
        version: nextVersionNumber,
        ...activation,
        rule: preview.rule,
        running:
          running === null
            ? null
            : { version: running.version, document: (running.document as JsonObject | null) ?? null },
      });
      setPreparing(false);
    } catch (error) {
      fail(errorMessage(error));
    }
  };

  if (analysing)
    return (
      <RuleAnalyse
        ruleId={target.ruleId}
        document={document}
        draft={draft}
        names={lists.names}
        onBack={() => setAnalysing(false)}
        onApply={(applied, notApplied) => {
          setDocument(applied);
          setAnalysing(false);
          setMode('visual');
          setNotice(notApplied === 0 ? null : ANALYSE_COPY.notApplied(notApplied));
        }}
      />
    );

  const title = target.kind === 'new' ? COPY.newTitle(target.ruleId) : COPY.editTitle(target.ruleId);
  const panels: PanelLine[] = [
    watches(document, (id) => aliasOf(lists.names, id)),
    whichMessages(document),
    judgeLine(document),
    ...whereTheyGo(document),
    whatsKept(document),
    limitLine(document),
  ];
  return (
    <section aria-label={title} className="flex flex-col gap-(--cue-space-4)">
      <BackTo label={target.kind === 'new' ? 'All rules' : target.ruleId} onBack={onClose} />
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">
          <UntrustedText text={title} />
        </h2>
        <Chip tone="neutral">{COPY.notSaved(version)}</Chip>
        <span className="ml-auto flex flex-wrap items-center gap-(--cue-space-2)">
          <SegmentedControl
            aria-label={COPY.editAs}
            size="sm"
            value={mode}
            items={[
              { value: 'visual', label: COPY.visual, disabled: mode === 'text' && textErrors !== null },
              { value: 'text', label: COPY.text },
              { value: 'json', label: COPY.json, disabled: mode === 'text' && textErrors !== null },
            ]}
            onValueChange={(value) => toMode(value as Mode)}
          />
          <Button size="sm" icon={Sparkles} disabled={textErrors !== null} onClick={() => setAnalysing(true)}>
            {COPY.analyse}
          </Button>
        </span>
      </div>
      {notice === null ? null : <p className="text-fg-muted">{notice}</p>}
      <div className="flex flex-wrap items-start gap-(--cue-space-4)">
        <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-(--cue-space-3)">
          {mode === 'visual' ? (
            <RuleVisual
              document={document}
              onChange={setDocument}
              context={{
                names: lists.names,
                judges: judgeChoices,
                onChooseJudge: (choice) => void chooseJudge(choice),
                judgeReading,
                judgeProblem,
                linear,
                takenTargetIds,
                onEditAsText: () => toMode('text'),
                onIntegrations: toIntegrations,
              }}
            />
          ) : mode === 'text' ? (
            <RuleTextPane text={text} onText={onText} />
          ) : (
            <RuleJsonPane document={document} />
          )}
        </div>
        <aside aria-label="Summary" className="flex min-w-0 flex-[1_1_16rem] flex-col gap-(--cue-space-3)">
          {mode === 'text' ? (
            <RuleChecks checks={checks} names={lists.names} onIntegrations={toIntegrations} />
          ) : (
            <PlainWords lines={panels} names={lists.names} />
          )}
          {mode === 'text' && textErrors !== null ? <p className="text-fg-muted">{COPY.fixTextFirst}</p> : null}
          <AnalyseCard onAnalyse={() => setAnalysing(true)} disabled={textErrors !== null} />
        </aside>
      </div>
      {problem === null ? null : <Problem message={problem} />}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-(--cue-space-2) bg-bg py-(--cue-space-3)">
        <span className="min-w-60 flex-1 text-(length:--cue-text-label) text-fg-muted">
          {COPY.footer(version, running?.version ?? null)}
        </span>
        {preparing ? <Spinner size="sm" label={REVIEW_COPY.preparing} /> : null}
        <Button variant="ghost" disabled={preparing} onClick={onClose}>
          {COPY.cancel}
        </Button>
        <Button
          variant="primary"
          loading={preparing}
          disabled={preparing || textErrors !== null || blocking(checks)}
          onClick={() => void prepare()}
        >
          {COPY.review}
        </Button>
      </div>
      {review === null ? null : (
        <RuleReview
          review={review}
          names={lists.names}
          onApproved={() => onApproved(review.ruleId, review.version)}
          onDone={() => onApproved(review.ruleId, review.version)}
          onClosed={(revokeProblem) => {
            setReview(null);
            setProblem(revokeProblem);
            setNotice(revokeProblem === null ? REVIEW_COPY.revoked : null);
          }}
        />
      )}
    </section>
  );
}
