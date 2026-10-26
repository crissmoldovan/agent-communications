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
import { contextPart, linearView, SESSION_MODE_WORDS, sessionView, templateOf } from './targets.ts';

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

/** A message field as the review names it once a mapped field is traced to it. */
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  '/from': "the message's sender",
  '/from/name': "the sender's name",
  '/from/address': "the sender's address",
  '/subject': "the message's subject",
  '/snippet': "the message's first 300 characters",
  '/messageId': 'a link to the message',
  '/attachments': "the message's attachments' names",
};

/**
 * What a pointer into a rule's mapped data names, traced through the mapping as the event service reads it
 * (`mappingProduces`): a field of the message a `$path` reference copies (with any path below it); the rule's own
 * constant; a part of the mapping that holds both, as written; or nothing the mapping writes.
 */
export type MappedValue =
  | { kind: 'source'; pointer: string }
  | { kind: 'constant'; value: unknown }
  | { kind: 'template'; value: unknown }
  | { kind: 'none' };

const isReference = (node: unknown): node is { $path: string } => isObject(node) && typeof node.$path === 'string';

function holdsReference(node: unknown): boolean {
  if (isReference(node)) return true;
  if (Array.isArray(node)) return node.some(holdsReference);
  return isObject(node) && Object.values(node).some(holdsReference);
}

export function resolveMapped(mapping: unknown, pointer: string): MappedValue {
  if (!pointer.startsWith('/')) return { kind: 'none' };
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  let at: unknown = mapping;
  for (const [index, token] of tokens.entries()) {
    if (isReference(at)) {
      const below = tokens
        .slice(index)
        .map((each) => each.replaceAll('~', '~0').replaceAll('/', '~1'))
        .join('/');
      return { kind: 'source', pointer: `${at.$path}/${below}` };
    }
    if (Array.isArray(at)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token) || Number(token) >= at.length) return { kind: 'none' };
      at = at[Number(token)];
    } else if (isObject(at)) {
      if (!Object.hasOwn(at, token)) return { kind: 'none' };
      at = at[token];
    } else return { kind: 'none' };
  }
  if (isReference(at)) return { kind: 'source', pointer: at.$path };
  return holdsReference(at) ? { kind: 'template', value: at } : { kind: 'constant', value: at };
}

/**
 * One mapped field, said by where its value comes from: "the message's subject" for a field the message gives; for the
 * rule's own constant, its text, boxed as the author's — what the mapping's key is called never stands in for it.
 */
function mappedRef(mapping: unknown, pointer: string): RulePart[] {
  const found = resolveMapped(mapping, pointer);
  switch (found.kind) {
    case 'source': {
      const words = SOURCE_WORDS[found.pointer];
      return words === undefined ? [plain("the message's "), authored(found.pointer)] : [plain(words)];
    }
    case 'constant':
      return [plain('the rule’s own text '), authored(written(found.value))];
    case 'template':
      return [plain('the rule’s mapping '), authored(written(found.value))];
    case 'none':
      return [authored(pointer), plain(', which the rule does not map')];
  }
}

function mappedList(mapping: unknown, pointers: readonly string[]): RulePart[] {
  if (pointers.length === 0) return [plain('nothing of the message')];
  return pointers.flatMap((pointer, index) => [
    ...(index === 0 ? [] : [plain(index === pointers.length - 1 ? ' and ' : '; ')]),
    ...mappedRef(mapping, pointer),
  ]);
}

/** Every constant a mapping writes, as its author wrote it, in the mapping's order: each goes wherever the whole record does. */
function constantsOf(node: unknown): unknown[] {
  if (isReference(node)) return [];
  if (Array.isArray(node)) return node.flatMap(constantsOf);
  if (isObject(node)) return Object.values(node).flatMap(constantsOf);
  return [node];
}

/** The whole mapped record, as a webhook or the live stream gets it: the message's fields and the rule's own text. */
function wholeRecord(mapping: unknown, fields: RulePart[]): RulePart[] {
  const constants = constantsOf(isObject(mapping) ? mapping : {});
  if (constants.length === 0) return fields;
  return [
    ...fields,
    plain(constants.length === 1 ? ', with the rule’s own text ' : ', with the rule’s own texts '),
    ...constants.flatMap((constant, index) => [...(index === 0 ? [] : [plain(', ')]), authored(written(constant))]),
    plain(','),
  ];
}

/** A Linear slot's mapped field, as the event service reads it (`slotPointer`): `from.address` is `/from/address`. */
const SLOT = /\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/gu;

const JEV_ROUTES: Readonly<Record<string, string>> = {
  openrouter: 'OpenRouter (openrouter.ai), which passes it to TypeSafe',
  typesafe: 'TypeSafe (api.typesafe.ai)',
};

/**
 * "What leaves this Mac": each place a match's fields go, with which fields; or that nothing leaves it. Read from the
 * activation's own preview, so it says what the approval binds, not what the editor meant. As the terminal's preview
 * does (`renderB3ApprovalPreviewV1`), it says all a session target is given — whether one is started, what happens
 * while it is busy, every context part and the instruction it is told last — and all a Linear issue carries: its team,
 * title and description, labels and assignee. Whatever an author wrote is author text; a part the app cannot read is
 * shown as written, never left out.
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
      case 'dry-run':
      case 'queue':
        break;
      case 'webhook': {
        const url = isObject(target.url) ? target.url : {};
        const host =
          url.kind === 'secret' && typeof url.host === 'string'
            ? url.host
            : typeof url.value === 'string'
              ? hostOf(url.value)
              : null;
        lines.push([
          ...wholeRecord(rule.mapping, fields),
          plain(' go to the webhook at '),
          value(host ?? 'its address'),
          plain('.'),
        ]);
        break;
      }
      case 'sse':
        lines.push([...wholeRecord(rule.mapping, fields), plain(' go to the apps that subscribe to the live stream.')]);
        break;
      case 'linear':
        lines.push(...linearLines(target, rule.mapping));
        break;
      case 'session':
        lines.push(...sessionLines(target, fields, rule.mapping));
        break;
      default:
        lines.push([plain('A target the app cannot describe, as written: '), authored(written(target))]);
        break;
    }
  }
  return lines.length === 0 ? [[plain('Nothing leaves this Mac.')]] : lines;
}

/** A value as its author wrote it: a string itself, anything else its JSON. */
function written(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

/** The fields of a target the review has words for; any other is shown as written. */
const SESSION_FIELDS = [
  'targetId',
  'version',
  'kind',
  'find',
  'ifNone',
  'provider',
  'mode',
  'ifBusy',
  'context',
  'instruction',
];
const LINEAR_FIELDS = ['targetId', 'version', 'kind', 'team', 'title', 'description', 'labels', 'assignee'];

function otherFields(target: JsonObject, known: readonly string[]): RulePart[][] {
  const others = Object.keys(target).filter((key) => !known.includes(key));
  return others.map((key) => [plain(`It also carries ${key}, as written: `), authored(written(target[key]))]);
}

/** What a model writes for a part, asked by its author, from which fields, through which provider. */
function generated(
  mapping: unknown,
  part: { provider: string; model: string; instruction: string; from: string[] },
): RulePart[] {
  return [
    plain('what '),
    authored(part.model || 'a model'),
    plain(' writes, asked '),
    authored(part.instruction),
    plain(' — it is sent '),
    ...mappedList(mapping, part.from),
    plain(' through '),
    value(part.provider || 'its provider'),
    plain(', on your own key'),
  ];
}

function sessionLines(target: JsonObject, fields: RulePart[], mapping: unknown): RulePart[][] {
  const session = sessionView(target);
  if (session === null) return [];
  if (session.windowOnly)
    return [
      [
        ...fields,
        plain(' wake the agent window bound to lane '),
        authored(session.where),
        plain(', which reads them.'),
      ],
    ];
  const who = session.provider === 'codex' ? 'a Codex session' : 'a Claude Code session';
  const lines: RulePart[][] = [
    [
      ...fields,
      plain(` and the context below go to ${who} `),
      ...(session.findBy === 'lane'
        ? [plain('bound to lane '), authored(session.where)]
        : [plain('in '), authored(session.where)]),
      plain(`, a coding agent there, which may act: ${SESSION_MODE_WORDS[session.mode]}.`),
    ],
    [
      plain(
        session.ifNone === 'start'
          ? session.findBy === 'lane'
            ? 'If the bound window is not a session claude-stream runs, the match is a lane item in that lane.'
            : 'If there is no such session, one is started in that folder.'
          : 'If there is no such session, the match is left in the Queue.',
      ),
    ],
    [
      plain(
        session.ifBusy === 'queue'
          ? 'While the session is busy, the match waits for it, and goes when its run ends.'
          : 'While the session is busy, the match is left in the Queue.',
      ),
    ],
  ];
  const parts = Array.isArray(target.context) ? target.context : [];
  parts.forEach((raw, index) => {
    const label = plain(`Context part ${index + 1}: `);
    const part = contextPart(raw);
    if (part === null) lines.push([label, plain('as written, '), authored(written(raw))]);
    else if (part.kind === 'fields') lines.push([label, ...mappedList(mapping, part.fields), plain('.')]);
    else if (part.kind === 'text') lines.push([label, plain('the fixed text '), authored(part.text)]);
    else if (part.kind === 'file')
      lines.push([
        label,
        plain('the file '),
        authored(part.path),
        plain(', read when the match is passed on (at most 64 KB).'),
      ]);
    else lines.push([label, ...generated(mapping, part), plain('.')]);
  });
  if (session.instruction !== null) lines.push([plain('It is told last: '), authored(session.instruction)]);
  lines.push(...otherFields(target, SESSION_FIELDS));
  return lines;
}

/**
 * A Linear title or description, as its author wrote it, and what fills each slot. A constant is the rule's own text,
 * which the issue's description takes as it is — Markdown, so its links and mentions work there.
 */
function templateLine(name: string, raw: unknown, mapping: unknown, markdown: boolean): RulePart[] {
  const template = templateOf(raw);
  if (template === null) return [plain(`${name}, as written: `), authored(written(raw))];
  if (template.kind !== 'text') return [plain(`${name} is `), ...generated(mapping, template), plain('.')];
  const slots = [
    ...new Set([...template.text.matchAll(SLOT)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))),
  ];
  return [
    plain(`${name}: `),
    authored(template.text),
    ...slots.flatMap((slot, index) => {
      const ref = mappedRef(mapping, `/${slot.split('.').join('/')}`);
      const constant = resolveMapped(mapping, `/${slot.split('.').join('/')}`).kind !== 'source';
      return [
        plain(index === 0 ? ', where ' : '; '),
        authored(`{{${slot}}}`),
        plain(' is '),
        ...ref,
        ...(constant && markdown ? [plain(', written into the issue as it is, as Markdown')] : []),
      ];
    }),
  ];
}

function linearLines(target: JsonObject, mapping: unknown): RulePart[][] {
  const linear = linearView(target);
  if (linear === null) return [];
  const lines: RulePart[][] = [
    [
      plain('An issue is added in Linear (api.linear.app), with your Linear key, team '),
      value(linear.teamKey || linear.teamId || 'its team'),
      plain('.'),
    ],
    templateLine('Its title', target.title, mapping, false),
    templateLine('Its description', target.description ?? { text: '' }, mapping, true),
  ];
  const labels = linear.labels;
  if (labels === null) lines.push([plain('Its labels, as written: '), authored(written(target.labels))]);
  else if (labels.length === 0) lines.push([plain('It has no labels.')]);
  else
    lines.push([
      plain(labels.length === 1 ? 'Its label: ' : 'Its labels: '),
      ...labels.flatMap((label, index) => [...(index === 0 ? [] : [plain(', ')]), authored(label.name)]),
    ]);
  const assignee = target.assignee;
  if (assignee === null) lines.push([plain('It is assigned to nobody.')]);
  else if (assignee === 'me') lines.push([plain("It is assigned to the Linear key's own user.")]);
  else if (isObject(assignee) && typeof assignee.id === 'string' && Object.keys(assignee).length === 1)
    lines.push([plain('It is assigned to the Linear user '), authored(assignee.id), plain('.')]);
  else lines.push([plain('Its assignee, as written: '), authored(written(assignee))]);
  lines.push(...otherFields(target, LINEAR_FIELDS));
  return lines;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
