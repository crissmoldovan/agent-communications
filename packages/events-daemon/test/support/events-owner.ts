import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import type { DesktopOrigin } from '@agentcomms/core';
import { run } from '../../src/cli/program.ts';
import { EventControlClient } from '../../src/control/client.ts';
import { type EventOwner, type EventOwnerOptions, startEventOwner } from '../../src/runtime/owner.ts';
import { eventPaths } from '../../src/runtime/paths.ts';
import { openEventDatabase } from '../../src/store/database.ts';
import { shortTempDir } from './short-temp.ts';
import { standInHome, standInSecrets } from './stand-ins.ts';

/**
 * A real event-service owner for the 0.36 events tests (Track D): a stand-in home, configuration and data folder, the
 * file secret store (never the Keychain), a control client, a second connection to its store for reading and seeding,
 * and the CLI run as a person — or as an agent, or inside the MCP server, by its environment.
 */

/** The app, attested: what the CLI finds when the Agent Comms app started it (a stand-in; nothing is checked). */
export const ATTESTED_APP = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

export interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface CliOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** An interactive terminal: stdin and stdout are TTYs. */
  readonly tty?: boolean;
  readonly stdin?: string;
  /** What a hidden prompt reads, for a secret typed at the terminal. */
  readonly hidden?: string;
  readonly desktopOrigin?: () => Promise<DesktopOrigin>;
  /** `--json` (the default): a terminal-only secret command takes none, since it reveals to a person's terminal. */
  readonly json?: boolean;
}

export interface EventsOwnerHarness {
  readonly root: string;
  readonly stateDir: string;
  readonly configDir: string;
  readonly owner: EventOwner;
  readonly control: EventControlClient;
  /** A second connection to the owner's store, for reading what it wrote and seeding rows. */
  readonly database: DatabaseSync;
  cli(argv: readonly string[], options?: CliOptions): Promise<CliRun>;
  /** Approves a prepared activation as the person does at a terminal: the challenge, typed back. */
  approve(approvalId: string): Promise<unknown>;
}

export async function runCli(stateDir: string, argv: readonly string[], options: CliOptions = {}): Promise<CliRun> {
  const tty = options.tty === true;
  const stdin = Object.assign(new PassThrough(), { isTTY: tty });
  stdin.end(options.stdin ?? '');
  const stdout = Object.assign(new PassThrough(), { isTTY: tty });
  const stderr = Object.assign(new PassThrough(), { isTTY: tty });
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const code = await run(['--state-dir', stateDir, ...(options.json === false ? [] : ['--json']), ...argv], {
    streams: { stdin, stdout, stderr },
    env: options.env ?? {},
    ...(options.desktopOrigin === undefined ? {} : { desktopOrigin: options.desktopOrigin }),
    ...(options.hidden === undefined ? {} : { readSecret: async () => options.hidden as string }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

export async function withEventsOwner(
  work: (harness: EventsOwnerHarness) => Promise<void>,
  options: Partial<EventOwnerOptions> = {},
): Promise<void> {
  const root = await shortTempDir('aev-d-events-');
  const stateDir = join(root, 'state');
  const home = await standInHome(root);
  const opened = await openEventDatabase({ stateDir });
  try {
    await standInSecrets(opened.database);
  } finally {
    opened.close();
  }
  const owner = await startEventOwner({
    stateDir,
    configDir: home.configDir,
    dataDir: home.dataDir,
    homeDirectory: home.homeDirectory,
    tickMs: 60_000,
    ...options,
  });
  const database = new DatabaseSync(eventPaths(stateDir).database);
  database.exec('PRAGMA busy_timeout = 5000');
  const control = new EventControlClient({ stateDir, clientName: 'd-events-test' });
  try {
    await work({
      root,
      stateDir,
      configDir: home.configDir,
      owner,
      control,
      database,
      cli: (argv, cliOptions) => runCli(stateDir, argv, cliOptions),
      async approve(approvalId) {
        const challenge = (await control.request('approve-challenge', { approvalId })) as string;
        return control.request('approve', { approvalId, answer: challenge });
      },
    });
  } finally {
    database.close();
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
}

/** A live subscriber on this Mac, given events. */
export function sseSubscriber(input: {
  readonly subscriberId?: string;
  readonly version?: number;
  readonly port?: number;
  readonly origins?: readonly string[];
  readonly namespaces?: readonly string[];
  readonly patterns?: readonly string[];
  readonly content?: 'none' | 'enveloped';
  readonly events?: false;
}): Record<string, unknown> {
  return {
    subscriberId: input.subscriberId ?? 'events-dashboard',
    version: input.version ?? 1,
    kind: 'sse',
    authority: { host: '127.0.0.1', port: input.port ?? 4801 },
    origins: [...(input.origins ?? ['http://localhost:3000'])],
    retentionMs: 86_400_000,
    ...(input.events === false
      ? {}
      : {
          events: {
            namespaces: [...(input.namespaces ?? ['acme'])],
            patterns: [...(input.patterns ?? ['*.*.*.failed', 'acme.client-asks.*.*'])],
            content: input.content ?? 'none',
          },
        }),
  };
}

/** A subscriber off this Mac, by signed webhook to a loopback receiver. */
export function webhookSubscriber(input: {
  readonly subscriberId?: string;
  readonly version?: number;
  readonly url?: string;
  readonly retryLimit?: number;
  readonly patterns?: readonly string[];
  readonly content?: 'none' | 'enveloped';
}): Record<string, unknown> {
  return {
    subscriberId: input.subscriberId ?? 'crm-hook',
    version: input.version ?? 1,
    kind: 'webhook',
    url: { kind: 'plain', value: input.url ?? 'http://127.0.0.1:4802/hooks/events' },
    approvedAddressSet: ['127.0.0.1'],
    signing: 'standard-webhooks',
    retryLimit: input.retryLimit ?? 3,
    events: {
      namespaces: ['acme'],
      patterns: [...(input.patterns ?? ['acme.*.*.*'])],
      content: input.content ?? 'none',
    },
  };
}
