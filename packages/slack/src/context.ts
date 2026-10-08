import {
  type CliHandoffs,
  CommsError,
  type Config,
  type Core,
  openCore,
  type PathOverrides,
  requireHandoffs,
  type SecretStore,
  type SendPacing,
  secretsStoreOf,
  sendPacing,
} from '@agentcomms/core';
import { closedPermit, type FetchLike, guardSlackRequests } from './api/guard.ts';
import { SLACK_ORIGIN } from './api/methods.ts';
import { type FlowStore, openFlowStore } from './auth/flow.ts';
import type { PersistPolicy } from './auth/refresh.ts';
import { SLACK_CALLER } from './caller.ts';

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
  /** Explicit suite directories, resolved before any store is constructed. */
  pathOverrides?: PathOverrides;
  now?: () => Date;
  /** The shell syntax used for commands an operation returns or prints. */
  platform?: NodeJS.Platform | undefined;
  surface?: 'cli' | 'mcp';
  /**
   * The folder the process was started in: what a download offers as "the current folder". The process's own when
   * left out; a test names a temporary one, since a test process cannot change its own without changing every test's.
   */
  cwd?: string | undefined;
  /** Exchanges an authorisation code. Injected so a test never reaches Slack. */
  exchange?: (params: Record<string, string>) => Promise<unknown>;
  /** The guarded Web API's inner fetch. Tests point it at loopback; production leaves it as global fetch. */
  fetch?: FetchLike | undefined;
  /** The Slack Web API origin. Tests normally keep the real origin and rewrite only after the guard. */
  slackBaseUrl?: string | undefined;
  /**
   * How patiently a renewed credential's write is retried, on every surface. Tests shorten the minute it takes in
   * production, so a store that never recovers can be driven through a whole command.
   */
  persist?: PersistPolicy | undefined;
  /** The CLI owns only in-process sign-ins, registered before their first persistent write. */
  foregroundSignIn?:
    | {
        signal: AbortSignal;
        /** Resolves to the completion error, if any; ownership errors must survive cancellation. */
        register(flowId: string, settled: Promise<unknown>): void;
      }
    | undefined;
  /** How a throttled post, reaction, edit or deletion waits (design 2026-10-08 §R2): core's; a test injects one. */
  sendPacing?: (() => SendPacing) | undefined;
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
  /*
   * Bounded, because a refresh makes this call while holding the credentials lock and the account's own lock.
   * Without a deadline a Slack endpoint that accepts the connection and then says nothing would hold both for as
   * long as the socket stayed open — blocking every credential operation on the machine, not just this one. The
   * refresh contract asks the caller to bound the exchange; this is the caller.
   */
  const response = await send(new URL('/api/oauth.v2.access', SLACK_ORIGIN), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  /*
   * Slack answers 200 with `ok:false` for a refusal, so the status is not the thing to read — but a 5xx has no
   * JSON body at all, and letting `json()` throw would report a parse error for an outage.
   *
   * Every failure here says which step it was and what status came back, in `details`. A refresh decides from
   * that whether the token it sent may have been used: a 429 is the rate limiter turning the request away
   * (Slack's `ratelimited`, often with no body), while a 5xx or an unreadable reply may have followed a request
   * Slack acted on. Fetch's own rejection is left to propagate untouched, because its `cause` code is the evidence
   * of whether anything was sent at all.
   */
  if (response.status === 429) {
    throw new CommsError('TRANSIENT', 'Slack is rate-limiting the token exchange', {
      hint: 'Try again shortly.',
      details: { stage: 'http', httpStatus: 429, slackError: 'ratelimited' },
    });
  }
  if (!response.ok && response.status >= 500) {
    throw new CommsError('TRANSIENT', `Slack returned ${response.status} for the token exchange`, {
      hint: 'Try again in a moment.',
      details: { stage: 'http', httpStatus: response.status },
    });
  }
  try {
    return await response.json();
  } catch {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack’s reply to the token exchange was not readable', {
      hint: 'Try again; if it persists, check https://status.slack.com.',
      details: { stage: 'unreadable', httpStatus: response.status },
    });
  }
}

export class SlackContext {
  readonly core: Core;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  /** A fresh pacing for each act: how a throttled one waits before it tries again. */
  readonly sendPacing: () => SendPacing;
  readonly platform: NodeJS.Platform;
  readonly surface: 'cli' | 'mcp';
  readonly cwd: string;
  readonly flows: FlowStore;
  readonly exchange: (params: Record<string, string>) => Promise<unknown>;
  readonly fetch: FetchLike | undefined;
  readonly slackBaseUrl: string | undefined;
  readonly persist: PersistPolicy | undefined;
  readonly foregroundSignIn: SlackContextOptions['foregroundSignIn'];

  constructor(options: SlackContextOptions = {}) {
    this.env = options.env ?? process.env;
    this.core =
      options.core ??
      openCore({
        env: this.env,
        platform: options.platform ?? process.platform,
        ...(options.pathOverrides ? { pathOverrides: options.pathOverrides } : {}),
        caller: SLACK_CALLER,
      });
    this.now = options.now ?? (() => new Date());
    this.sendPacing = options.sendPacing ?? (() => sendPacing());
    this.foregroundSignIn = options.foregroundSignIn;
    this.platform = options.platform ?? process.platform;
    this.surface = options.surface ?? 'cli';
    this.cwd = options.cwd ?? process.cwd();
    // Made now, so a core without this package's caller is refused where the context is made, not at a refusal.
    this.flows = openFlowStore(this.core.paths.stateDir, this.now, this.handoffs);
    this.exchange = options.exchange ?? postExchange;
    this.fetch = options.fetch;
    this.slackBaseUrl = options.slackBaseUrl;
    this.persist = options.persist;
  }

  /**
   * The commands this process tells a person to run, quoted for its shell: Slack's own, core's, another product's, each
   * located from this installation with its folders pinned, or why there is none here (CONTRIBUTING.md, "Telling a
   * person what to run"). A core given without Slack's caller is a programming error, refused here rather than printing
   * a bare `agent-slack` nobody's PATH has.
   */
  get handoffs(): CliHandoffs {
    return requireHandoffs(this.core).on(this.platform);
  }

  config(): Promise<Config> {
    return this.core.config.load();
  }

  /** The secret store this configuration chose, or the default before anything has been stored. */
  async secrets(): Promise<SecretStore> {
    return this.core.secrets(secretsStoreOf(await this.config()));
  }
}
