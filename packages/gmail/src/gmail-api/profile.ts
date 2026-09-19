import { CommsError } from '@agentcomms/core';
import type { GoogleEndpoints } from '../auth/endpoints.ts';
import { describeGoogleError, mapGoogleError } from './errors.ts';

/**
 * `users.getProfile` with an access token in hand, before any inbox exists to build a transport for. Used by the
 * post-consent identity check, where Gmail — not the ID token, and not what the user typed — is the authority on
 * which mailbox was just authorised.
 */
export async function getProfileWithToken(
  endpoints: GoogleEndpoints,
  accessToken: string,
): Promise<{ emailAddress: string }> {
  let response: Response;
  const url = new URL('gmail/v1/users/me/profile', endpoints.gmailRoot);
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'could not reach Gmail to confirm which account this is', {
      cause: error,
    });
  }
  const body = (await response.json().catch(() => ({}))) as { emailAddress?: string; error?: unknown };
  if (!response.ok) {
    const failure = { response: { status: response.status, data: body } };
    throw mapGoogleError(failure, { operation: 'confirm which account signed in', api: 'gmail' });
  }
  if (!body.emailAddress) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Gmail did not say which address this is', {
      details: { status: describeGoogleError(body).status },
    });
  }
  return { emailAddress: body.emailAddress };
}
