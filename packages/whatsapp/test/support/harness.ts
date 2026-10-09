import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { type CliDeps, run } from '../../src/cli/program.ts';
import { WhatsAppContext, type WhatsAppContextOptions } from '../../src/context.ts';
import { LISTS_FILE } from '../../src/lists.ts';
import { syncAccount } from '../../src/operations/sync.ts';
import { WHATSAPP_GROUP_CONTAINER } from '../../src/source/location.ts';
import { buildFixtureStore, type Fixture, type FixtureOptions } from './fixture.ts';

/**
 * A temporary home, config and state directory, with a synthetic store where WhatsApp for Mac would keep its own.
 *
 * Everything is under one temporary directory, and the environment is built from nothing — not copied from
 * `process.env` — so no agent marker, no real HOME and no real config reach the code under test. Core's config is
 * written with the file secret store pinned, though this package never opens a secret store: a harness that could
 * reach the login keychain is one refactor away from writing to it.
 */

/** Core's agent markers: a harness made with one set is an agent's, and `ready` sets up as the person would. */
const AGENT_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_HOME',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'AGENT_COMMS_AGENT',
];

export function tempDir(prefix = 'agent-whatsapp-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** The `--json` envelope on stdout. */
  json(): { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };
  /** The envelope's `data`, which must be there: the command succeeded. */
  data(): Record<string, unknown>;
}

export interface Harness {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The container directory inside the temporary home. */
  container: string;
  /** Present unless the harness was made with `store: false`. */
  fixture: Fixture | null;
  context(options?: WhatsAppContextOptions): WhatsAppContext;
  cli(argv: readonly string[], deps?: CliDeps): Promise<CliRun>;
  /** `add` then `sync`, as a person would start — at their own terminal, whatever marker the harness carries. */
  ready(name?: string): Promise<void>;
  /** The environment without any agent marker: the person's. */
  personEnv: NodeJS.ProcessEnv;
  configDir: string;
  /** Core's `config.json`, as written. */
  coreConfig(): { version: number; accounts: Record<string, { id: string } & Record<string, unknown>> } & Record<
    string,
    unknown
  >;
  /** The person's lists file, or null when there is none. */
  listsFile(): { version: 1; accounts: Record<string, { allow: string[]; deny: string[] }> } | null;
  /** Rebuilds every channel-owned index artifact from the fixture source without touching an event-daemon database. */
  resetAndRebuildAllIndexState(name?: string): Promise<void>;
}

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString('utf8');
    done();
  }
}

export async function newHarness(
  options: { store?: FixtureOptions | false; env?: NodeJS.ProcessEnv } = {},
): Promise<Harness> {
  const root = tempDir();
  const home = join(root, 'home');
  const configDir = join(root, 'config');
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);
  const env: NodeJS.ProcessEnv = {
    /*
     * The home under both names core reads it by: `HOME` on macOS and Linux, `USERPROFILE` on Windows. With `HOME`
     * alone, a Windows run resolved the default data and downloads directories to the real profile of whoever ran the
     * tests, as the Slack harness did until the 0.8.0 release run caught it.
     */
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(root, 'state'),
    AGENT_COMMS_DATA_DIR: join(root, 'data'),
    NO_COLOR: '1',
    // The daily update check, off: no test asks the real npm registry, and no call stops for a release the tests did
    // not make. The gate's own tests turn it back on, with a registry and a clock of their own (design 2026-09-28).
    AGENT_COMMS_UPDATE_CHECK: 'off',
    ...options.env,
  };
  const personEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !AGENT_MARKERS.includes(name)));
  const container = join(home, 'Library', 'Group Containers', WHATSAPP_GROUP_CONTAINER);
  const fixture = options.store === false ? null : await buildFixtureStore(container, options.store ?? {});

  const harness: Harness = {
    root,
    home,
    env,
    container,
    fixture,
    context: (extra = {}) =>
      new WhatsAppContext({
        env,
        // Tests that need Windows override this. Operation-result assertions otherwise use stable POSIX text.
        platform: extra.platform ?? 'darwin',
        ...extra,
      }),
    async cli(argv, deps = {}) {
      const stdout = new Capture();
      const stderr = new Capture();
      const code = await run(argv, {
        env,
        streams: { stdout, stderr },
        open: () => true,
        // Tests that need Windows override this. Printed-command assertions otherwise use stable POSIX text.
        platform: deps.platform ?? 'darwin',
        ...deps,
      });
      return {
        code,
        stdout: stdout.text,
        stderr: stderr.text,
        json: () => JSON.parse(stdout.text),
        data: () => {
          const envelope = JSON.parse(stdout.text) as { ok: boolean; data?: Record<string, unknown> };
          if (!envelope.ok || !envelope.data) throw new Error(`expected a result, got: ${stdout.text}`);
          return envelope.data;
        },
      };
    },
    async ready(name = 'acme/whatsapp') {
      const added = await harness.cli(['add', name, '--json'], { env: personEnv });
      if (added.code !== 0) throw new Error(`add failed: ${added.stdout}${added.stderr}`);
      const synced = await harness.cli(['sync', '--account', name, '--json'], { env: personEnv });
      if (synced.code !== 0) throw new Error(`sync failed: ${synced.stdout}${synced.stderr}`);
    },
    personEnv,
    configDir,
    coreConfig: () => JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')),
    listsFile: () => {
      const path = join(configDir, LISTS_FILE);
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
    async resetAndRebuildAllIndexState(name = 'acme/whatsapp') {
      const config = harness.coreConfig();
      const id = config.accounts[name]?.id;
      if (typeof id !== 'string') throw new Error(`the fixture account ${name} was not added`);
      const state = join(env.AGENT_COMMS_STATE_DIR as string, 'whatsapp', id);
      // The harness owns only the channel's derived state. It never opens, locates, or changes a daemon database.
      await rm(state, { recursive: true, force: true });
      await syncAccount(harness.context(), { account: name });
    },
  };
  return harness;
}
