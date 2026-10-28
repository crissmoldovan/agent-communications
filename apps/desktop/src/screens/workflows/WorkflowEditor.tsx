/**
 * A workflow in the designer (workflows design §11.2–§11.3, the approved prototype's WorkflowDesigner): Events →
 * Workflows opens it in place of the rule editor once the event service has workflows (0.36.0). It holds one thing,
 * the canonical workflow document, and draws it; every change is a pure function of it. A straight line is drawn as the
 * graph it already is and written as a flow only when a change needs one, so opening one and leaving it untouched makes
 * no call at all, and Save stays off.
 *
 * Save draft stores what the workflow needs — each changed or new target as a version of its own, then the workflow's
 * next version — and Review and approve… prepares that version's activation and shows its own preview (`RuleReview`).
 * Nothing switches on until the person approves it there; the version that runs keeps running until then.
 *
 * Describe it… (0.36.0 §11.4) drafts the workflow from the person's words into the same document, as any edit: open at
 * once for a new workflow started from their own words, and saved nowhere until they save it.
 */
import { Button, Chip, Spinner } from '@cueplusplus/ui';
import { useCallback, useMemo, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { useAppData } from '../../data.tsx';
import { currentVersion, type RuleVersionView } from '../../events-rules.ts';
import { useCall } from '../../hooks/use-call.ts';
import { readLinear } from '../../integrations.ts';
import { type Call, errorMessage } from '../../ipc.ts';
import { useNavigate } from '../../navigation.tsx';
import { readJudgeShow, readListedJudges } from '../../providers.ts';
import { blocking, draftChecks } from '../../rule-editor/checks.ts';
import { REVIEW_COPY } from '../../rule-editor/copy.ts';
import {
  canonical,
  copyOf,
  isObject,
  type JsonObject,
  newRule,
  nextVersion,
  setJudge,
} from '../../rule-editor/model.ts';
import { knownTargets, readTargetVersions } from '../../rule-editor/submit.ts';
import { designerChecks } from '../../workflows/checks.ts';
import { FLOW_LIMIT_DEFAULTS, isEventSegment } from '../../workflows/flow.ts';
import { useDocumentHistory } from '../../workflows/history.ts';
import { prepareReview, saveWorkflow } from '../../workflows/save.ts';
import type { EventsLists } from '../events/lists.ts';
import { BackTo, Problem } from '../events/parts.tsx';
import type { EditTarget } from '../events/RuleEditor.tsx';
import { type PreparedReview, RuleReview } from '../events/RuleReview.tsx';
import type { JudgeChoice, VisualContext } from '../events/RuleVisual.tsx';
import { Describe } from './Describe.tsx';
import type { DesignerContext } from './Designer.tsx';
import { Views } from './Views.tsx';

export const WORKFLOW_EDITOR_COPY = {
  allWorkflows: 'All workflows',
  newTitle: (id: string) => `New workflow ${id}`,
  editTitle: (id: string) => `Edit ${id}`,
  draft: (version: number) => `Version ${version}, a draft`,
  saved: (version: number) => `Version ${version}, saved`,
  footer: (version: number, running: number | null) =>
    running === null
      ? `Saving makes version ${version}. Nothing runs until you approve it.`
      : `Saving makes version ${version}. Version ${running} keeps running until you approve version ${version}.`,
  savedLine: (version: number) => `Saved as version ${version}. Nothing runs until you approve it.`,
  saving: 'Saving…',
  saveDraft: 'Save draft',
  review: 'Review and approve…',
  cancel: 'Cancel',
  fixFirst: (count: number) =>
    count === 1 ? 'One thing to fix before it can be saved.' : `${count} things to fix before it can be saved.`,
} as const;

const TARGETS: Call = { kind: 'eventsTargetsList' };
const JUDGES: Call = { kind: 'judgesList' };
const LINEAR: Call = { kind: 'integrationShow', integration: 'linear' };

/** A judge version's key, `<id>@<version>`, as the pickers name it. */
const judgeKey = (judge: { judgeId: string; version: number }) => `${judge.judgeId}@${judge.version}`;

/** Every workflow document the app read, newest last: where a stored target's exact copy is found. */
function documentsOf(lists: EventsLists): JsonObject[] {
  return [...lists.versions.values()].flatMap((read) =>
    read.state === 'ready'
      ? read.value.flatMap((version) => (isObject(version.document) ? [version.document as JsonObject] : []))
      : [],
  );
}

/** A workflow with no steps yet: what an empty canvas starts from. */
function emptyWorkflow(ruleId: string, account: { id: string; channel: string } | null): JsonObject {
  return {
    ...newRule(ruleId, account),
    targets: [],
    flow: { flowVersion: 1, start: '', steps: {}, limits: { ...FLOW_LIMIT_DEFAULTS } },
  };
}

/** A copy of another workflow's current version, as version 1 of `ruleId`; its events named after its new id. */
function copyWorkflow(ruleId: string, source: JsonObject): JsonObject {
  const next: JsonObject = { ...copyOf(source), ruleId, version: 1 };
  if (isObject(next.flow) && isObject(next.flow.events) && isEventSegment(ruleId))
    next.flow = { ...next.flow, events: { ...next.flow.events, workflow: ruleId } };
  return next;
}

/** What the editor opens on: the next version of the workflow, an empty canvas, a copy, or a new straight line. */
export function startDocument(
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
  const account = first === undefined ? null : { id: first[0], channel: first[1].channel };
  if (target.kind === 'new' && target.from !== undefined && typeof target.from === 'object') {
    const read = lists.versions.get(target.from.copy);
    const current = read?.state === 'ready' ? currentVersion(read.value) : null;
    if (isObject(current?.document)) return copyWorkflow(target.ruleId, current.document as JsonObject);
  }
  if (target.kind === 'new' && target.from !== undefined) return emptyWorkflow(target.ruleId, account);
  return newRule(target.ruleId, account);
}

export function WorkflowEditor({
  target,
  lists,
  onClose,
  onApproved,
}: {
  target: EditTarget;
  lists: EventsLists;
  onClose: () => void;
  onApproved: (ruleId: string, version: number) => void;
}) {
  const bridge = useBridge();
  const { installation } = useAppData();
  const home = installation.state === 'ready' ? (installation.value.home ?? null) : null;
  const versions = useMemo(() => {
    const read = lists.versions.get(target.ruleId);
    return read?.state === 'ready' ? read.value : null;
  }, [lists.versions, target.ruleId]);
  const running = versions?.find((each) => each.state === 'active') ?? null;
  const [stored] = useState<JsonObject>(() => startDocument(target, versions, lists));
  const history = useDocumentHistory(() => stored);
  const { document, apply } = history;
  const [saved, setSaved] = useState<JsonObject | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<PreparedReview | null>(null);

  const navigate = useNavigate();
  const targetsRead = useCall<unknown>(TARGETS).result;
  const judges = useCall<unknown>(JUDGES).result;
  const linearRead = useCall<unknown>(LINEAR).result;
  const linear = linearRead.state === 'ready' ? readLinear(linearRead.value) : null;
  const documents = useMemo(() => documentsOf(lists), [lists]);
  // Every live judge `judges list` names is offered; the one chosen is embedded exactly as `judge show` gives its
  // document, read once per version, as the rule editor does.
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
  const readJudge = useCallback(
    async (choice: JudgeChoice): Promise<JsonObject | null> => {
      if (choice.document !== null) return choice.document;
      try {
        const result = await bridge.cli({ kind: 'judgeShow', judgeId: choice.judgeId, version: choice.version });
        const judge = result.status === 'ok' ? (readJudgeShow(result.data, choice) as JsonObject | null) : null;
        if (judge !== null) setJudgeDocuments((before) => new Map(before).set(judgeKey(choice), judge));
        return judge;
      } catch {
        return null;
      }
    },
    [bridge],
  );
  const context: DesignerContext = useMemo(() => {
    const listed = targetsRead.state === 'ready' ? readTargetVersions(targetsRead.value) : null;
    const takenTargetIds = new Set(listed?.keys() ?? []);
    const webhooks = documents.flatMap((each) =>
      Array.isArray(each.targets)
        ? each.targets.filter((one): one is JsonObject => isObject(one) && one.kind === 'webhook')
        : [],
    );
    const onEditAsText = () => undefined;
    const visual: VisualContext = {
      names: lists.names,
      judges: judgeChoices,
      onChooseJudge: (choice) => {
        setJudgeProblem(null);
        if (choice === null) {
          apply((current) => setJudge(current, null));
          return;
        }
        setJudgeReading(true);
        void readJudge(choice).then((judge) => {
          setJudgeReading(false);
          if (judge === null) setJudgeProblem('That judge’s details could not be read.');
          else apply((current) => setJudge(current, judge));
        });
      },
      judgeReading,
      judgeProblem,
      linear,
      takenTargetIds,
      onEditAsText,
      onIntegrations: navigate === null ? null : () => navigate({ screen: 'settings', section: 'integrations' }),
    };
    return {
      names: lists.names,
      takenTargetIds,
      webhooks,
      judges: judgeChoices,
      readJudge,
      linear,
      visual,
      onEditAsText,
    };
  }, [
    apply,
    documents,
    judgeChoices,
    judgeProblem,
    judgeReading,
    linear,
    lists.names,
    navigate,
    readJudge,
    targetsRead,
  ]);

  const version = typeof document.version === 'number' ? document.version : 1;
  const base = saved ?? stored;
  const changed = canonical(document) !== canonical(base);
  const fresh = target.kind === 'new' && saved === null;
  const flowProblems = designerChecks(document);
  const straightProblems = isObject(document.flow)
    ? []
    : draftChecks(document, { accounts: lists.names, lanes: null, linear: null, sessions: null, home });
  const blocked = flowProblems.length > 0 || blocking(straightProblems);
  const canSave = !busy && !blocked && (changed || fresh);
  const canReview = !busy && !blocked && (changed || fresh || saved !== null);

  const fail = (message: string) => {
    setProblem(message);
    setBusy(false);
  };

  /** Stores the targets and the workflow's version; the version stored, or null when a step failed. */
  const save = async (): Promise<{ document: JsonObject; version: number } | null> => {
    const outcome = await saveWorkflow(bridge, {
      isNew: target.kind === 'new' && saved === null,
      ruleId: target.ruleId,
      document,
      known: knownTargets(documents),
    });
    if (!outcome.ok) {
      fail(outcome.problem);
      return null;
    }
    history.reset(outcome.document);
    setSaved(outcome.document);
    return { document: outcome.document, version: outcome.version };
  };

  const saveDraft = async () => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const done = await save();
      if (done === null) return;
      setNotice(WORKFLOW_EDITOR_COPY.savedLine(done.version));
      setBusy(false);
    } catch (error) {
      fail(errorMessage(error));
    }
  };

  const prepare = async () => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      let at = saved === null ? null : { document: saved, version };
      if (at === null || changed) at = await save();
      if (at === null) return;
      const prepared = await prepareReview(bridge, target.ruleId, at.version);
      if (!prepared.ok) return fail(prepared.problem);
      setReview({
        ruleId: target.ruleId,
        version: at.version,
        approvalId: prepared.approvalId,
        digest: prepared.digest,
        rule: prepared.rule,
        running:
          running === null
            ? null
            : { version: running.version, document: (running.document as JsonObject | null) ?? null },
      });
      setBusy(false);
    } catch (error) {
      fail(errorMessage(error));
    }
  };

  const COPY = WORKFLOW_EDITOR_COPY;
  const title = target.kind === 'new' ? COPY.newTitle(target.ruleId) : COPY.editTitle(target.ruleId);
  const problems = flowProblems.length + straightProblems.filter((check) => check.tone === 'error').length;
  return (
    <section aria-label={title} className="flex flex-col gap-(--cue-space-4)">
      <BackTo label={target.kind === 'new' ? COPY.allWorkflows : target.ruleId} onBack={onClose} />
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <h2 className="font-semibold text-(length:--cue-text-title) text-fg">
          <UntrustedText text={title} />
        </h2>
        <Chip tone="neutral">{saved !== null && !changed ? COPY.saved(version) : COPY.draft(version)}</Chip>
        {running === null ? null : <Chip tone="ok">{`Version ${running.version} is on`}</Chip>}
      </div>
      {notice === null ? null : (
        <p role="status" className="text-fg-muted">
          {notice}
        </p>
      )}
      <Describe
        ruleId={target.ruleId}
        version={version}
        document={document}
        onDraft={(next) => apply(() => next)}
        startOpen={target.kind === 'new' && target.from === 'words'}
      />
      <Views history={history} context={context} />
      {problem === null ? null : <Problem message={problem} />}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-(--cue-space-2) bg-bg py-(--cue-space-3)">
        <span className="min-w-60 flex-1 text-(length:--cue-text-label) text-fg-muted">
          {problems > 0 ? COPY.fixFirst(problems) : COPY.footer(version, running?.version ?? null)}
        </span>
        {busy ? <Spinner size="sm" label={COPY.saving} /> : null}
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {COPY.cancel}
        </Button>
        <Button disabled={!canSave} onClick={() => void saveDraft()}>
          {COPY.saveDraft}
        </Button>
        <Button variant="primary" loading={busy} disabled={!canReview} onClick={() => void prepare()}>
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
