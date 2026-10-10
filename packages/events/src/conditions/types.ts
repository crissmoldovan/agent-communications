/** D5's deterministic tree and the static form of an agentic condition. */

/** The JSON scalars a deterministic condition can compare. */
export type Scalar = string | number | boolean | null;

/** The persisted D5 condition tree: every supported case-sensitivity flag is explicit. */
export type CanonicalCondition =
  | { readonly all: readonly [CanonicalCondition, ...CanonicalCondition[]] }
  | { readonly any: readonly [CanonicalCondition, ...CanonicalCondition[]] }
  | { readonly not: CanonicalCondition }
  | { readonly path: string; readonly op: 'exists' }
  | {
      readonly path: string;
      readonly op: 'equals' | 'notEquals';
      readonly value: Scalar;
      readonly caseSensitive: boolean;
    }
  | { readonly path: string; readonly op: 'contains'; readonly value: Scalar; readonly caseSensitive: boolean }
  | {
      readonly path: string;
      readonly op: 'startsWith' | 'endsWith';
      readonly value: string;
      readonly caseSensitive: boolean;
    }
  | { readonly path: string; readonly op: 'in'; readonly values: readonly [Scalar, ...Scalar[]] }
  | { readonly path: string; readonly op: 'gt' | 'gte' | 'lt' | 'lte'; readonly value: number | string }
  | { readonly path: string; readonly op: 'domainIs'; readonly value: string; readonly includeSubdomains: boolean };

/** The save-time input form: D5 lets a person omit a supported `caseSensitive`, which becomes `false`. */
export type AuthoringCondition =
  | { readonly all: readonly [AuthoringCondition, ...AuthoringCondition[]] }
  | { readonly any: readonly [AuthoringCondition, ...AuthoringCondition[]] }
  | { readonly not: AuthoringCondition }
  | { readonly path: string; readonly op: 'exists' }
  | {
      readonly path: string;
      readonly op: 'equals' | 'notEquals';
      readonly value: Scalar;
      readonly caseSensitive?: boolean;
    }
  | { readonly path: string; readonly op: 'contains'; readonly value: Scalar; readonly caseSensitive?: boolean }
  | {
      readonly path: string;
      readonly op: 'startsWith' | 'endsWith';
      readonly value: string;
      readonly caseSensitive?: boolean;
    }
  | { readonly path: string; readonly op: 'in'; readonly values: readonly [Scalar, ...Scalar[]] }
  | { readonly path: string; readonly op: 'gt' | 'gte' | 'lt' | 'lte'; readonly value: number | string }
  | { readonly path: string; readonly op: 'domainIs'; readonly value: string; readonly includeSubdomains: boolean };

/** The portable JSON-shaped reference embedded by an agentic condition. The daemon validates its closed judge form. */
export interface AgenticJudgeDocumentV1 {
  readonly judgeId: string;
  readonly version: number;
  readonly [field: string]: unknown;
}

/** D5's pure, persisted part of an agentic condition. Execution belongs to phase E. */
export interface AgenticConditionV1 {
  /** The complete immutable judge document. Its daemon-side canonical bytes bind it to the stored version. */
  readonly judge: AgenticJudgeDocumentV1;
  readonly question: string;
  readonly inputs: readonly string[];
  readonly threshold: number;
  readonly onUncertain: 'no-match' | 'hold';
  readonly callsPerRollingHour: number;
  readonly inputTokensPerRolling30Days: number;
  readonly concurrency: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}
