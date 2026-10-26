/**
 * Review and approve… (0.33.0, design 2026-10-26-rules-that-act-0330 §3.1): what the editor's document becomes before
 * the person sees its preview. A rule carries an exact copy of each target version it names, so a target the person
 * changed, or added, becomes a version of its own first (`target update -`, `target add -`), and the rule embeds the
 * copy the event service stored. Then the rule's version (`rule create|update -`) and its activation (`rule enable`),
 * whose approval view is the preview. Nothing is approved here: only the person's press of Approve does that.
 */
import {
  changedSections,
  describeCondition,
  judgeLine,
  limitLine,
  mappedFields,
  type RulePart,
  watches,
  whatsKept,
  whereTheyGo,
} from '../events-rules.ts';
import { canonical, isObject, type JsonObject, targetsIn } from './model.ts';
import { linearView, sessionView } from './targets.ts';

const plain = (text: string): RulePart => ({ text, kind: 'plain' });
const value = (text: string): RulePart => ({ text, kind: 'value' });
const authored = (text: string): RulePart => ({ text, kind: 'untrusted' });

/** `targets list --json`: each target id's highest version. Null when it is not that answer. */
export function readTargetVersions(data: unknown): Map<string, number> | null {
  if (!Array.isArray(data)) return null;
  const versions = new Map<string, number>();
  for (const row of data) {
    if (!isObject(row) || typeof row.target_id !== 'string' || typeof row.version !== 'number') continue;
    versions.set(row.target_id, Math.max(versions.get(row.target_id) ?? 0, row.version));
  }
  return versions;
}

/** Every target version the app has a copy of, from the rules it read: `<id>@<version>` → its canonical JSON. */
export function knownTargets(documents: readonly (JsonObject | null)[]): Map<string, string> {
  const known = new Map<string, string>();
  for (const document of documents) {
    if (document === null) continue;
    for (const target of targetsIn(document))
      if (typeof target.targetId === 'string' && typeof target.version === 'number')
        known.set(`${target.targetId}@${target.version}`, canonical(target));
  }
  return known;
}

/** One target the rule needs stored first, and where it sits in the rule. */
export interface TargetStep {
  index: number;
  call: 'eventsTargetAdd' | 'eventsTargetUpdate';
  document: JsonObject;
}

/**
 * The targets to store before the rule: one the app has a copy of, unchanged, needs nothing; one changed becomes its
 * id's next version; one with an id no target has is added at its version. One the app has no copy of, at a version
 * the event service already has, is taken as written: the event service refuses it if it differs.
 */
export function targetSteps(
  document: JsonObject,
  known: ReadonlyMap<string, string>,
  versions: ReadonlyMap<string, number>,
): TargetStep[] {
  const steps: TargetStep[] = [];
  targetsIn(document).forEach((target, index) => {
    const id = typeof target.targetId === 'string' ? target.targetId : '';
    const version = typeof target.version === 'number' ? target.version : 1;
    const stored = known.get(`${id}@${version}`);
    const latest = versions.get(id);
    if (stored !== undefined) {
      if (stored === canonical(target)) return;
      steps.push({
        index,
        call: 'eventsTargetUpdate',
        document: { ...target, version: Math.max(latest ?? version, version) + 1 },
      });
      return;
    }
    if (latest === undefined) {
      steps.push({ index, call: 'eventsTargetAdd', document: { ...target } });
      return;
    }
    if (version > latest) steps.push({ index, call: 'eventsTargetUpdate', document: { ...target } });
  });
  return steps;
}

/** The rule with `stored` (what each step's command answered, its `document`) in place of the targets it stored. */
export function withStoredTargets(document: JsonObject, stored: ReadonlyMap<number, JsonObject>): JsonObject {
  return {
    ...document,
    targets: targetsIn(document).map((target, index) => stored.get(index) ?? target),
  };
}

/** What `rule enable` came back with: the approval to answer, and the digest it binds. */
export function readActivation(data: unknown): { approvalId: string; digest: string } | null {
  if (!isObject(data) || typeof data.approvalId !== 'string' || !isObject(data.binding)) return null;
  const digest = data.binding.digest;
  return typeof digest === 'string' && /^[0-9a-f]{64}$/u.test(digest) ? { approvalId: data.approvalId, digest } : null;
}

/** The approval view, read: the rule it would switch on. Null when it is not a ready view of a rule. */
export function readPreview(data: unknown): { rule: JsonObject; problem: null } | { rule: null; problem: string } {
  if (!isObject(data)) return { rule: null, problem: 'The preview could not be read.' };
  if (data.kind === 'STALE_APPROVAL') return { rule: null, problem: 'This approval is no longer waiting.' };
  if (data.kind === 'DIGEST_MISMATCH') return { rule: null, problem: 'The rule changed after it was prepared.' };
  const preview = isObject(data.preview) ? data.preview : null;
  if (data.kind !== 'READY' || preview === null || preview.kind !== 'rule' || !isObject(preview.rule))
    return { rule: null, problem: 'The preview could not be read.' };
  return { rule: preview.rule, problem: null };
}

/** "What changes", line by line: each section the new version changes, as its panel says it now. */
export function whatChanges(before: JsonObject | null, after: JsonObject, alias: (id: string) => string): RulePart[][] {
  const sections: [string, () => RulePart[][]][] = [
    ['what it watches', () => [watches(after, alias).main.concat(plain(': '), watches(after, alias).detail)]],
    ['which messages', () => [describeCondition(after.condition)]],
    ['the judge', () => [judgeLine(after).main.concat(judgeDetail(after))]],
    ['where they go', () => whereTheyGo(after).map((line) => line.main.concat(detailOf(line.detail)))],
    ["what's kept", () => [whatsKept(after).main]],
    ['the limit', () => [limitLine(after).main]],
  ];
  const changed = before === null ? sections.map(([name]) => name) : changedSections(before, after);
  return sections.filter(([name]) => changed.includes(name)).flatMap(([, lines]) => lines());
}

function detailOf(detail: RulePart[]): RulePart[] {
  return detail.length === 0 ? [] : [plain(' — '), ...detail];
}

function judgeDetail(document: JsonObject): RulePart[] {
  return detailOf(judgeLine(document).detail);
}

const FIELD_WORDS: Readonly<Record<string, string>> = {
  '/from': 'the sender',
  '/from/name': "the sender's name",
  '/from/address': "the sender's address",
  '/subject': 'the subject',
  '/snippet': 'the first 300 characters',
  '/messageId': 'a link to the message',
  '/attachments': "the attachments' names",
};

function fieldList(pointers: readonly string[]): RulePart[] {
  if (pointers.length === 0) return [plain('nothing of the message')];
  return pointers.flatMap((pointer, index) => {
    const name = FIELD_WORDS[pointer];
    const part = name === undefined ? value(pointer) : plain(name);
    const between = index === 0 ? [] : [plain(index === pointers.length - 1 ? ' and ' : ', ')];
    return [...between, part];
  });
}

const JEV_ROUTES: Readonly<Record<string, string>> = {
  openrouter: 'OpenRouter (openrouter.ai), which passes it to TypeSafe',
  typesafe: 'TypeSafe (api.typesafe.ai)',
};

/**
 * "What leaves this Mac": each place a match's fields go, with which fields; or that nothing leaves it. Read from the
 * activation's own preview, so it says what the approval binds, not what the editor meant.
 */
export function whatLeaves(rule: JsonObject): RulePart[][] {
  const lines: RulePart[][] = [];
  const kept = mappedFields(rule.mapping);
  const agentic = isObject(rule.agentic) ? rule.agentic : null;
  if (agentic !== null && isObject(agentic.judge) && agentic.judge.kind === 'typesafe') {
    const inputs = Array.isArray(agentic.inputs) ? agentic.inputs.filter((each) => typeof each === 'string') : [];
    const route = JEV_ROUTES[String(agentic.judge.provider)] ?? 'the judge’s provider';
    lines.push([
      plain('To judge them: '),
      ...fieldList(inputs as string[]),
      plain(` of matching mail go to ${route}.`),
    ]);
  }
  for (const target of targetsIn(rule)) {
    const fields = fieldList(kept);
    switch (target.kind) {
      case 'webhook': {
        const url = isObject(target.url) ? target.url : {};
        const host =
          url.kind === 'secret' && typeof url.host === 'string'
            ? url.host
            : typeof url.value === 'string'
              ? hostOf(url.value)
              : null;
        lines.push([...fields, plain(' go to the webhook at '), value(host ?? 'its address'), plain('.')]);
        break;
      }
      case 'sse':
        lines.push([...fields, plain(' go to the apps that subscribe to the live stream.')]);
        break;
      case 'linear': {
        const linear = linearView(target);
        lines.push([
          plain('An issue is added in Linear (api.linear.app), team '),
          value(linear?.teamKey || linear?.teamId || 'its team'),
          plain(', with '),
          ...fields,
          plain('.'),
        ]);
        break;
      }
      case 'session': {
        const session = sessionView(target);
        if (session === null) break;
        if (session.windowOnly) {
          lines.push([
            ...fields,
            plain(' wake the agent window bound to lane '),
            authored(session.where),
            plain(', which reads them.'),
          ]);
          break;
        }
        const who = session.provider === 'codex' ? 'a Codex session' : 'a Claude Code session';
        lines.push([
          ...fields,
          plain(` and the context it lists go to ${who} `),
          ...(session.findBy === 'lane'
            ? [plain('bound to lane '), authored(session.where)]
            : [plain('in '), authored(session.where)]),
          plain(', which can act'),
          ...(session.mode === null
            ? [plain(' as claude-stream lets it by default.')]
            : [plain(' in its mode '), value(session.mode), plain('.')]),
        ]);
        for (const part of session.context ?? []) {
          if (part.kind === 'generate')
            lines.push([
              ...fieldList(part.from),
              plain(' go to '),
              value(part.provider || 'a model'),
              plain(' to write: '),
              authored(part.instruction),
            ]);
          if (part.kind === 'file')
            lines.push([plain('The file '), authored(part.path), plain(' goes to the session.')]);
        }
        break;
      }
      default:
        break;
    }
  }
  return lines.length === 0 ? [[plain('Nothing leaves this Mac.')]] : lines;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
