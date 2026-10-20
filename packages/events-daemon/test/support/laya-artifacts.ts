import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type net from 'node:net';
import { join } from 'node:path';
import type tls from 'node:tls';
import { ApprovalStore, ConfigStore, emptyConfig } from '@agentcomms/core';
import type { LayaPlatformProbe, LayaReviewedAssetSource } from '../../src/domain/judges.ts';
import { JUDGE_KINDS } from '../../src/domain/lifecycle.ts';
import type { PinnedTcpOptions, PinnedTlsOptions } from '../../src/network/pinned-connection.ts';
import { ActivationRuntime } from '../../src/runtime/activations.ts';
import { B3OperatorControl } from '../../src/runtime/b3-operator-control.ts';
import { registerJudgeWorkPurgeListener } from '../../src/runtime/judge-purge.ts';
import {
  type LayaArtifactEdge,
  type LayaArtifactFailpoint,
  LayaArtifactManager,
} from '../../src/runtime/laya/manager.ts';
import { WriterQuiescer } from '../../src/runtime/writer-quiescer.ts';
import { MailboxLock } from '../../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../../src/store/database.ts';
import { resolverFor } from './laya-origin.ts';
import { shortTempDir } from './short-temp.ts';

export const LAYA: (typeof JUDGE_KINDS)[1] = JUDGE_KINDS[1];
const fixtureRoot = join(import.meta.dirname, '..', 'fixtures', 'laya');
const MODEL_FILES = [
  'laya.onnx',
  'laya.onnx.data',
  'laya_config.json',
  'tokenizer/tokenizer.json',
  'tokenizer/tokenizer_config.json',
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface SyntheticModelFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export interface SyntheticLock {
  schemaVersion: 1;
  packages: {
    name: string;
    version: string;
    url: string;
    integrity: string;
    files: Record<string, { path: string; size: number; sha256: string; executable: boolean }[]>;
  }[];
}

export interface SyntheticLaya {
  readonly assets: LayaReviewedAssetSource;
  readonly manifestId: string;
  readonly revision: string;
  readonly repo: string;
  readonly modelFiles: readonly SyntheticModelFile[];
  readonly lock: SyntheticLock;
  /** The registry path of each runtime archive the lock names, mapped to its SRI-pinned fixture bytes. */
  readonly archives: ReadonlyMap<string, Buffer>;
}

/**
 * Reviewed asset bytes for the tiny five-file model and the two fixture runtime archives. They are written in each
 * asset's canonical layout and then accepted or refused by the production parser alone; nothing here parses them.
 */
export async function syntheticLaya(
  options: {
    readonly manifestId?: string;
    readonly revision?: string;
    readonly lock?: (lock: SyntheticLock) => void;
    readonly modelBytes?: (path: string, bytes: Buffer) => Buffer;
  } = {},
): Promise<SyntheticLaya> {
  const reviewed = JSON.parse(await readFile(join(fixtureRoot, 'manifest-tiny-v1.json'), 'utf8')) as {
    manifestId: string;
    source: { host: string; repo: string; revision: string };
    files: { path: string; size: number; sha256: string }[];
  } & Record<string, unknown>;
  const modelFiles = await Promise.all(
    MODEL_FILES.map(async (path) => {
      const original = await readFile(join(fixtureRoot, 'model-tiny-v1', path));
      const bytes = options.modelBytes?.(path, original) ?? original;
      return { path, size: bytes.length, sha256: sha256(bytes), bytes };
    }),
  );
  const manifestId = options.manifestId ?? 'laya-en-onnx-tiny-v1';
  const revision = options.revision ?? 'c'.repeat(40);
  const manifest = {
    ...reviewed,
    manifestId,
    source: { ...reviewed.source, revision },
    files: modelFiles.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`.replace(
      '  "promptTemplates": [\n    "laya-choice2-v1",\n    "laya-noul-v1"\n  ]',
      '  "promptTemplates": ["laya-choice2-v1", "laya-noul-v1"]',
    ),
  );
  const lock = JSON.parse(await readFile(join(fixtureRoot, 'lock-expected.json'), 'utf8')) as SyntheticLock;
  const archiveBytes = new Map<string, Buffer>();
  for (const pkg of lock.packages)
    archiveBytes.set(pkg.name, await readFile(join(fixtureRoot, 'lock-input', `${pkg.name}-${pkg.version}.tgz`)));
  options.lock?.(lock);
  // A changed lock may rename an archive's registry path; the origin serves each package's one fixture archive there.
  const archives = new Map<string, Buffer>();
  for (const pkg of lock.packages) {
    const bytes = archiveBytes.get(pkg.name);
    if (bytes !== undefined) archives.set(new URL(pkg.url).pathname, bytes);
  }
  return {
    assets: {
      manifestBytes,
      runtimeLockBytes: Buffer.from(`${JSON.stringify(lock, null, 2)}\n`),
      disclosuresBytes: await readFile(join(fixtureRoot, 'disclosures-tiny-v1.json')),
    },
    manifestId,
    revision,
    repo: reviewed.source.repo,
    modelFiles,
    lock,
    archives,
  };
}

/**
 * A macOS host, native (its Rosetta query answers 0), whose content-free `sandbox-exec` probe exits as told; no real
 * process is started.
 */
export function macPlatform(sandbox: 'passes' | 'fails' = 'passes'): LayaPlatformProbe {
  return {
    platform: 'darwin',
    architecture: 'arm64',
    spawnSync: (command) =>
      command === '/usr/sbin/sysctl'
        ? { status: 0, signal: null, error: undefined, stdout: '0\n' }
        : { status: sandbox === 'passes' ? 0 : 1, signal: null, error: undefined },
  };
}

export interface OriginGate {
  /** Resolves once the gated reply has sent its status line and the first half of its body. */
  readonly reached: Promise<void>;
  release(): void;
}

export interface LayaArtifactOrigin {
  readonly network: {
    readonly resolver: ReturnType<typeof resolverFor>;
    readonly tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
    readonly tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  };
  /** Every request path the production fetcher wrote, in order. */
  readonly requests: string[];
  /** Replaces what one path serves from now on. */
  serve(path: string, body: Uint8Array): void;
  /** Holds the next reply for one path halfway through its body until released. */
  gate(path: string): OriginGate;
}

/** The request path of one reviewed model file at the synthetic revision. */
export function modelPath(laya: SyntheticLaya, file: string): string {
  return `/${laya.repo}/resolve/${laya.revision}/${file}`;
}

/**
 * A sealed in-process origin for the production fetcher: its fake TCP/TLS sockets never open a route, and each
 * written request is answered from the routes by path, with an exact `Range`/`Content-Range` resume.
 */
export function layaArtifactOrigin(laya: SyntheticLaya): LayaArtifactOrigin {
  const routes = new Map<string, Uint8Array>(laya.archives);
  for (const file of laya.modelFiles) routes.set(modelPath(laya, file.path), file.bytes);
  const gates = new Map<string, { reached: () => void; released: Promise<void> }>();
  const requests: string[] = [];
  const tlsConnect = async (_options: PinnedTlsOptions): Promise<tls.TLSSocket> => {
    const socket = new EventEmitter() as EventEmitter & {
      write(bytes: Uint8Array): boolean;
      destroy(): void;
      pause(): void;
      resume(): void;
    };
    let closed = false;
    socket.destroy = () => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => socket.emit('close'));
    };
    socket.pause = () => undefined;
    socket.resume = () => undefined;
    socket.write = (bytes: Uint8Array) => {
      const request = Buffer.from(bytes).toString('latin1');
      const path = /^GET (\S+) HTTP\/1\.1\r\n/u.exec(request)?.[1] ?? '';
      requests.push(path);
      const body = Buffer.from(routes.get(path) ?? Buffer.alloc(0));
      const range = /\r\nrange: bytes=(\d+)-\r\n/iu.exec(request);
      const start = range === null ? 0 : Number(range[1]);
      const payload = routes.has(path) ? body.subarray(start) : Buffer.alloc(0);
      const status = !routes.has(path) ? '404 Not Found' : range === null ? '200 OK' : '206 Partial Content';
      const headers = [`content-length: ${payload.length}`];
      if (range !== null && routes.has(path))
        headers.push(`content-range: bytes ${start}-${body.length - 1}/${body.length}`);
      const head = Buffer.from(`HTTP/1.1 ${status}\r\n${headers.join('\r\n')}\r\n\r\n`, 'latin1');
      const gate = gates.get(path);
      gates.delete(path);
      void (async () => {
        await Promise.resolve();
        if (gate === undefined) {
          if (closed) return;
          socket.emit('data', Buffer.concat([head, payload]));
          socket.emit('end');
          return;
        }
        const half = Math.floor(payload.length / 2);
        socket.emit('data', Buffer.concat([head, payload.subarray(0, half)]));
        gate.reached();
        await gate.released;
        if (closed) return;
        socket.emit('data', payload.subarray(half));
        socket.emit('end');
      })();
      return true;
    };
    return socket as unknown as tls.TLSSocket;
  };
  return {
    network: {
      resolver: resolverFor('8.8.8.8'),
      tcpConnect: async () => ({}) as net.Socket,
      tlsConnect,
    },
    requests,
    serve(path, body) {
      routes.set(path, body);
    },
    gate(path) {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(path, { reached, released });
      return { reached: reachedPromise, release };
    },
  };
}

/** One test-controlled pause at one artifact edge; every other edge, and later visits, pass straight through. */
export function pauseAt(edge: LayaArtifactEdge): {
  readonly failpoint: LayaArtifactFailpoint;
  readonly reached: Promise<void>;
  release(): void;
} {
  let armed = true;
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    failpoint: async (visited) => {
      if (!armed || visited !== edge) return;
      armed = false;
      reached();
      await released;
    },
    reached: reachedPromise,
    release,
  };
}

/** Every relative path below a directory, sorted, or null when it does not exist. */
export async function treeListing(root: string): Promise<readonly string[] | null> {
  try {
    await lstat(root);
  } catch {
    return null;
  }
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else found.push(relative);
    }
  };
  await visit(root, '');
  return found.sort();
}

export interface LayaRig {
  readonly root: string;
  readonly store: Awaited<ReturnType<typeof openEventDatabase>>;
  readonly artifactRoot: string;
  readonly manager: LayaArtifactManager;
  readonly operator: B3OperatorControl;
  readonly activations: ActivationRuntime;
  readonly origin: LayaArtifactOrigin;
  readonly laya: SyntheticLaya;
  /** Prepares `judge kind enable laya` through the production control; it never approves. */
  prepare(): Promise<{ readonly approvalId: string }>;
  /** A person's terminal approval of one prepared enablement: E's challenge, approve, claim and pointer. */
  approve(prepared: { readonly approvalId: string }): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<unknown>;
  modelRow(): unknown;
  close(): Promise<void>;
}

/**
 * The owner's own composition of E2's artifact manager — the production activation runtime, B3 operator control, E
 * purge listener and manager — over one temporary state, data directory and sealed origin.
 */
export async function layaRig(
  options: {
    readonly laya?: SyntheticLaya;
    readonly platform?: LayaPlatformProbe;
    readonly failpoint?: LayaArtifactFailpoint;
    readonly freeBytes?: () => Promise<number>;
    readonly root?: string;
    readonly origin?: LayaArtifactOrigin;
    readonly now?: () => number;
    readonly audit?: { append(record: Record<string, unknown>): Promise<unknown> };
  } = {},
): Promise<LayaRig> {
  const root = options.root ?? (await shortTempDir('events-e2-t6-'));
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(emptyConfig())}\n`);
  const laya = options.laya ?? (await syntheticLaya());
  const origin = options.origin ?? layaArtifactOrigin(laya);
  const store = await openEventDatabase({ stateDir });
  const config = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => config.load() });
  const platform = options.platform ?? macPlatform();
  const inputs = { layaAssetSource: laya.assets, layaPlatformProbe: platform };
  const now = options.now ?? (() => 1_800_000_000_000);
  const artifactRoot = join(root, 'data', 'events', LAYA);
  const manager = new LayaArtifactManager({
    store,
    artifactRoot,
    inputs,
    network: origin.network,
    freeBytes: options.freeBytes ?? (async () => Number.MAX_SAFE_INTEGER),
    failpoint: options.failpoint,
    ...(options.audit === undefined ? {} : { audit: options.audit as never }),
    now,
  });
  const unregister = registerJudgeWorkPurgeListener(store.database, manager);
  const refused = async (): Promise<never> => {
    throw new Error('a judge-kind activation touches no source');
  };
  const activations = new ActivationRuntime({
    store,
    approvals,
    config,
    gmailSourceFor: refused,
    encryptBaseline: refused,
    decryptBaseline: refused,
    encryptPoint: refused,
    decryptPoint: refused,
    mailboxLock: new MailboxLock(),
    ...inputs,
    // Core's approvals stamp real time, so the claim deadline is measured on it; only D8 stamps use the test clock.
    onJudgeKindEnabled: ({ kind }) => {
      if (kind === LAYA) void manager.ensureInstalled();
    },
  });
  const operator = new B3OperatorControl({
    store,
    ports: { quiescer: new WriterQuiescer() } as never,
    activations,
    laya: manager,
    now,
  });
  const prepare = async () =>
    (await operator.handle({ operation: 'enableJudgeKind', args: { kind: LAYA } })) as { readonly approvalId: string };
  const approve = async (prepared: { readonly approvalId: string }) => {
    const answer = await activations.issueChallenge(prepared.approvalId);
    await activations.approve({ approvalId: prepared.approvalId, answer });
  };
  return {
    root,
    store,
    artifactRoot,
    manager,
    operator,
    activations,
    origin,
    laya,
    prepare,
    approve,
    async enable() {
      await approve(await prepare());
    },
    disable: () => operator.handle({ operation: 'disableJudgeKind', args: { kind: LAYA } }),
    modelRow: () => {
      const row = store.database.prepare('SELECT * FROM laya_models WHERE manifest_id = ?').get(laya.manifestId);
      return row === undefined ? null : { ...row };
    },
    async close() {
      await manager.stop();
      unregister();
      store.close();
      if (options.root === undefined) await rm(root, { recursive: true, force: true });
    },
  };
}
