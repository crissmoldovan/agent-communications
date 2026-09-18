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
 * `AGENT_COMMS_GOOGLE_ROOT_URL` replaces every Google endpoint with a local test server, so the tests exercise the
 * real bundled Google libraries — token refresh included — instead of a test-only code path. It is honoured only for
 * loopback hosts, so it cannot redirect tokens anywhere else.
 */
export function resolveEndpoints(env: NodeJS.ProcessEnv): GoogleEndpoints {
  const override = env.AGENT_COMMS_GOOGLE_ROOT_URL;
  if (!override) return GOOGLE_ENDPOINTS;
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
