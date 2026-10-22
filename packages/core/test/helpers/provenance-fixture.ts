import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import type { TarballFetch } from '../../src/release-tarball.ts';
import {
  ATTESTATIONS_BASE,
  type AttestationFetch,
  releaseVerifier,
  sigstoreBundleVerifier,
} from '../../src/update-provenance.ts';
import type { Packument, ReleaseRegistry, ReleaseVerifier } from '../../src/update-release.ts';
import { integrityOfBytes, releaseTarball } from './tarball-fixture.ts';

/*
 * Provenance bundles made here, for tests that must never reach npm or Sigstore (design 2026-10-16 §4).
 *
 * Each bundle is the shape npm serves from its attestations endpoint — a Sigstore bundle holding a DSSE envelope of an
 * in-toto statement of SLSA provenance v1, signed by a Fulcio-style certificate, with a transparency-log entry — and
 * it is signed for real, by keys made for the test: a certificate authority, a certificate-transparency log and a
 * transparency log, which `trustedRoot()` names as Sigstore's trust root names its own. So sigstore-js itself verifies
 * one, as it would verify npm's, and refuses one that was changed after it was signed.
 *
 * Every field the pins read can be set to something else (`ProvenanceShape`), to break one pin at a time.
 */

// ── DER, as far as a certificate needs ─────────────────────────────────────────────────────────────────────────

function lengthOf(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), lengthOf(content.length), content]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'));
const octets = (value: Buffer): Buffer => tlv(0x04, value);
const bits = (value: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), value]));
const yes = (): Buffer => tlv(0x01, Buffer.from([0xff]));

function integer(value: number): Buffer {
  const bytes: number[] = [];
  for (let rest = value; rest > 0 || bytes.length === 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  if ((bytes[0] as number) & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out: number[] = [(first as number) * 40 + (second as number)];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let value = arc; ; value = Math.floor(value / 128)) {
      groups.unshift(value % 128);
      if (value < 128) break;
    }
    out.push(...groups.map((group, index) => (index < groups.length - 1 ? group | 0x80 : group)));
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(at: Date): Buffer {
  const two = (value: number) => String(value).padStart(2, '0');
  const text = `${two(at.getUTCFullYear() % 100)}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

const name = (common: string): Buffer =>
  seq(set(seq(oid('2.5.4.10'), utf8('comms-test')), seq(oid('2.5.4.3'), utf8(common))));
const ecdsaWithSha256 = (): Buffer => seq(oid('1.2.840.10045.4.3.2'));
const extension = (id: string, value: Buffer, critical = false): Buffer =>
  seq(oid(id), ...(critical ? [yes()] : []), octets(value));

function spki(key: KeyObject): Buffer {
  return key.export({ type: 'spki', format: 'der' });
}

function keyId(key: KeyObject): Buffer {
  return createHash('sha256').update(spki(key)).digest();
}

function signCertificate(tbs: Buffer, issuerKey: KeyObject): Buffer {
  return seq(tbs, ecdsaWithSha256(), bits(sign('sha256', tbs, issuerKey)));
}

// ── The trust root the tests' bundles chain to ──────────────────────────────────────────────────────────────────

interface Keys {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

const ec = (): Keys => generateKeyPairSync('ec', { namedCurve: 'P-256' });

const NOT_BEFORE = new Date('2026-01-01T00:00:00Z');
const NOT_AFTER = new Date('2036-01-01T00:00:00Z');

/** One certificate authority, one CT log and one transparency log, made once per test process. */
const authority = ec();
const ctLog = ec();
const transparencyLog = ec();

const rootCertificate = signCertificate(
  seq(
    tlv(0xa0, integer(2)),
    integer(1),
    ecdsaWithSha256(),
    name('comms-test root'),
    seq(utcTime(NOT_BEFORE), utcTime(NOT_AFTER)),
    name('comms-test root'),
    spki(authority.publicKey),
    tlv(
      0xa3,
      seq(
        extension('2.5.29.19', seq(yes()), true),
        extension('2.5.29.15', bits(Buffer.from([0x06])), true),
        extension('2.5.29.14', octets(keyId(authority.publicKey).subarray(0, 20))),
      ),
    ),
  ),
  authority.privateKey,
);

/** The trust root, as Sigstore's `trusted_root.json` is written, naming the three made above. */
export function trustedRoot(): Record<string, unknown> {
  const log = (keys: Keys, url: string) => ({
    baseUrl: url,
    hashAlgorithm: 'SHA2_256',
    publicKey: {
      rawBytes: spki(keys.publicKey).toString('base64'),
      keyDetails: 'PKIX_ECDSA_P256_SHA_256',
      validFor: { start: NOT_BEFORE.toISOString() },
    },
    logId: { keyId: keyId(keys.publicKey).toString('base64') },
  });
  return {
    mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    tlogs: [log(transparencyLog, 'https://rekor.comms.test')],
    certificateAuthorities: [
      {
        subject: { organization: 'comms-test', commonName: 'comms-test root' },
        uri: 'https://fulcio.comms.test',
        certChain: { certificates: [{ rawBytes: rootCertificate.toString('base64') }] },
        validFor: { start: NOT_BEFORE.toISOString() },
      },
    ],
    ctlogs: [log(ctLog, 'https://ctfe.comms.test')],
    timestampAuthorities: [],
  };
}

// ── One provenance bundle ───────────────────────────────────────────────────────────────────────────────────────

/** What a bundle says. Each field defaults to what a release of `version` built by release.yml says. */
export interface ProvenanceShape {
  packageName: string;
  version: string;
  /** The tarball's integrity, as the registry gives it: `sha512-<base64>`. */
  integrity: string;
  issuer?: string;
  /** The certificate's one subject alternative name, a URI. */
  identity?: string;
  runner?: string;
  sourceRepository?: string;
  sourceRef?: string;
  /** The subject's package URL and SHA-512, hex. */
  subjectName?: string;
  subjectSha512?: string;
  predicateType?: string;
}

const REPOSITORY = 'https://github.com/crissmoldovan/agent-communications';

/** A tarball's integrity, as the registry writes it, for `contents`. */
export function integrityOf(contents: string): string {
  return `sha512-${createHash('sha512').update(contents).digest('base64')}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function pae(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} ${type} ${payload.length} `, 'ascii'), payload]);
}

/** An SCT for `precertificate` (the leaf's body without the SCT), as a CT log signs one: RFC 6962 §3.2. */
function sctFor(precertificate: Buffer, at: Date): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigInt64BE(BigInt(at.getTime()));
  const issuerKeyHash = keyId(authority.publicKey);
  const length = Buffer.alloc(3);
  length.writeUIntBE(precertificate.length, 0, 3);
  const signed = Buffer.concat([
    Buffer.from([0, 0]),
    timestamp,
    Buffer.from([0, 1]),
    issuerKeyHash,
    length,
    precertificate,
    Buffer.from([0, 0]),
  ]);
  const signature = sign('sha256', signed, ctLog.privateKey);
  const signatureLength = Buffer.alloc(2);
  signatureLength.writeUInt16BE(signature.length);
  const sct = Buffer.concat([
    Buffer.from([0]),
    keyId(ctLog.publicKey),
    timestamp,
    Buffer.from([0, 0]),
    Buffer.from([4, 3]),
    signatureLength,
    signature,
  ]);
  const item = Buffer.alloc(2);
  item.writeUInt16BE(sct.length);
  const list = Buffer.alloc(2);
  list.writeUInt16BE(sct.length + 2);
  return Buffer.concat([list, item, sct]);
}

/** The bundle, as npm's endpoint holds it under `attestations[].bundle`, for exactly `shape`. */
export function provenanceBundle(
  shape: ProvenanceShape,
  signedAt: Date = new Date('2026-10-10T12:00:00Z'),
): Record<string, unknown> {
  const tag = `refs/tags/v${shape.version}`;
  const leaf = ec();
  const fulcio = (id: string, value: string) => extension(`1.3.6.1.4.1.57264.1.${id}`, utf8(value));
  const extensions = [
    extension('2.5.29.15', bits(Buffer.from([0x80])), true),
    extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.3'))),
    extension('2.5.29.35', seq(tlv(0x80, keyId(authority.publicKey).subarray(0, 20)))),
    extension(
      '2.5.29.17',
      seq(tlv(0x86, Buffer.from(shape.identity ?? `${REPOSITORY}/.github/workflows/release.yml@${tag}`, 'ascii'))),
      true,
    ),
    fulcio('8', shape.issuer ?? 'https://token.actions.githubusercontent.com'),
    fulcio('11', shape.runner ?? 'github-hosted'),
    fulcio('12', shape.sourceRepository ?? REPOSITORY),
    fulcio('14', shape.sourceRef ?? tag),
  ];
  const serial = integer(1000 + Math.floor(Math.random() * 1_000_000));
  // The certificate's body, with the SCT extension or without it: the precertificate the CT log signs is the latter.
  const body = (more: Buffer[]) =>
    seq(
      tlv(0xa0, integer(2)),
      serial,
      ecdsaWithSha256(),
      name('comms-test root'),
      seq(utcTime(new Date(signedAt.getTime() - 60_000)), utcTime(new Date(signedAt.getTime() + 10 * 60_000))),
      tlv(0x30, Buffer.alloc(0)),
      spki(leaf.publicKey),
      tlv(0xa3, seq(...extensions, ...more)),
    );
  const sct = sctFor(body([]), signedAt);
  const certificate = signCertificate(body([extension('1.3.6.1.4.1.11129.2.4.2', octets(sct))]), authority.privateKey);

  const sha512 = shape.subjectSha512 ?? Buffer.from(shape.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: shape.subjectName ?? `pkg:npm/${shape.packageName.replace(/^@/, '%40')}@${shape.version}`,
        digest: { sha512 },
      },
    ],
    predicateType: shape.predicateType ?? 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: { workflow: { ref: tag, repository: REPOSITORY, path: '.github/workflows/release.yml' } },
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' } },
    },
  };
  const payloadType = 'application/vnd.in-toto+json';
  const payload = Buffer.from(JSON.stringify(statement), 'utf8');
  const signature = sign('sha256', pae(payloadType, payload), leaf.privateKey);

  const entryBody = Buffer.from(
    canonical({
      apiVersion: '0.0.1',
      kind: 'dsse',
      spec: {
        payloadHash: { algorithm: 'sha256', value: createHash('sha256').update(payload).digest('hex') },
        signatures: [{ signature: signature.toString('base64'), verifier: certificate.toString('base64') }],
      },
    }),
    'utf8',
  );
  const integratedTime = Math.floor(signedAt.getTime() / 1000);
  const logIndex = 4242;
  const promise = sign(
    'sha256',
    Buffer.from(
      canonical({
        body: entryBody.toString('base64'),
        integratedTime,
        logID: keyId(transparencyLog.publicKey).toString('hex'),
        logIndex,
      }),
      'utf8',
    ),
    transparencyLog.privateKey,
  );
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.1',
    verificationMaterial: {
      x509CertificateChain: { certificates: [{ rawBytes: certificate.toString('base64') }] },
      tlogEntries: [
        {
          logIndex: String(logIndex),
          logId: { keyId: keyId(transparencyLog.publicKey).toString('base64') },
          kindVersion: { kind: 'dsse', version: '0.0.1' },
          integratedTime: String(integratedTime),
          inclusionPromise: { signedEntryTimestamp: promise.toString('base64') },
          canonicalizedBody: entryBody.toString('base64'),
        },
      ],
    },
    dsseEnvelope: {
      payload: payload.toString('base64'),
      payloadType,
      signatures: [{ sig: signature.toString('base64'), keyid: '' }],
    },
  };
}

/** What npm's endpoint answers for one version: its publish attestation and its SLSA provenance. */
export function attestationsAnswer(bundle: Record<string, unknown>): { attestations: Record<string, unknown>[] } {
  return {
    attestations: [
      { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: { mediaType: 'x' } },
      { predicateType: 'https://slsa.dev/provenance/v1', bundle },
    ],
  };
}

// ── Stand-ins for an update: npm's endpoint, a registry of full documents, and the verifier ─────────────────────────

const packed = new Map<string, Buffer>();

/** The tarball every stand-in serves for one release (`releaseTarball`, declaring nothing), made once per process. */
function fixtureTarball(packageName: string, version: string): Buffer {
  const key = `${packageName}@${version}`;
  let bytes = packed.get(key);
  if (bytes === undefined) {
    bytes = releaseTarball(packageName, version);
    packed.set(key, bytes);
  }
  return bytes;
}

/** The tarball every stand-in serves for one release: its integrity, as the registry writes it. */
export const tarballOf = (packageName: string, version: string): string =>
  integrityOfBytes(fixtureTarball(packageName, version));

/** Where a stand-in registry says one release's tarball is: npm's own path, on a host no test can reach. */
export function fixtureTarballUrl(packageName: string, version: string): string {
  return `https://registry.comms.test/${packageName}/-/${packageName.split('/').at(-1)}-${version}.tgz`;
}

/**
 * The tarballs a stand-in registry names (`fixtureTarballUrl`): each release's `releaseTarball`, the very bytes
 * `tarballOf` gives the integrity of and the attestations endpoint signs. Anything else is a 404.
 */
export const fixtureTarballs: TarballFetch = async (url) => {
  const found = /^https:\/\/registry\.comms\.test\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)\.tgz$/.exec(url);
  const packageName = found?.[1];
  const base = packageName?.split('/').at(-1);
  const file = found?.[2];
  if (packageName === undefined || base === undefined || file === undefined || !file.startsWith(`${base}-`)) {
    return new Response('not found', { status: 404 });
  }
  const version = file.slice(base.length + 1);
  if (fixtureTarballUrl(packageName, version) !== url) return new Response('not found', { status: 404 });
  const bytes = fixtureTarball(packageName, version);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
  });
};

/**
 * npm's attestations endpoint: a genuine bundle for every package and version, signing `tarballOf` it — but where
 * `change` says otherwise, by `package` or by `package@version`: another shape, or `'missing'` for none at all.
 */
export function attestationsEndpoint(change: Record<string, Partial<ProvenanceShape> | 'missing'> = {}): {
  fetch: AttestationFetch;
  asked: string[];
} {
  const asked: string[] = [];
  const fetch: AttestationFetch = async (url) => {
    asked.push(url);
    const spec = decodeURIComponent(url.slice(ATTESTATIONS_BASE.length));
    const at = spec.lastIndexOf('@');
    const packageName = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const shape = change[`${packageName}@${version}`] ?? change[packageName];
    if (shape === 'missing') return { status: 404, body: { error: 'not found' } };
    const bundle = provenanceBundle({ packageName, version, integrity: tarballOf(packageName, version), ...shape });
    return { status: 200, body: attestationsAnswer(bundle) };
  };
  return { fetch, asked };
}

/** The verifier an update is handed in a test: the real one, reading `endpoint`, with sigstore-js and the test's root. */
export function testReleaseVerifier(endpoint: { fetch: AttestationFetch } = attestationsEndpoint()): ReleaseVerifier {
  return releaseVerifier({
    fetch: endpoint.fetch,
    verifyBundle: sigstoreBundleVerifier({ trustedRoot: async () => trustedRoot() }),
  });
}

/** One release in a stand-in registry: when it came out, and what its core manifest declares. */
export interface ListedRelease {
  version: string;
  publishedAt?: Date | undefined;
  declares?: unknown;
}

/**
 * A registry's full package documents: for each package, `latest` as its tag and every release in `releases` (and
 * `latest` itself), each with the tarball `tarballOf` it at `fixtureTarballUrl`; `agentcommsRelease` only on core's, as
 * the release declares.
 */
export function packumentRegistry(
  latest: Record<string, string>,
  releases: readonly ListedRelease[] = [],
): { read: ReleaseRegistry; asked: string[] } {
  const asked: string[] = [];
  const read: ReleaseRegistry = async (packageName) => {
    asked.push(packageName);
    const tag = latest[packageName];
    if (tag === undefined) throw new Error(`the registry answered 404 for ${packageName}`);
    const packument: Packument = { 'dist-tags': { latest: tag }, versions: {}, time: {} };
    const listed = releases.some((release) => release.version === tag) ? releases : [...releases, { version: tag }];
    for (const release of listed) {
      (packument.versions as Record<string, unknown>)[release.version] = {
        dist: {
          integrity: tarballOf(packageName, release.version),
          tarball: fixtureTarballUrl(packageName, release.version),
        },
        ...(packageName === '@agentcomms/core' && release.declares !== undefined
          ? { agentcommsRelease: release.declares }
          : {}),
      };
      (packument.time as Record<string, unknown>)[release.version] = (
        release.publishedAt ?? new Date('2026-10-01T00:00:00Z')
      ).toISOString();
    }
    return { packument };
  };
  return { read, asked };
}

/**
 * A registry whose every package's latest release is what `latestOf` says — a stand-in `latestVersion`, read again —
 * with its tarball `tarballOf` it at `fixtureTarballUrl`: for a test about something else than which releases there are.
 */
export function registryOf(latestOf: (packageName: string) => string | Promise<string>): ReleaseRegistry {
  return async (packageName) => {
    const version = await latestOf(packageName);
    return {
      packument: {
        'dist-tags': { latest: version },
        versions: {
          [version]: {
            dist: { integrity: tarballOf(packageName, version), tarball: fixtureTarballUrl(packageName, version) },
          },
        },
      },
    };
  };
}
