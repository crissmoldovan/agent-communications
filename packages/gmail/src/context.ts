import {
  type ClientConfig,
  type CliHandoffs,
  CommsError,
  type Config,
  type Core,
  handoffSentenceToFill,
  type InboxConfig,
  openCore,
  type PathOverrides,
  requireHandoffs,
  requireInbox,
  type SendPacing,
  sendPacing,
} from '@agentcomms/core';
import { type GoogleEndpoints, resolveEndpoints } from './auth/endpoints.ts';
import { FlowStore } from './auth/flows.ts';
import { type Capability, capabilitiesOf, grantHint } from './auth/scopes.ts';
import { TokenSource } from './auth/session.ts';
import { GMAIL_CALLER } from './caller.ts';
import { type GmailTransport, GoogleGmailTransport } from './gmail-api/transport.ts';
import { HistoryCache } from './operations/history-cache.ts';

export interface ResolvedInbox {
  alias: string;
  inbox: InboxConfig;
}

/** Everything needed to build a transport for one inbox. Tests replace the factory; nothing else varies. */
export interface TransportRequest {
  resolved: ResolvedInbox;
  client: ClientConfig;
  context: GmailContext;
}

export interface GmailContextOptions {
  /** Opened with Gmail's caller (`GMAIL_CALLER`), so the commands it prints are located; opened here when left out. */
  core?: Core;
  env?: NodeJS.ProcessEnv;
  /** Explicit suite directories, resolved before any store is constructed. */
  pathOverrides?: PathOverrides;
  now?: () => Date;
  /** The shell syntax used for commands an operation returns or prints. */
  platform?: NodeJS.Platform | undefined;
  /** Which surface is calling: for the audit log, and for refusals that name the next step as that surface takes it. */
  surface?: 'cli' | 'mcp';
  /**
   * The folder the process was started in: what a download offers as "the current folder". The process's own when
   * left out; a test names a temporary one, since a test process cannot change its own without changing every test's.
   */
  cwd?: string | undefined;
  /** Replaced in tests by a fake; the default builds the real Google transport. */
  createTransport?: (request: TransportRequest) => GmailTransport;
  /** How a throttled send waits (design 2026-10-08 §R2): core's pacing; a test injects one that does not wait. */
  sendPacing?: () => SendPacing;
}

/**
 * What every operation needs: the core stores, the Google endpoints, and a transport per inbox. Config is read afresh
 * on each use rather than cached here, so an inbox added or a policy tightened through the CLI applies to the next
 * call of an MCP server that is already running.
 */
export class GmailContext {
  readonly core: Core;
  readonly env: NodeJS.ProcessEnv;
  readonly endpoints: GoogleEndpoints;
  readonly flows: FlowStore;
  readonly now: () => Date;
  /** A fresh pacing for each send: how a throttled one waits before it tries again. */
  readonly sendPacing: () => SendPacing;
  readonly platform: NodeJS.Platform;
  readonly surface: 'cli' | 'mcp';
  readonly cwd: string;
  readonly #createTransport: (request: TransportRequest) => GmailTransport;
  #historyCache: HistoryCache | undefined;
  readonly #transports = new Map<string, GmailTransport>();
  #handoffs: CliHandoffs | undefined;

  constructor(options: GmailContextOptions = {}) {
    this.env = options.env ?? process.env;
    this.core =
      options.core ??
      openCore({
        env: this.env,
        platform: options.platform ?? process.platform,
        ...(options.pathOverrides ? { pathOverrides: options.pathOverrides } : {}),
        caller: GMAIL_CALLER,
      });
    this.endpoints = resolveEndpoints(this.env);
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? process.platform;
    this.surface = options.surface ?? 'cli';
    this.cwd = options.cwd ?? process.cwd();
    this.flows = new FlowStore(this.core.paths.stateDir, this.now, this.surface, () => this.handoffs);
    this.#createTransport = options.createTransport ?? defaultTransport;
    this.sendPacing = options.sendPacing ?? (() => sendPacing());
  }

  /**
   * What recipient analyses learned from Sent, shared for ten minutes across every process using this state directory
   * (design 2026-10-05 §D4). Made on first use, so a call that studies no recipient — a wait, a list — never touches
   * it. A test replaces it with one whose writes fail.
   */
  get historyCache(): HistoryCache {
    this.#historyCache ??= new HistoryCache(this.core.paths.stateDir, { now: this.now });
    return this.#historyCache;
  }

  set historyCache(cache: HistoryCache) {
    this.#historyCache = cache;
  }

  /**
   * The commands this context tells a person to run — Gmail's own, core's — located from this installation for its
   * folders, and quoted for its shell (CUE-403; CONTRIBUTING.md, "Telling a person what to run"). A core opened without
   * Gmail's caller has none, and that is a programming error: every entry point opens it with `GMAIL_CALLER`.
   */
  get handoffs(): CliHandoffs {
    this.#handoffs ??= requireHandoffs(this.core).on(this.platform);
    return this.#handoffs;
  }

  config(): Promise<Config> {
    return this.core.config.load();
  }

  /** Resolves an alias against the current config, failing with the known aliases when it is not one. */
  async inbox(alias: string): Promise<ResolvedInbox> {
    const config = await this.config();
    return { alias, inbox: requireInbox(config, alias) };
  }

  async client(name: string): Promise<ClientConfig> {
    const config = await this.config();
    const client = config.clients[name];
    if (client) return client;
    throw new CommsError('CONFIG', `no OAuth client called "${name}" is registered`, {
      hint: handoffSentenceToFill(
        this.handoffs.own(['client', 'add']),
        ['<client_secret.json>'],
        (command) => `Add one with ${command}.`,
      ),
    });
  }

  /**
   * Refuses the call when the inbox was never granted what it needs, naming the command that grants it. Checked here,
   * before Google is called, so the message is the fix rather than a 403 — and checked on every call, so a server
   * started before a re-consent sees the new scopes without a restart.
   */
  async requireCapability(resolved: ResolvedInbox, capability: Capability): Promise<void> {
    if (capabilitiesOf(resolved.inbox.grantedScopes).has(capability)) return;
    throw new CommsError('SCOPE_MISSING', `${resolved.alias} was not granted permission to ${describe(capability)}`, {
      hint: grantHint(resolved.alias, capability, this.handoffs, (command) => `Grant it: ${command}.`),
      details: { alias: resolved.alias, capability },
    });
  }

  /**
   * The transport for an inbox, built once per context: each carries its own token cache and concurrency budget.
   *
   * **Keyed by the inbox id, not the alias.** An alias is a name a person chose and can move; the id is the mailbox.
   * Keyed by alias, a long-lived process served the *previous* mailbox's transport after an alias was reused — and
   * `forgetTransports()` does not help, because it only runs in the process that made the change, while an MCP
   * server holds one context for a whole client session and never sees a rename made at a terminal. Every operation
   * resolves the inbox freshly and then asks for a transport, so the two would disagree: the gates (send policy,
   * granted scopes, internal domains) ran against the new inbox's config while the Google calls went to the old
   * mailbox. Resolving first costs a config read that the operation has already done anyway.
   */
  async transport(alias: string): Promise<GmailTransport> {
    const resolved = await this.inbox(alias);
    const existing = this.#transports.get(resolved.inbox.id);
    if (existing) return existing;
    const client = await this.client(resolved.inbox.client);
    const transport = this.#createTransport({ resolved, client, context: this });
    this.#transports.set(resolved.inbox.id, transport);
    return transport;
  }

  /** A transport for an inbox that is not in the config yet — used while a sign-in is being verified. */
  transportFor(resolved: ResolvedInbox, client: ClientConfig): GmailTransport {
    return this.#createTransport({ resolved, client, context: this });
  }

  /** Forgets cached transports, so the next call reloads config (after add, reauth or remove). */
  forgetTransports(): void {
    this.#transports.clear();
  }
}

function defaultTransport({ resolved, client, context }: TransportRequest): GmailTransport {
  return new GoogleGmailTransport({
    tokens: new TokenSource({
      core: context.core,
      endpoints: context.endpoints,
      inbox: resolved.inbox,
      client,
      alias: resolved.alias,
      handoffs: context.handoffs,
    }),
    endpoints: context.endpoints,
    handoffs: context.handoffs,
  });
}

function describe(capability: Capability): string {
  switch (capability) {
    case 'read':
      return 'read this mailbox';
    case 'draft':
      return 'create drafts';
    case 'organize':
      return 'change labels and archive';
    case 'contacts':
      return 'search contacts';
  }
}
