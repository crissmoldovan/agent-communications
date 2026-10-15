import { CommsError, type ErrorCode } from '@agentcomms/core';
import { avatarWith, closedPermit, type FetchLike, guardSlackRequests } from './guard.ts';
import { SLACK_AVATARS_ORIGIN } from './methods.ts';

/**
 * The signed-in person's profile photo, from Slack's photo host, through the guard — and with no token on it.
 *
 * `icon make` puts a badge on the photo, so it needs the picture's bytes. Slack names the photo in `users.info`
 * (`profile.image_512`), on `avatars.slack-edge.com`, which serves it to anybody with the address. So this sends
 * nothing but the request: no `Authorization`, no cookie — the guard refuses a request to that host that carries
 * either — and the link is not followed as given. It is parsed, held to the photo host exactly, and rebuilt from that
 * origin and its path, so its query, its fragment and anything else about it do not travel.
 *
 * A photo kept anywhere else is refused before any request exists: a person with no photo of their own has a Gravatar
 * link or Slack's default picture there, and neither is theirs to badge.
 *
 * What comes back is held to a cap while it arrives, and to a time, and refused when it is plainly not a picture —
 * a web page, an error, or anything that does not say it is an image. Whether it is a PNG or a JPEG is the decoder's to
 * decide, from the bytes: a type in a header is the host's claim.
 */

/**
 * The most a profile photo may be: 5 MiB.
 *
 * Slack's 512-pixel photos are tens of kilobytes. The cap is many times that, so a large photo Slack chose to keep is
 * still read, and small enough that a host answering with something else entirely cannot fill memory with it.
 */
export const AVATAR_MAX_BYTES: number = 5 * 1024 * 1024;

/** How long the whole photo may take, unless a test says otherwise (`timeoutMs`). */
const AVATAR_TIME_MS = 30_000;

export interface AvatarCall {
  /** The inner fetch the guard wraps: the real one in production, a loopback rewrite in tests. */
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface AvatarBody {
  bytes: Buffer;
  /** The response's media type, lower-cased and without parameters, or null when it sent none. The host's claim. */
  contentType: string | null;
}

function refused(code: ErrorCode, message: string, hint: string): CommsError {
  return new CommsError(code, message, { hint });
}

const NO_PHOTO_HINT =
  'Add a profile photo in Slack (your profile, then Upload photo), then make the icon again. Nothing was saved.';

/**
 * Slack's link to the photo, checked and rebuilt, or a refusal.
 *
 * The link is not printed in any refusal: its path is Slack's, but a Gravatar link carries an address's digest, and a
 * person reading the error needs only to know which kind of photo it was.
 */
export function checkedAvatarUrl(link: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw refused('BAD_DATA', 'Slack’s link to the profile photo is not a URL', NO_PHOTO_HINT);
  }
  if (parsed.origin !== SLACK_AVATARS_ORIGIN || parsed.username !== '' || parsed.password !== '') {
    throw refused(
      'BAD_DATA',
      `this account’s profile photo is not kept on ${SLACK_AVATARS_ORIGIN}, so it is not read`,
      `It is most likely a Gravatar or Slack’s default picture. ${NO_PHOTO_HINT}`,
    );
  }
  if (parsed.pathname.length <= 1) {
    throw refused('BAD_DATA', 'Slack’s link to the profile photo names no photo', NO_PHOTO_HINT);
  }
  return new URL(parsed.pathname, SLACK_AVATARS_ORIGIN);
}

function mediaTypeOf(header: string | null): string | null {
  const type = header?.split(';')[0]?.trim().toLowerCase();
  return type ? type : null;
}

function codeForStatus(status: number): ErrorCode {
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 429 || status >= 500) return 'TRANSIENT';
  return 'PROVIDER_UNAVAILABLE';
}

/** Whether a failed `fetch` failed because it met a redirect, which the guard told it to treat as an error. */
function isRefusedRedirect(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause;
  return typeof cause?.message === 'string' && /redirect/i.test(cause.message);
}

/**
 * Downloads the photo `link` names, or throws a `CommsError` saying why not.
 *
 * Every wait — for the answer, and for each piece of the body — is raced against one deadline the code here rejects,
 * as `download.ts` learned to do: an abort handed to `fetch` alone did not always wake a read that had stalled.
 */
export async function slackAvatarDownload(
  call: AvatarCall,
  link: string,
  maxBytes: number = AVATAR_MAX_BYTES,
): Promise<AvatarBody> {
  const cap = Math.min(Math.max(0, Math.floor(maxBytes)), AVATAR_MAX_BYTES);
  const url = checkedAvatarUrl(link);
  const permit = closedPermit();
  const send = guardSlackRequests(call.fetch ?? (fetch as FetchLike), permit);

  const controller = new AbortController();
  let outOfTime = false;
  let give: (reason: unknown) => void = () => undefined;
  const up = new Promise<never>((_, reject) => {
    give = reject;
  });
  up.catch(() => undefined);
  const stop = (reason: unknown): void => {
    controller.abort(reason);
    give(reason);
  };
  const timer = setTimeout(() => {
    outOfTime = true;
    stop(new DOMException('the photo took too long', 'TimeoutError'));
  }, call.timeoutMs ?? AVATAR_TIME_MS);
  const forward = (): void => stop(call.signal?.reason);
  if (call.signal?.aborted) forward();
  else call.signal?.addEventListener('abort', forward, { once: true });
  const within = <T>(work: Promise<T>): Promise<T> => Promise.race([work, up]);
  const lost = (): CommsError =>
    refused(
      'TRANSIENT',
      outOfTime
        ? `${SLACK_AVATARS_ORIGIN} did not send the photo in time`
        : `could not fetch the profile photo from ${SLACK_AVATARS_ORIGIN}`,
      'Check the network, then try again. Nothing was saved.',
    );
  const tooLarge = (): CommsError =>
    refused('BAD_DATA', `the profile photo is larger than ${cap} bytes`, 'Nothing of it was saved.');

  try {
    return await avatarWith(permit, url.href, async () => {
      let response: Response;
      try {
        response = await within(send(url, { method: 'GET', signal: controller.signal }));
      } catch (error) {
        if (error instanceof CommsError) throw error;
        if (isRefusedRedirect(error)) {
          throw refused(
            'PROVIDER_UNAVAILABLE',
            `${SLACK_AVATARS_ORIGIN} answered with a redirect, which is never followed`,
            'Nothing was saved.',
          );
        }
        throw lost();
      }
      const discard = (): void => {
        response.body?.cancel().catch(() => undefined);
      };
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        discard();
        throw refused(
          'PROVIDER_UNAVAILABLE',
          `${SLACK_AVATARS_ORIGIN} answered with a redirect, which is never followed`,
          'Nothing was saved.',
        );
      }
      if (!response.ok) {
        discard();
        throw refused(
          codeForStatus(response.status),
          `${SLACK_AVATARS_ORIGIN} answered ${response.status} for the profile photo`,
          response.status === 429 || response.status >= 500 ? 'Try again shortly.' : NO_PHOTO_HINT,
        );
      }
      /*
       * Not a picture, by the host's own account: a web page, a JSON error, plain text. Refused before a byte of it is
       * read. A type that does say `image/` is still only a claim, and the decoder decides from the bytes.
       */
      const contentType = mediaTypeOf(response.headers.get('content-type'));
      if (contentType !== null && !contentType.startsWith('image/')) {
        discard();
        throw refused(
          'BAD_DATA',
          `${SLACK_AVATARS_ORIGIN} answered with ${contentType}, not a picture`,
          'Try again later. Nothing was saved.',
        );
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > cap) {
        discard();
        throw tooLarge();
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader !== undefined) {
        try {
          for (;;) {
            const { done, value } = await within(reader.read());
            if (done) break;
            total += value.byteLength;
            if (total > cap) throw tooLarge();
            chunks.push(value);
          }
        } catch (error) {
          reader.cancel().catch(() => undefined);
          if (error instanceof CommsError) throw error;
          throw lost();
        }
      }
      return { bytes: Buffer.concat(chunks, total), contentType };
    });
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', forward);
  }
}
