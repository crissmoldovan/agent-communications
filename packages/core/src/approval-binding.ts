import type { ApprovalKind, Expectation, ListedFile } from './approvals.ts';
import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import type { SendPolicy } from './config.ts';
import { canonicalJson, sha256Hex } from './digest.ts';
import { CommsError } from './errors.ts';

/**
 * What a version-2 approval binds, defined once (design 2026-10-05 §D1, "Digest integrity").
 *
 * A record stores two digests. `contentDigest` is the outward content or change, computed as before: the message, the
 * change, the download. `bindingDigest` is this module's: the content digest together with the record's route, its
 * lifetimes and its own identity — who it belongs to, which draft, which channel, which send epoch. Every one of those
 * is a field a claim or a report acts on, so a record whose binding no longer recomputes from its own fields has been
 * altered since it was made, and nothing it says can be trusted.
 *
 * There is no second copy of anything: the binding is recomputed from the stored fields alone, never stored apart
 * from them as a key.
 */

/**
 * How an approval is decided, fixed when it is made: `chat` — a yes in the conversation is enough — or `confirm` — a
 * person outside the chat decides. A send's route is the stricter of its live send policy and any escalation; a
 * change's is the live change policy. It never changes when the configuration does.
 */
export type ApprovalRoute = 'chat' | 'confirm';

/** The four activation documents that may receive standing disclosure authority. */
export type DisclosureActivationKind = 'rule' | 'judge-budget' | 'judge-kind' | 'enable-all';

/** An immutable version named by a standing disclosure authorisation. */
export type DisclosureVersionKind = 'rule' | 'target' | 'subscriber' | 'judge' | 'judge-budget' | 'judge-kind';

export interface DisclosureVersion {
  readonly kind: DisclosureVersionKind;
  readonly id: string;
  readonly version: number;
}

/**
 * The content-free, canonical authority for a future disclosure (local-event design D2).
 *
 * The event daemon derives this from one canonical activation document. Core does not construct
 * that document; it verifies the closed shape that makes an independently supplied version list
 * impossible to smuggle into a disclosure record.
 */
export interface DisclosureBinding {
  readonly digest: string;
  readonly activationIntentId: string;
  readonly activationKind: DisclosureActivationKind;
  readonly versions: readonly DisclosureVersion[];
}

const DISCLOSURE_VERSION_KINDS: readonly DisclosureVersionKind[] = [
  'rule',
  'target',
  'subscriber',
  'judge',
  'judge-budget',
  'judge-kind',
];
const DISCLOSURE_ACTIVATION_KINDS: readonly DisclosureActivationKind[] = [
  'rule',
  'judge-budget',
  'judge-kind',
  'enable-all',
];
const HEX64 = /^[0-9a-f]{64}$/;

function disclosureFailure(): never {
  throw new CommsError('BAD_DATA', 'a disclosure binding is not in its canonical activation shape');
}

function compareDisclosureVersions(left: DisclosureVersion, right: DisclosureVersion): number {
  const compareText = (one: string, two: string) => (one < two ? -1 : one > two ? 1 : 0);
  return compareText(left.kind, right.kind) || compareText(left.id, right.id) || left.version - right.version;
}

/**
 * Validates and copies a disclosure binding without reordering it. A caller must provide the
 * daemon-derived canonical list, already sorted by (kind, id, version), so a different document
 * cannot become authorised by a convenient normalisation here.
 */
export function canonicalDisclosureBinding(binding: DisclosureBinding): DisclosureBinding {
  if (
    !HEX64.test(binding.digest) ||
    typeof binding.activationIntentId !== 'string' ||
    binding.activationIntentId.length === 0 ||
    !DISCLOSURE_ACTIVATION_KINDS.includes(binding.activationKind) ||
    !Array.isArray(binding.versions)
  ) {
    return disclosureFailure();
  }
  const versions = binding.versions.map((entry) => {
    if (
      !DISCLOSURE_VERSION_KINDS.includes(entry.kind) ||
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 1
    ) {
      return disclosureFailure();
    }
    return { kind: entry.kind, id: entry.id, version: entry.version };
  });
  for (let index = 1; index < versions.length; index += 1) {
    if (
      compareDisclosureVersions(versions[index - 1] as DisclosureVersion, versions[index] as DisclosureVersion) >= 0
    ) {
      return disclosureFailure();
    }
  }
  const kinds = new Set(versions.map((entry) => entry.kind));
  if (binding.activationKind === 'rule') {
    if (!kinds.has('rule') || kinds.has('judge-budget') || kinds.has('judge-kind')) return disclosureFailure();
  } else if (binding.activationKind === 'judge-budget') {
    if (versions.length !== 1 || versions[0]?.kind !== 'judge-budget') return disclosureFailure();
  } else if (binding.activationKind === 'judge-kind') {
    if (versions.length !== 1 || versions[0]?.kind !== 'judge-kind') return disclosureFailure();
  } else if (versions.some((entry) => entry.kind !== 'rule')) {
    return disclosureFailure();
  }
  return {
    digest: binding.digest,
    activationIntentId: binding.activationIntentId,
    activationKind: binding.activationKind,
    versions,
  };
}

/** Exact canonical equality for each re-check at approval and claim. */
export function sameDisclosureBinding(left: DisclosureBinding, right: DisclosureBinding): boolean {
  try {
    return canonicalJson(canonicalDisclosureBinding(left)) === canonicalJson(canonicalDisclosureBinding(right));
  } catch {
    return false;
  }
}

/**
 * What a record's `inboxId` names. `owner` — a mailbox or account that existed when it was made (every send and
 * download, and a change to one). `prospective` — a change that creates its owner, which has no id yet. `global` — a
 * change to no owner at all, stored with `inboxId: ''`.
 */
export type OwnerScope = 'owner' | 'prospective' | 'global';

/** The lifetime profile, in milliseconds: pending on each route, approved, and a download's question. */
export const APPROVAL_LIFETIMES: Readonly<{ chat: number; confirm: number; approved: number; download: number }> =
  Object.freeze({ chat: 600_000, confirm: 1_800_000, approved: 86_400_000, download: 1_800_000 });

/**
 * The sending lease (design 2026-10-05 §D1): a `sending` record whose claimant has not renewed it for this long reads
 * `unknown` — its outcome can no longer be known from here. Two minutes, renewed every thirty seconds by a claimant
 * whose provider work is still outstanding (`SENDING_HEARTBEAT_MS`), so long work stays `sending` and a process that
 * stopped is found out quickly.
 */
export const SENDING_LEASE_MS: number = 2 * 60 * 1000;
/** How often a claimant renews its lease while provider work is outstanding. */
export const SENDING_HEARTBEAT_MS: number = 30 * 1000;

/**
 * When a send claimed at `sendingAt` and last renewed at `sendingHeartbeatAt` reads `unknown`: never stored, always
 * derived — `(sendingHeartbeatAt ?? sendingAt) + SENDING_LEASE_MS`. Undefined for a record never claimed.
 */
export function unknownAtOf(record: {
  readonly sendingAt?: string | undefined;
  readonly sendingHeartbeatAt?: string | undefined;
}): string | undefined {
  const renewed = record.sendingHeartbeatAt ?? record.sendingAt;
  if (renewed === undefined) return undefined;
  const at = Date.parse(renewed);
  return Number.isFinite(at) ? new Date(at + SENDING_LEASE_MS).toISOString() : undefined;
}

/** How long a pending send or change on `route` stays open. */
export function pendingMsOf(route: ApprovalRoute): number {
  return route === 'confirm' ? APPROVAL_LIFETIMES.confirm : APPROVAL_LIFETIMES.chat;
}

/** Whether `channel` is one this release knows: a manifest channel of the generated snapshot. */
export function isKnownChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && CHANNEL_SNAPSHOT.some((entry) => entry.manifest.channel === channel);
}

/** Refuses a channel this release does not know, before any record naming it is written. */
export function requireKnownChannel(channel: string): void {
  if (!isKnownChannel(channel)) {
    throw new CommsError(
      'UNEXPECTED',
      `an approval cannot be made for the channel "${channel}": this release does not know it`,
      {
        hint: 'This is a bug — please report it.',
      },
    );
  }
}

/** The fields of a record the binding reads, and nothing else. */
export interface BindingFields {
  approvalId: string;
  kind: ApprovalKind;
  channel: string;
  ownerScope: OwnerScope;
  inboxId: string;
  inboxSub?: string | undefined;
  draftId: string;
  draftMessageId: string;
  expect: Expectation;
  contentDigest: string;
  route?: ApprovalRoute | undefined;
  pendingMs: number;
  approvedMs?: number | undefined;
  /** On a send: the owner's send epoch as read at prepare. */
  sendEpoch?: number | undefined;
  policy: SendPolicy;
  requiredPolicy: SendPolicy;
  download?:
    | {
        folders: { downloads: string; current: string };
        listing?: readonly ListedFile[] | undefined;
      }
    | undefined;
}

/** The much smaller binding record for an isolated standing disclosure approval. */
export interface DisclosureBindingFields {
  approvalId: string;
  kind: 'disclosure';
  disclosure: DisclosureBinding;
}

/** A record's identity: the top-level operational fields that ownership and execution use, plus a send's epoch. */
export interface ApprovalIdentity {
  approvalId: string;
  channel: string;
  ownerScope: OwnerScope;
  inboxId: string;
  inboxSub?: string;
  draftId: string;
  draftMessageId: string;
  expect: Expectation;
  sendEpoch?: number;
}

/**
 * The identity a record is bound to, exactly as stored. An absent `inboxSub` is left out rather than kept as
 * `undefined`; a send always carries its epoch.
 */
export function identityOf(record: BindingFields): ApprovalIdentity {
  return {
    approvalId: record.approvalId,
    channel: record.channel,
    ownerScope: record.ownerScope,
    inboxId: record.inboxId,
    ...(record.inboxSub === undefined ? {} : { inboxSub: record.inboxSub }),
    draftId: record.draftId,
    draftMessageId: record.draftMessageId,
    expect: {
      to: [...record.expect.to],
      cc: [...record.expect.cc],
      bcc: [...record.expect.bcc],
      subject: record.expect.subject,
    },
    ...(record.kind === 'send' ? { sendEpoch: record.sendEpoch as number } : {}),
  };
}

/** One listed file, as stored: its name and size, and its rename reason and flags only when it has them. */
function listedEntry(file: ListedFile): Record<string, unknown> {
  return {
    name: file.name,
    size: file.size,
    ...(file.renamed === undefined ? {} : { renamed: file.renamed }),
    ...(file.flags === undefined ? {} : { flags: [...file.flags] }),
  };
}

/**
 * The object the binding digest is taken of, before it is hashed.
 *
 * A send or change: `{ v: 2, kind, contentDigest, route, pendingMs, approvedMs, identity }`. A download: `{ v: 2, kind:
 * 'download', contentDigest, profile: { pendingMs, policy, requiredPolicy }, identity, offered, listing? }` — the two
 * folders it offered, and the listing exactly as stored, left out when the record has none.
 */
export function bindingObjectOf(record: BindingFields | DisclosureBindingFields): Record<string, unknown> {
  if (record.kind === 'disclosure' && 'disclosure' in record && record.disclosure !== undefined) {
    return {
      v: 2,
      kind: 'disclosure',
      approvalId: record.approvalId,
      disclosure: canonicalDisclosureBinding(record.disclosure),
    };
  }
  const ordinary = record as BindingFields;
  const identity = identityOf(ordinary);
  if (ordinary.kind === 'download') {
    const download = ordinary.download;
    if (download === undefined) {
      throw new CommsError('BAD_DATA', 'a download’s approval does not hold the question it was asked for');
    }
    return {
      v: 2,
      kind: 'download',
      contentDigest: ordinary.contentDigest,
      profile: { pendingMs: ordinary.pendingMs, policy: ordinary.policy, requiredPolicy: ordinary.requiredPolicy },
      identity,
      offered: { downloads: download.folders.downloads, current: download.folders.current },
      ...(download.listing === undefined ? {} : { listing: download.listing.map(listedEntry) }),
    };
  }
  return {
    v: 2,
    kind: ordinary.kind,
    contentDigest: ordinary.contentDigest,
    route: ordinary.route,
    pendingMs: ordinary.pendingMs,
    approvedMs: ordinary.approvedMs,
    identity,
  };
}

/** The SHA-256 of the canonical JSON of `bindingObjectOf(record)`: the one binding digest. */
export function bindingDigestOf(record: BindingFields | DisclosureBindingFields): string {
  return sha256Hex(canonicalJson(bindingObjectOf(record)));
}
