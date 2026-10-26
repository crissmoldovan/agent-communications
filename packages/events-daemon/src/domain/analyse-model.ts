import type { EventSecretProvider } from './providers.ts';

/**
 * Where Analyse's model runs (0.33.0 design §3.3), and the exact bytes it is sent and reads back. The person picks the
 * provider among those with a key: OpenRouter (the key 0.32.0 added for Jev) or Anthropic's own Messages API. Both
 * run Claude Sonnet, the current one each lists. Pure: the owner's transport (`runtime/analyse-transport.ts`) writes
 * these bytes over the pinned network path and nothing else.
 */

/** The providers Analyse's model can run on. */
export const ANALYSE_PROVIDERS: readonly ['openrouter', 'anthropic'] = Object.freeze([
  'openrouter',
  'anthropic',
] as const);
export type AnalyseProvider = (typeof ANALYSE_PROVIDERS)[number];

export function isAnalyseProvider(value: unknown): value is AnalyseProvider {
  return typeof value === 'string' && (ANALYSE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The model each provider runs, pinned: the current Claude Sonnet, as each lists it, checked 2026-10-26 —
 * https://openrouter.ai/anthropic/claude-sonnet-5.5 (OpenRouter's id) and Anthropic's model table (`claude-sonnet-5-5`).
 * A newer model is a deliberate change here, in one place.
 */
export const ANALYSE_MODELS_CHECKED_AT = '2026-10-26';
export const ANALYSE_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';
export const ANALYSE_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** Anthropic's API version, sent with each Messages request (`anthropic-version`). */
export const ANTHROPIC_API_VERSION = '2026-10-21';

export interface AnalyseRoute {
  readonly provider: AnalyseProvider;
  readonly name: string;
  readonly host: string;
  readonly endpoint: string;
  readonly model: string;
}

export const ANALYSE_ROUTES: Readonly<Record<AnalyseProvider, AnalyseRoute>> = Object.freeze({
  openrouter: {
    provider: 'openrouter',
    name: 'OpenRouter',
    host: 'openrouter.ai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: ANALYSE_OPENROUTER_MODEL,
  },
  anthropic: {
    provider: 'anthropic',
    name: 'Anthropic',
    host: 'api.anthropic.com',
    endpoint: 'https://api.anthropic.com/v1/messages',
    model: ANALYSE_ANTHROPIC_MODEL,
  },
});

/** The most a request may be, and a response: as the judges', the request is bounded before any DNS lookup. */
export const ANALYSE_MAX_REQUEST_BYTES = 65_536;
export const ANALYSE_MAX_RESPONSE_BYTES = 262_144;
/** The most tokens the model may write, its thinking included. */
export const ANALYSE_MAX_OUTPUT_TOKENS = 4_096;
/** One call's deadline, from DNS to the last byte. */
export const ANALYSE_CALL_DEADLINE_MS = 60_000;

/** The JSON a model must answer with: `{ after, why }`, two strings and nothing else. */
export const ANALYSE_ANSWER_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { after: { type: 'string' }, why: { type: 'string' } },
  required: ['after', 'why'],
  additionalProperties: false,
});

/** A key goes into one header; anything but visible ASCII could end that header, so it is refused before the call. */
export function isHeaderSafeKey(key: string): boolean {
  return key.length > 0 && key.length <= 4096 && /^[\x21-\x7e]+$/u.test(key);
}

export interface AnalyseWireRequest {
  readonly body: Buffer;
  /** The closed header set for the provider, the key's one header among them. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The exact request for one part: the fixed brief as the system prompt, the rule's text and counts as the user turn. */
export function buildAnalyseRequest(input: {
  readonly provider: AnalyseProvider;
  readonly key: string;
  readonly system: string;
  readonly user: string;
}): AnalyseWireRequest {
  if (!isHeaderSafeKey(input.key)) throw new TypeError('the provider key is not one header value');
  const route = ANALYSE_ROUTES[input.provider];
  if (input.provider === 'openrouter') {
    // https://openrouter.ai/docs/api/reference/overview, read 2026-10-26: chat completions with a json_schema answer.
    const body = {
      model: route.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      max_tokens: ANALYSE_MAX_OUTPUT_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'suggestion', strict: true, schema: ANALYSE_ANSWER_SCHEMA },
      },
    };
    return {
      body: Buffer.from(JSON.stringify(body)),
      headers: {
        Authorization: `Bearer ${input.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
  }
  // Anthropic's Messages API, version 2026-10-21: the brief as `system`, a json_schema answer, low effort.
  const body = {
    model: route.model,
    max_tokens: ANALYSE_MAX_OUTPUT_TOKENS,
    system: input.system,
    messages: [{ role: 'user', content: input.user }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ANALYSE_ANSWER_SCHEMA } },
  };
  return {
    body: Buffer.from(JSON.stringify(body)),
    headers: {
      'x-api-key': input.key,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
    },
  };
}

/** Why a model call gave no answer: closed words, never the provider's own text. */
export type AnalyseCallRefusal =
  | 'NO_KEY'
  | 'KEY_MALFORMED'
  | 'REQUEST_TOO_LARGE'
  | 'NETWORK_FENCE_REFUSED'
  | 'NETWORK_FAILURE'
  | 'NETWORK_DEADLINE_EXCEEDED'
  | 'RESPONSE_TOO_LARGE'
  | 'RESPONSE_MALFORMED'
  | 'MODEL_KEY_REFUSED'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_REQUEST_REFUSED'
  | 'MODEL_REFUSED'
  | 'MODEL_OUTPUT_TRUNCATED';

/** A non-2xx status, in closed words. */
export function refusalForStatus(status: number): AnalyseCallRefusal {
  if (status === 401 || status === 403) return 'MODEL_KEY_REFUSED';
  if (status === 429) return 'MODEL_RATE_LIMITED';
  if (status >= 500) return 'MODEL_UNAVAILABLE';
  return 'MODEL_REQUEST_REFUSED';
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * The model's text from a 2xx body, or why there is none. OpenRouter: `choices[0].message.content`, finished with
 * `stop`. Anthropic: the `text` blocks of a `message`, finished with `end_turn`; thinking blocks are passed over.
 */
export function readAnalyseResponse(
  provider: AnalyseProvider,
  body: Buffer,
): { readonly text: string } | { readonly refused: AnalyseCallRefusal } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return { refused: 'RESPONSE_MALFORMED' };
  }
  const response = record(parsed);
  if (response === null) return { refused: 'RESPONSE_MALFORMED' };
  if (provider === 'openrouter') {
    const choice = Array.isArray(response.choices) ? record(response.choices[0]) : null;
    const message = record(choice?.message);
    if (choice === null || message === null) return { refused: 'RESPONSE_MALFORMED' };
    if (choice.finish_reason === 'length') return { refused: 'MODEL_OUTPUT_TRUNCATED' };
    if (choice.finish_reason === 'content_filter') return { refused: 'MODEL_REFUSED' };
    if (choice.finish_reason !== 'stop' || typeof message.content !== 'string')
      return { refused: 'RESPONSE_MALFORMED' };
    return { text: message.content };
  }
  if (response.type !== 'message' || !Array.isArray(response.content)) return { refused: 'RESPONSE_MALFORMED' };
  if (response.stop_reason === 'max_tokens') return { refused: 'MODEL_OUTPUT_TRUNCATED' };
  if (response.stop_reason === 'refusal') return { refused: 'MODEL_REFUSED' };
  if (response.stop_reason !== 'end_turn') return { refused: 'RESPONSE_MALFORMED' };
  const texts: string[] = [];
  for (const block of response.content) {
    const entry = record(block);
    if (entry === null) return { refused: 'RESPONSE_MALFORMED' };
    if (entry.type !== 'text') continue;
    if (typeof entry.text !== 'string') return { refused: 'RESPONSE_MALFORMED' };
    texts.push(entry.text);
  }
  if (texts.length === 0) return { refused: 'RESPONSE_MALFORMED' };
  return { text: texts.join('') };
}

/** The provider an Analyse runs on: the one the person names, or else the first with a key, OpenRouter first. */
export function chooseAnalyseProvider(
  named: AnalyseProvider | undefined,
  hasKey: (provider: EventSecretProvider) => boolean,
): { readonly provider: AnalyseProvider; readonly hasKey: boolean } | null {
  if (named !== undefined) return { provider: named, hasKey: hasKey(named) };
  const found = ANALYSE_PROVIDERS.find((provider) => hasKey(provider));
  return found === undefined ? null : { provider: found, hasKey: true };
}
