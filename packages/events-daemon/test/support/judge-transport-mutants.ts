/**
 * Task 6 keeps its destructive edits beside its transport fixtures; this data-only companion is the verifier-facing
 * inventory.  The strict runner's own loop is structurally checked against this exact id set.
 */
interface JudgeTransportMutationId {
  readonly id: string;
}

const ids: readonly string[] = [
  'e6-reference-date',
  'e6-header-allowlist',
  'e6-single-line-hosted-key',
  'e6-request-cap',
  'e6-response-cap',
  'e6-streaming-response-cap',
  'e6-output-token-limit',
  'e6-provider-match',
  'e6-score-clamp',
  'e6-closed-score-pointer',
  'e6-dns-final-gate',
  'e6-tcp-final-gate',
  'e6-tls-final-gate',
  'e6-write-final-gate',
  'e6-write-gate-adjacency',
  'e6-no-http-client',
  'e6-no-proxy-path',
  'e6-no-redirect',
  'e6-literal-loopback-only',
  'e6-attempt-deadline',
  'e6-post-gate-deadline',
  'e6-final-gate-deadline',
  'e6-synchronous-final-gate',
  'e6-response-deadline',
  'e6-fatal-utf8',
  'e6-a-accept-non-global',
  'e6-a-skip-embedded-addresses',
  'e6-a-allow-global-only-non-typesafe',
  'e6-m-accept-alias',
  'e6-m-substitute-constant-model',
];

export const JUDGE_TRANSPORT_MUTATION_IDS: readonly JudgeTransportMutationId[] = Object.freeze(
  ids.map((id): JudgeTransportMutationId => ({ id })),
);
