import { CommsError } from '@agentcomms/core';
import { methodOfUrl, methodRule, SLACK_ORIGIN } from './methods.ts';

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
}

export function closedPermit(): WritePermit {
  return { approvalId: null, method: null };
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Wraps `fetch` so every Slack call is classified before it leaves.
 *
 * `permit` is read at call time rather than captured, so opening and closing it around a single request is enough
 * to scope what that request may do.
 *
 * **The origin is hardcoded, and there is no argument for it.** The first attempt made it an option defaulting to
 * Slack's, on the reasoning that the check still always ran and only its target moved. That reasoning was wrong:
 * the type was exported from the package root, so any caller could name any origin, which is precisely the
 * production override it claimed not to be. A test reaches a fake Slack by rewriting an already-validated URL in
 * the *inner* fetch — after this has approved it — so there is no mode, anywhere, in which the check is off.
 */
export function guardSlackRequests(inner: FetchLike, permit: WritePermit): FetchLike {
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
    let actual: string;
    try {
      actual = new URL(url).origin;
    } catch {
      throw new CommsError('SEND_REFUSED', 'that is not a URL this package can call', {
        hint: 'This is a bug — please report it.',
      });
    }
    if (actual !== SLACK_ORIGIN) {
      // The origin is named; the rest of the URL is not, because a query can carry a token.
      throw new CommsError(
        'SEND_REFUSED',
        `this package only calls ${SLACK_ORIGIN}, and that request went to ${actual}`,
        { hint: 'This is a bug — please report it.' },
      );
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

    return inner(input, init);
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
  if (permit.approvalId !== null) {
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
