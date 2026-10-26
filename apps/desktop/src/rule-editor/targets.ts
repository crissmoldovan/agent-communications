/**
 * The two targets 0.33.0 adds, as the editor reads and writes them (design 2026-10-26-rules-that-act-0330 §3.4–§3.6):
 * an agent session and a Linear issue. Their documents are the spec's:
 *
 *   { kind: 'session', find: { folder } | { lane }, ifNone: 'start' | 'queue-only', provider: 'claude' | 'codex',
 *     mode: 'manual' | 'acceptEdits' | 'plan', ifBusy: 'queue' | 'queue-only', context: ContextPart[], instruction? }
 *   { kind: 'linear', team: { id, key }, title: { text }, description: { text }, labels: [{ id, name }],
 *     assignee: 'me' | { id } | null }
 *
 * as the event service's builders wrote them (`session-target.ts`, `linear-target.ts`). A context part is `{ text }`,
 * `{ fields: [pointer] }`, `{ generate: { provider, model, instruction, from } }` or `{ file: path }`; a template is
 * `{ text }` with `{{field}}` slots (a model-written one comes later). Anything else of theirs is edited as text, and
 * kept as it was.
 */
import { copyOf, isObject, type Json, type JsonObject } from './model.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const pointers = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];

/** One part of what a session is given. */
export type ContextView =
  | { kind: 'fields'; fields: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'generate'; provider: string; model: string; instruction: string; from: string[] }
  | { kind: 'file'; path: string };

/** One context part as the editor reads it; null for a part it has no control for. */
export function contextPart(part: unknown): ContextView | null {
  if (!isObject(part)) return null;
  const keys = Object.keys(part);
  if (keys.length !== 1) return null;
  if (Array.isArray(part.fields)) return { kind: 'fields', fields: pointers(part.fields) };
  if (typeof part.text === 'string') return { kind: 'text', text: part.text };
  if (typeof part.file === 'string') return { kind: 'file', path: part.file };
  if (isObject(part.generate)) {
    const generate = part.generate;
    return {
      kind: 'generate',
      provider: text(generate.provider),
      model: text(generate.model),
      instruction: text(generate.instruction),
      from: pointers(generate.from),
    };
  }
  return null;
}

export function contextDocument(part: ContextView): JsonObject {
  switch (part.kind) {
    case 'fields':
      return { fields: [...part.fields] };
    case 'text':
      return { text: part.text };
    case 'file':
      return { file: part.path };
    case 'generate':
      return {
        generate: { provider: part.provider, model: part.model, instruction: part.instruction, from: [...part.from] },
      };
  }
}

/** The relay's modes a session target may fix, most restrained first (`session-target.ts`, `SESSION_MODES`). */
export const SESSION_MODES = ['manual', 'acceptEdits', 'plan'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** What each mode lets the session do, as the D2 preview says it. */
export const SESSION_MODE_WORDS: Readonly<Record<SessionMode, string>> = {
  manual: 'it asks before it acts',
  acceptEdits: 'it may edit files without asking, and asks before anything else',
  plan: 'it only plans, and changes nothing',
};

/** What a session target's card reads. */
export interface SessionView {
  findBy: 'folder' | 'lane';
  where: string;
  /** A window the person opened, bound to a lane: reached through the lane, with nothing else to choose. */
  windowOnly: boolean;
  ifNone: 'start' | 'queue-only';
  provider: 'claude' | 'codex';
  ifBusy: 'queue' | 'queue-only';
  mode: SessionMode;
  /** Its context, part by part; null when a part has no control here (edited as text). */
  context: ContextView[] | null;
  /**
   * What the session is told last, as its author wrote it; null when the target tells it nothing. The card has no
   * control for it: it is shown, marked "Edited as text", and kept as it was.
   */
  instruction: string | null;
}

export function sessionView(target: JsonObject): SessionView | null {
  if (target.kind !== 'session') return null;
  const find = isObject(target.find) ? target.find : {};
  const findBy = typeof find.lane === 'string' ? 'lane' : 'folder';
  const where = findBy === 'lane' ? text(find.lane) : text(find.folder);
  const own = Object.keys(target).filter((key) => !['targetId', 'version', 'kind'].includes(key));
  const windowOnly = findBy === 'lane' && own.length === 1 && own[0] === 'find';
  const context = Array.isArray(target.context) ? target.context.map(contextPart) : [];
  return {
    findBy,
    where,
    windowOnly,
    ifNone: target.ifNone === 'queue-only' ? 'queue-only' : 'start',
    provider: target.provider === 'codex' ? 'codex' : 'claude',
    ifBusy: target.ifBusy === 'queue-only' ? 'queue-only' : 'queue',
    mode: SESSION_MODES.find((mode) => mode === target.mode) ?? 'manual',
    context: context.every((part): part is ContextView => part !== null) ? context : null,
    instruction:
      target.instruction === undefined
        ? null
        : typeof target.instruction === 'string'
          ? target.instruction
          : JSON.stringify(target.instruction),
  };
}

/** The session target as `view` says, with every field the card has no control for kept as it was. */
export function setSession(target: JsonObject, view: SessionView): JsonObject {
  const next = copyOf(target);
  next.find = view.findBy === 'lane' ? { lane: view.where } : { folder: view.where };
  if (view.windowOnly) {
    for (const key of ['ifNone', 'provider', 'ifBusy', 'mode', 'context']) delete next[key];
    return next;
  }
  next.ifNone = view.ifNone;
  next.provider = view.provider;
  next.mode = view.mode;
  next.ifBusy = view.ifBusy;
  if (view.context !== null) next.context = view.context.map(contextDocument);
  return next;
}

/** A Linear issue's title or description. */
export type TemplateView =
  | { kind: 'text'; text: string }
  | { kind: 'generate'; provider: string; model: string; instruction: string; from: string[] };

/** A Linear title or description as the editor reads it; null for one it has no control for. */
export function templateOf(value: unknown): TemplateView | null {
  if (typeof value === 'string') return { kind: 'text', text: value };
  const part = contextPart(value);
  return part?.kind === 'generate' || part?.kind === 'text' ? part : null;
}

/** A template as the Linear target writes one: `{ text }`; a generator as itself. */
function templateDocument(view: TemplateView): Json {
  return view.kind === 'text' ? { text: view.text } : contextDocument(view);
}

/** What a Linear target's card reads. */
export interface LinearView {
  teamId: string;
  teamKey: string;
  /** Null when the template has no control here (edited as text). */
  title: TemplateView | null;
  description: TemplateView | null;
  labels: { id: string; name: string }[] | null;
  assignee: 'me' | 'nobody' | 'someone';
}

export function linearView(target: JsonObject): LinearView | null {
  if (target.kind !== 'linear') return null;
  const team = isObject(target.team) ? target.team : {};
  const labels = Array.isArray(target.labels)
    ? target.labels.map((label) =>
        isObject(label) && typeof label.id === 'string' && typeof label.name === 'string'
          ? { id: label.id, name: label.name }
          : null,
      )
    : [];
  return {
    teamId: text(team.id),
    teamKey: text(team.key),
    title: templateOf(target.title),
    description: target.description === undefined ? { kind: 'text', text: '' } : templateOf(target.description),
    labels: labels.every((label): label is { id: string; name: string } => label !== null) ? labels : null,
    assignee: target.assignee === 'me' ? 'me' : target.assignee === null ? 'nobody' : 'someone',
  };
}

export function setLinear(target: JsonObject, view: LinearView): JsonObject {
  const next = copyOf(target);
  next.team = { id: view.teamId, key: view.teamKey };
  if (view.title !== null) next.title = templateDocument(view.title);
  if (view.description !== null) next.description = templateDocument(view.description);
  if (view.labels !== null) next.labels = view.labels.map((label) => ({ ...label }));
  if (view.assignee === 'me') next.assignee = 'me';
  else if (view.assignee === 'nobody') next.assignee = null;
  return next;
}

/** The `{{field}}` slots a template names. */
export function slotsOf(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}
