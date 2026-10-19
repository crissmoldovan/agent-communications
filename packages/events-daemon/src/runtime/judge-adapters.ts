import { canonicalJson } from '@agentcomms/core';
import { getPointer, type JsonValue, parsePointer } from '@agentcomms/events';
import { JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';

export const JUDGE_MAX_REQUEST_BYTES = 65_536;
export const JUDGE_MAX_RESPONSE_BYTES = 65_536;

export type JudgeWireAdapter = typeof JUDGE_KIND_TYPESAFE | 'ollama';
export type JudgeResponseAdapter = JudgeWireAdapter | 'generic-json-score';

export interface JudgeAdapterReference {
  readonly url: string;
  readonly readAt: '2026-10-10';
}

export interface JudgeAdapterReferences {
  readonly typesafe: Readonly<{
    readonly quickstart: JudgeAdapterReference;
    readonly models: JudgeAdapterReference;
  }>;
  readonly ollama: JudgeAdapterReference;
}

/** Every network-capable adapter has one dated published reference from the Phase E provider record. */
export const JUDGE_ADAPTER_REFERENCES: JudgeAdapterReferences = {
  typesafe: {
    quickstart: {
      url: 'https://docs.typesafe.ai/introduction/quickstart',
      readAt: '2026-10-10',
    },
    models: {
      url: 'https://docs.typesafe.ai/models',
      readAt: '2026-10-10',
    },
  },
  ollama: {
    url: 'https://docs.ollama.com/capabilities/decision',
    readAt: '2026-10-10',
  },
};

export type JudgeTransportRefusalCode =
  | 'ADAPTER_REFERENCE_BLOCKED'
  | 'INPUT_TOKEN_LIMIT_EXCEEDED'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'OUTPUT_TOKEN_LIMIT_EXCEEDED'
  | 'MALFORMED_RESPONSE'
  | 'NETWORK_FENCE_REFUSED'
  | 'NETWORK_FAILURE'
  | 'NETWORK_DEADLINE_EXCEEDED';

export interface JudgeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type JudgeTransportResult =
  | {
      readonly kind: 'answer';
      readonly value: number;
      readonly valueLabel: 'probability' | 'uncalibrated-score';
      readonly usage: JudgeUsage;
    }
  | {
      readonly kind: 'refused';
      readonly code: JudgeTransportRefusalCode;
      /**
       * Closed settlement signal for the coordinator. `true` proves that this attempt made no DNS lookup, TCP
       * connection, TLS handshake, or request-byte write; `false` means a physical network action may have occurred
       * and its reservation must be charged conservatively.
       */
      readonly preIo: boolean;
    };

export interface JudgeWireRequestInput {
  readonly adapter: JudgeWireAdapter;
  readonly model: string;
  readonly state: string;
  readonly questionName: string;
  readonly instructions: string;
  readonly hostedApiKey?: string | undefined;
}

export interface JudgeWireRequest {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

export interface JudgeResponseInput {
  readonly adapter: JudgeResponseAdapter;
  readonly protocol: { readonly protocol: 'noul' } | { readonly protocol: 'json-score'; readonly scorePointer: string };
  readonly questionName: string;
  readonly response: Uint8Array;
  readonly maxOutputTokens: number;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const found = Object.keys(value).sort();
  const expected = [...keys].sort();
  return found.length === expected.length && found.every((key, index) => key === expected[index]);
}

function refusal(code: JudgeTransportRefusalCode): JudgeTransportResult {
  // Response parsing is reached only after the sealed transport has written its request. Keeping standalone parser
  // refusals conservative also makes the shared result contract total.
  return { kind: 'refused', code, preIo: false };
}

function knownNoulUsage(value: unknown, maxOutputTokens: number): JudgeUsage | null {
  if (!exactObject(value, ['input_tokens', 'output_tokens'])) return null;
  if (!nonNegativeInteger(value.input_tokens) || !nonNegativeInteger(value.output_tokens)) return null;
  if (value.output_tokens > maxOutputTokens) return null;
  return { inputTokens: value.input_tokens, outputTokens: value.output_tokens };
}

function noulResponse(input: JudgeResponseInput, parsed: unknown): JudgeTransportResult {
  if (!exactObject(parsed, ['answers', 'model', 'usage']) || !text(parsed.model)) return refusal('MALFORMED_RESPONSE');
  if (!exactObject(parsed.answers, [input.questionName])) return refusal('MALFORMED_RESPONSE');
  const answer = parsed.answers[input.questionName];
  if (!exactObject(answer, ['type', 'noul']) || answer.type !== 'noul') return refusal('MALFORMED_RESPONSE');
  if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
    return refusal('MALFORMED_RESPONSE');
  if (!exactObject(parsed.usage, ['input_tokens', 'output_tokens'])) return refusal('MALFORMED_RESPONSE');
  if (!nonNegativeInteger(parsed.usage.input_tokens) || !nonNegativeInteger(parsed.usage.output_tokens))
    return refusal('MALFORMED_RESPONSE');
  if (parsed.usage.output_tokens > input.maxOutputTokens) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');
  const usage = knownNoulUsage(parsed.usage, input.maxOutputTokens);
  if (usage === null) return refusal('MALFORMED_RESPONSE');
  return { kind: 'answer', value: answer.noul, valueLabel: 'probability', usage };
}

function jsonScoreResponse(input: JudgeResponseInput, parsed: unknown): JudgeTransportResult {
  if (input.protocol.protocol !== 'json-score') return refusal('MALFORMED_RESPONSE');
  const pointer = parsePointer(input.protocol.scorePointer);
  if (!pointer.ok || pointer.value.length === 0 || pointer.value.includes('*')) return refusal('MALFORMED_RESPONSE');
  let score: ReturnType<typeof getPointer>;
  try {
    score = getPointer(parsed as JsonValue, input.protocol.scorePointer);
  } catch {
    return refusal('MALFORMED_RESPONSE');
  }
  if (
    !score.found ||
    typeof score.value !== 'number' ||
    !Number.isFinite(score.value) ||
    score.value < 0 ||
    score.value > 1
  )
    return refusal('MALFORMED_RESPONSE');
  const outputTokens = input.response.byteLength;
  if (outputTokens > input.maxOutputTokens) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');
  return {
    kind: 'answer',
    value: score.value,
    valueLabel: 'uncalibrated-score',
    usage: { inputTokens: 0, outputTokens },
  };
}

/** Parses only one documented native Noul answer or a closed generic score pointer; all other output is data-free refusal. */
export function parseJudgeResponse(input: JudgeResponseInput): JudgeTransportResult {
  if (!nonNegativeInteger(input.maxOutputTokens)) return refusal('MALFORMED_RESPONSE');
  if (input.response.byteLength > JUDGE_MAX_RESPONSE_BYTES) return refusal('RESPONSE_TOO_LARGE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.response));
  } catch {
    return refusal('MALFORMED_RESPONSE');
  }
  if (input.protocol.protocol === 'noul') return noulResponse(input, parsed);
  return jsonScoreResponse(input, parsed);
}

/** Builds the only two dated, published System One request shapes. No caller can add a header or generation control. */
export function buildJudgeWireRequest(input: JudgeWireRequestInput): JudgeWireRequest {
  if (!text(input.model) || !text(input.state) || !text(input.questionName) || !text(input.instructions))
    throw new TypeError('a documented System One request needs non-empty model, state, question name and instructions');
  const questions = Object.create(null) as Record<string, { readonly type: 'noul'; readonly instructions: string }>;
  questions[input.questionName] = { type: 'noul', instructions: input.instructions };
  const body = Buffer.from(canonicalJson({ model: input.model, questions, state: input.state }), 'utf8');
  if (input.adapter === JUDGE_KIND_TYPESAFE) {
    if (!text(input.hostedApiKey)) throw new TypeError('the hosted adapter needs its boundary key');
    if (/[\r\n]/u.test(input.hostedApiKey)) throw new TypeError('the hosted adapter needs a single-line boundary key');
    return {
      body,
      headers: { Authorization: `Bearer ${input.hostedApiKey}`, 'Content-Type': 'application/json' },
    };
  }
  return { body, headers: { 'Content-Type': 'application/json' } };
}
