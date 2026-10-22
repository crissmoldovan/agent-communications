import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TarballFetch } from '../../src/release-tarball.ts';
import {
  ATTESTATIONS_BASE,
  type AttestationFetch,
  type BundleVerifier,
  releaseVerifier,
  sigstoreBundleVerifier,
} from '../../src/update-provenance.ts';
import type { Packument, ReleaseRegistry, ReleaseVerifier } from '../../src/update-release.ts';
import {
  attestationsAnswer,
  fixtureTarballUrl,
  type ProvenanceShape,
  provenanceBundle,
  trustedRoot,
} from './provenance-fixture.ts';
import { integrityOfBytes, releaseTarball } from './tarball-fixture.ts';

/*
 * One world of releases, for a test about what a release declares and when it was signed (design 2026-10-22 P1, P4):
 * the registry's documents, npm's attestations endpoint, the verifier over the test's own trust root, and the
 * tarballs the documents point at — each release's tarball its own bytes, which its provenance signs.
 *
 * What the registry says and what the verified tarball says are set apart on purpose (`declares`, `registrySays`), so
 * a test can show which one an update believes. Nothing here reaches npm or Sigstore: the tarballs are served by a
 * stand-in fetch, or by `loopbackRegistry` on 127.0.0.1 for a test that runs npm itself.
 */

const CORE = '@agentcomms/core';
const DEFAULT_PUBLISHED = new Date('2026-10-01T00:00:00Z');

/** One release in the world, on every package `latest` names unless `packages` says which. */
export interface WorldRelease {
  version: string;
  /** Default: every package `latest` names. */
  packages?: readonly string[];
  /** The tarball manifest's `agentcommsRelease` (core only). */
  declares?: unknown;
  /** The packument's `agentcommsRelease` (core only); default: `declares`. */
  registrySays?: unknown;
  /** The packument's `time`. */
  publishedAt?: Date;
  /** Passed to `provenanceBundle` as its signing time. */
  signedAt?: Date;
  /** What its attestation says instead of the genuine bundle, or `'missing'` for none. */
  shape?: Partial<ProvenanceShape> | 'missing';
  /** What its tarball location answers: its own bytes, a 404, or another tarball's bytes. */
  serve?: 'ok' | 'missing' | 'other-bytes';
  /**
   * More of a package's manifest, by package, in its tarball and its registry document alike: Gmail's `dependencies`
   * on core, so that npm installs a global Gmail with a nested `@agentcomms/core`, or a `bin`. Not given, the tarball
   * is the one it always was.
   */
  manifests?: Record<string, Record<string, unknown>>;
  /** More files in a package's tarball, by package, each below `package/`. */
  files?: Record<string, Record<string, string>>;
}

export interface World {
  registry: ReleaseRegistry;
  registryAsked: string[];
  attestations: AttestationFetch;
  attestationsAsked: string[];
  verifyBundle: BundleVerifier;
  verifyRelease: ReleaseVerifier;
  tarballs: TarballFetch;
  tarballsAsked: string[];
  /** A release's own tarball: what its provenance signs. */
  tarball(packageName: string, version: string): Buffer;
  integrity(packageName: string, version: string): string;
  /**
   * What the attestations endpoint says from now on, by package or `package@version`: each key replaces what was said
   * of it (a release's own `shape` included), and `{}` makes it genuine again.
   */
  change(next: Record<string, Partial<ProvenanceShape> | 'missing'>): void;
}

/** A package's document, as the world's registry and its loopback both serve it, with `tarballAt` for each version. */
interface Built {
  packument: Packument & { name: string };
}

/** What `loopbackRegistry` serves a world from: its documents, and what each tarball location answers. */
interface Inside {
  build: (packageName: string, tarballAt: (version: string) => string) => Built;
  served: (packageName: string, version: string) => Buffer | 'missing' | null;
}

const insides = new WeakMap<World, Inside>();

export function releaseWorld(latest: Record<string, string>, releases: readonly WorldRelease[] = []): World {
  const packages = Object.keys(latest);
  const releaseOf = (packageName: string, version: string): WorldRelease | undefined =>
    releases.find((release) => release.version === version && (release.packages ?? packages).includes(packageName));
  const versionsOf = (packageName: string): string[] => {
    const listed = releases
      .filter((release) => (release.packages ?? packages).includes(packageName))
      .map((release) => release.version);
    const tag = latest[packageName];
    return tag === undefined || listed.includes(tag) ? listed : [...listed, tag];
  };
  const exists = (packageName: string, version: string): boolean => versionsOf(packageName).includes(version);

  const packed = new Map<string, Buffer>();
  const tarball = (packageName: string, version: string): Buffer => {
    const key = `${packageName}@${version}`;
    let bytes = packed.get(key);
    if (bytes === undefined) {
      const release = releaseOf(packageName, version);
      const declares = packageName === CORE ? release?.declares : undefined;
      const manifest = release?.manifests?.[packageName];
      const files = release?.files?.[packageName];
      bytes = releaseTarball(packageName, version, {
        ...(declares === undefined ? {} : { declares }),
        ...(manifest === undefined ? {} : { manifest }),
        ...(files === undefined ? {} : { files }),
      });
      packed.set(key, bytes);
    }
    return bytes;
  };
  const integrity = (packageName: string, version: string): string => integrityOfBytes(tarball(packageName, version));

  const build = (packageName: string, tarballAt: (version: string) => string): Built => {
    const tag = latest[packageName];
    // Each version's manifest as npm's registry serves one: its name and version beside what an update reads.
    const versions: Record<string, NonNullable<NonNullable<Packument['versions']>[string]> & Record<string, unknown>> =
      {};
    const time: Record<string, unknown> = {};
    for (const version of versionsOf(packageName)) {
      const release = releaseOf(packageName, version);
      const says = release?.registrySays !== undefined ? release.registrySays : release?.declares;
      versions[version] = {
        ...release?.manifests?.[packageName],
        name: packageName,
        version,
        ...(packageName === CORE && says !== undefined ? { agentcommsRelease: says } : {}),
        dist: { integrity: integrity(packageName, version), tarball: tarballAt(version) },
      };
      time[version] = (release?.publishedAt ?? DEFAULT_PUBLISHED).toISOString();
    }
    return { packument: { name: packageName, 'dist-tags': { latest: tag }, versions, time } };
  };

  /** What a release's tarball location answers, or null for a release the world does not have. */
  const served = (packageName: string, version: string): Buffer | 'missing' | null => {
    if (!exists(packageName, version)) return null;
    const serve = releaseOf(packageName, version)?.serve ?? 'ok';
    if (serve === 'missing') return 'missing';
    if (serve === 'other-bytes') {
      return releaseTarball(packageName, version, { files: { 'OTHER.md': 'not the tarball its provenance signs\n' } });
    }
    return tarball(packageName, version);
  };

  const registryAsked: string[] = [];
  const registry: ReleaseRegistry = async (packageName) => {
    registryAsked.push(packageName);
    if (latest[packageName] === undefined) throw new Error(`the registry answered 404 for ${packageName}`);
    return { packument: build(packageName, (version) => fixtureTarballUrl(packageName, version)).packument };
  };

  const changes: Record<string, Partial<ProvenanceShape> | 'missing'> = {};
  const attestationsAsked: string[] = [];
  const attestations: AttestationFetch = async (url) => {
    attestationsAsked.push(url);
    const spec = decodeURIComponent(url.slice(ATTESTATIONS_BASE.length));
    const at = spec.lastIndexOf('@');
    const packageName = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (!url.startsWith(ATTESTATIONS_BASE) || at <= 0 || !exists(packageName, version)) {
      return { status: 404, body: { error: 'not found' } };
    }
    const shape =
      changes[`${packageName}@${version}`] ?? changes[packageName] ?? releaseOf(packageName, version)?.shape;
    if (shape === 'missing') return { status: 404, body: { error: 'not found' } };
    const signedAt = releaseOf(packageName, version)?.signedAt;
    const bundle = provenanceBundle(
      { packageName, version, integrity: integrity(packageName, version), ...shape },
      ...(signedAt === undefined ? [] : [signedAt]),
    );
    return { status: 200, body: attestationsAnswer(bundle) };
  };
  const verifyBundle = sigstoreBundleVerifier({ trustedRoot: async () => trustedRoot() });

  const tarballsAsked: string[] = [];
  const tarballs: TarballFetch = async (url) => {
    tarballsAsked.push(url);
    for (const packageName of packages) {
      for (const version of versionsOf(packageName)) {
        if (fixtureTarballUrl(packageName, version) !== url) continue;
        const answer = served(packageName, version);
        if (answer === null || answer === 'missing') return new Response('not found', { status: 404 });
        return new Response(new Uint8Array(answer), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(answer.length) },
        });
      }
    }
    return new Response('not found', { status: 404 });
  };

  const world: World = {
    registry,
    registryAsked,
    attestations,
    attestationsAsked,
    verifyBundle,
    verifyRelease: releaseVerifier({ fetch: attestations, verifyBundle }),
    tarballs,
    tarballsAsked,
    tarball,
    integrity,
    change: (next) => {
      Object.assign(changes, next);
    },
  };
  insides.set(world, { build, served });
  return world;
}

/**
 * The world on 127.0.0.1: each package's document at `/<name>` (a scope's slash escaped or not), with its
 * `dist.tarball` pointing here, and each release's tarball as its `serve` says. `toNpm` serves npm itself — a request
 * whose user agent is npm's — another tarball by package name, and gives that tarball's integrity in the document npm
 * reads, so npm installs it: a registry that lies to npm, consistently, and not to the check.
 */
export async function loopbackRegistry(
  world: World,
  options: { toNpm?: Record<string, Buffer> } = {},
): Promise<{ url: string; asked: { url: string; npm: boolean }[]; close(): Promise<void> }> {
  const inside = insides.get(world);
  if (inside === undefined) throw new Error('loopbackRegistry serves a world releaseWorld made');
  const { build, served } = inside;
  const asked: { url: string; npm: boolean }[] = [];
  let url = '';
  const fromNpm = (request: IncomingMessage) => /\bnpm\//.test(String(request.headers['user-agent']));
  const server: Server = createServer((request, response) => {
    const npm = fromNpm(request);
    const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    asked.push({ url: path, npm });
    const notFound = () => response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    const file = /^\/tarballs\/((?:@[^/]+\/)?[^/]+)\/-\/[^/]+-(\d+\.\d+\.\d+[^/]*)\.tgz$/.exec(path);
    if (file) {
      const packageName = String(file[1]);
      const version = String(file[2]);
      const swapped = npm ? options.toNpm?.[packageName] : undefined;
      const answer = swapped ?? served(packageName, version);
      if (answer === null || answer === 'missing') return notFound();
      response
        .writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(answer.length) })
        .end(answer);
      return;
    }
    const packageName = path.slice(1);
    let built: Built;
    try {
      built = build(
        packageName,
        (version) => `${url}tarballs/${packageName}/-/${packageName.split('/').at(-1)}-${version}.tgz`,
      );
    } catch {
      return notFound();
    }
    if (built.packument['dist-tags']?.latest === undefined) return notFound();
    const lie = npm ? options.toNpm?.[packageName] : undefined;
    const packument =
      lie === undefined
        ? built.packument
        : {
            ...built.packument,
            versions: Object.fromEntries(
              Object.entries(built.packument.versions ?? {}).map(([version, manifest]) => [
                version,
                { ...manifest, dist: { ...manifest?.dist, integrity: integrityOfBytes(lie) } },
              ]),
            ),
          };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument));
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    url,
    asked,
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}
