import { EventControlClient } from '../control/client.ts';
import { ACTIVATION_FAILURE_CODES, type ActivationFailureCode } from '../domain/activation-failure-codes.ts';
import type {
  JUDGE_KIND_LAYA,
  JUDGE_KIND_LOCAL_ENDPOINT,
  JUDGE_KIND_TYPESAFE,
  JudgeKind,
} from '../domain/lifecycle.ts';
import type { LayaModelStatus } from '../runtime/laya/contracts.ts';

/**
 * Reserved content-free doctor projection for the later Laya-specific doctor schema. It deliberately does not amend
 * pinned doctor-v1; Task 6 supplies its lifecycle-backed value and Task 11 owns presentation wiring.
 */
export type LayaDoctorStatus = LayaModelStatus;

/** The checked binding for contracts/doctor-v1.schema.json. No free-form values cross this operation boundary. */
export type DoctorSource = 'gmail' | 'slack' | 'resend' | 'whatsapp';
export type DoctorActivationKind = 'rule' | 'enable-all' | 'unknown';
/** The persisted writer vocabulary plus the fixed, content-free fallback for legacy or damaged rows. */
export type DoctorActivationFailureCode = ActivationFailureCode | 'UNRECOGNISED';
export const DOCTOR_ACTIVATION_FAILURE_CODES: readonly DoctorActivationFailureCode[] = [
  ...ACTIVATION_FAILURE_CODES,
  'UNRECOGNISED',
];
export type DoctorDerivationEditKind =
  | 'remove-target'
  | 'remove-output-field'
  | 'lower-rate-cap'
  | 'shorten-retention'
  | 'narrow-source-options';
export type DoctorLineageFailureCode =
  | 'ACTIVATION_DOCUMENT_INVALID'
  | 'ACTIVATION_DIGEST_DRIFT'
  | 'ACTIVATION_LINEAGE_MISMATCH'
  | 'ACTIVATION_LINEAGE_MISSING'
  | 'BOUND_OBJECT_REVOKED'
  | 'DERIVATION_CYCLE'
  | 'DERIVATION_EDGE_INVALID'
  | 'DERIVATION_NOT_TIGHTENING'
  | 'DERIVATION_PARENT_INVALID'
  | 'DERIVATION_ROOT_INVALID'
  | 'DISCLOSURE_BINDING_DRIFT'
  | 'DISCLOSURE_NOT_USED'
  | 'IMMUTABLE_VERSION_DRIFT'
  | 'RULE_LINEAGE_MISSING';

export interface DoctorReportV1 {
  readonly schemaVersion: 'doctor-v1';
  readonly owner: {
    readonly status: 'running';
    readonly protocolVersions: readonly number[];
    readonly installationId: string;
  };
  readonly switch: { readonly status: 'enabled' | 'disabled'; readonly paused: boolean; readonly generation: number };
  readonly lineages: readonly {
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly status: 'active';
    readonly approvalId: string;
    readonly authorizationActivationId: string;
    readonly currentCutoverId: string | null;
    readonly activatedAt: number;
    readonly retainedWork: number;
    readonly validation:
      | { readonly status: 'valid' }
      | { readonly status: 'invalid'; readonly code: DoctorLineageFailureCode };
    /** Root-to-active stable derivation edges; empty only for an exact approval. */
    readonly derivation: readonly {
      readonly versionId: string;
      readonly parentApprovalId: string;
      readonly parentVersionId: string;
      readonly editKind: DoctorDerivationEditKind;
    }[];
  }[];
  readonly superseded: readonly {
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly retainedWork: number;
  }[];
  readonly points: readonly {
    readonly activationId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly source: DoctorSource;
    readonly accountId: string;
    readonly scopeId: string;
    readonly status: 'active';
    readonly createdAt: number;
  }[];
  readonly awaitingReapproval: readonly {
    readonly accountId: string;
    readonly scopeId: string;
    readonly status: 'awaitingReapproval';
  }[];
  readonly activationIntents: readonly {
    readonly id: string;
    readonly kind: DoctorActivationKind;
    readonly status: 'pending' | 'pending-completion' | 'completed' | 'failed' | 'cancelled';
    readonly claimedAt: number | null;
    readonly completionDeadline: number | null;
    readonly failureCode: DoctorActivationFailureCode | null;
    readonly baselines: number;
    readonly draining: number;
  }[];
  readonly sources: readonly {
    readonly source: DoctorSource;
    readonly accountId: string;
    readonly metadata: {
      readonly retryAgeMs: number | null;
      /** The number of pending occurrences, never a terminal-resolution count. */
      readonly retryCount: number;
      readonly maxAttempts: number;
      /** A stage that doctor could not decrypt; its content and error detail never leave the owner. */
      readonly unreadable: number;
      readonly resolutions: {
        readonly vanished: number;
        readonly unresolvable: number;
        readonly retentionExpired: number;
        readonly last: { readonly code: 'vanished' | 'unresolvable' | 'retentionExpired'; readonly at: number } | null;
      };
    };
    readonly materialisation: {
      readonly retryAgeMs: number | null;
      readonly retryCount: number;
      readonly maxAttempts: number;
      readonly unreadable: number;
      readonly resolutions: {
        readonly vanished: number;
        readonly unresolvable: number;
        readonly retentionExpired: number;
        readonly last: { readonly code: 'vanished' | 'unresolvable' | 'retentionExpired'; readonly at: number } | null;
      };
    };
    readonly lagMs: number | null;
  }[];
  readonly recovery: {
    readonly leases: number;
    readonly held: number;
    readonly deadLetters: number;
    readonly deadlines: number;
    readonly resetBarriers: readonly { readonly state: 'open' | 'closed' | 'degraded'; readonly count: number }[];
    readonly missingSecrets: readonly {
      readonly kind: 'target' | 'subscriber' | 'judge';
      readonly id: string;
      readonly version: number;
    }[];
  };
  readonly judgeBoundary: readonly {
    readonly kind: JudgeKind;
    readonly code: 'E_REQUIRED' | 'E2_REQUIRED';
    readonly phase: 'E' | 'E2';
  }[];
  readonly whatsapp: readonly {
    readonly accountId: string;
    readonly status: 'applied' | 'missing' | 'stale';
    readonly appliedAt: number | null;
  }[];
}

/**
 * Phase E leaves doctor-v1 byte-for-byte intact for B3 consumers. The successor keeps every v1 property and
 * narrows its boundary list to the one capability E still does not provide; `judge` adds only closed state.
 */
export interface DoctorReportV2 extends Omit<DoctorReportV1, 'schemaVersion'> {
  readonly schemaVersion: 'doctor-v2';
  readonly judge: {
    readonly kinds: readonly (
      | {
          readonly kind: typeof JUDGE_KIND_TYPESAFE | typeof JUDGE_KIND_LOCAL_ENDPOINT;
          readonly state: 'disabled' | 'enabled';
          readonly version: number | null;
        }
      | { readonly kind: typeof JUDGE_KIND_LAYA; readonly state: 'unavailable'; readonly code: 'E2_REQUIRED' }
    )[];
    readonly budget: { readonly activeVersion: number | null };
    /** Counts only; a doctor report never exposes a work id, request, prompt, event or provider response. */
    readonly reservations: readonly {
      readonly state: 'reserved' | 'in-flight' | 'settled' | 'released';
      readonly count: number;
    }[];
    /** Content-free retention visibility; no decision, event, rule, prompt or provider field crosses doctor. */
    readonly holds: {
      readonly count: number;
      readonly oldestCreatedAt: number | null;
      readonly nextExpiresAt: number | null;
    };
  };
}

/**
 * The transport binding mirrors the root `additionalProperties: false` in doctor-v1.schema.json. Keeping this at
 * the production projection boundary makes an accidental diagnostic field fail closed before CLI or MCP can render
 * it; nested fields are constructed from closed object literals in the projection below that boundary.
 */
const DOCTOR_REPORT_V1_KEYS = [
  'schemaVersion',
  'owner',
  'switch',
  'lineages',
  'superseded',
  'points',
  'awaitingReapproval',
  'activationIntents',
  'sources',
  'recovery',
  'judgeBoundary',
  'whatsapp',
] as const;

export function assertDoctorReportV1(report: DoctorReportV1): DoctorReportV1 {
  if (Object.keys(report).some((key) => !DOCTOR_REPORT_V1_KEYS.includes(key as (typeof DOCTOR_REPORT_V1_KEYS)[number])))
    throw new Error('doctor-v1 report is closed');
  return report;
}

const DOCTOR_REPORT_V2_KEYS = [
  'schemaVersion',
  'owner',
  'switch',
  'lineages',
  'superseded',
  'points',
  'awaitingReapproval',
  'activationIntents',
  'sources',
  'recovery',
  'judgeBoundary',
  'judge',
  'whatsapp',
] as const;

export function assertDoctorReportV2(report: DoctorReportV2): DoctorReportV2 {
  if (Object.keys(report).some((key) => !DOCTOR_REPORT_V2_KEYS.includes(key as (typeof DOCTOR_REPORT_V2_KEYS)[number])))
    throw new Error('doctor-v2 report is closed');
  return report;
}

export async function doctor(options: { readonly stateDir?: string | undefined } = {}): Promise<DoctorReportV2> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('doctor')) as DoctorReportV2;
}
