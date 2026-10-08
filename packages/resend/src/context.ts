import {
  type CliHandoffs,
  CommsError,
  type Config,
  type Core,
  handoffSentence,
  openCore,
  type PathOverrides,
  requireHandoffs,
  type SecretStore,
  type SendPacing,
  type SendPolicy,
  secretsStoreOf,
  sendPacing,
} from '@agentcomms/core';
import { AccountStore, type NamedAccount } from './accounts.ts';
import type { ResendTransport } from './api/client.ts';
import type { FetchLike, WritePermit } from './api/guard.ts';
import { Throttle, type ThrottleOptions } from './api/throttle.ts';
import { PACKAGE_NAME, RESEND_CALLER } from './caller.ts';

/**
 * What every Resend operation needs, assembled once — the same shape as the Gmail and Slack contexts.
 *
 * The key is read from core's secret store here and nowhere else, handed to one transport, and never put in a result.
 */

export interface ResendContextOptions {
  /** Core, opened with this package as its caller (`RESEND_CALLER`); opened that way here when left out. */
  core?: Core | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Explicit suite directories, resolved before any store is constructed. */
  pathOverrides?: PathOverrides | undefined;
  now?: (() => Date) | undefined;
  /** The shell syntax used for commands an operation returns or prints. */
  platform?: NodeJS.Platform | undefined;
  surface?: 'cli' | 'mcp' | undefined;
  /** The inner fetch every request goes through, always inside the guard. Injected so a test never reaches Resend. */
  fetch?: FetchLike | undefined;
  /** The throttle's clock and pause. Tests shorten the pause; nothing a person or an agent passes can. */
  throttle?: ThrottleOptions | undefined;
  /** How a throttled send waits (design 2026-10-08 §R2): core's pacing; a test injects one on the throttle's clock. */
  sendPacing?: (() => SendPacing) | undefined;
}

const TEAM_DOMAINS_TTL_MS = 5 * 60 * 1000;

/**
 * The commands this package prints, located from it (CUE-403): core has to have been opened with Resend as its caller.
 * A core opened without one — or as another package — would print bare names, or that package's commands for Resend's,
 * so it is a programming error here rather than a sentence a person reads.
 */
function resendHandoffs(core: Core): CliHandoffs {
  const handoffs = requireHandoffs(core);
  if (handoffs.caller.packageName !== PACKAGE_NAME) {
    throw new TypeError(
      `core was opened as ${handoffs.caller.packageName}, so it would print that package's commands for Resend's: open it with RESEND_CALLER`,
    );
  }
  return handoffs;
}

export class ResendContext {
  readonly core: Core;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  readonly platform: NodeJS.Platform;
  readonly surface: 'cli' | 'mcp';
  /**
   * What every result, refusal and hint names for a person to run: Resend's own CLI as this installation runs it, or
   * core's through its installed dependency (`own`, `core`), quoted for `platform` — or why there is none here.
   */
  readonly handoffs: CliHandoffs;
  readonly accounts: AccountStore;
  readonly #fetch: FetchLike | undefined;
  /** A fresh pacing for each send: how a throttled one waits before it tries again. */
  readonly sendPacing: () => SendPacing;
  readonly #throttle: Throttle;
  readonly #teamDomains = new Map<string, { at: number; domains: readonly string[] }>();

  constructor(options: ResendContextOptions = {}) {
    this.env = options.env ?? process.env;
    this.core =
      options.core ??
      openCore({
        env: this.env,
        platform: options.platform ?? process.platform,
        ...(options.pathOverrides ? { pathOverrides: options.pathOverrides } : {}),
        caller: RESEND_CALLER,
      });
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
    this.surface = options.surface ?? 'cli';
    this.handoffs = resendHandoffs(this.core).on(this.platform);
    this.accounts = new AccountStore(() => this.core.config.load(), this.handoffs);
    this.#fetch = options.fetch;
    this.#throttle = new Throttle(this.core.paths.stateDir, options.throttle);
    this.sendPacing = options.sendPacing ?? (() => sendPacing());
  }

  config(): Promise<Config> {
    return this.core.config.load();
  }

  /** The secret store this configuration chose, or the keychain before anything has been stored. */
  async secrets(): Promise<SecretStore> {
    return this.core.secrets(secretsStoreOf(await this.config()));
  }

  /** The machine's default send policy, which an account without one of its own inherits. */
  async defaultSendPolicy(): Promise<SendPolicy> {
    return (await this.config()).defaults.sendPolicy;
  }

  /**
   * The machine's one Resend throttle. Not one per account: Resend's budget is the team's, and nothing here can tell
   * which accounts share a team, so every account — and a key being checked before it is stored — shares one.
   */
  throttle(): Throttle {
    return this.#throttle;
  }

  /**
   * The team's verified domains for an account, from `load` at most every five minutes in this process: received mail
   * is read a page at a time, and asking Resend for the same list before every page would spend the team's budget on
   * an answer that changes when a person adds a domain.
   */
  async teamDomains(accountId: string, load: () => Promise<readonly string[]>): Promise<readonly string[]> {
    const cached = this.#teamDomains.get(accountId);
    const now = this.now().getTime();
    if (cached && now - cached.at < TEAM_DOMAINS_TTL_MS) return cached.domains;
    const domains = await load();
    this.#teamDomains.set(accountId, { at: now, domains });
    return domains;
  }

  /** A transport for a key that is not stored yet — `account add` checking what it was given. */
  transportForKey(key: string): ResendTransport {
    return { fetch: this.#fetch, key, throttle: this.#throttle };
  }

  /** A transport for a connected account: its key from the secret store, the machine's throttle, and any open permit. */
  async transport(named: NamedAccount, permit?: WritePermit): Promise<ResendTransport> {
    const key = await (await this.secrets()).get(named.account.secretRef);
    if (key === null || key.trim() === '') {
      throw new CommsError('AUTH_REQUIRED', `the key for "${named.name}" is not in the secret store`, {
        hint: handoffSentence(
          this.handoffs.own(['account', 'add', named.name]),
          (command) => `A person removes the account and adds it again: ${command}.`,
        ),
      });
    }
    return { fetch: this.#fetch, key, throttle: this.#throttle, permit };
  }
}
