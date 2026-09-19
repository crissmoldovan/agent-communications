import { CommsError } from '@cloudpixel/comms-core';

/** Where Google lives. Tests point everything at a local fake server; nothing else may redirect it. */
export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  /** Root for the Gmail client, with a trailing slash. */
  gmailRoot: string;
  /** Root for the People client, with a trailing slash. */
  peopleRoot: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  gmailRoot: 'https://gmail.googleapis.com/',
  peopleRoot: 'https://people.googleapis.com/',
};

/**
 * True when this module was loaded from TypeScript source — which is to say, from a checkout, never from a release.
 *
 * The published packages are bundles: `dist/*.mjs`. So this is a distinction an attacker cannot flip without
 * replacing the installed files, and at that point the endpoint override is the least of anybody's problems.
 */
const RUNNING_FROM_SOURCE = import.meta.url.endsWith('.ts');

/**
 * `AGENT_COMMS_GOOGLE_ROOT_URL` replaces every Google endpoint with a local test server, so the tests exercise the
 * real bundled Google libraries — token refresh included — instead of a test-only code path.
 *
 * **It is ignored entirely in a released build**, and that is not belt-and-braces. Anyone able to influence this
 * process's environment — an `env` block added to an MCP server entry in a client's config file, a shell profile, a
 * launchd unit — could otherwise point the token endpoint at a local server of their own and receive every inbox's
 * refresh token and the OAuth client secret in cleartext, the moment a token was refreshed. That is precisely the
 * actor this package designs against elsewhere: one with file-write access and no mailbox access. The loopback
 * restriction below does not help, because a local attacker is already local.
 */
export function resolveEndpoints(env: NodeJS.ProcessEnv): GoogleEndpoints {
  const override = env.AGENT_COMMS_GOOGLE_ROOT_URL;
  if (!override || !RUNNING_FROM_SOURCE) return GOOGLE_ENDPOINTS;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new CommsError('CONFIG', 'AGENT_COMMS_GOOGLE_ROOT_URL is not a URL');
  }
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    throw new CommsError('CONFIG', 'AGENT_COMMS_GOOGLE_ROOT_URL may only point at a loopback test server', {
      details: { host: url.hostname },
    });
  }
  const root = url.origin;
  return {
    authUrl: `${root}/o/oauth2/v2/auth`,
    tokenUrl: `${root}/token`,
    revokeUrl: `${root}/revoke`,
    gmailRoot: `${root}/`,
    peopleRoot: `${root}/`,
  };
}

/** Loopback by address, never by name: only `localhost` is trusted as a name, and only because Node resolves it locally. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
