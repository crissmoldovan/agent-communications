/**
 * Every Slack method this package may reach, and what each one is allowed to do.
 *
 * Gmail could guard sending by looking at the URL, because its send endpoints all end in `/send`. Slack has no
 * such shape: `chat.postMessage` and `conversations.history` are the same URL with a different last segment, and
 * the research found four separate ways to put a message in front of people, only one of which needs `chat:write`.
 * A guard that looked for one of them would be a guard against that one.
 *
 * So the rule is a list rather than a pattern, and the list is closed: a method that is not written down here
 * cannot be called at all. That is what makes "every write goes through the gate" checkable instead of hopeful —
 * a new method added anywhere in this package fails at the transport until somebody classifies it, and
 * classifying it is the moment to ask whether it posts.
 */

export type MethodClass =
  /** Reads. No permit, no approval. */
  | 'read'
  /** Puts something in front of people, or changes something that already is. Needs an open permit. */
  | 'write'
  /** Deliberately unreachable. Listed so the decision is recorded rather than implied by absence. */
  | 'refused';

export interface MethodRule {
  readonly kind: MethodClass;
  /** Why, for the `refused` ones — printed when something tries, so the answer is in the error and not only here. */
  readonly note?: string;
}

/**
 * The four write paths the research enumerated, plus the ones that came with them.
 *
 * `chat:write` is the obvious one. `files.completeUploadExternal` publishes a file into a channel with an
 * `initial_comment`, which is a visible message that never touches `chat:write`. `reactions.add` is a public,
 * notifying act attributed to the person. All three are posts, so all three are behind the gate.
 */
const RULES: Readonly<Record<string, MethodRule>> = {
  // ── Identity and setup ────────────────────────────────────────────────────────────────────────────────────
  'auth.test': { kind: 'read' },
  'team.info': { kind: 'read' },
  'apps.uninstall': {
    kind: 'refused',
    note: 'removing an installation is something a person does in Slack, not something an agent does for them',
  },

  // ── Writes: everything that puts a message in front of somebody ───────────────────────────────────────────
  'chat.postMessage': { kind: 'write' },
  // Editing a message that people have already read changes what they saw, after they saw it.
  'chat.update': { kind: 'write' },
  'chat.delete': { kind: 'write' },
  'chat.meMessage': { kind: 'write' },
  'chat.scheduleMessage': { kind: 'write' },
  'chat.deleteScheduledMessage': { kind: 'write' },
  // A file share is a post. `initial_comment` is a message, and it arrives without `chat:write` anywhere.
  'files.completeUploadExternal': { kind: 'write' },
  'files.getUploadURLExternal': { kind: 'write' },
  'reactions.add': { kind: 'write' },
  'reactions.remove': { kind: 'write' },

  // ── Refused: never requested in any manifest, and unreachable even if a token somehow carried the scope ───
  'chat.postEphemeral': {
    kind: 'refused',
    note: 'an ephemeral message is a post nobody else can see afterwards, so nothing can show what was sent',
  },
  'conversations.mark': {
    kind: 'refused',
    note: 'marking things read mutates what the person sees and is not worth a write scope',
  },
  'apps.connections.open': {
    kind: 'refused',
    note: 'Socket Mode is reserved by the design but not built; nothing in v1 subscribes to events',
  },
  'admin.conversations.create': {
    kind: 'refused',
    note: 'no admin method is in any manifest this package ships',
  },
};

/** What the registry says about a method. `null` when it says nothing, which is itself the answer: refuse it. */
export function methodRule(method: string): MethodRule | null {
  return RULES[method] ?? null;
}

/** Every method named here, for the test that asserts the transport cannot reach one that is not. */
export function classifiedMethods(): string[] {
  return Object.keys(RULES).sort();
}

/** The methods that need an open permit. Exported so a manifest can be checked against what it actually enables. */
export function writeMethods(): string[] {
  return Object.entries(RULES)
    .filter(([, rule]) => rule.kind === 'write')
    .map(([method]) => method)
    .sort();
}

/**
 * The method a Slack API URL names, or null when the URL is not one.
 *
 * Slack puts the method in the last path segment, so this is exact rather than a heuristic — but only after the
 * query is dropped and a trailing slash removed, or `chat.postMessage?pretty=1` names no method this can see and
 * the guard waves through the one call it exists to stop.
 */
export function methodOfUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? url;
  }
  const match = /\/api\/([^/?#]+)\/?$/.exec(path.replace(/\/+$/, '/'));
  return match?.[1] ?? null;
}
