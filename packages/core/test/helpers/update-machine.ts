import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type Core, openCore } from '../../src/core.ts';
import { CORE_CALLER } from '../../src/handoffs.ts';
import { type CoreMcpOptions, createCoreMcpServer } from '../../src/mcp/server.ts';
import type { UpdateDeps } from '../../src/operations/update.ts';
import { updateJobMarkerPath } from '../../src/update-job.ts';
import { changeUpdateCheck, type UpdateCheckRecord } from '../../src/update-state.ts';
import { registryOf, testReleaseVerifier } from './provenance-fixture.ts';
import { tempDir } from './temp.ts';

/*
 * A machine for the update notice's tests (design 2026-10-16): a home of its own with the check **on** — nothing here
 * sets the switch every other harness sets — a registry nobody answers on, and the state file seeded by hand.
 */

export const LATEST = '99.0.0';
export const OLD = '0.0.1';
export const CORE = '@agentcomms/core';

export interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  stateDir: string;
  configPath: string;
}

export function machine(extra: Record<string, string> = {}, config: Record<string, unknown> = {}): Machine {
  const home = tempDir('comms-update-notice-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify({ version: 2, secrets: { store: 'file' }, ...config })}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    NO_COLOR: '1',
    npm_config_offline: 'true',
    // Nobody answers here: an ask that got past a stand-in fails at once instead of reaching the real registry.
    npm_config_registry: 'http://127.0.0.1:9/',
    ...extra,
  };
  const core = openCore({ env, caller: CORE_CALLER });
  return { home, env, core, stateDir: core.paths.stateDir, configPath };
}

/**
 * The background job set up, as far as everything but the scheduler reads it: the marker Track C's installer writes
 * (`<state>/update-job.json`, design 2026-10-16 U4), with its platform, when, and the job's name. No job is scheduled.
 */
export function markJobSetUp(m: Machine): void {
  mkdirSync(m.stateDir, { recursive: true });
  writeFileSync(
    updateJobMarkerPath(m.stateDir),
    `${JSON.stringify({ platform: 'darwin', installedAt: new Date().toISOString(), label: 'com.agentcomms.update' })}\n`,
  );
}

/** The file as a check would have left it, asked at `at`, written under the check's own lock. */
export async function seed(m: Machine, record: Partial<UpdateCheckRecord>, at: Date = new Date()): Promise<void> {
  mkdirSync(m.stateDir, { recursive: true });
  await changeUpdateCheck(m.stateDir, (current) => ({
    record: { ...current, lastChecked: at.toISOString(), ...record },
  }));
}

/** A registry that cannot be reached: what a server is handed when a test is not about the registry. */
export const unreachable = async (): Promise<string> => {
  throw new Error('the registry could not be reached (a test that is not about it)');
};

/** The update's other stand-ins: nothing registered, and `global` installed globally. */
export function deps(
  latestVersion: UpdateDeps['latestVersion'] = unreachable,
  global: Record<string, string> = { [CORE]: OLD },
): UpdateDeps {
  const installed = { ...global };
  return {
    latestVersion,
    // Each release's document, and its provenance verified against the test's own trust root: nothing reaches npm.
    registry: registryOf(async (packageName) => String(await (latestVersion ?? unreachable)(packageName))),
    verifyRelease: testReleaseVerifier(),
    globalPackages: async () => ({ ...installed }),
    installGlobal: async (spec: string) => {
      const at = spec.lastIndexOf('@');
      installed[spec.slice(0, at)] = spec.slice(at + 1);
    },
    installRuntime: async () => undefined,
  };
}

export interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

export interface Connected {
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  client: Client;
  close: () => Promise<unknown>;
}

export async function connect(m: Machine, options: Partial<CoreMcpOptions> = {}): Promise<Connected> {
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null, update: deps(), ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { call, client, close: () => Promise.all([client.close(), server.close()]) };
}

/** Every text block of a result, joined. */
export const textsOf = (result: ToolResult): string =>
  (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');

export const codeOf = (result: ToolResult): string | undefined =>
  (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
