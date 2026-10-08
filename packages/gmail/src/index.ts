/**
 * The library entry of `@agentcomms/gmail`.
 *
 * It is deliberately small. Everything else in this package is reached through the `agent-gmail` command or through
 * the MCP server, and both are shipped as a bundle whose internals no caller can import — so the public API here
 * stays a contract we can keep, rather than the whole internal surface.
 */

import { cliHandoffs, type Handoff, type HandoffUse, type PathOverrides, resolvePaths } from '@agentcomms/core';
import { createGmailMcpServer as createServer, type GmailMcpOptions } from './mcp/server.ts';
import { redirectConsoleToStderr } from './mcp/stdio-entry.ts';

export type { GmailHistoryPage } from './gmail-api/transport.ts';
export {
  type CreateGmailEventSourceOptions,
  createGmailEventSource,
  type GmailEventMessageMetadata,
  type GmailEventSource,
  normaliseGmailEventMetadata,
} from './operations/events.ts';

import { VERSION } from './version.ts';

/** How a command is rendered for a person: in a sentence, or as a value of its own (CUE-403). */
export { type Handoff, handoffSentence, handoffText } from '@agentcomms/core';
export { VERSION };
export const PACKAGE_NAME = '@agentcomms/gmail';

/**
 * A module of this package, for locating the Gmail CLI from code that is not in it: the `@agentcomms/gmail-mcp`
 * wrapper, whose own modules belong to the wrapper and would locate it instead (CUE-403). With `PACKAGE_NAME`, it is
 * the caller a command for Gmail is located from.
 */
export const RESOLVER_URL: string = import.meta.url;

export interface GmailCommandOptions {
  /** Where the suite's folders are found, as for the server: this process's environment when left out. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The folders a server was started with (`--config-dir` …): pinned in the command, so it runs on the same ones. */
  pathOverrides?: PathOverrides | undefined;
  /** The shell the command is quoted for: this one's when left out. */
  platform?: NodeJS.Platform | undefined;
  /** The folders the command opens: the four every command does when left out; `{ uses: [] }` for `--help`. */
  use?: HandoffUse | undefined;
}

/**
 * The Gmail CLI command with `words` after the program, for a person to run — located from this package (its
 * `RESOLVER_URL`), never from the module asking: a module of the `@agentcomms/gmail-mcp` wrapper belongs to the
 * wrapper, which has no CLI. Either a command that runs this Node and Gmail's checked CLI entry, the folders pinned,
 * or — with none here — the sentence saying why, naming no other command in its place (CUE-403).
 */
export function gmailCommand(words: readonly string[], options: GmailCommandOptions = {}): Handoff {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = resolvePaths({
    env,
    platform,
    ...(options.pathOverrides ? { pathOverrides: options.pathOverrides } : {}),
  });
  return cliHandoffs({ caller: { url: RESOLVER_URL, packageName: PACKAGE_NAME }, paths, platform, env }).own(
    words,
    options.use,
  );
}

/** What a host gets back: enough to serve the tools and to stop again, and nothing that ties it to an SDK version. */
export interface GmailMcpHandle {
  /** Serves MCP on this process's stdin and stdout, and resolves when the client disconnects. */
  connectStdio(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateGmailMcpServerOptions {
  /** Where the configuration lives; defaults to the usual per-user location. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Canonical suite directories supplied by a CLI or installer-written server entry. */
  pathOverrides?: PathOverrides | undefined;
  /** Serve only this mailbox. */
  inbox?: string | undefined;
  /** Register only the tools that cannot change anything. */
  readOnly?: boolean | undefined;
}

/**
 * Builds the Gmail MCP server. The `@agentcomms/gmail-mcp` package is one call to this, and a host embedding the
 * server should use it the same way:
 *
 * ```js
 * const server = await createGmailMcpServer();
 * await server.connectStdio();
 * ```
 */
export async function createGmailMcpServer(options: CreateGmailMcpServerOptions = {}): Promise<GmailMcpHandle> {
  // On stdio, stdout carries the protocol: anything else printed there breaks the connection.
  redirectConsoleToStderr();
  const built = await createServer(options as GmailMcpOptions);
  return {
    connectStdio: () => built.connectStdio(),
    close: () => built.close(),
  };
}
