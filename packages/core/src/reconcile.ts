import { CommsError } from './errors.ts';
import type { SecretStore } from './secrets.ts';

/**
 * What to do with a credential after the config write that should have named it was rejected.
 *
 * A rejection does not mean nothing was written. `ConfigStore.update` commits atomically and *then* releases its lock
 * in a `finally`, and if that release throws the call rejects with the write already in. Deleting the credential
 * then deletes the one the configuration now names — a sign-in that worked, turned into an account with no token.
 * So every caller reads the configuration again first and asks one question: does it name this credential?
 *
 * - `present`: the write landed. Keep the credential; the operation succeeded.
 * - `absent`: it did not. Withdraw the credential, and say so if that fails.
 * - `unknown`: the configuration cannot be read. Keep the credential and say which one may be left behind — never
 *   treat an unreadable file as proof of absence, because the cost of being wrong is a live credential deleted.
 *
 * The Slack package reasoned this through first; these are its rules, shared.
 */
export type WriteOutcome = 'present' | 'absent' | 'unknown';

export async function writeOutcome(check: () => Promise<boolean>): Promise<WriteOutcome> {
  try {
    return (await check()) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/** The original error, with the credential it may have left behind named — and deliberately not deleted. */
export function keepAndReport(original: unknown, ref: string, howToCheck: string): CommsError {
  const base = original instanceof CommsError ? original : new CommsError('UNEXPECTED', String(original));
  return new CommsError(base.code, base.message, {
    hint:
      `${base.hint ? `${base.hint} ` : ''}Whether this was saved could not be confirmed, so the credential stored ` +
      `for it was kept rather than risk deleting a live one. ${howToCheck} If it is not there, delete \`${ref}\` ` +
      'from your secret store.',
    details: { possiblyStrandedSecretRef: ref },
    cause: original,
  });
}

/**
 * Takes back a credential stored for an attempt that then failed, and says so if it cannot.
 *
 * One retry, because a keychain prompt dismissed by accident is common and a second chance is cheap; if that fails
 * too, the original error comes back **with the stranded reference attached**, so the leak is something a person is
 * told about rather than something they would have to know to look for. A `false` from `delete` is not a failure:
 * nothing was stored, so there is nothing to take back.
 */
export async function withdrawStaged(secrets: SecretStore, ref: string, original: unknown): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await secrets.delete(ref);
      return original;
    } catch (error) {
      last = error;
    }
  }
  const base = original instanceof CommsError ? original : new CommsError('UNEXPECTED', String(original));
  return new CommsError(base.code, base.message, {
    hint: `${base.hint ? `${base.hint} ` : ''}A credential stored for this attempt could not be removed: delete \`${ref}\` from your secret store.`,
    details: { strandedSecretRef: ref, cleanupError: (last as Error | undefined)?.message },
    cause: original,
  });
}
