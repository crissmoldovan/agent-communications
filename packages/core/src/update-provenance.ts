/**
 * Provenance before a background install (design 2026-10-16 U5 step 3; §2): a release is installed in the background
 * only when npm's attestation for it says it was built by this repository's own release workflow, on a tag of exactly
 * that version, on a GitHub-hosted runner — and the attestation is signed, through Sigstore, for exactly that.
 *
 * npm itself pins none of this: a version without provenance installs, and so does one built anywhere else
 * (§2, the Nx postmortem). So it is checked here, twice over:
 *
 * - **By sigstore-js** (`BundleVerifier`): the DSSE envelope's signature, the signing certificate's chain to Sigstore's
 *   Fulcio, its certificate-transparency proof, the transparency-log entry that recorded the signing, and the issuer
 *   and identity as a policy. sigstore-js reads an identity given as text as an unanchored regular expression
 *   (`signerIdentity.match(policy)`), so `release.yml@refs/tags/v0.20.0` would also take `v0.20.0-evil` and
 *   `v0.20.01`: it is handed the anchored pattern instead.
 * - **Here**, from the bundle's own certificate and statement: the issuer, the identity anchored at both ends, the
 *   runner environment — which sigstore-js has no policy for — the source repository and ref, and the statement's
 *   subject: this package at this version, with the very SHA-512 the registry gives as its tarball's integrity, which
 *   is what npm then checks the tarball it downloads against.
 *
 * Anything missing or different is a refusal, with the field that failed, said in fixed words: never what the
 * certificate, the statement or the endpoint held instead. Provenance proves where a package was built,
 * not that it is safe (§2): the hold before a background install is the other half.
 *
 * Nothing here installs or writes anything. The fetch and the verifier are injectable, so a test reads fixtures and no
 * test reaches npm or Sigstore.
 */

import { join } from 'node:path';
import { sha512Hex } from './update-release.ts';

/** The pins: what a release's provenance has to say, field by field (plan, Global constraints). */
export const PROVENANCE_PINS: Readonly<{
  issuer: string;
  repository: string;
  workflow: string;
  runner: string;
}> = Object.freeze({
  issuer: 'https://token.actions.githubusercontent.com',
  repository: 'crissmoldovan/agent-communications',
  workflow: '.github/workflows/release.yml',
  runner: 'github-hosted',
});

/** npm's attestations endpoint. Always npm's own: a mirror's package document is checked against it, not trusted. */
export const ATTESTATIONS_BASE = 'https://registry.npmjs.org/-/npm/v1/attestations/';

/** The predicate type npm publishes a build's SLSA provenance under. */
export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';

const IN_TOTO_PAYLOAD = 'application/vnd.in-toto+json';
const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
const FETCH_TIMEOUT_MS = 15_000;

/** The certificate extensions read, by OID (Fulcio's, and X.509's subject alternative name). */
const OID = Object.freeze({
  issuerV1: '1.3.6.1.4.1.57264.1.1',
  issuerV2: '1.3.6.1.4.1.57264.1.8',
  runner: '1.3.6.1.4.1.57264.1.11',
  sourceRepository: '1.3.6.1.4.1.57264.1.12',
  sourceRef: '1.3.6.1.4.1.57264.1.14',
  subjectAltName: '2.5.29.17',
});

/** Which part of the provenance a refusal is about. */
export type ProvenanceField =
  | 'attestation'
  | 'bundle'
  | 'issuer'
  | 'identity'
  | 'runner'
  | 'repository'
  | 'ref'
  | 'subject'
  | 'signature';

/** What was verified for one package, for the run's report and its dry run. */
export interface VerifiedProvenance {
  package: string;
  version: string;
  issuer: string;
  identity: string;
  runner: string;
  repository: string;
  ref: string;
  /** The tarball's SHA-512, hex: what the attestation signs and the registry's integrity names. */
  sha512: string;
  /** The transparency-log entry that recorded the signing, when the bundle says: its index and its time. */
  logIndex: string | null;
  integratedTime: string | null;
}

export type ProvenanceVerdict =
  | { ok: true; provenance: VerifiedProvenance }
  | { ok: false; package: string; version: string; field: ProvenanceField; reason: string };

/** What the attestations endpoint answered: its status, and its body read as JSON (null when it was not). */
export type AttestationFetch = (url: string) => Promise<{ status: number; body: unknown }>;

/** The policy a bundle is verified against, as sigstore-js takes it. */
export interface BundlePolicy {
  issuer: string;
  /** Anchored at both ends: see the top of this module. */
  identity: RegExp;
}

/** Verifies a Sigstore bundle cryptographically and against `policy`; throws when it does not verify. */
export type BundleVerifier = (bundle: unknown, policy: BundlePolicy) => Promise<void>;

export interface ProvenanceDeps {
  fetch?: AttestationFetch | undefined;
  verifyBundle?: BundleVerifier | undefined;
}

/** A release to check: a package, the exact version, and the integrity the registry gives for its tarball. */
export interface ProvenanceRelease {
  packageName: string;
  version: string;
  integrity: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one signing identity a release's provenance may carry: release.yml at the tag of exactly that version. */
export function provenanceIdentity(version: string): RegExp {
  const { repository, workflow } = PROVENANCE_PINS;
  return new RegExp(`^${escapeRegExp(`https://github.com/${repository}/${workflow}@refs/tags/v${version}`)}$`);
}

/** Where npm serves a version's attestations: a scope's slash escaped, as npm spells a package in a path. */
export function attestationsUrl(packageName: string, version: string): string {
  return `${ATTESTATIONS_BASE}${packageName.replace('/', '%2f')}@${version}`;
}

/** The package URL npm's provenance names as its subject: a scope's `@` escaped, as npm writes it. */
export function packageUrl(packageName: string, version: string): string {
  return `pkg:npm/${packageName.replace(/^@/, '%40')}@${version}`;
}

export { sha512Hex } from './update-release.ts';

// ── A certificate, read as far as the pins need ───────────────────────────────────────────────────────────────

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function tlvAt(bytes: Uint8Array, at: number, within: number = bytes.length): Tlv {
  if (at + 2 > within) throw new Error('the certificate is cut short');
  const tag = bytes[at] as number;
  if ((tag & 0x1f) === 0x1f) throw new Error('the certificate has a tag this does not read');
  let length = bytes[at + 1] as number;
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > within)
      throw new Error('the certificate has a length this does not read');
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + (bytes[start + index] as number);
    start += count;
  }
  const end = start + length;
  if (end > within) throw new Error('the certificate is cut short');
  return { tag, start, end };
}

function childrenOf(bytes: Uint8Array, node: Tlv): Tlv[] {
  const children: Tlv[] = [];
  for (let at = node.start; at < node.end; ) {
    const child = tlvAt(bytes, at, node.end);
    children.push(child);
    at = child.end;
  }
  return children;
}

function oidOf(bytes: Uint8Array, node: Tlv): string {
  if (node.tag !== 0x06 || node.end === node.start) throw new Error('the certificate has an extension with no OID');
  const arcs: number[] = [];
  let value = 0;
  for (let at = node.start; at < node.end; at += 1) {
    const byte = bytes[at] as number;
    value = value * 128 + (byte & 0x7f);
    if (byte & 0x80) continue;
    if (arcs.length === 0) arcs.push(value < 80 ? Math.floor(value / 40) : 2, value < 80 ? value % 40 : value - 80);
    else arcs.push(value);
    value = 0;
  }
  return arcs.join('.');
}

function text(bytes: Uint8Array, node: Tlv): string {
  return Buffer.from(bytes.subarray(node.start, node.end)).toString('utf8');
}

/** What the pins read from a signing certificate: its extensions by OID, and its subject alternative names. */
interface CertificateFacts {
  issuer: string | null;
  runner: string | null;
  sourceRepository: string | null;
  sourceRef: string | null;
  /** Every subject alternative name, each as `URI:…` or the kind it is. */
  names: string[];
}

/** A DER `UTF8String` inside an extension's value, as Fulcio writes its newer extensions; null when it is not one. */
function utf8Inside(bytes: Uint8Array, value: Tlv): string | null {
  const inner = tlvAt(bytes, value.start, value.end);
  return inner.tag === 0x0c && inner.end === value.end ? text(bytes, inner) : null;
}

export function readCertificate(der: Uint8Array): CertificateFacts {
  const certificate = tlvAt(der, 0);
  if (certificate.tag !== 0x30 || certificate.end !== der.length) throw new Error('it is not one DER certificate');
  const [tbs] = childrenOf(der, certificate);
  if (tbs?.tag !== 0x30) throw new Error('it has no certificate body');
  const wrapper = childrenOf(der, tbs).find((field) => field.tag === 0xa3);
  const values = new Map<string, Tlv>();
  if (wrapper !== undefined) {
    const [list] = childrenOf(der, wrapper);
    if (list?.tag !== 0x30) throw new Error('its extensions are not a list');
    for (const extension of childrenOf(der, list)) {
      const parts = childrenOf(der, extension);
      const [id] = parts;
      const value = parts.at(-1);
      if (id === undefined || value?.tag !== 0x04 || parts.length < 2)
        throw new Error('it has an extension this does not read');
      const oid = oidOf(der, id);
      // RFC 5280 §4.2: an extension appears once. Two that disagree must not be read as whichever comes first.
      if (values.has(oid)) throw new Error('it has one extension twice');
      values.set(oid, value);
    }
  }
  const v2 = values.get(OID.issuerV2);
  const v1 = values.get(OID.issuerV1);
  const utf8 = (oid: string) => {
    const value = values.get(oid);
    return value === undefined ? null : utf8Inside(der, value);
  };
  const names: string[] = [];
  const san = values.get(OID.subjectAltName);
  if (san !== undefined) {
    const list = tlvAt(der, san.start, san.end);
    if (list.tag !== 0x30) throw new Error('its subject alternative name is not a list');
    for (const name of childrenOf(der, list))
      names.push(name.tag === 0x86 ? `URI:${text(der, name)}` : `tag ${name.tag}`);
  }
  return {
    issuer: v2 !== undefined ? utf8Inside(der, v2) : v1 !== undefined ? text(der, v1) : null,
    runner: utf8(OID.runner),
    sourceRepository: utf8(OID.sourceRepository),
    sourceRef: utf8(OID.sourceRef),
    names,
  };
}

// ── The bundle ────────────────────────────────────────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The signing certificate in a bundle, in either place a bundle keeps it (v0.1–0.2, and v0.3). */
function signingCertificate(bundle: Record<string, unknown>): Uint8Array | null {
  const material = record(bundle.verificationMaterial);
  const chain = record(material?.x509CertificateChain)?.certificates;
  const raw = Array.isArray(chain) ? record(chain[0])?.rawBytes : record(material?.certificate)?.rawBytes;
  return typeof raw === 'string' && raw.length > 0 ? Buffer.from(raw, 'base64') : null;
}

function firstLogEntry(bundle: Record<string, unknown>): { logIndex: string | null; integratedTime: string | null } {
  const entries = record(bundle.verificationMaterial)?.tlogEntries;
  const entry = Array.isArray(entries) ? record(entries[0]) : null;
  const time = entry?.integratedTime;
  const seconds = typeof time === 'string' || typeof time === 'number' ? Number(time) : Number.NaN;
  return {
    logIndex:
      typeof entry?.logIndex === 'string' || typeof entry?.logIndex === 'number' ? String(entry.logIndex) : null,
    integratedTime: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
  };
}

function refuse(release: ProvenanceRelease, field: ProvenanceField, reason: string): ProvenanceVerdict {
  return { ok: false, package: release.packageName, version: release.version, field, reason };
}

/** The reader the run uses: npm's endpoint over HTTPS, with a timeout, its body read as JSON. */
export const fetchAttestations: AttestationFetch = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
};

/**
 * Whether `release` was built where the pins say, as npm's attestation for it shows and Sigstore signed: the verdict,
 * with what was verified, or the field that failed and why. Reads; changes nothing.
 */
export async function verifyProvenance(
  release: ProvenanceRelease,
  deps: ProvenanceDeps = {},
): Promise<ProvenanceVerdict> {
  const { packageName, version } = release;
  const url = attestationsUrl(packageName, version);
  let answer: { status: number; body: unknown };
  try {
    answer = await (deps.fetch ?? fetchAttestations)(url);
  } catch {
    // What failed is not said: an error's words can carry what the far end answered.
    return refuse(release, 'attestation', "npm's attestations could not be read");
  }
  if (answer.status === 404) {
    return refuse(
      release,
      'attestation',
      `npm has no attestation for ${packageName}@${version}: it was published without provenance`,
    );
  }
  if (answer.status !== 200) {
    return refuse(
      release,
      'attestation',
      `npm's attestations answered ${Number.isInteger(answer.status) ? answer.status : 'otherwise'}`,
    );
  }
  const listed = record(answer.body)?.attestations;
  const provenance = Array.isArray(listed)
    ? listed.map(record).find((entry) => entry?.predicateType === SLSA_PROVENANCE_V1)
    : undefined;
  const bundle = record(provenance?.bundle);
  if (bundle === null) {
    return refuse(release, 'attestation', `npm has no SLSA provenance v1 attestation for ${packageName}@${version}`);
  }

  const der = signingCertificate(bundle);
  if (der === null) return refuse(release, 'bundle', 'the provenance bundle carries no signing certificate');
  let facts: CertificateFacts;
  try {
    facts = readCertificate(der);
  } catch {
    return refuse(release, 'bundle', 'its signing certificate cannot be read');
  }
  // Each refusal says the pin, never what the certificate held instead: nothing in it is verified yet, and its text is
  // not this package's to repeat (security review of 0.20.0, severity 6).
  const pins = PROVENANCE_PINS;
  if (facts.issuer !== pins.issuer) {
    return refuse(release, 'issuer', `it was not signed for the issuer ${pins.issuer}`);
  }
  const identity = provenanceIdentity(version);
  const [only, ...others] = facts.names;
  const uri = only?.startsWith('URI:') && others.length === 0 ? only.slice('URI:'.length) : null;
  if (uri === null || !identity.test(uri)) {
    return refuse(
      release,
      'identity',
      `it was not signed for this repository's ${pins.workflow} at refs/tags/v${version}`,
    );
  }
  if (facts.runner !== pins.runner) {
    return refuse(release, 'runner', `it was not built on a ${pins.runner} runner`);
  }
  const repository = `https://github.com/${pins.repository}`;
  if (facts.sourceRepository !== repository) {
    return refuse(release, 'repository', `it was not built from ${repository}`);
  }
  if (facts.sourceRef !== `refs/tags/v${version}`) {
    return refuse(release, 'ref', `it was not built from refs/tags/v${version}`);
  }

  const wanted = sha512Hex(release.integrity);
  if (wanted === null) {
    return refuse(
      release,
      'subject',
      `the registry gives no SHA-512 integrity for ${packageName}@${version} to check it against`,
    );
  }
  const envelope = record(bundle.dsseEnvelope);
  if (envelope?.payloadType !== IN_TOTO_PAYLOAD || typeof envelope.payload !== 'string') {
    return refuse(release, 'subject', 'the provenance bundle carries no in-toto statement');
  }
  let statement: Record<string, unknown> | null;
  try {
    statement = record(JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')));
  } catch {
    statement = null;
  }
  if (statement?._type !== IN_TOTO_STATEMENT_V1 || statement.predicateType !== SLSA_PROVENANCE_V1) {
    return refuse(release, 'subject', 'its statement is not an in-toto v1 statement of SLSA provenance v1');
  }
  const purl = packageUrl(packageName, version);
  const subjects = Array.isArray(statement.subject) ? statement.subject.map(record) : [];
  const ours = subjects.filter((subject) => subject?.name === purl);
  if (ours.length !== 1) {
    return refuse(release, 'subject', `its statement does not name ${purl} once as its subject`);
  }
  const signed = record(ours[0]?.digest)?.sha512;
  if (signed !== wanted) {
    return refuse(release, 'subject', "what it signs is not the registry's tarball for it");
  }

  try {
    await (deps.verifyBundle ?? sigstoreBundleVerifier())(bundle, { issuer: pins.issuer, identity });
  } catch (error) {
    // sigstore-js's own message can quote the certificate ("expected …, got …"): only its fixed code is said.
    const code = (error as { code?: unknown } | null)?.code;
    const named = typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,47}$/.test(code) ? ` (${code})` : '';
    return refuse(release, 'signature', `Sigstore did not verify it${named}`);
  }
  return {
    ok: true,
    provenance: {
      package: packageName,
      version,
      issuer: facts.issuer,
      identity: uri,
      runner: facts.runner,
      repository: facts.sourceRepository,
      ref: facts.sourceRef,
      sha512: wanted,
      ...firstLogEntry(bundle),
    },
  };
}

/**
 * Core's own verifier, for its CLI's and its server's checks and updates: Sigstore's trust root read through TUF into
 * `<state>/sigstore`. A channel's process has none: it carries no Sigstore.
 */
export function stateReleaseVerifier(stateDir: string): (release: ProvenanceRelease) => Promise<ProvenanceVerdict> {
  return releaseVerifier({ cachePath: join(stateDir, 'sigstore') });
}

/**
 * The verifier an update is handed (`update-release.ts`, `ReleaseVerifier`): `verifyProvenance` with npm's endpoint and
 * sigstore-js reading Sigstore's trust root through TUF into `cachePath` — or, for a test, its own fetch and verifier.
 */
export function releaseVerifier(
  options: { cachePath?: string | undefined } & ProvenanceDeps = {},
): (release: ProvenanceRelease) => Promise<ProvenanceVerdict> {
  const verifyBundle = options.verifyBundle ?? sigstoreBundleVerifier({ cachePath: options.cachePath });
  return (release) => verifyProvenance(release, { fetch: options.fetch, verifyBundle });
}

// ── sigstore-js ───────────────────────────────────────────────────────────────────────────────────────────────

/** The parts of sigstore-js the verifier uses: @sigstore/verify, /bundle, /tuf and /protobuf-specs. */
export interface SigstoreModules {
  verify: {
    Verifier: new (
      material: unknown,
      options?: { tlogThreshold?: number; ctlogThreshold?: number },
    ) => { verify(entity: unknown, policy?: unknown): unknown };
    toSignedEntity(bundle: unknown): unknown;
    toTrustMaterial(root: unknown): unknown;
  };
  bundle: { bundleFromJSON(json: unknown): unknown };
  tuf: { getTrustedRoot(options?: { cachePath?: string | undefined }): Promise<unknown> };
  protobuf: { TrustedRoot: { fromJSON(json: unknown): unknown } };
}

/**
 * sigstore-js's verification modules — `@sigstore/verify`, `/bundle`, `/tuf` and `/protobuf-specs`, at the versions
 * sigstore-js 3.1.0 carries — imported by name as this package's own declared dependencies, and only when a bundle is
 * to be verified: nothing else here, and nothing a channel's server or command starts, loads them. Core's bundle keeps
 * them external, so npm installs them beside it, each with its own licence (Apache-2.0), and no channel's bundle
 * inlines them (`pnpm run licenses` counts what each bundle inlines).
 *
 * Not `sigstore` itself: its `createVerifier` takes the identity as a string, which it then reads as an unanchored
 * regular expression, and always reads the trust root through TUF. The parts it is made of take the anchored pattern
 * and, in a test, a trust root of the test's own.
 */
export async function loadSigstore(): Promise<SigstoreModules> {
  const [verify, bundle, tuf, protobuf] = await Promise.all([
    import('@sigstore/verify'),
    import('@sigstore/bundle'),
    import('@sigstore/tuf'),
    import('@sigstore/protobuf-specs'),
  ]);
  return {
    verify: verify as unknown as SigstoreModules['verify'],
    bundle: bundle as unknown as SigstoreModules['bundle'],
    tuf: tuf as unknown as SigstoreModules['tuf'],
    protobuf: protobuf as unknown as SigstoreModules['protobuf'],
  };
}

/**
 * The verifier a run uses: sigstore-js's own, with Sigstore's public-good trust root read through TUF into
 * `cachePath`, one transparency-log entry and one certificate-transparency proof required, and the policy given as
 * the anchored pattern. `trustedRoot` and `load` are for tests, which hand in a trust root and never reach TUF.
 */
export function sigstoreBundleVerifier(
  options: {
    cachePath?: string | undefined;
    trustedRoot?: (() => Promise<unknown>) | undefined;
    load?: (() => Promise<SigstoreModules>) | undefined;
  } = {},
): BundleVerifier {
  return async (bundle, policy) => {
    const sigstore = await (options.load ?? loadSigstore)();
    const root =
      options.trustedRoot === undefined
        ? await sigstore.tuf.getTrustedRoot({ cachePath: options.cachePath })
        : sigstore.protobuf.TrustedRoot.fromJSON(await options.trustedRoot());
    const verifier = new sigstore.verify.Verifier(sigstore.verify.toTrustMaterial(root), {
      tlogThreshold: 1,
      ctlogThreshold: 1,
    });
    const entity = sigstore.verify.toSignedEntity(sigstore.bundle.bundleFromJSON(bundle));
    verifier.verify(entity, { subjectAlternativeName: policy.identity, extensions: { issuer: policy.issuer } });
  };
}
