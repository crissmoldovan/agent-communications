import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentcomms/core';
import { type CompiledMapping, getPointer, type JsonValue } from '@agentcomms/events';
import { EventDomainError } from './lifecycle.ts';

/*
 * The Linear target (0.33.0 design §3.4): a match adds one issue to a team in the person's Linear workspace, with their
 * Linear API key (`provider key set linear`). The document says which team, which labels, who it is assigned to, and
 * how the title and the description are written: a text with `{{field}}` slots, each naming one of the rule's mapped
 * fields, checked when the rule is activated. Nothing else from the message reaches Linear.
 *
 * Sender-written values never reach Linear's Markdown as Markdown. Linear makes a mention from a resource's plain URL
 * (a profile URL notifies that person and subscribes them; an issue URL relates that issue), links bare URLs and
 * pasted issue ids, and renders the description as Markdown (linear.app/developers/graphql and linear.app/docs/editor,
 * read 2026-10-26). So in the description each value from the message is a block quote labelled as from outside, the
 * text inside a fenced code block, where Linear's Markdown makes no link, mention, image or formatting; and in the
 * title, which is plain text, it is flattened to one line.
 */

/** Linear's GraphQL endpoint: the one URL a Linear target or `integration show linear` reaches. */
export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** The most a title template, and the issue title it makes, may be. */
export const LINEAR_TITLE_MAX = 255;
/** The most a description template may be. */
export const LINEAR_DESCRIPTION_TEMPLATE_MAX = 10_000;
/** The most labels one target may set. */
export const LINEAR_LABELS_MAX = 20;
/** The most field slots one template may name. */
export const LINEAR_TEMPLATE_SLOTS_MAX = 20;
/** The most of one value from the message an issue's description shows. */
export const LINEAR_OUTSIDE_VALUE_MAX = 2_000;

/** A title or description: text with `{{field}}` slots. A model-written one (`{ generate }`) comes later. */
export interface LinearTemplate {
  readonly text: string;
}

/** Who an issue is assigned to: the key's own user, one user by id, or nobody. */
export type LinearAssignee = 'me' | { readonly id: string } | null;

export interface LinearLabel {
  readonly id: string;
  readonly name: string;
}

export interface LinearTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'linear';
  readonly team: { readonly id: string; readonly key: string };
  readonly title: LinearTemplate;
  readonly description: LinearTemplate;
  /** Sorted by id, each once. */
  readonly labels: readonly LinearLabel[];
  readonly assignee: LinearAssignee;
}

const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TEAM_KEY = /^[A-Za-z0-9_]{1,32}$/u;
const FIELD_SEGMENT = '[A-Za-z0-9_-]+';
const SLOT = new RegExp(`\\{\\{\\s*(${FIELD_SEGMENT}(?:\\.${FIELD_SEGMENT})*)\\s*\\}\\}`, 'gu');
// Control characters other than a newline and a tab, and the bidirectional formatting characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters it removes.
const UNSHOWN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function fail(message: string, code: EventDomainError['code'] = 'VERSION_DOCUMENT_INVALID'): never {
  throw new EventDomainError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a Linear id: a lowercase UUID, as Linear's API gives one. */
export function isLinearId(value: unknown): value is string {
  return typeof value === 'string' && LINEAR_ID.test(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} has no ${key} field`);
}

function linearId(value: unknown, name: string): string {
  if (!isLinearId(value)) return fail(`${name} is a Linear id, a lowercase UUID`);
  return value;
}

/** The field names a template's slots give, in order, each once. */
export function linearTemplateSlots(template: LinearTemplate): readonly string[] {
  return [...new Set([...template.text.matchAll(SLOT)].map((match) => match[1] as string))];
}

/** A slot's field name as the JSON Pointer into the rule's mapped data: `from.address` is `/from/address`. */
export function slotPointer(name: string): string {
  return `/${name.split('.').join('/')}`;
}

function canonicalTemplate(value: unknown, name: 'title' | 'description'): LinearTemplate {
  if (!isRecord(value)) return fail(`a Linear target's ${name} is { text }`);
  if (Object.hasOwn(value, 'generate'))
    fail(
      `a model-written ${name} arrives with the session target's context; for now write the ${name} as text with {{field}} slots`,
      'TEMPLATE_GENERATE_NOT_YET',
    );
  exactKeys(value, ['text'], `a Linear target's ${name}`);
  const text = value.text;
  const max = name === 'title' ? LINEAR_TITLE_MAX : LINEAR_DESCRIPTION_TEMPLATE_MAX;
  if (typeof text !== 'string' || (name === 'title' && text.trim().length === 0) || text.length > max)
    return fail(`a Linear target's ${name} is text of ${name === 'title' ? '1' : '0'} to ${max} characters`);
  if (name === 'title' && /[\r\n]/u.test(text)) fail("a Linear target's title is one line");
  if (text.replace(UNSHOWN, '') !== text) fail(`a Linear target's ${name} has a control character`);
  // Every `{{` opens a slot and every `}}` closes one: a malformed slot is refused rather than sent as written.
  const rest = text.replace(SLOT, '');
  if (rest.includes('{{') || rest.includes('}}'))
    fail(`a Linear target's ${name} has a malformed slot; a slot names one mapped field, such as {{subject}}`);
  const template = { text };
  if (linearTemplateSlots(template).length > LINEAR_TEMPLATE_SLOTS_MAX)
    fail(`a Linear target's ${name} names at most ${LINEAR_TEMPLATE_SLOTS_MAX} fields`);
  return template;
}

function canonicalLabels(value: unknown): readonly LinearLabel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LINEAR_LABELS_MAX)
    return fail(`a Linear target's labels are a list of at most ${LINEAR_LABELS_MAX}`);
  const labels = value.map((entry) => {
    if (!isRecord(entry)) return fail('a Linear label is { id, name }');
    exactKeys(entry, ['id', 'name'], 'a Linear label');
    const name = entry.name;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80 || name.replace(UNSHOWN, '') !== name)
      return fail("a Linear label's name is 1 to 80 characters");
    return { id: linearId(entry.id, "a Linear label's id"), name };
  });
  const sorted = [...labels].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (new Set(sorted.map((label) => label.id)).size !== sorted.length) fail('a Linear target names each label once');
  return sorted;
}

function canonicalAssignee(value: unknown): LinearAssignee {
  if (value === undefined || value === null) return null;
  if (value === 'me') return 'me';
  if (!isRecord(value)) return fail('a Linear assignee is "me", { id } or null');
  exactKeys(value, ['id'], 'a Linear assignee');
  return { id: linearId(value.id, "a Linear assignee's id") };
}

/** The canonical immutable Linear target: exact keys, labels sorted by id, and no labels and nobody written out. */
export function canonicalLinearTarget(value: Record<string, unknown>): LinearTargetDocument {
  exactKeys(
    value,
    ['targetId', 'version', 'kind', 'team', 'title', 'description', 'labels', 'assignee'],
    'a Linear target',
  );
  if (value.kind !== 'linear') return fail('a Linear target document has kind linear');
  if (typeof value.targetId !== 'string' || value.targetId.length === 0)
    return fail('a target id is a non-empty string');
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1)
    return fail('a target version is a positive safe integer');
  if (!isRecord(value.team)) return fail("a Linear target's team is { id, key }");
  exactKeys(value.team, ['id', 'key'], "a Linear target's team");
  const key = value.team.key;
  if (typeof key !== 'string' || !TEAM_KEY.test(key)) return fail("a Linear team's key is 1 to 32 letters and digits");
  return {
    targetId: value.targetId,
    version: value.version as number,
    kind: 'linear',
    team: { id: linearId(value.team.id, "a Linear team's id"), key },
    title: canonicalTemplate(value.title, 'title'),
    description: canonicalTemplate(value.description ?? { text: '' }, 'description'),
    labels: canonicalLabels(value.labels),
    assignee: canonicalAssignee(value.assignee),
  };
}

/** Where one mapped field comes from: the message (`source`) or the rule's own words (`constant`). */
export type MappedFieldOrigin = 'source' | 'constant';

/**
 * The fields a slot may name: every leaf of the rule's mapping, by its dotted name, with where its value comes from. A
 * leaf below a key a dotted name cannot say (a dot, a space) has none, and so cannot be named.
 */
export function mappedFields(mapping: CompiledMapping): ReadonlyMap<string, MappedFieldOrigin> {
  const fields = new Map<string, MappedFieldOrigin>();
  const segment = new RegExp(`^${FIELD_SEGMENT}$`, 'u');
  const walk = (node: CompiledMapping['root'], path: readonly string[]): void => {
    if (node.kind === 'object') {
      for (const property of node.properties)
        if (segment.test(property.key)) walk(property.node, [...path, property.key]);
      return;
    }
    if (path.length === 0 || node.kind === 'array') return;
    fields.set(path.join('.'), node.kind === 'reference' ? 'source' : 'constant');
  };
  walk(mapping.root, []);
  return fields;
}

/** At activation: every slot of a Linear target names one of the rule's mapped fields, or the rule is refused. */
export function assertLinearSlotsMapped(target: LinearTargetDocument, mapping: CompiledMapping): void {
  const fields = mappedFields(mapping);
  for (const part of ['title', 'description'] as const) {
    for (const slot of linearTemplateSlots(target[part])) {
      if (fields.has(slot)) continue;
      const known = [...fields.keys()];
      fail(
        `Linear target ${target.targetId}'s ${part} names {{${slot}}}, which the rule does not keep; ${
          known.length === 0 ? 'the rule keeps no field' : `it keeps ${known.join(', ')}`
        }`,
        'TEMPLATE_FIELD_NOT_MAPPED',
      );
    }
  }
}

/**
 * The issue's own id, chosen from the delivery's id: every try of one delivery creates, or finds, the same issue, so a
 * retry after a lost answer cannot add a second one. A UUID in v4 form, as Linear's `issueCreate` takes it.
 */
export function linearIssueId(deliveryId: string): string {
  const bytes = createHash('sha256').update(`agentcomms-linear-issue:v1:${deliveryId}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A value as text: a string as it is, anything else as JSON; nothing for a field the message did not have. */
function valueText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : canonicalJson(value);
}

/** Markdown's backslash escape for every ASCII punctuation character it could read as markup. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~:@&=]/gu, '\\$&');
}

/**
 * A value from the message, as the description shows it: a block quote labelled as from outside, holding the text in a
 * fenced code block longer than any run of backticks in it. Linear's Markdown makes no link, mention or formatting
 * inside it, so a URL, an `@name`, an issue id or markup the sender wrote is shown, never followed.
 */
export function outsideBlock(field: string, value: string): string {
  let text = value.replace(/\r\n?|[\u2028\u2029]/gu, '\n').replace(UNSHOWN, '');
  const shortened = text.length > LINEAR_OUTSIDE_VALUE_MAX;
  if (shortened) text = text.slice(0, LINEAR_OUTSIDE_VALUE_MAX);
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const lines = text.split('\n');
  return [
    `> **From outside: written by the sender, not checked** (\`${field}\`)`,
    '>',
    `> ${fence}text`,
    ...lines.map((line) => (line.length === 0 ? '>' : `> ${line}`)),
    `> ${fence}`,
    ...(shortened ? ['>', `> _Shortened to its first ${LINEAR_OUTSIDE_VALUE_MAX} characters._`] : []),
  ].join('\n');
}

/** A value in the title: one line, without control characters. The title is plain text in Linear, never Markdown. */
function titleText(value: string): string {
  return value.replace(UNSHOWN, ' ').replace(/\s+/gu, ' ');
}

export interface RenderedLinearIssue {
  readonly title: string;
  readonly description: string;
}

/**
 * The issue a match makes, from the approved target and the rule's mapped data: the title and description templates
 * with each slot filled. A value from the message is flattened in the title and quoted as from outside in the
 * description; a constant the rule maps is the person's own text and is written as it is. The description ends with a
 * line saying which rule and delivery added it.
 */
export function renderLinearIssue(input: {
  readonly target: LinearTargetDocument;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly deliveryId: string;
  readonly data: JsonValue;
  readonly fields: ReadonlyMap<string, MappedFieldOrigin>;
}): RenderedLinearIssue {
  const lookup = (name: string): { readonly text: string; readonly outside: boolean } => {
    const found = getPointer(input.data, slotPointer(name));
    return {
      text: valueText(found.found ? found.value : undefined),
      // A field the activation check did not see is treated as the message's: outside, never the person's words.
      outside: input.fields.get(name) !== 'constant',
    };
  };
  const filledTitle = input.target.title.text.replace(SLOT, (_slot, name: string) => {
    const { text, outside } = lookup(name);
    return outside ? titleText(text) : text;
  });
  let title = titleText(filledTitle).trim();
  if (title.length > LINEAR_TITLE_MAX) title = `${title.slice(0, LINEAR_TITLE_MAX - 1).trimEnd()}…`;
  if (title.length === 0) title = `Agent Comms: rule ${input.ruleId}`.slice(0, LINEAR_TITLE_MAX);
  const body = input.target.description.text.replace(SLOT, (_slot, name: string) => {
    const { text, outside } = lookup(name);
    return outside ? `\n\n${outsideBlock(name, text)}\n\n` : text;
  });
  const footer = `_Added by Agent Comms: rule ${escapeMarkdown(input.ruleId)}, version ${input.ruleVersion}; delivery ${escapeMarkdown(input.deliveryId)}._`;
  const description = `${body.replace(/\n{3,}/gu, '\n\n').trim()}${body.trim().length === 0 ? '' : '\n\n'}${footer}`;
  return { title, description };
}

/** What the approval preview says a Linear target does, in plain words: where, how it is labelled, and from what. */
export function linearTargetDisclosure(target: LinearTargetDocument): string {
  const labels =
    target.labels.length === 0
      ? 'no labels'
      : `${target.labels.length === 1 ? 'label' : 'labels'} ${target.labels.map((label) => JSON.stringify(label.name)).join(', ')}`;
  const assignee =
    target.assignee === null
      ? 'assigned to nobody'
      : target.assignee === 'me'
        ? "assigned to the Linear key's own user"
        : `assigned to the Linear user ${target.assignee.id}`;
  const from = (template: LinearTemplate) => {
    const slots = linearTemplateSlots(template);
    return slots.length === 0 ? 'no field' : slots.join(', ');
  };
  return `Linear issue ${target.targetId}@${target.version}: adds an issue in team ${target.team.key} (${target.team.id}) through Linear's API (api.linear.app), with your Linear key; ${labels}; ${assignee}. Its title is filled from ${from(target.title)}; its description from ${from(target.description)}, each value from the message quoted as written by the sender.`;
}
