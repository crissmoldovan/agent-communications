import {
  CONTEXT_LIMITS,
  type ContextPart,
  canonicalContextInstruction,
  canonicalContextParts,
  type JsonValue,
  unmappedContextFields,
} from '@agentcomms/events';
import { isLaneName } from './lanes.ts';
import { EventDomainError } from './lifecycle.ts';

/**
 * The agent-session target (0.33.0 design §3.5–§3.6). A match is handed to a coding-agent session that claude-stream
 * runs — found by its folder, or as the session behind the window bound to a lane — with a prompt written in a fixed
 * frame from the target's context. Its document fixes everything a delivery does, so the person's approval covers it:
 * where the session is found, whether one is started and with which provider, the mode it may act in, what happens
 * while it is busy, and every part of what it is told.
 */

export const SESSION_PROVIDERS: readonly ['claude', 'codex'] = Object.freeze(['claude', 'codex'] as const);
export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

/**
 * The relay's permission modes a target may fix, most restrained first; `manual` — the session asks before it acts —
 * is the default. claude-stream's `bypassPermissions` ("nothing asks first") is refused: what a rule passes on was
 * written by a message's sender, so a session it prompts always keeps a way to ask.
 */
export const SESSION_MODES: readonly ['manual', 'acceptEdits', 'plan'] = Object.freeze([
  'manual',
  'acceptEdits',
  'plan',
] as const);
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_IF_NONE: readonly ['start', 'queue-only'] = Object.freeze(['start', 'queue-only'] as const);
export const SESSION_IF_BUSY: readonly ['queue', 'queue-only'] = Object.freeze(['queue', 'queue-only'] as const);

export interface SessionTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'session';
  /** By the realpath of its working folder, or by the Claude Code session of the window bound to a lane (B5). */
  readonly find: { readonly folder: string } | { readonly lane: string };
  readonly ifNone: (typeof SESSION_IF_NONE)[number];
  readonly provider: SessionProvider;
  readonly mode: SessionMode;
  readonly ifBusy: (typeof SESSION_IF_BUSY)[number];
  readonly context: readonly ContextPart[];
  /** The prompt's last words, when the person gave the session one. */
  readonly instruction?: string;
}

/** How the D2 preview names each mode: what the session may do without asking. */
export const SESSION_MODE_WORDS: Readonly<Record<SessionMode, string>> = Object.freeze({
  manual: 'it asks before it acts',
  acceptEdits: 'it may edit files without asking, and asks before anything else',
  plan: 'it only plans, and changes nothing',
});

export const SESSION_PROVIDER_NAMES: Readonly<Record<SessionProvider, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
});

function fail(message: string, code: EventDomainError['code'] = 'VERSION_DOCUMENT_INVALID'): never {
  throw new EventDomainError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A folder as a target names one: absolute, already normal — no `.` or `..` step, no repeated or trailing slash — and
 * at most 1,024 bytes. Its realpath is taken when a match is passed on, and it must lie inside the relay's allowed
 * roots, which activation checks.
 */
export function isSessionFolder(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > CONTEXT_LIMITS.pathBytes)
    return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is what the check refuses.
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value === '/') return false;
  if (!value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false;
  return !value
    .slice(1)
    .split('/')
    .some((step) => step === '.' || step === '..');
}

function canonicalFind(value: unknown): SessionTargetDocument['find'] {
  if (!isRecord(value) || Object.keys(value).length !== 1)
    return fail('a session target is found by { folder } or by { lane }, one of them');
  if (Object.hasOwn(value, 'folder')) {
    if (!isSessionFolder(value.folder))
      return fail("a session target's folder is an absolute path, written without . or .. steps or a trailing /");
    return { folder: value.folder };
  }
  if (Object.hasOwn(value, 'lane')) {
    if (!isLaneName(value.lane)) return fail('a lane name is 1 to 40 lowercase letters, digits and hyphens');
    return { lane: value.lane };
  }
  return fail('a session target is found by { folder } or by { lane }, one of them');
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T, what: string): T {
  const chosen = value === undefined ? fallback : value;
  if (!(values as readonly unknown[]).includes(chosen)) return fail(`${what} is ${values.join(' or ')}`);
  return chosen as T;
}

/** The canonical immutable session target: exact keys, its defaults written out, so the digest binds what applies. */
export function canonicalSessionTarget(target: Record<string, unknown>): SessionTargetDocument {
  const keys = [
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
  for (const key of Object.keys(target)) if (!keys.includes(key)) return fail(`a session target has no ${key} field`);
  if (typeof target.targetId !== 'string' || target.targetId.length === 0)
    return fail('a target id is a non-empty string');
  if (!Number.isSafeInteger(target.version) || (target.version as number) < 1)
    return fail('a target version is a positive safe integer');
  const find = canonicalFind(target.find);
  if (target.mode === 'bypassPermissions')
    return fail(
      'a session target never fixes bypassPermissions: what it passes on was written by a sender, so the session keeps a way to ask',
    );
  const ifNone = oneOf(target.ifNone, SESSION_IF_NONE, 'queue-only', "a session target's ifNone");
  if ('lane' in find && ifNone === 'start')
    return fail(
      "a session found by a lane is the bound window's, and is never started: its ifNone is queue-only, leaving the item in the lane",
    );
  if (target.provider === undefined) return fail('a session target names its provider: claude or codex');
  const provider = oneOf(target.provider, SESSION_PROVIDERS, 'claude', "a session target's provider");
  const mode = oneOf(target.mode, SESSION_MODES, 'manual', "a session target's mode");
  const ifBusy = oneOf(target.ifBusy, SESSION_IF_BUSY, 'queue', "a session target's ifBusy");
  const context = canonicalContextParts(target.context ?? []);
  if (!context.ok) return fail(`a session target's context: ${context.issues[0]?.message ?? 'is not valid'}`);
  let instruction: string | undefined;
  if (target.instruction !== undefined) {
    const checked = canonicalContextInstruction(target.instruction);
    if (!checked.ok) return fail(`a session target's ${checked.issues[0]?.message ?? 'instruction is not valid'}`);
    instruction = checked.value;
  }
  return {
    targetId: target.targetId,
    version: target.version as number,
    kind: 'session',
    find,
    ifNone,
    provider,
    mode,
    ifBusy,
    context: context.value,
    ...(instruction === undefined ? {} : { instruction }),
  };
}

/** Refuses a session target whose context reads a field the rule's mapping does not keep, naming the fields (§2). */
export function assertSessionMapping(target: SessionTargetDocument, mapping: JsonValue): void {
  const unmapped = unmappedContextFields(target.context, mapping);
  if (unmapped.length > 0)
    fail(`the session target ${target.targetId} reads ${unmapped.join(', ')}, which the rule's mapping does not keep`);
}

/** The files a session target reads, for the activation check that each is under a folder it may be read from. */
export function sessionTargetFiles(target: SessionTargetDocument): readonly string[] {
  return target.context.flatMap((part) => ('file' in part ? [part.file] : []));
}
