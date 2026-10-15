import { createHash, timingSafeEqual } from 'node:crypto';
import { CommsError } from '@agentcomms/core';
import {
  type FileOfPath,
  fileOfPath,
  isUploadPath,
  methodOfUrl,
  methodRule,
  SLACK_AVATARS_ORIGIN,
  SLACK_FILES_ORIGIN,
  SLACK_ORIGIN,
} from './methods.ts';

/**
 * The one door every Slack request goes through.
 *
 * The Gmail package learned this the expensive way: a guarantee enforced at the operation layer is a guarantee
 * about the operations somebody remembered to route through it. This sits under all of them, on the `fetch` the
 * transport actually calls, so a method added anywhere in the package — or in a dependency reaching for the same
 * client — meets it whether or not its author knew this file existed.
 *
 * It fails closed in both directions. An unclassified method is refused, so the registry cannot silently fall
 * behind the code; and a classified write is refused without an open permit, so the approval gate cannot be
 * stepped around by calling Slack directly.
 *
 * Two origins that carry the token, both hardcoded: the Web API, and `files.slack.com` for a file's bytes. The second
 * is shut except inside a download grant naming one file, and then open for one `GET` of that file's path and nothing
 * else — or inside an upload grant naming one upload URL, which opens only inside an approved file post, and then for
 * one `POST` to that exact URL and nothing else.
 *
 * A third, `avatars.slack-edge.com`, holds people's profile photos, and is shut the same way except inside a photo
 * grant naming one photo's URL: then open for one `GET` of exactly that URL, carrying no credential, and nothing else.
 */

export interface WritePermit {
  /**
   * The approval this permit belongs to, or null when no write is allowed.
   *
   * Null between sends, which is almost always. A permit is opened for one request and closed by it — see
   * `spendOn` — so a second write inside the same permit finds the door shut, exactly as a retried Gmail send does.
   */
  approvalId: string | null;
  /** The method the approval was for. A permit for a reaction does not open the door for a message. */
  method: string | null;
  /**
   * The one app-configuration method that may go out next, or null — which is always, except inside `configureWith`.
   *
   * On the same object as the post's permit so that every request meets both answers in one place, and kept apart
   * from it so that neither lends the other anything: opening this leaves `approvalId` null, so a post attempted
   * inside a configuration grant is refused exactly as it always was.
   */
  configuring: string | null;
  /** The one superseded bearer which may be revoked next, or null outside `revokeWith`. */
  revoking: RevokeBinding | null;
  /**
   * The one file whose bytes may be fetched next, or null — which is always, except inside `downloadWith`.
   *
   * On this object for the reason `configuring` is: every request meets every answer in one place. And like it, it
   * lends nothing: opening it leaves `approvalId` and `configuring` null, so nothing that posts or changes an app
   * gets through inside a download, and a download is refused inside either of those.
   */
  downloading: FileOfPath | null;
  /**
   * The one upload URL a file's bytes may be sent to next, or null — which is always, except inside `uploadWith`.
   *
   * The fourth answer on this object, and the only one that borrows. An upload is part of a post: the bytes are what
   * the person approved, and Slack discards them unless the post that names a channel follows. So it opens only while
   * that post's own permit is open for {@link UPLOAD_PUBLISHES}, and the guard asks again at the request whether it
   * still is. It lends nothing back: opening it leaves the post's permit as it was, for the one call that publishes.
   */
  uploading: string | null;
  /**
   * The one profile photo that may be fetched next, by its whole URL, or null — which is always, except inside
   * `avatarWith`.
   *
   * The fifth answer, and like a download it lends nothing: opening it leaves every other answer null, so nothing that
   * posts, changes an app or reads a file gets through inside it. Unlike a download, the request it lets out carries no
   * credential: the photo host is never sent the workspace's token, and the guard refuses a request that has one.
   */
  avatar: string | null;
}

export function closedPermit(): WritePermit {
  return {
    approvalId: null,
    method: null,
    configuring: null,
    revoking: null,
    downloading: null,
    uploading: null,
    avatar: null,
  };
}

/** The durable identity a revocation request is bound to, without retaining its bearer token. */
export interface RevokeBinding {
  readonly ref: string;
  readonly kind: 'access' | 'refresh';
  readonly tokenSha256: string;
}

/**
 * The method whose permit an upload goes out inside: the call that makes uploaded files visible in a channel.
 *
 * `files.getUploadURLExternal` is a `prepare` and spends nothing, and the bytes themselves are not a Web API call, so
 * a file post's approval opens the permit for this method alone — and the upload rides inside it, before it is spent.
 */
const UPLOAD_PUBLISHES = 'files.completeUploadExternal';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Why a download was refused, in the words `slackFileDownload` promises its caller.
 *
 * The files-host refusals below carry one in `details.reason`, so a refusal that could only come from here — because
 * the check in `download.ts` was wrong — still arrives with a reason the download operation knows how to report.
 */
type DownloadRefusal = 'wrong-host' | 'wrong-path';

function refuseDownload(message: string, reason: DownloadRefusal): CommsError {
  return new CommsError('SEND_REFUSED', message, {
    hint: 'This is a bug — please report it.',
    details: { reason },
  });
}

/**
 * The files host: one `GET`, of the path of the one file the open grant names, and then the grant is spent.
 *
 * Every refusal here happens before the grant is spent, so a request that got something wrong does not use up the
 * download it was meant to be — but it does not go out either.
 */
function checkDownload(url: URL, verb: string, permit: WritePermit): void {
  const grant = permit.downloading;
  if (grant === null) {
    throw refuseDownload(
      `${SLACK_FILES_ORIGIN} is reached only to download a file just looked up, and no download is open`,
      'wrong-path',
    );
  }
  // Not HEAD, not POST: a file is read by fetching it, and nothing else this host offers is wanted.
  if (verb !== 'GET') throw refuseDownload(`a file is fetched with GET, not ${verb}`, 'wrong-path');
  /*
   * The path alone. A query is not ours to forward — the link came from Slack's reply, and whatever rides in its
   * query rides with the token — and `slackFileDownload` rebuilds the URL without one.
   */
  if (url.search !== '' || url.hash !== '') {
    throw refuseDownload('a file is fetched by its path alone, with no query', 'wrong-path');
  }
  const named = fileOfPath(url.pathname);
  if (named === null || named.teamId !== grant.teamId || named.fileId !== grant.fileId) {
    // The path is not repeated: its last segment is a file name somebody in the workspace chose.
    throw refuseDownload('that is not the path of the file this download is for', 'wrong-path');
  }
  // One grant, one request: a second fetch inside the same grant finds the door shut.
  permit.downloading = null;
}

function refuseUpload(message: string): CommsError {
  return new CommsError('SEND_REFUSED', message, { hint: 'This is a bug — please report it.' });
}

/**
 * The files host's upload path: one `POST`, to the exact URL the open grant names, while the post it belongs to is
 * still open — and then the grant is spent.
 *
 * The post's permit is asked about here, at the request, and not only where the grant was opened. A grant is opened
 * inside the permit, but the permit is spent by the call that publishes; bytes sent after that belong to no approval,
 * whichever way the grant came to be still standing. As with a download, every refusal here comes before the grant
 * is spent, so a request that got something wrong does not use up the upload it was meant to be.
 */
function checkUpload(url: URL, verb: string, permit: WritePermit): void {
  const grant = permit.uploading;
  if (grant === null) {
    throw refuseUpload(`${SLACK_FILES_ORIGIN} takes an upload only inside an approved post, and no upload is open`);
  }
  if (permit.approvalId === null || permit.method !== UPLOAD_PUBLISHES) {
    throw refuseUpload(
      `a file is uploaded only inside an approved post, and no approval for ${UPLOAD_PUBLISHES} is open`,
    );
  }
  if (verb !== 'POST') throw refuseUpload(`a file is uploaded with POST, not ${verb}`);
  /*
   * The whole URL, compared exactly: Slack's reply named it, and nothing about it is ours to vary. Not repeated in the
   * refusal — it is a signed address, good for one upload.
   */
  if (url.href !== grant) throw refuseUpload('that is not the URL Slack gave for this upload');
  // One grant, one request: a second POST inside the same grant finds the door shut.
  permit.uploading = null;
}

function refuseAvatar(message: string): CommsError {
  return new CommsError('SEND_REFUSED', message, { hint: 'This is a bug — please report it.' });
}

/** The headers a request carries, however they were given: on `init`, or on a `Request`. */
function headersOf(input: string | URL | Request, init: RequestInit | undefined): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers);
  return input instanceof Request ? new Headers(input.headers) : new Headers();
}

/**
 * The photo host: one `GET`, of exactly the URL the open grant names, with no credential on it — and then the grant
 * is spent.
 *
 * No credential, checked here at the request rather than trusted to the caller: the host serves a photo to anyone with
 * its address, so a token or a cookie on the request could only be one sent by mistake, to a host that never needed it.
 * As with a download, every refusal comes before the grant is spent, and none names the URL.
 */
function checkAvatar(url: URL, verb: string, headers: Headers, permit: WritePermit): void {
  const grant = permit.avatar;
  if (grant === null) {
    throw refuseAvatar(
      `${SLACK_AVATARS_ORIGIN} is reached only for a profile photo just looked up, and no photo is open`,
    );
  }
  if (verb !== 'GET') throw refuseAvatar(`a profile photo is fetched with GET, not ${verb}`);
  if (headers.has('authorization') || headers.has('cookie')) {
    throw refuseAvatar(`a profile photo is fetched with no credential, and this request carried one`);
  }
  if (url.href !== grant) throw refuseAvatar('that is not the photo this grant is for');
  // One grant, one request: a second fetch inside the same grant finds the door shut.
  permit.avatar = null;
}

/**
 * Wraps `fetch` so every Slack call is classified before it leaves.
 *
 * `permit` is read at call time rather than captured, so opening and closing it around a single request is enough
 * to scope what that request may do.
 *
 * **The origins are hardcoded, and there is no argument for either.** The first attempt made the origin an option
 * defaulting to Slack's, on the reasoning that the check still always ran and only its target moved. That reasoning
 * was wrong: the type was exported from the package root, so any caller could name any origin, which is precisely
 * the production override it claimed not to be. A test reaches a fake Slack by rewriting an already-validated URL in
 * the *inner* fetch — after this has approved it — so there is no mode, anywhere, in which the check is off. The
 * files host was added the same way: a second constant beside the first, not a parameter, and the photo host a third.
 */
export function guardSlackRequests(
  inner: FetchLike,
  permit: WritePermit,
  revocation?: Pick<RevokeBinding, 'ref' | 'kind'>,
): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    /*
     * The host, before anything else.
     *
     * This checked only the path, and the method name *is* the last path segment — so
     * `https://evil.example/api/auth.test` classified as a read and went out with the workspace's token on it.
     * The message below already claimed "this package only calls the Slack Web API"; now it is true.
     *
     * Compared as a parsed origin rather than a prefix: `https://slack.com.attacker.net/…` starts with the
     * right characters and is a different site.
     */
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CommsError('SEND_REFUSED', 'that is not a URL this package can call', {
        hint: 'This is a bug — please report it.',
      });
    }
    const actual = parsed.origin;
    if (actual !== SLACK_ORIGIN && actual !== SLACK_FILES_ORIGIN && actual !== SLACK_AVATARS_ORIGIN) {
      // The origin is named; the rest of the URL is not, because a query can carry a token.
      throw new CommsError(
        'SEND_REFUSED',
        `this package only calls ${SLACK_ORIGIN} and ${SLACK_FILES_ORIGIN}, and reads profile photos from ${SLACK_AVATARS_ORIGIN}; that request went to ${actual}`,
        { hint: 'This is a bug — please report it.' },
      );
    }
    /*
     * Credentials in the URL itself, at either host.
     *
     * `https://user@files.slack.com/…` has the right origin and is a request carrying a second credential nobody
     * here chose. Nothing in this package builds one; a link from Slack's reply could, which is where the files host
     * gets its URLs from.
     */
    if (parsed.username !== '' || parsed.password !== '') {
      if (actual === SLACK_FILES_ORIGIN) {
        throw refuseDownload('a URL carrying credentials is never called', 'wrong-host');
      }
      throw new CommsError('SEND_REFUSED', 'a URL carrying credentials is never called', {
        hint: 'This is a bug — please report it.',
      });
    }

    if (actual === SLACK_FILES_ORIGIN) {
      const verb = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      /*
       * Which of the two the path is decides which grant is asked, and each refuses everything its own grant does not
       * name. So a download path is shut inside an upload grant, and an upload path inside a download grant: neither
       * grant lends the host to anything but the one request it was opened for.
       */
      if (parsed.pathname === '/upload' || parsed.pathname.startsWith('/upload/')) checkUpload(parsed, verb, permit);
      else checkDownload(parsed, verb, permit);
      // The redirect rule below holds here too, and matters more: this request carries the token, and a 30x would
      // take it to an address chosen by whatever answered rather than by the path just checked.
      return inner(input, { ...init, redirect: 'error' });
    }

    if (actual === SLACK_AVATARS_ORIGIN) {
      const verb = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      checkAvatar(parsed, verb, headersOf(input, init), permit);
      // Not followed either: a redirect would be a second request, to a host nothing here checked.
      return inner(input, { ...init, redirect: 'error' });
    }

    const method = methodOfUrl(url);

    if (method === null) {
      throw new CommsError('SEND_REFUSED', `this package only calls the Slack Web API, and ${actual} is not it`, {
        hint: 'This is a bug — please report it.',
      });
    }

    const rule = methodRule(method);
    if (rule === null) {
      // The registry is the allowlist, so an unknown method is refused rather than assumed harmless. Whoever adds
      // the next one has to say what it does, which is the only moment anyone reliably asks whether it posts.
      throw new CommsError('SEND_REFUSED', `${method} is not a method this package is allowed to call`, {
        hint: 'Classify it in api/methods.ts as read, write or refused. This is a bug — please report it.',
      });
    }

    if (rule.kind === 'refused') {
      throw new CommsError('SEND_REFUSED', `${method} is deliberately not available: ${rule.note ?? 'by design'}`, {
        hint: 'This is a bug — please report it.',
      });
    }

    /*
     * A Slack app's own configuration: only inside a grant for exactly this method, and only once.
     *
     * Before the write branch and separate from it, so that branch is untouched: a configuration grant opens no
     * approval, and a post's approval opens no configuration grant. Without an open grant this refuses, whichever
     * token the request carries — so a workspace session that somehow named `apps.manifest.update` meets the same
     * door as a post with no approval.
     */
    if (rule.kind === 'configure') {
      if (permit.configuring !== method) {
        throw new CommsError(
          'SEND_REFUSED',
          `${method} changes a Slack app, and only this package's \`app\` commands may call it`,
          {
            hint: 'This is a bug — please report it.',
          },
        );
      }
      // One grant, one request, as with a post: the next call has to be opened on purpose.
      permit.configuring = null;
    }

    /*
     * One superseded bearer, named by the durable ledger row which owns it.
     *
     * The token itself is compared only here, at the request boundary. The open grant retains its digest, never the
     * bearer, and is consumed before the inner fetch can observe the request — a response or thrown transport can
     * never leave the same grant available for an accidental retry.
     */
    if (rule.kind === 'revoke') {
      const grant = permit.revoking;
      if (grant === null) {
        throw new CommsError('SEND_REFUSED', `${method} destroys a token, and no revocation grant is open`, {
          hint: 'This is a bug — please report it.',
        });
      }
      if (revocation?.ref !== grant.ref || revocation?.kind !== grant.kind) {
        throw new CommsError('SEND_REFUSED', 'the ledger entry or token kind does not match the revocation grant', {
          hint: 'This is a bug — please report it.',
        });
      }
      const requestHeaders =
        init?.headers !== undefined
          ? new Headers(init.headers)
          : input instanceof Request
            ? new Headers(input.headers)
            : new Headers();
      const authorization = requestHeaders.get('authorization');
      const token = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
      const actual = token === undefined ? null : createHash('sha256').update(token).digest();
      const expected = Buffer.from(grant.tokenSha256, 'hex');
      if (actual === null || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
        throw new CommsError('SEND_REFUSED', 'the bearer does not belong to the open revocation grant', {
          hint: 'This is a bug — please report it.',
        });
      }
      permit.revoking = null;
    }

    /*
     * `prepare` is not a write and must not spend the permit.
     *
     * `files.getUploadURLExternal` asks Slack where to put bytes and publishes nothing. Classifying it `write`
     * burned the one-shot permit on the preparation, so `files.completeUploadExternal` — the call that actually
     * makes the file visible — then found the door shut. The gate would have blocked the post and allowed the
     * upload, which is exactly backwards.
     */
    if (rule.kind === 'write') {
      if (permit.approvalId === null) {
        throw new CommsError('SEND_REFUSED', `${method} would post, and no approval is open`, {
          hint: 'Nothing is posted except through `send execute`, after an approval. This is a bug — please report it.',
        });
      }
      if (permit.method !== method) {
        throw new CommsError('SEND_REFUSED', `the open approval is for ${permit.method ?? 'nothing'}, not ${method}`, {
          hint: 'An approval covers one act. Prepare the one you mean.',
        });
      }
      // One permit, one request.
      permit.approvalId = null;
      permit.method = null;
    }

    /*
     * A redirect is a second request this never saw.
     *
     * Everything above validates the URL in hand; `fetch` then follows a 30x wherever it points, and the
     * header carrying a workspace token travels with it unless the runtime decides otherwise. That decision is
     * not ours to rely on, and the Slack Web API does not redirect — so a redirect here is either a mistake or
     * somebody's idea, and both are better as an error than as a request to an address nothing checked.
     */
    return inner(input, { ...init, redirect: 'error' });
  };
}

/**
 * Opens a permit for exactly one call to `method`, and closes it however `body` ends.
 *
 * The permit is closed in a `finally` rather than after a successful call, because the failure case is the one
 * that matters: a write that threw halfway must not leave a door open behind it for whatever runs next.
 */
export async function spendOn<T>(
  permit: WritePermit,
  approvalId: string,
  method: string,
  body: () => Promise<T>,
): Promise<T> {
  if (
    permit.approvalId !== null ||
    permit.revoking !== null ||
    permit.downloading !== null ||
    permit.uploading !== null ||
    permit.avatar !== null
  ) {
    throw new CommsError('SEND_REFUSED', 'a permit is already open; they do not nest', {
      hint: 'This is a bug — please report it.',
    });
  }
  permit.approvalId = approvalId;
  permit.method = method;
  try {
    return await body();
  } finally {
    permit.approvalId = null;
    permit.method = null;
  }
}

/**
 * Opens a grant for one `auth.revoke` request bound to one pending bundle and token.
 *
 * The ref and kind make the transport grant part of the durable cleanup identity; the digest proves that the bearer
 * attached at request time is the one the operation loaded from that bundle. Empty or mutable identities are refused,
 * and this opens none of the posting, configuration, download, or upload doors beside it.
 *
 * Internal to this package. Task 5's revocation operation is the sole production caller; the package root deliberately
 * exports neither this helper nor the permit which carries it.
 */
export async function revokeWith<T>(
  permit: WritePermit,
  method: string,
  binding: RevokeBinding,
  body: () => Promise<T>,
): Promise<T> {
  if (methodRule(method)?.kind !== 'revoke') {
    throw new CommsError('SEND_REFUSED', `${method} is not a token revocation method`, {
      hint: 'This is a bug — please report it.',
    });
  }
  if (
    binding.ref.length === 0 ||
    (binding.kind !== 'access' && binding.kind !== 'refresh') ||
    !/^[a-f0-9]{64}$/.test(binding.tokenSha256)
  ) {
    throw new CommsError('SEND_REFUSED', 'a revocation grant names one pending ref, token kind and bearer digest', {
      hint: 'This is a bug — please report it.',
    });
  }
  if (
    permit.approvalId !== null ||
    permit.configuring !== null ||
    permit.revoking !== null ||
    permit.downloading !== null ||
    permit.uploading !== null ||
    permit.avatar !== null
  ) {
    throw new CommsError('SEND_REFUSED', 'a permit is already open; they do not nest', {
      hint: 'This is a bug — please report it.',
    });
  }
  permit.revoking = Object.freeze({ ...binding });
  try {
    return await body();
  } finally {
    permit.revoking = null;
  }
}

/**
 * Opens a configuration grant for exactly one call to `method`, and closes it however `body` ends.
 *
 * The shape of `spendOn`, and deliberately not `spendOn`: changing an app is not a post, has no approval to name,
 * and must not be able to borrow one. It refuses to open while a post's permit is open, and refuses a method the
 * registry does not classify `configure`, so it cannot be used to open anything else.
 *
 * Not exported from the package root. `operations/app.ts` is the one caller, and a test fails if another appears.
 */
export async function configureWith<T>(permit: WritePermit, method: string, body: () => Promise<T>): Promise<T> {
  if (methodRule(method)?.kind !== 'configure') {
    throw new CommsError('SEND_REFUSED', `${method} is not a method that configures a Slack app`, {
      hint: 'This is a bug — please report it.',
    });
  }
  if (
    permit.approvalId !== null ||
    permit.configuring !== null ||
    permit.revoking !== null ||
    permit.downloading !== null ||
    permit.uploading !== null ||
    permit.avatar !== null
  ) {
    throw new CommsError('SEND_REFUSED', 'a permit is already open; they do not nest', {
      hint: 'This is a bug — please report it.',
    });
  }
  permit.configuring = method;
  try {
    return await body();
  } finally {
    permit.configuring = null;
  }
}

/**
 * Opens a download grant for exactly one `GET` of one file's bytes, and closes it however `body` ends.
 *
 * The third of the shape, beside `spendOn` and `configureWith`, and like them it lends nothing: it refuses to open
 * while a post's permit or a configuration grant is open, and neither opens while it is. The team and file must be
 * ones a path on the files host could name — Slack ids, with no `-` or `/` in them — or `<TEAM>-<FILEID>` could be
 * read more than one way, and the grant would name more than one file.
 *
 * Not exported from the package root. `api/download.ts` is the one caller, and a test fails if another appears.
 */
export async function downloadWith<T>(permit: WritePermit, file: FileOfPath, body: () => Promise<T>): Promise<T> {
  const named = fileOfPath(`/files-pri/${file.teamId}-${file.fileId}/file`);
  if (named === null || named.teamId !== file.teamId || named.fileId !== file.fileId) {
    throw refuseDownload('a download grant names one Slack team id and one Slack file id', 'wrong-path');
  }
  if (
    permit.approvalId !== null ||
    permit.configuring !== null ||
    permit.revoking !== null ||
    permit.downloading !== null ||
    permit.uploading !== null ||
    permit.avatar !== null
  ) {
    throw new CommsError('SEND_REFUSED', 'a permit is already open; they do not nest', {
      hint: 'This is a bug — please report it.',
    });
  }
  permit.downloading = { teamId: file.teamId, fileId: file.fileId };
  try {
    return await body();
  } finally {
    permit.downloading = null;
  }
}

/**
 * Opens an upload grant for exactly one `POST` of one file's bytes to `url`, and closes it however `body` ends.
 *
 * The fourth of the shape, and the one that is not a door of its own: it opens only inside a post's permit for
 * {@link UPLOAD_PUBLISHES}, which the gate opens after the person's approval has been claimed. So there is no way to
 * send a file's bytes that does not pass the approval first — and none to send them after the post has published,
 * since the guard asks again at the request.
 *
 * `url` is the `upload_url` Slack returned, whole. It must be on the files origin, under `/upload/`, with no
 * credentials and no fragment; the request is then compared with it exactly, so the grant names one URL and not a
 * pattern. It lends nothing and does not nest: no download, configuration, other upload or other post opens inside it.
 *
 * Not exported from the package root. `api/upload.ts` is the one caller, and a test fails if another appears.
 */
export async function uploadWith<T>(permit: WritePermit, url: string, body: () => Promise<T>): Promise<T> {
  let named: URL | undefined;
  try {
    named = new URL(url);
  } catch {
    named = undefined;
  }
  if (
    named === undefined ||
    named.origin !== SLACK_FILES_ORIGIN ||
    named.username !== '' ||
    named.password !== '' ||
    named.hash !== '' ||
    url.includes('#') ||
    !isUploadPath(named.pathname)
  ) {
    throw refuseUpload(`an upload grant names one URL under ${SLACK_FILES_ORIGIN}/upload/, as Slack gave it`);
  }
  if (permit.approvalId === null || permit.method !== UPLOAD_PUBLISHES) {
    throw refuseUpload(`a file is uploaded only inside an approved post, with the permit for ${UPLOAD_PUBLISHES} open`);
  }
  if (
    permit.configuring !== null ||
    permit.revoking !== null ||
    permit.downloading !== null ||
    permit.uploading !== null ||
    permit.avatar !== null
  ) {
    throw new CommsError('SEND_REFUSED', 'a permit is already open; they do not nest', {
      hint: 'This is a bug — please report it.',
    });
  }
  permit.uploading = named.href;
  try {
    return await body();
  } finally {
    permit.uploading = null;
  }
}

/**
 * Opens a photo grant for exactly one `GET` of one profile photo at `url`, and closes it however `body` ends.
 *
 * The fifth of the shape, and the narrowest: the photo host, a path, and nothing else. `url` must be on
 * {@link SLACK_AVATARS_ORIGIN} exactly — `https`, no port, no credentials — with a path and no query or fragment, so
 * the grant names one photo and not a pattern; the request is then compared with it whole. It lends nothing and does
 * not nest: no post, configuration, revocation, download, upload or other photo opens inside it, and it opens inside
 * none of them.
 *
 * Not exported from the package root. `api/avatar.ts` is the one caller, and a test fails if another appears.
 */
export async function avatarWith<T>(permit: WritePermit, url: string, body: () => Promise<T>): Promise<T> {
  let named: URL | undefined;
  try {
    named = new URL(url);
  } catch {
    named = undefined;
  }
  if (
    named === undefined ||
    named.origin !== SLACK_AVATARS_ORIGIN ||
    named.username !== '' ||
    named.password !== '' ||
    named.search !== '' ||
    named.hash !== '' ||
    url.includes('?') ||
    url.includes('#') ||
    named.pathname.length <= 1
  ) {
    throw refuseAvatar(`a photo grant names one photo on ${SLACK_AVATARS_ORIGIN}, by its path alone`);
  }
  if (
    permit.approvalId !== null ||
    permit.configuring !== null ||
    permit.revoking !== null ||
    permit.downloading !== null ||
    permit.uploading !== null ||
    permit.avatar !== null
  ) {
    throw new CommsError('SEND_REFUSED', 'a permit is already open; they do not nest', {
      hint: 'This is a bug — please report it.',
    });
  }
  permit.avatar = named.href;
  try {
    return await body();
  } finally {
    permit.avatar = null;
  }
}
