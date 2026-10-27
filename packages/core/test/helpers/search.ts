import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type Core, openCore } from '../../src/core.ts';
import { CORE_CALLER } from '../../src/handoffs.ts';
import type { SearchSystem } from '../../src/search/folder.ts';
import type { SearchDeps } from '../../src/search/indexer.ts';
import { folded } from '../../src/search/rank.ts';
import type { SecretStore } from '../../src/secrets.ts';
import { tempDir } from './temp.ts';

/*
 * What Search's tests run against: a temporary home with a synthetic configuration — one Gmail mailbox, one Slack
 * workspace, one Resend mailbox and one WhatsApp account, none of them real — a secret store in memory, so no test
 * touches a keychain, stand-ins for `tmutil` and `fdesetup`, and a fake Ollama on a loopback port. Nothing here
 * downloads a model, and nothing talks to any address but 127.0.0.1.
 */

export const MAIL = { id: 'ibx_AAAAAAAAAAAAAAAA', alias: 'acme/gmail', email: 'jo@acme.test' } as const;
export const SLACK = { id: 'acc_AAAAAAAAAAAAAAAA', alias: 'acme/slack', workspace: 'T0ACME', userId: 'U0ME' } as const;
export const RESEND = { id: 'ibx_RRRRRRRRRRRRRRRR', alias: 'acme/resend' } as const;
export const WHATSAPP = { id: 'acc_WWWWWWWWWWWWWWWW', alias: 'acme/whatsapp' } as const;

const CREATED = '2026-09-01T00:00:00.000Z';

/** A secret store in memory: what the master is kept in for a test, and nothing else. */
export class MemorySecrets implements SecretStore {
  readonly kind = 'file' as const;
  readonly values: Map<string, string> = new Map();
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
  invalidate(): void {}
}

/** `tmutil` and `fdesetup`, as stand-ins: every call recorded, answered as a Mac with FileVault on would. */
export function standInSystem(
  platform: NodeJS.Platform = 'darwin',
  fileVault: 'On' | 'Off' = 'On',
): { system: SearchSystem; calls: { program: string; args: readonly string[] }[] } {
  const calls: { program: string; args: readonly string[] }[] = [];
  const excluded = new Set<string>();
  const system: SearchSystem = {
    platform,
    run: async (program, args) => {
      calls.push({ program, args });
      if (program === '/usr/bin/tmutil' && args[0] === 'addexclusion') {
        excluded.add(String(args[1]));
        return { code: 0, stdout: '' };
      }
      if (program === '/usr/bin/tmutil' && args[0] === 'isexcluded') {
        const path = String(args[1]);
        return { code: 0, stdout: `${excluded.has(path) ? '[Excluded]' : '[Included]'}    ${path}\n` };
      }
      if (program === '/usr/bin/fdesetup') return { code: 0, stdout: `FileVault is ${fileVault}.\n` };
      return { code: 1, stdout: '' };
    },
  };
  return { system, calls };
}

export interface SearchMachine {
  readonly home: string;
  readonly env: Record<string, string>;
  readonly configDir: string;
  readonly stateDir: string;
  readonly core: Core;
  readonly secrets: MemorySecrets;
  readonly deps: SearchDeps;
  readonly calls: { program: string; args: readonly string[] }[];
  /** Rewrites the configuration with this `search` block and these activity settings. */
  write(search: Record<string, unknown> | undefined, activity?: Record<string, unknown>): void;
}

function configBody(search: Record<string, unknown> | undefined, activity: Record<string, unknown> | undefined) {
  return {
    version: 3,
    naming: 2,
    clients: {
      desktop: { provider: 'google', clientId: 'x', secretRef: 'gmail:client:desktop', addedAt: CREATED },
    },
    inboxes: {
      [MAIL.alias]: {
        id: MAIL.id,
        provider: 'gmail',
        email: MAIL.email,
        identity: 'oidc',
        client: 'desktop',
        tier: 'send',
        grantedScopes: [],
        secretRef: `gmail:refresh:${MAIL.id}`,
        internalDomains: ['acme.test'],
        createdAt: CREATED,
      },
      [RESEND.alias]: {
        id: RESEND.id,
        provider: 'resend',
        email: 'news@acme.test',
        identity: 'legacy',
        client: 'resend',
        tier: 'send',
        grantedScopes: [],
        secretRef: `resend:key:${RESEND.id}`,
        internalDomains: ['acme.test'],
        createdAt: CREATED,
      },
    },
    accounts: {
      [SLACK.alias]: {
        id: SLACK.id,
        platform: 'slack',
        workspace: SLACK.workspace,
        userId: SLACK.userId,
        tier: 'send',
        mode: 'send',
        grantedScopes: [],
        secretRef: `slack:token:${SLACK.id}`,
        createdAt: CREATED,
      },
      [WHATSAPP.alias]: {
        id: WHATSAPP.id,
        platform: 'whatsapp',
        workspace: 'WA',
        userId: 'me',
        tier: 'read',
        mode: 'read',
        grantedScopes: [],
        secretRef: `whatsapp:none:${WHATSAPP.id}`,
        createdAt: CREATED,
      },
    },
    defaults: { sendPolicy: 'chat' },
    ...(search === undefined ? {} : { search }),
    ...(activity === undefined ? {} : { activity }),
  };
}

/** A machine with Search's stand-ins, and the `search` block given. */
export function searchMachine(
  search?: Record<string, unknown>,
  options: {
    platform?: NodeJS.Platform;
    fileVault?: 'On' | 'Off';
    exchange?: SearchDeps['exchange'];
    now?: () => number;
  } = {},
): SearchMachine {
  const home = tempDir('comms-search-');
  const configDir = join(home, 'config');
  const stateDir = join(home, 'state');
  mkdirSync(configDir);
  // By rename, as every write to it is: a new file each time, so no read can take it for the one before.
  const write = (block: Record<string, unknown> | undefined, activity?: Record<string, unknown>) => {
    const staged = join(configDir, `config.json.${process.pid}.test`);
    writeFileSync(staged, `${JSON.stringify(configBody(block, activity), null, 2)}\n`);
    renameSync(staged, join(configDir, 'config.json'));
  };
  write(search);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: stateDir,
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  const secrets = new MemorySecrets();
  const { system, calls } = standInSystem(options.platform ?? 'darwin', options.fileVault ?? 'On');
  const deps: SearchDeps = {
    secrets: async () => secrets,
    system,
    ...(options.exchange === undefined ? {} : { exchange: options.exchange }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return { home, env, configDir, stateDir, core: openCore({ env, caller: CORE_CALLER }), secrets, deps, calls, write };
}

// ── A fake Ollama on loopback ──────────────────────────────────────────────────────────────────────────────────

/**
 * Words that mean the same thing, in English and Romanian, each group one direction of the fake model's space — so a
 * search by meaning finds "bill" for "invoice" and "factură" for both, and a search by words does not.
 */
const CONCEPTS: readonly (readonly string[])[] = [
  ['invoice', 'invoices', 'bill', 'billing', 'factura', 'facturi', 'facturii', 'plata', 'payment'],
  ['deploy', 'deployed', 'release', 'staging', 'lansare', 'lansarea', 'publish'],
  ['meeting', 'call', 'sedinta', 'intalnire', 'calendar'],
  ['contract', 'agreement', 'contractul', 'semnat', 'signed'],
];

function hashOf(word: string): number {
  let hash = 2166136261;
  for (const char of word) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** The fake model's vector for a text: a direction for each concept it names, a hashed one for each other word. */
export function fakeEmbedding(text: string, dimensions: number): number[] {
  const vector: number[] = Array.from({ length: dimensions }, () => 0);
  const words = folded(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const concept = CONCEPTS.findIndex((group) => group.includes(word));
    if (concept !== -1) vector[concept] = (vector[concept] ?? 0) + 3;
    else {
      const slot = CONCEPTS.length + (hashOf(word) % (dimensions - CONCEPTS.length));
      vector[slot] = (vector[slot] ?? 0) + 0.3;
    }
  }
  if (!vector.some((value) => value !== 0)) vector[dimensions - 1] = 1;
  return vector;
}

export interface FakeOllamaModel {
  name: string;
  model?: string;
  digest?: string;
  remote_model?: string;
  remote_host?: string;
}

export interface FakeOllama {
  readonly address: string;
  readonly port: number;
  /** Every request, as it arrived. */
  readonly requests: { method: string; path: string; body: string }[];
  /** What `/api/tags` lists; change it to change the model. */
  models: FakeOllamaModel[];
  /** When set, `/api/embed` answers with this status instead. */
  failEmbed: number | null;
  /** When true, `/api/embed` refuses a batch of more than one input — the indexer's — and answers a query's. */
  failBatches: boolean;
  close(): Promise<void>;
}

/** A fake Ollama on 127.0.0.1: `/api/tags` lists `models`, `/api/embed` answers with `fakeEmbedding`. */
export async function startFakeOllama(models: FakeOllamaModel[]): Promise<FakeOllama> {
  const state = {
    requests: [] as { method: string; path: string; body: string }[],
    models,
    failEmbed: null as number | null,
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: request.method ?? '', path: request.url ?? '', body });
      const send = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'GET' && request.url === '/api/tags') {
        send(200, { models: fake.models });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/embed') {
        if (fake.failEmbed !== null) {
          send(fake.failEmbed, { error: 'failing on purpose' });
          return;
        }
        const parsed = JSON.parse(body) as { input: string[]; dimensions?: number };
        if (fake.failBatches && parsed.input.length > 1) {
          send(500, { error: 'busy on purpose' });
          return;
        }
        const dimensions = parsed.dimensions ?? 1024;
        send(200, { model: 'fake', embeddings: parsed.input.map((input) => fakeEmbedding(input, dimensions)) });
        return;
      }
      send(404, { error: 'not here' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fake: FakeOllama = {
    address: `http://127.0.0.1:${port}`,
    port,
    requests: state.requests,
    models: state.models,
    failEmbed: null,
    failBatches: false,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}

export const QWEN_LOCAL: FakeOllamaModel = {
  name: 'qwen3-embedding:0.6b',
  model: 'qwen3-embedding:0.6b',
  digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
};
