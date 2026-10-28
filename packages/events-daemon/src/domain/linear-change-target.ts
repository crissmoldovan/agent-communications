import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentcomms/core';
import { getPointer, type JsonValue } from '@agentcomms/events';
import { EventDomainError } from './lifecycle.ts';
import {
  escapeMarkdown,
  isLinearId,
  LINEAR_DESCRIPTION_TEMPLATE_MAX,
  LINEAR_LABELS_MAX,
  LINEAR_TEMPLATE_SLOTS_MAX,
  type LinearAssignee,
  type LinearLabel,
  type LinearTemplate,
  linearTemplateSlots,
  type MappedFieldOrigin,
  outsideBlock,
  type SlotAuthor,
  slotOrigin,
  slotPointer,
} from './linear-target.ts';

/*
 * The Linear change target (workflows design §4.2, §6.7, W15): inside a workflow's flow, a deliver step changes the
 * issue an earlier step of the same run created — a comment, a state, labels added or removed, an assignee — and never
 * an issue a message names. The target fixes everything the change does, so the approval covers it; which issue is the
 * deliver step's `to.issue`, the create step the flow names. It is valid only inside a flow, which activation checks.
 *
 * The comment is text with `{{field}}` slots, as a Linear target's description is: a mapped field, a step's closed
 * output (`{{steps.issue.identifier}}`), or — here only — a session's summary (`{{steps.<wait>.summary}}`), which an
 * agent wrote and the comment quotes as outside text. Which slots it may name is the flow's to check, since only the
 * flow knows its steps.
 */

/** The state types a change may set: a started, a completed or a cancelled state of the team's. */
export const LINEAR_CHANGE_STATE_TYPES: readonly ['started', 'completed', 'canceled'] = Object.freeze([
  'started',
  'completed',
  'canceled',
] as const);
export type LinearChangeStateType = (typeof LINEAR_CHANGE_STATE_TYPES)[number];

export interface LinearChangeTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'linear-change';
  readonly team: { readonly id: string; readonly key: string };
  /** A comment on the issue: text with slots, as a description's. */
  readonly comment?: LinearTemplate;
  /** The state the issue moves to, by its id in the team, as activation checks against Linear. */
  readonly state?: { readonly id: string; readonly name: string; readonly type: LinearChangeStateType };
  /** Labels added and removed, each list sorted by id; no label in both. */
  readonly labels?: { readonly add: readonly LinearLabel[]; readonly remove: readonly LinearLabel[] };
  /** Who the issue is assigned to from now: the key's own user, one user by id, or nobody (null). */
  readonly assignee?: LinearAssignee;
}

const TEAM_KEY = /^[A-Za-z0-9_]{1,32}$/u;
const FIELD_SEGMENT = '[A-Za-z0-9_-]+';
const SLOT = new RegExp(`\\{\\{\\s*(${FIELD_SEGMENT}(?:\\.${FIELD_SEGMENT})*)\\s*\\}\\}`, 'gu');
// Control characters other than a newline and a tab, and the bidirectional formatting characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters it refuses.
const UNSHOWN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu;

function fail(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} has no ${key} field`);
}

function linearId(value: unknown, name: string): string {
  if (!isLinearId(value)) return fail(`${name} is a Linear id, a lowercase UUID`);
  return value;
}

function shownName(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 80 ||
    value.replace(UNSHOWN, '') !== value ||
    /[\r\n]/u.test(value)
  )
    return fail(`${name} is one line of 1 to 80 characters`);
  return value;
}

function canonicalComment(value: unknown): LinearTemplate {
  if (!isRecord(value)) return fail("a Linear change's comment is { text }");
  exactKeys(value, ['text'], "a Linear change's comment");
  const text = value.text;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > LINEAR_DESCRIPTION_TEMPLATE_MAX)
    return fail(`a Linear change's comment is text of 1 to ${LINEAR_DESCRIPTION_TEMPLATE_MAX} characters`);
  if (text.replace(UNSHOWN, '') !== text) fail("a Linear change's comment has a control character");
  const rest = text.replace(SLOT, '');
  if (rest.includes('{{') || rest.includes('}}'))
    fail("a Linear change's comment has a malformed slot; a slot names one field or one step's output");
  const template = { text };
  if (linearTemplateSlots(template).length > LINEAR_TEMPLATE_SLOTS_MAX)
    fail(`a Linear change's comment names at most ${LINEAR_TEMPLATE_SLOTS_MAX} slots`);
  return template;
}

function canonicalLabelList(value: unknown, name: string): readonly LinearLabel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LINEAR_LABELS_MAX)
    return fail(`${name} is a list of at most ${LINEAR_LABELS_MAX} labels`);
  const labels = value.map((entry) => {
    if (!isRecord(entry)) return fail('a Linear label is { id, name }');
    exactKeys(entry, ['id', 'name'], 'a Linear label');
    return { id: linearId(entry.id, "a Linear label's id"), name: shownName(entry.name, "a Linear label's name") };
  });
  const sorted = [...labels].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (new Set(sorted.map((label) => label.id)).size !== sorted.length) fail(`${name} names each label once`);
  return sorted;
}

function canonicalAssignee(value: unknown): LinearAssignee {
  if (value === null) return null;
  if (value === 'me') return 'me';
  if (!isRecord(value)) return fail('a Linear assignee is "me", { id } or null');
  exactKeys(value, ['id'], 'a Linear assignee');
  return { id: linearId(value.id, "a Linear assignee's id") };
}

/**
 * The canonical immutable Linear change target: exact keys, labels sorted by id, and only the changes it names — at
 * least one of a comment, a state, labels and an assignee.
 */
export function canonicalLinearChangeTarget(value: Record<string, unknown>): LinearChangeTargetDocument {
  exactKeys(
    value,
    ['targetId', 'version', 'kind', 'team', 'comment', 'state', 'labels', 'assignee'],
    'a Linear change target',
  );
  if (value.kind !== 'linear-change') return fail('a Linear change target document has kind linear-change');
  if (typeof value.targetId !== 'string' || value.targetId.length === 0)
    return fail('a target id is a non-empty string');
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1)
    return fail('a target version is a positive safe integer');
  if (!isRecord(value.team)) return fail("a Linear change target's team is { id, key }");
  exactKeys(value.team, ['id', 'key'], "a Linear change target's team");
  const key = value.team.key;
  if (typeof key !== 'string' || !TEAM_KEY.test(key)) return fail("a Linear team's key is 1 to 32 letters and digits");
  let state: LinearChangeTargetDocument['state'];
  if (value.state !== undefined) {
    if (!isRecord(value.state)) return fail("a Linear change's state is { id, name, type }");
    exactKeys(value.state, ['id', 'name', 'type'], "a Linear change's state");
    const type = value.state.type;
    if (!(LINEAR_CHANGE_STATE_TYPES as readonly unknown[]).includes(type))
      return fail(`a Linear change's state type is ${LINEAR_CHANGE_STATE_TYPES.join(', ')}`);
    state = {
      id: linearId(value.state.id, "a Linear state's id"),
      name: shownName(value.state.name, "a Linear state's name"),
      type: type as LinearChangeStateType,
    };
  }
  let labels: LinearChangeTargetDocument['labels'];
  if (value.labels !== undefined) {
    if (!isRecord(value.labels)) return fail("a Linear change's labels are { add, remove }");
    exactKeys(value.labels, ['add', 'remove'], "a Linear change's labels");
    const add = canonicalLabelList(value.labels.add, "a Linear change's labels to add");
    const remove = canonicalLabelList(value.labels.remove, "a Linear change's labels to remove");
    if (add.length === 0 && remove.length === 0) return fail("a Linear change's labels add or remove at least one");
    if (add.some((label) => remove.some((other) => other.id === label.id)))
      return fail('a Linear change neither adds and removes the same label');
    labels = { add, remove };
  }
  const comment = value.comment === undefined ? undefined : canonicalComment(value.comment);
  const assignee = Object.hasOwn(value, 'assignee') ? canonicalAssignee(value.assignee) : undefined;
  if (comment === undefined && state === undefined && labels === undefined && !Object.hasOwn(value, 'assignee'))
    return fail('a Linear change comments, sets a state, changes labels or assigns the issue: at least one');
  return {
    targetId: value.targetId,
    version: value.version as number,
    kind: 'linear-change',
    team: { id: linearId(value.team.id, "a Linear team's id"), key },
    ...(comment === undefined ? {} : { comment }),
    ...(state === undefined ? {} : { state }),
    ...(labels === undefined ? {} : { labels }),
    ...(Object.hasOwn(value, 'assignee') ? { assignee: assignee as LinearAssignee } : {}),
  };
}

/** The slots a Linear change's comment names, in order, each once. */
export function linearChangeSlots(target: LinearChangeTargetDocument): readonly string[] {
  return target.comment === undefined ? [] : linearTemplateSlots(target.comment);
}

/** What the approval preview says a Linear change does, in plain words: on which issue, and every change. */
export function linearChangeTargetDisclosure(target: LinearChangeTargetDocument): string {
  const changes: string[] = [];
  if (target.comment !== undefined) {
    const slots = linearChangeSlots(target);
    changes.push(
      `comments on it, filled from ${slots.length === 0 ? 'no field' : slots.join(', ')}, each value quoted as text, never as links or mentions`,
    );
  }
  if (target.state !== undefined)
    changes.push(`moves it to the state ${JSON.stringify(target.state.name)} (${target.state.type})`);
  if (target.labels !== undefined) {
    const names = (labels: readonly LinearLabel[]) => labels.map((label) => JSON.stringify(label.name)).join(', ');
    if (target.labels.add.length > 0) changes.push(`adds the labels ${names(target.labels.add)}`);
    if (target.labels.remove.length > 0) changes.push(`removes the labels ${names(target.labels.remove)}`);
  }
  if (target.assignee !== undefined)
    changes.push(
      target.assignee === null
        ? 'assigns it to nobody'
        : target.assignee === 'me'
          ? "assigns it to the Linear key's own user"
          : `assigns it to the Linear user ${target.assignee.id}`,
    );
  return `Linear change ${target.targetId}@${target.version}: on the issue this run created in team ${target.team.key} (${target.team.id}), and no other, through Linear's API (api.linear.app), with your Linear key, it ${changes.join('; ')}.`;
}

/**
 * The comment's own id, chosen from the delivery's: every try of one delivery makes, or finds, the same comment, so a
 * retry after a lost answer cannot add a second one. A UUID in v4 form, as Linear's `commentCreate` takes it (its
 * `CommentCreateInput.id`, Linear's GraphQL schema, read 2026-10-27).
 */
export function linearCommentId(deliveryId: string): string {
  const bytes = createHash('sha256').update(`agentcomms-linear-comment:v1:${deliveryId}`).digest().subarray(0, 16);
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

/**
 * The comment a Linear change adds (workflows design §6.7), rendered once from the approved target, the run's mapped
 * data, its steps' closed outputs and its sealed summaries: the template's own words as the person approved them, and
 * each slot's value a quoted code block labelled by who wrote it — the sender, the workflow's mapping, Agent Comms (the
 * run's own values), or an agent (a session's summary, "Written by an agent, not checked") — so no slot can mention a
 * person, link an issue or format anything. It ends with the workflow and delivery that added it. Null when the target
 * comments not.
 */
export function renderLinearComment(input: {
  readonly target: LinearChangeTargetDocument;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly deliveryId: string;
  readonly data: JsonValue;
  readonly fields: ReadonlyMap<string, MappedFieldOrigin>;
  /** A slot naming the run's own values (`{{steps.issue.identifier}}`, `{{run}}`): its text; undefined otherwise. */
  readonly closed?: ((slot: string) => string | undefined) | undefined;
  /** A slot naming a session's summary (`{{steps.<wait>.summary}}`): its text; undefined otherwise. */
  readonly summary?: ((slot: string) => string | undefined) | undefined;
}): string | null {
  if (input.target.comment === undefined) return null;
  const lookup = (name: string): { readonly text: string; readonly author: SlotAuthor } => {
    const summary = input.summary?.(name);
    if (summary !== undefined) return { text: summary, author: 'agent' };
    const closed = input.closed?.(name);
    if (closed !== undefined) return { text: closed, author: 'agent-comms' };
    const found = getPointer(input.data, slotPointer(name));
    return {
      text: valueText(found.found ? found.value : undefined),
      author: slotOrigin(input.fields, name) === 'constant' ? 'rule' : 'sender',
    };
  };
  const body = input.target.comment.text.replace(SLOT, (_slot, name: string) => {
    const { text, author } = lookup(name);
    return `\n\n${outsideBlock(name, text, author)}\n\n`;
  });
  const footer = `_Added by Agent Comms: workflow ${escapeMarkdown(input.ruleId)}, version ${input.ruleVersion}; delivery ${escapeMarkdown(input.deliveryId)}._`;
  return `${body.replace(/\n{3,}/gu, '\n\n').trim()}${body.trim().length === 0 ? '' : '\n\n'}${footer}`;
}
