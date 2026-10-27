/**
 * Save, and Review and approve…, for a workflow drawn in the designer (workflows design §11.3, W1, W2, W24): what the
 * editor's document becomes before the person sees its preview, as the rule editor's submit does it (0.33.0 §3.1).
 * Each target the person changed or added becomes a version of its own first (`target update -`, `target add -`), and
 * the workflow embeds the copy the event service stored — and, in a flow, every deliver step that named the old version
 * names the new one. Then the workflow's version (`rule create|update -`), past any version another session made
 * meanwhile. Step ids are never renamed, so a subscriber's pattern keeps matching from version to version.
 *
 * Review and approve… then prepares the version's activation (`rule enable`) and reads its approval view, which is the
 * preview. Nothing is approved here: only the person's press of Approve does that (`RuleReview`).
 */
import { readRuleShow } from '../events-rules.ts';
import type { Bridge, Call, CliResult } from '../ipc.ts';
import { isObject, type JsonObject, targetsIn } from '../rule-editor/model.ts';
import {
  readActivation,
  readPreview,
  readTargetVersions,
  targetSteps,
  withStoredTargets,
} from '../rule-editor/submit.ts';

const UNREADABLE = 'That answer could not be read.';

const failure = (result: CliResult): string => (result.status === 'failed' ? result.message : UNREADABLE);

/**
 * `after` (the workflow once its targets were stored) with each flow deliver step that named a target's old version,
 * in `before`, naming the version stored in its place.
 */
export function withFlowTargets(before: JsonObject, after: JsonObject): JsonObject {
  if (!isObject(after.flow) || !isObject(after.flow.steps)) return after;
  const old = targetsIn(before);
  const renamed = new Map<string, number>();
  targetsIn(after).forEach((target, index) => {
    const was = old[index];
    if (was !== undefined && was.targetId === target.targetId && was.version !== target.version)
      renamed.set(`${String(was.targetId)}@${String(was.version)}`, target.version as number);
  });
  if (renamed.size === 0) return after;
  const steps = Object.fromEntries(
    Object.entries(after.flow.steps).map(([id, step]) => {
      if (!isObject(step) || step.kind !== 'deliver' || !isObject(step.target)) return [id, step];
      const moved = renamed.get(`${String(step.target.targetId)}@${String(step.target.version)}`);
      return [id, moved === undefined ? step : { ...step, target: { ...step.target, version: moved } }];
    }),
  );
  return { ...after, flow: { ...after.flow, steps } };
}

export type SaveOutcome = { ok: true; document: JsonObject; version: number } | { ok: false; problem: string };

/**
 * Stores the workflow's changed targets, then its version: `eventsRuleCreate` for a new workflow, `eventsRuleUpdate`
 * for the next version of one. `known` is every target version the app holds a copy of (`knownTargets`).
 */
export async function saveWorkflow(
  bridge: Pick<Bridge, 'cli'>,
  input: { isNew: boolean; ruleId: string; document: JsonObject; known: ReadonlyMap<string, string> },
): Promise<SaveOutcome> {
  const listed = await bridge.cli({ kind: 'eventsTargetsList' });
  if (listed.status !== 'ok') return { ok: false, problem: failure(listed) };
  const versions = readTargetVersions(listed.data) ?? new Map<string, number>();
  let next = input.document;
  const version = typeof next.version === 'number' ? next.version : 1;
  if (!input.isNew) {
    const shown = await bridge.cli({ kind: 'eventsRuleShow', ruleId: input.ruleId });
    const latest = shown.status === 'ok' ? (readRuleShow(shown.data) ?? []) : [];
    const highest = Math.max(0, ...latest.map((each) => each.version));
    if (highest >= version) next = { ...next, version: highest + 1 };
  }
  const stored = new Map<number, JsonObject>();
  for (const step of targetSteps(next, input.known, versions)) {
    const result = await bridge.cli({ kind: step.call, document: step.document } as Call);
    if (result.status !== 'ok') return { ok: false, problem: failure(result) };
    stored.set(
      step.index,
      isObject(result.data) && isObject(result.data.document) ? (result.data.document as JsonObject) : step.document,
    );
  }
  next = withFlowTargets(next, withStoredTargets(next, stored));
  const saved = await bridge.cli({ kind: input.isNew ? 'eventsRuleCreate' : 'eventsRuleUpdate', document: next });
  if (saved.status !== 'ok') return { ok: false, problem: failure(saved) };
  return { ok: true, document: next, version: typeof next.version === 'number' ? next.version : version };
}

export type ReviewOutcome =
  | { ok: true; approvalId: string; digest: string; rule: JsonObject }
  | { ok: false; problem: string };

/** Prepares version `version`'s activation and reads its preview; a preview that cannot be read revokes it. */
export async function prepareReview(
  bridge: Pick<Bridge, 'cli' | 'revokePreview'>,
  ruleId: string,
  version: number,
): Promise<ReviewOutcome> {
  const enabled = await bridge.cli({ kind: 'eventsRuleEnable', ruleId, version });
  if (enabled.status !== 'ok') return { ok: false, problem: failure(enabled) };
  const activation = readActivation(enabled.data);
  if (activation === null) return { ok: false, problem: 'The activation could not be read.' };
  const viewed = await bridge.cli({ kind: 'eventsApprovalView', ...activation });
  const preview =
    viewed.status === 'ok'
      ? readPreview(viewed.data)
      : { rule: null, problem: viewed.status === 'failed' ? viewed.message : 'The preview could not be read.' };
  if (preview.rule === null) {
    await bridge.revokePreview(activation.approvalId).catch(() => undefined);
    return { ok: false, problem: preview.problem };
  }
  return { ok: true, ...activation, rule: preview.rule };
}
