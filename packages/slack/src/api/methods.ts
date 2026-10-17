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

/**
 * Where Slack serves a file's bytes, and the only other origin this package talks to.
 *
 * Hardcoded for the same reason as {@link SLACK_ORIGIN}, and reachable for two things only. A `GET` of the path of a
 * file just looked up with `files.info` or `files.list`, inside a grant for exactly that file (`downloadWith` in
 * `guard.ts`). The link Slack returns is never followed as given — it is checked against {@link fileOfPath} and
 * rebuilt on this origin, so a link pointing anywhere else is refused before the token could go with it. And a `POST`
 * of a file's bytes to the exact upload URL `files.getUploadURLExternal` returned, inside a grant for that URL
 * (`uploadWith` in `guard.ts`), which opens only inside the approved post the file belongs to.
 *
 * Unlike Resend's attachment CDN, this host needs the workspace's token: Slack documents that both `url_private` and
 * `url_private_download` answer only a request carrying `Authorization: Bearer` with a token that has `files:read`.
 * So the token goes to two hosts, both Slack's, and to nothing else.
 */
export const SLACK_FILES_ORIGIN = 'https://files.slack.com';

/**
 * Where Slack keeps people's profile photos: the third origin, and the one no token ever goes to.
 *
 * Reached for one thing only: a `GET` of the signed-in person's own photo, the `profile.image_512` that `users.info`
 * just returned, inside a grant for exactly that URL (`avatarWith` in `guard.ts`) — so `icon make` can put a badge on
 * it. The photo host serves the picture to anybody who has its address, so the request carries no credential at all,
 * and the guard refuses one that does. A photo kept anywhere else — a Gravatar, Slack's default picture on another
 * host — is not fetched.
 */
export const SLACK_AVATARS_ORIGIN = 'https://avatars.slack-edge.com';

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
  /**
   * A step towards a write that publishes nothing by itself.
   *
   * `files.getUploadURLExternal` asks Slack where to put bytes; the file becomes visible only when
   * `files.completeUploadExternal` names a channel. Classifying it `write` spent the one-shot permit on the
   * preparation, so the call that actually publishes then found the door shut — the gate would have blocked the
   * post while letting the upload through, which is precisely backwards.
   */
  | 'prepare'
  /**
   * Rewrites a Slack app's own configuration — its manifest — with an app configuration token.
   *
   * Neither of the other two shapes fits. It posts nothing and changes no token already issued, so a post's approval
   * is the wrong thing to ask for; but it changes what the app may ask for next, and the token it carries can rewrite
   * every app its owner has, so leaving it reachable like a read would let any code in this package do that. It is
   * reachable only while a configuration grant is open for exactly that method (`configureWith` in `guard.ts`), and
   * the one place that opens one is `agent-slack app`.
   */
  | 'configure'
  /**
   * Revokes one superseded token, only while a grant binds the request to its ledger ref, token kind and digest.
   *
   * This is not ordinary authentication: OAuth exchanges create a credential and carry none, while `auth.revoke`
   * destroys an existing bearer. It therefore has a door of its own (`revokeWith` in `guard.ts`) rather than being
   * reachable as `auth`, `read`, or a posting approval.
   */
  | 'revoke'
  /**
   * A file's bytes, from {@link SLACK_FILES_ORIGIN} rather than the Web API.
   *
   * Not a method at all, which is why no row of the table below has this kind and why it has a rule of its own,
   * {@link FILE_DOWNLOAD}. A read — it changes nothing at Slack and needs no approval — but not reachable like one:
   * only inside a grant naming the one file, which `slackFileDownload` opens around a single `GET`.
   */
  | 'download'
  /** Deliberately unreachable. Listed so the decision is recorded rather than implied by absence. */
  | 'refused';

export interface MethodRule {
  readonly kind: MethodClass;
  /**
   * The user scopes this method needs — **any one of them is enough**, which is why it is a list.
   *
   * Slack's conversation methods take whichever of `channels:history`, `groups:history`, `im:history` and
   * `mpim:history` matches the conversation being read, so a single-scope field could not describe
   * `conversations.history` at all. Better to find that out here than when S3 adds it.
   *
   * Here rather than in a second table beside the manifests, so "the manifest enables everything the allowlist
   * can reach" is checkable from one source. Two lists of the same fact drift; this one cannot.
   */
  readonly requiredScopes?: readonly string[] | undefined;
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
  'auth.revoke': { kind: 'revoke' },

  'apps.uninstall': {
    kind: 'refused',
    note: 'removing an installation is something a person does in Slack, not something an agent does for them',
  },

  // ── The app itself: `agent-slack app update` and `app create`, with an app configuration token ──────────────
  /*
   * Classified `configure`, not `read` or `write`: the guard lets one through only inside a configuration grant for
   * that exact method, which only `operations/app.ts` opens. The token on these calls is the person's app
   * configuration token, typed at a hidden prompt for this one command, and never a workspace's own sign-in token.
   *
   * No `requiredScopes`, deliberately. Those are the user scopes a manifest has to ask for; these need
   * `app_configurations:write`, which is a property of the configuration token, not of any app this package builds.
   */
  'apps.manifest.validate': { kind: 'configure' },
  'apps.manifest.update': { kind: 'configure' },
  'apps.manifest.create': { kind: 'configure' },
  'apps.manifest.delete': {
    kind: 'refused',
    note: 'deleting a Slack app is something a person does at api.slack.com, not something this package does for them',
  },
  'tooling.tokens.rotate': {
    kind: 'refused',
    note: 'an app configuration token is used for one command and never kept, so there is nothing here to rotate',
  },

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────
  /*
   * Four scopes each, and any one of them is enough.
   *
   * Slack's conversation methods take whichever of `channels:`, `groups:`, `im:` and `mpim:` matches the
   * conversation being read: a public channel needs `channels:history`, a private one `groups:history`, a DM
   * `im:history`. There is no single scope that covers a method, which is why `requiredScopes` was a list before
   * anything needed it to be.
   */
  'conversations.list': {
    kind: 'read',
    requiredScopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read'],
  },
  'conversations.info': {
    kind: 'read',
    requiredScopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read'],
  },
  'conversations.members': {
    kind: 'read',
    requiredScopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read'],
  },
  'conversations.history': {
    kind: 'read',
    requiredScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
  },
  'conversations.replies': {
    kind: 'read',
    requiredScopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history'],
  },
  'users.info': { kind: 'read', requiredScopes: ['users:read'] },
  /*
   * Which app a bot belongs to (CUE-493): `workspace bot` asks it, with the member's own token, before keeping a pasted
   * bot token for a workspace whose organisation names its agent app — so another app's token is refused by name.
   */
  'bots.info': { kind: 'read', requiredScopes: ['users:read'] },
  'users.list': { kind: 'read', requiredScopes: ['users:read'] },
  /*
   * `search.messages` is a user-token method and has no bot equivalent, which is one of the reasons this package
   * installs as a user token at all.
   */
  'search.messages': { kind: 'read', requiredScopes: ['search:read'] },
  'files.info': { kind: 'read', requiredScopes: ['files:read'] },
  'files.list': { kind: 'read', requiredScopes: ['files:read'] },

  // ── Writes: everything that puts a message in front of somebody ───────────────────────────────────────────
  /*
   * Four of these may carry the send app's bot token as well as the person's (design 2026-10-15 S1): `chat.postMessage`
   * for an app post, `chat.update` and `chat.delete` for an app message this account posted, and `reactions.add` and
   * `reactions.remove` for a reaction the app makes. The bot's scopes are the manifest's four and no more, and every
   * request either token carries is a write here, behind the same permit — the token does not change the door.
   */
  'chat.postMessage': { kind: 'write', requiredScopes: ['chat:write'] },
  // Editing a message that people have already read changes what they saw, after they saw it.
  'chat.update': { kind: 'write', requiredScopes: ['chat:write'] },
  'chat.delete': { kind: 'write', requiredScopes: ['chat:write'] },
  'chat.meMessage': { kind: 'write', requiredScopes: ['chat:write'] },
  'chat.scheduleMessage': { kind: 'write', requiredScopes: ['chat:write'] },
  'chat.deleteScheduledMessage': { kind: 'write', requiredScopes: ['chat:write'] },
  // A file share is a post. `initial_comment` is a message, and it arrives without `chat:write` anywhere.
  'files.completeUploadExternal': { kind: 'write', requiredScopes: ['files:write'] },
  // Publishes nothing on its own: it asks Slack where to put bytes. The permit belongs to the call that
  // makes the file visible, not to this one.
  'files.getUploadURLExternal': { kind: 'prepare', requiredScopes: ['files:write'] },
  'reactions.add': { kind: 'write', requiredScopes: ['reactions:write'] },
  'reactions.remove': { kind: 'write', requiredScopes: ['reactions:write'] },

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

/**
 * The one rule that is not a Web API method: a file's bytes, fetched from {@link SLACK_FILES_ORIGIN}.
 *
 * Kept out of the method table on purpose. That table is keyed by the name Slack puts at the end of an `/api/` path,
 * and a row here would make `https://slack.com/api/<its name>` classify as something — a name for a request Slack's
 * API does not have, reachable at a host that must never serve it. So the table stays the Web API, and this sits
 * beside it: `GET` only, at the files origin only, and only for the path {@link fileOfPath} reads as the file a grant
 * names. `files:read` is what Slack asks of the token, and it is in the read manifest, so a workspace connected to
 * read can download.
 */
export const FILE_DOWNLOAD: MethodRule = Object.freeze({
  kind: 'download',
  requiredScopes: ['files:read'],
  note: 'one file’s bytes, by GET, from files.slack.com, for the file just looked up',
});

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
export function scopesFor(kinds: readonly MethodClass[]): string[] {
  return [
    ...new Set(
      [...Object.values(RULES), FILE_DOWNLOAD]
        .filter((rule) => kinds.includes(rule.kind))
        .flatMap((rule) => rule.requiredScopes ?? []),
    ),
  ].sort();
}

/**
 * Methods that reach Slack with no scope recorded.
 *
 * Must be empty for everything but `read` — `auth.test` and the OAuth calls genuinely need none. A write or a
 * prepare with no scope attached is one nobody checked, and `scopesFor` would hide it by returning the others.
 */
export function unscopedMethods(): string[] {
  return Object.entries(RULES)
    .filter(([, rule]) => (rule.kind === 'write' || rule.kind === 'prepare') && !rule.requiredScopes?.length)
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
  /*
   * No regular expression here, deliberately.
   *
   * This collapsed trailing slashes with `/\/+$/`, which an unanchored regex engine tries from every position in a
   * run of slashes — quadratic on a path of many `/` that does not end in one. It sits on the guard every Slack
   * request passes through and is exported from the package root, which is the one place a slow-path input is
   * least acceptable. A backwards scan and a split say the same thing in linear time: the path, less any trailing
   * slashes, ends in `/api/<method>`.
   */
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end -= 1;
  const segments = path.slice(0, end).split('/');
  const method = segments.at(-1);
  if (segments.at(-2) !== 'api' || !method) return null;
  return method;
}

/** A file, as the path of its bytes on {@link SLACK_FILES_ORIGIN} names it. */
export interface FileOfPath {
  readonly teamId: string;
  readonly fileId: string;
}

/*
 * A Slack id: upper-case letters and digits, starting with a letter — `T024BE7LD`, `F0H2BJ8GV`.
 *
 * No `-` and no `/` in it, which is what makes `<TEAM>-<FILEID>` read one way only. Anchored and bounded, so it
 * costs the same on any input.
 */
const SLACK_ID = /^[A-Z][A-Z0-9]{1,39}$/;

/**
 * Whether one decoded path segment is a plain file name: something Slack put there, not a way out of the file's
 * own directory.
 *
 * The URL parser already resolves `..` and `%2e%2e` segments, so what is left to refuse is what only a server that
 * decodes again would see — `%2F`, `%5C` — and the bytes no file name needs.
 */
function isPlainName(segment: string | undefined): boolean {
  if (segment === undefined || segment === '') return false;
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return false;
  }
  if (name === '.' || name === '..') return false;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code === 0x2f || code === 0x5c || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Whether a path on the files host is where an upload's bytes go: `/upload/` and then one or more plain segments.
 *
 * Slack's upload URLs are opaque — `/upload/v1/CwABAAAAXAoAAZnKg309…` — so this does not read them, only rules out
 * what no upload URL is: the bare `/upload/` directory, an empty segment, and a segment that a server decoding again
 * would read as a way out of it. The guard does not trust this to say *which* upload: a grant names one URL exactly,
 * and that is what the request is compared with. This decides only whether a grant may name it at all.
 *
 * A split rather than a regular expression, for the reason {@link methodOfUrl} gives.
 */
export function isUploadPath(pathname: string): boolean {
  const segments = pathname.split('/');
  if (segments[0] !== '' || segments[1] !== 'upload' || segments.length < 3) return false;
  return segments.slice(2).every(isPlainName);
}

/**
 * The team and file a path on the files host names, or null when it is not the path of one file's bytes.
 *
 * Two shapes, and only two, because those are the two links `files.info` returns: `url_private`,
 * `/files-pri/<TEAM>-<FILEID>/<name>`, and `url_private_download`, `/files-pri/<TEAM>-<FILEID>/download/<name>`.
 * Thumbnails (`/files-tmb/…`), a bare directory, or anything deeper are not files this package fetches. `pathname`
 * is a parsed URL's: no query, no fragment, dot segments already resolved.
 *
 * A split rather than one regular expression, for the reason {@link methodOfUrl} gives: this sits on the guard, and
 * a split is linear on any input.
 */
export function fileOfPath(pathname: string): FileOfPath | null {
  const segments = pathname.split('/');
  if (segments[0] !== '' || segments[1] !== 'files-pri') return null;
  const shaped = segments.length === 4 || (segments.length === 5 && segments[3] === 'download');
  if (!shaped || !isPlainName(segments.at(-1))) return null;
  const pair = (segments[2] ?? '').split('-');
  const [teamId, fileId] = pair;
  if (pair.length !== 2 || teamId === undefined || fileId === undefined) return null;
  if (!SLACK_ID.test(teamId) || !SLACK_ID.test(fileId)) return null;
  return { teamId, fileId };
}
