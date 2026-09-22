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

/**
 * The one origin this package talks to.
 *
 * Written here beside the method list because the two are one rule: *this* method, at *this* host. The guard
 * classified the method out of the path and never looked at the host, so `https://evil.example/api/auth.test`
 * was classified `read` and sent — with the workspace's token attached. The method name is the last path
 * segment, and any host can offer that path.
 *
 * Tests reach Slack through an injected base URL instead of relaxing this, so there is no mode in which the
 * check is off.
 */
export const SLACK_ORIGIN = 'https://slack.com';

export type MethodClass =
  /** Reads. No permit, no approval. */
  | 'read'
  /** Puts something in front of people, or changes something that already is. Needs an open permit. */
  | 'write'
  /**
   * Getting or renewing a token. No permit — there is no approval to attach one to, and no account token to
   * carry: these are the calls that *produce* the credential, so sending one with them would be circular.
   */
  | 'auth'
  /** Deliberately unreachable. Listed so the decision is recorded rather than implied by absence. */
  | 'refused';

export interface MethodRule {
  readonly kind: MethodClass;
  /**
   * The user scope this method needs, when it needs one.
   *
   * Here rather than in a second table beside the manifests, so "the manifest enables everything the allowlist
   * can reach" is checkable from one source. Two lists of the same fact drift; this one cannot.
   */
  readonly requiredScope?: string | undefined;
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
  /*
   * `auth.test` needs no scope at all, and it returns the workspace id, the workspace name and the user id —
   * which is the whole reason `team.info` is not here. `team.info` would need `team:read`, a scope nothing else
   * in either manifest wants, to learn what this already says.
   */
  'auth.test': { kind: 'read' },

  // Getting a token and renewing one. No permit, and no account token attached — these produce the credential.
  'oauth.v2.user.access': { kind: 'auth' },
  'oauth.v2.access': { kind: 'auth' },

  'apps.uninstall': {
    kind: 'refused',
    note: 'removing an installation is something a person does in Slack, not something an agent does for them',
  },

  // ── Writes: everything that puts a message in front of somebody ───────────────────────────────────────────
  'chat.postMessage': { kind: 'write', requiredScope: 'chat:write' },
  // Editing a message that people have already read changes what they saw, after they saw it.
  'chat.update': { kind: 'write', requiredScope: 'chat:write' },
  'chat.delete': { kind: 'write', requiredScope: 'chat:write' },
  'chat.meMessage': { kind: 'write', requiredScope: 'chat:write' },
  'chat.scheduleMessage': { kind: 'write', requiredScope: 'chat:write' },
  'chat.deleteScheduledMessage': { kind: 'write', requiredScope: 'chat:write' },
  // A file share is a post. `initial_comment` is a message, and it arrives without `chat:write` anywhere.
  'files.completeUploadExternal': { kind: 'write', requiredScope: 'files:write' },
  'files.getUploadURLExternal': { kind: 'write', requiredScope: 'files:write' },
  'reactions.add': { kind: 'write', requiredScope: 'reactions:write' },
  'reactions.remove': { kind: 'write', requiredScope: 'reactions:write' },

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
 * Every scope the reachable methods need, so a manifest can be checked against the allowlist rather than against
 * somebody's memory of it. A method classified `write` with no scope recorded is a gap, and `requiredScopes`
 * would hide it — so {@link unscopedWriteMethods} names those instead of silently dropping them.
 */
export function requiredScopes(kind: MethodClass): string[] {
  return [
    ...new Set(
      Object.values(RULES)
        .filter((rule) => rule.kind === kind && rule.requiredScope)
        .map((rule) => rule.requiredScope as string),
    ),
  ].sort();
}

/** Write methods with no scope recorded. Must be empty: a write nobody attached a scope to is a write nobody checked. */
export function unscopedWriteMethods(): string[] {
  return Object.entries(RULES)
    .filter(([, rule]) => rule.kind === 'write' && !rule.requiredScope)
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
