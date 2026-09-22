import { CommsError, type Config, type Core, openCore, type SecretStore, secretsStoreOf } from '@agentcomms/core';
import { closedPermit, guardSlackRequests } from './api/guard.ts';
import { SLACK_ORIGIN } from './api/methods.ts';
import { type FlowStore, openFlowStore } from './auth/flow.ts';

/**
 * What every Slack operation needs, assembled once.
 *
 * The same shape as `GmailContext`, deliberately. Two packages in one repository that assemble their world
 * differently are two packages nobody can move between, and everything here — config, secrets, a flow store, a
 * clock — is the same list for the same reasons.
 */

export interface SlackContextOptions {
  core?: Core;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  surface?: 'cli' | 'mcp';
  /** Exchanges an authorisation code. Injected so a test never reaches Slack. */
  exchange?: (params: Record<string, string>) => Promise<unknown>;
}

/**
 * The token exchange, through the same guard as everything else.
 *
 * It would have been easy to call `fetch` here: the URL is built from `SLACK_ORIGIN`, so it cannot go anywhere
 * else, and `oauth.v2.access` is classified `auth`, so a closed permit lets it through untouched. But the guard's
 * own comment says it is *the one door every Slack request goes through*, and a request that skips it makes that
 * false — which is how the next one gets written the same way, by somebody reading this as the precedent.
 *
 * It carries no credential, which is what PKCE is for. Slack's guide is explicit that a PKCE client "should call
 * the `oauth.v2.access` API method, but should not include `client_secret`", so what proves this request is the
 * verifier, which never left the machine that generated it.
 */
async function postExchange(params: Record<string, string>): Promise<unknown> {
  const send = guardSlackRequests(fetch, closedPermit());
  const response = await send(new URL('/api/oauth.v2.access', SLACK_ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });
  // Slack answers 200 with `ok:false` for a refusal, so the status is not the thing to read — but a 5xx has no
  // JSON body at all, and letting `json()` throw would report a parse error for an outage.
  if (!response.ok && response.status >= 500) {
    throw new CommsError('TRANSIENT', `Slack returned ${response.status} for the token exchange`, {
      hint: 'Try again in a moment.',
    });
  }
  try {
    return await response.json();
  } catch {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack’s reply to the token exchange was not readable', {
      hint: 'Try again; if it persists, check https://status.slack.com.',
    });
  }
}

export class SlackContext {
  readonly core: Core;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  readonly surface: 'cli' | 'mcp';
  readonly flows: FlowStore;
  readonly exchange: (params: Record<string, string>) => Promise<unknown>;

  constructor(options: SlackContextOptions = {}) {
    this.env = options.env ?? process.env;
    this.core = options.core ?? openCore({ env: this.env });
    this.now = options.now ?? (() => new Date());
    this.surface = options.surface ?? 'cli';
    this.flows = openFlowStore(this.core.paths.stateDir, this.now);
    this.exchange = options.exchange ?? postExchange;
  }

  config(): Promise<Config> {
    return this.core.config.load();
  }

  /** The secret store this configuration chose, or the default before anything has been stored. */
  async secrets(): Promise<SecretStore> {
    return this.core.secrets(secretsStoreOf(await this.config()));
  }
}
