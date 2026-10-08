import snapshot from '../../test/fixtures/iana-special-purpose-2025-10-09.json' with { type: 'json' };

export interface IanaSpecialPurposePrefix {
  readonly prefix: string;
  readonly globallyReachable: boolean;
}

export interface IanaSpecialPurposeRegistry {
  readonly title: string;
  readonly url: string;
  readonly lastUpdated: string;
  readonly rawSourceSha256: string;
  readonly prefixes: readonly IanaSpecialPurposePrefix[];
}

export interface IanaSpecialPurposeSnapshot {
  readonly snapshotVersion: string;
  readonly ipv4: IanaSpecialPurposeRegistry;
  readonly ipv6: IanaSpecialPurposeRegistry;
}

/** Checked-in IANA policy; network code must never refresh or consult it at runtime. */
export const IANA_SPECIAL_PURPOSE: IanaSpecialPurposeSnapshot = snapshot;
export const IANA_SPECIAL_PURPOSE_SNAPSHOT_VERSION = 'iana-special-purpose-2025-10-09';
