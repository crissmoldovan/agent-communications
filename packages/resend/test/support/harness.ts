import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { type Config, type Core, type LooseningConsent, openCore } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  type KeyPermission,
  type Mode,
  newResendAccountId,
  type ResendAccount,
  secretRefFor,
  withAccount,
} from '../../src/accounts.ts';
import { RESEND_CALLER } from '../../src/caller.ts';
import { run } from '../../src/cli/program.ts';
import { ResendContext } from '../../src/context.ts';
import { createResendMcpServer } from '../../src/mcp/server.ts';
import { type FakeResend, startFakeResend } from './fake-resend.ts';

/**
 * A temporary home, config, state and data directory; core's secret store pinned to files; and a loopback Resend.
 *
 * Nothing here can reach the real keychain, the real config, or the network: every path is under one temporary
 * directory, `secrets.store` is `file` before anything runs, and every request goes through the guard to the fake.
 */

/** Keys shaped like Resend's, and fake. None of them is a real key. */
export const FULL = 're_fakefull_0123456789abcdef';
export const SENDING = 're_fakesend_0123456789abcdef';
export const LOCKED = 're_fakelock_0123456789abcdef';

export const DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
export const PENDING_DOMAIN_ID = '22222222-2222-4222-8222-222222222222';

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  json<T = unknown>(): {
    ok: boolean;
    data?: T;
    error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
  };
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
}

export interface Harness {
  dir: string;
  env: NodeJS.ProcessEnv;
  core: Core;
  fake: FakeResend;
  context(surface?: 'cli' | 'mcp', platform?: NodeJS.Platform): ResendContext;
  addAccount(options: {
    name: string;
    key?: string;
    tier?: KeyPermission;
    mode?: Mode;
    sendPolicy?: 'chat' | 'confirm' | 'never';
    changePolicy?: 'chat' | 'confirm';
    domainLock?: string;
  }): Promise<ResendAccount>;
  cli(
    argv: string[],
    options?: { env?: NodeJS.ProcessEnv; tty?: boolean; input?: string[]; platform?: NodeJS.Platform },
  ): Promise<Captured>;
  mcp(options?: { account?: string; platform?: NodeJS.Platform }): Promise<{
    client: Client;
    call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
    close(): Promise<void>;
  }>;
  everyFile(): Promise<{ path: string; text: string }[]>;
  audit(): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export function tempDir(prefix = 'agent-resend-'): string {
  // realpath: on macOS the temp directory is a symlink, and path jails compare resolved paths.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Every `agentLabel` path a change to the label settings can loosen (design 2026-10-15-agent-label, L5). */
const AGENT_LABEL_PATHS = ['agentLabel.word', 'agentLabel.name', 'agentLabel.rules', 'agentLabel.slackIcons'];

/** Replaces the person's label settings, `agentLabel`, with the consent a person's change to them carries. */
export async function setAgentLabel(harness: Harness, settings: Record<string, unknown>): Promise<void> {
  const replaced = { agentLabel: settings };
  await harness.core.config.update((config): Config => ({ ...config, ...replaced }), {
    consent: { kind: 'loosening-consent', paths: AGENT_LABEL_PATHS },
  });
}

export async function newHarness(): Promise<Harness> {
  const dir = tempDir();
  const env: NodeJS.ProcessEnv = {
    AGENT_COMMS_CONFIG_DIR: join(dir, 'config'),
    AGENT_COMMS_STATE_DIR: join(dir, 'config', 'state'),
    AGENT_COMMS_DATA_DIR: join(dir, 'data'),
    HOME: dir,
    USERPROFILE: dir,
    NO_COLOR: '1',
    PATH: process.env.PATH ?? '',
    // The daily update check, off: no test asks the real npm registry, and no call stops for a release the tests did
    // not make. The gate's own tests turn it back on, with a registry and a clock of their own (design 2026-09-28).
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  // Opened as this package's CLI and server open it, so every command they print is located from here (CUE-403).
  const core = openCore({ env, caller: RESEND_CALLER });
  mkdirSync(join(dir, 'config'), { recursive: true, mode: 0o700 });
  /*
   * The person has a label name (design 2026-10-15-agent-label, L1): a send an agent prepares is labelled, and one
   * whose From is a bare address takes its name from here — without one it is refused. `setAgentLabel` changes it.
   */
  writeFileSync(
    join(dir, 'config', 'config.json'),
    `${JSON.stringify({ version: 2, secrets: { store: 'file' }, agentLabel: { name: 'Jo Example' } })}\n`,
  );
  const fake = await startFakeResend();
  fake.keys.set(FULL, { permission: 'full_access' });
  fake.keys.set(SENDING, { permission: 'sending_access' });
  fake.keys.set(LOCKED, { permission: 'sending_access', domain: 'acme.test' });
  fake.domains = [
    { id: DOMAIN_ID, name: 'acme.test', status: 'verified' },
    { id: PENDING_DOMAIN_ID, name: 'pending.test', status: 'pending' },
  ];

  const context = (surface: 'cli' | 'mcp' = 'cli', platform: NodeJS.Platform = 'darwin') =>
    new ResendContext({ core, env, fetch: fake.fetch, throttle: { intervalMs: 0 }, surface, platform });

  const harness: Harness = {
    dir,
    env,
    core,
    fake,
    context,
    async addAccount(options) {
      const id = newResendAccountId();
      const tier = options.tier ?? 'full_access';
      const mode = options.mode ?? (tier === 'sending_access' ? 'send' : 'read');
      const account: ResendAccount = {
        id,
        platform: 'resend',
        workspace: `key_${id.slice(-8).toLowerCase()}`,
        userId: `key_${id.slice(-8).toLowerCase()}`,
        tier: mode,
        mode,
        grantedScopes: [tier],
        secretRef: secretRefFor(id),
        ...(options.sendPolicy ? { sendPolicy: options.sendPolicy } : {}),
        ...(options.changePolicy ? { changePolicy: options.changePolicy } : {}),
        createdAt: '2026-09-26T10:00:00.000Z',
        ...(options.domainLock ? { domainLock: options.domainLock } : {}),
      };
      await (await core.secrets('file')).set(
        account.secretRef,
        options.key ?? (tier === 'full_access' ? FULL : SENDING),
      );
      // Planted in core's configuration as a person connected and approved it, so it carries that consent.
      const consent: LooseningConsent = {
        kind: 'loosening-consent',
        paths: ['mode', 'sendPolicy', 'changePolicy'].map((field) => `accounts.${options.name}.${field}`),
      };
      await core.config.update((config) => withAccount(config, options.name, account), { consent });
      return account;
    },
    async cli(argv, options = {}) {
      let stdout = '';
      let stderr = '';
      const out = new PassThrough();
      const err = new PassThrough();
      const input = new PassThrough();
      out.on('data', (chunk) => {
        stdout += String(chunk);
      });
      err.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const tty = options.tty ?? false;
      if (options.input) {
        // One line each time a prompt is shown — every prompt here ends in ": " on stderr — so a line is never read
        // by a question it was not meant for.
        const lines = [...options.input];
        err.on('data', (chunk) => {
          if (!String(chunk).endsWith(': ')) return;
          const next = lines.shift();
          if (next !== undefined) setImmediate(() => input.write(`${next}\n`));
        });
      }
      const code = await run(argv, {
        core,
        env: { ...env, ...options.env },
        fetch: fake.fetch,
        throttle: { intervalMs: 0 },
        // Tests that need Windows override this. Every other printed-command assertion is intentionally POSIX-pinned.
        platform: options.platform ?? 'darwin',
        streams: {
          stdout: Object.assign(out, { isTTY: tty }),
          stderr: Object.assign(err, { isTTY: tty }),
          stdin: Object.assign(input, { isTTY: tty }),
        },
      });
      return {
        code,
        stdout,
        stderr,
        json: () => JSON.parse(stdout),
      };
    },
    async mcp(options = {}) {
      const { server } = await createResendMcpServer({
        core,
        env,
        fetch: fake.fetch,
        throttle: { intervalMs: 0 },
        // Tests that need Windows override this. Every other printed-command assertion is intentionally POSIX-pinned.
        platform: options.platform ?? 'darwin',
        ...(options.account ? { account: options.account } : {}),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      return {
        client,
        call: async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult,
        close: async () => {
          await Promise.all([client.close(), server.close()]);
        },
      };
    },
    async everyFile() {
      const found: { path: string; text: string }[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        found.push({ path: relative(dir, path), text: await readFile(path, 'utf8') });
      }
      return found;
    },
    async audit() {
      const directory = join(core.paths.stateDir, 'audit');
      const lines: Record<string, unknown>[] = [];
      for (const name of await readdir(directory).catch(() => [] as string[])) {
        for (const line of (await readFile(join(directory, name), 'utf8')).split('\n')) {
          if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
      return lines;
    },
    close: () => fake.close(),
  };
  return harness;
}

/** A tool's data, asserting it succeeded. */
export function ok<T = Record<string, unknown>>(result: ToolResult): T {
  if (result.isError) throw new Error(`tool failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent as T;
}

/** A tool's refusal, with its code. */
export function refused(result: ToolResult): {
  code: string;
  message: string;
  hint: string | null;
  details?: Record<string, unknown>;
} {
  if (!result.isError) throw new Error(`tool succeeded: ${JSON.stringify(result.structuredContent)}`);
  return (result.structuredContent as { error: { code: string; message: string; hint: string | null } }).error;
}
