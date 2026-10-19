import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isLayaTemplateId,
  LAYA_HEAD_MAX_TOKENS,
  LAYA_MAX_SEQUENCE_TOKENS,
  LAYA_OPTION_MAX_TOKENS,
  type LayaTemplateId,
  layaLayout,
  layaTemplate,
} from './templates.ts';

/**
 * The isolated worker's Laya adapter (E2-7, D11). It runs only inside the child, only after that child's own boundary
 * proof and the daemon's whole-tree verification, and it imports Node built-ins only until a load frame names the
 * verified trees. Every external fact it relies on is in the Task 8 record of
 * `docs/superpowers/evidence/2026-10-10-e2-external-sources.md`, named by its entry id beside the code that uses it.
 */

export { LAYA_HEAD_MAX_TOKENS, LAYA_MAX_SEQUENCE_TOKENS, LAYA_OPTION_MAX_TOKENS } from './templates.ts';

/** The sequence's own markers: `[CLS]`, the head's `[SEP]`, and the `[SEP]` either side of the state. */
const LAYA_SEQUENCE_MARKERS = 4;
/** The one question each request asks; the name is not part of the rendered sequence. */
export const LAYA_QUESTION_NAME = 'decision';

/** The runtime's surface, as the adapter uses it: the bundle's tokenizer, one System One call, and release. */
export interface LayaRuntimeBinding {
  /** Tokens in one text with the bundle's tokenizer and no special tokens. */
  countTokens(text: string): number;
  systemOne(state: string, questions: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

/** What one request frame carries: the template id, the rule's question and the enveloped judge input. */
export interface LayaWorkerRequest {
  readonly templateId: LayaTemplateId;
  readonly instructions: string;
  readonly state: string;
}

/**
 * `token-limit`: the uncut layout does not fit the 512-token context or the head budget, so the runtime would cut it.
 * `malformed`: the runtime threw or answered outside its closed shape. `template-blocked`: the template's runtime wire
 * is not in the record (see `evaluateLayaRequest`). The daemon treats each as D5's malformed result: no-match.
 */
export type LayaWorkerRefusalCode = 'token-limit' | 'malformed' | 'template-blocked';

export type LayaWorkerOutcome =
  | { readonly kind: 'answer'; readonly value: number; readonly inputTokens: number }
  | { readonly kind: 'refused'; readonly code: LayaWorkerRefusalCode };

/** The verified trees the daemon names in its load frame: absolute, normalised paths and nothing else. */
export interface LayaLoadPayload {
  readonly runtimeRoot: string;
  readonly modelDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const found = Object.keys(value).sort();
  const expected = [...keys].sort();
  return found.length === expected.length && found.every((key, index) => key === expected[index]);
}

function normalAbsolute(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) && resolve(value) === value;
}

export function layaLoadPayload(value: unknown): LayaLoadPayload | null {
  if (!isRecord(value) || !exactKeys(value, ['runtimeRoot', 'modelDir'])) return null;
  if (!normalAbsolute(value.runtimeRoot) || !normalAbsolute(value.modelDir)) return null;
  return { runtimeRoot: value.runtimeRoot, modelDir: value.modelDir };
}

export function layaWorkerRequest(value: Readonly<Record<string, unknown>>): LayaWorkerRequest | null {
  if (!isLayaTemplateId(value.templateId)) return null;
  if (typeof value.instructions !== 'string' || value.instructions.length === 0) return null;
  if (typeof value.state !== 'string' || value.state.length === 0) return null;
  return { templateId: value.templateId, instructions: value.instructions, state: value.state };
}

function tokens(runtime: Pick<LayaRuntimeBinding, 'countTokens'>, text: string): number {
  const counted = runtime.countTokens(text);
  if (!Number.isSafeInteger(counted) || counted < 0) throw new Error('the Laya tokenizer count is not a token count');
  return counted;
}

/**
 * The exact length of the sequence the runtime would build, counted over the complete, uncut layout, or null when it
 * would cut anything: an option over 48 tokens, a head over its 192-token budget, or a sequence over 512. (The
 * runtime's further cut of options that leave the head under a 16-token reserve cannot apply to a two-option
 * template whose options are each within 48; a template with more options is a new id and a new review.) Within these
 * bounds nothing is cut, so the runtime's own `usage.input_tokens` must equal this count (hf-laya-onnx-config).
 */
export function layaSequenceTokens(
  runtime: Pick<LayaRuntimeBinding, 'countTokens'>,
  request: LayaWorkerRequest,
): number | null {
  const layout = layaLayout(request.templateId, request);
  const head = tokens(runtime, layout.head);
  const options = layout.options.map((option) => tokens(runtime, option));
  const state = tokens(runtime, layout.state);
  const optionTokens = options.reduce((sum, count) => sum + count, 0);
  if (options.some((count) => count > LAYA_OPTION_MAX_TOKENS)) return null;
  // The head is `[CLS]`, its text and `[SEP]`, then one `[MASK]` and the text of each option.
  if (2 + head + options.length + optionTokens > LAYA_HEAD_MAX_TOKENS) return null;
  const sequence = head + options.length + optionTokens + state + LAYA_SEQUENCE_MARKERS;
  return sequence > LAYA_MAX_SEQUENCE_TOKENS ? null : sequence;
}

/**
 * Reads one `noul` answer where System One puts it — `answers.<name>.noul` — exactly as the runtime returns it, after
 * the checks D5 makes: a finite number in [0, 1], never clamped. The usage must be the uncut count with no output
 * tokens (npm-receptron-laya-0.1.2-output), or the runtime cut something and the answer is malformed.
 */
function noulValue(answer: unknown, sequenceTokens: number): number | null {
  if (!isRecord(answer) || !isRecord(answer.answers) || !isRecord(answer.usage)) return null;
  if (!exactKeys(answer.answers, [LAYA_QUESTION_NAME])) return null;
  const decision = answer.answers[LAYA_QUESTION_NAME];
  if (!isRecord(decision) || decision.type !== 'noul') return null;
  const value = decision.noul;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  if (answer.usage.input_tokens !== sequenceTokens || answer.usage.output_tokens !== 0) return null;
  return value;
}

/**
 * One request: count, refuse rather than let the runtime cut, ask, check. `laya-choice2-v1` is laid out and counted
 * like any template but refuses before the runtime is asked: System One's `choice` `criteria` shape is "not stated"
 * in the Phase E provider record, and the Task 8 record names neither it nor where the runtime puts a choice's
 * probabilities, so building or reading that wire would be an inference. It stays `template-blocked` until a record
 * names both.
 */
export async function evaluateLayaRequest(
  runtime: LayaRuntimeBinding,
  request: LayaWorkerRequest,
): Promise<LayaWorkerOutcome> {
  let sequenceTokens: number | null;
  try {
    sequenceTokens = layaSequenceTokens(runtime, request);
  } catch {
    return { kind: 'refused', code: 'malformed' };
  }
  if (sequenceTokens === null) return { kind: 'refused', code: 'token-limit' };
  if (layaTemplate(request.templateId).type !== 'noul') return { kind: 'refused', code: 'template-blocked' };
  const questions = Object.create(null) as Record<string, unknown>;
  questions[LAYA_QUESTION_NAME] = { type: 'noul', instructions: request.instructions };
  let answer: unknown;
  try {
    answer = await runtime.systemOne(request.state, questions);
  } catch {
    return { kind: 'refused', code: 'malformed' };
  }
  const value = noulValue(answer, sequenceTokens);
  return value === null
    ? { kind: 'refused', code: 'malformed' }
    : { kind: 'answer', value, inputTokens: sequenceTokens };
}

/**
 * Exactly the verified model directory and the CPU provider (D11's `Laya.load({ modelDir, executionProviders: ["cpu"] })`).
 * With `modelDir` set the package never calls its downloader, and no repo, revision, token, cache directory, progress
 * callback or session option is passed, so neither a download nor a provider override is reachable
 * (npm-receptron-laya-0.1.2-load, npm-receptron-laya-0.1.2-download).
 */
export function layaLoadOptions(modelDir: string): { readonly modelDir: string; readonly executionProviders: ['cpu'] } {
  return { modelDir, executionProviders: ['cpu'] };
}

/** The module that defines `Laya.load` inside the verified runtime tree (npm-receptron-laya-0.1.2-load). */
export const LAYA_RUNTIME_MODULE = 'node_modules/@receptron/laya/dist/laya.js';
/** The tokenizer package `Laya.load` builds its tokenizer from (npm-receptron-laya-0.1.2-load). */
export const LAYA_TOKENIZERS_PACKAGE = 'node_modules/@huggingface/tokenizers';

function within(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset.length > 0 && !offset.startsWith('..') && !isAbsolute(offset) && !offset.split(sep).includes('..');
}

/**
 * The worker's one computed import: an absolute file URL inside the tree the daemon verified just before this start.
 * There is no package-name fallback — nothing resolves through the daemon's own `node_modules` — and phase E's
 * static check admits exactly this call, in exactly this file.
 */
async function importVerified(root: string, entry: string): Promise<Readonly<Record<string, unknown>>> {
  const verifiedEntry = resolve(root, entry);
  if (!within(root, verifiedEntry)) throw new Error('the Laya runtime entry is outside its verified tree');
  return (await import(pathToFileURL(verifiedEntry).href)) as Readonly<Record<string, unknown>>;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function relativeEntry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const entry = value.startsWith('./') ? value.slice(2) : value;
  if (entry.length === 0 || entry.includes('\\') || entry.includes('\0') || entry.startsWith('/')) return null;
  return entry.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : entry;
}

/** Node's package entry for an ES module import, over a closed subset of `package.json` forms; anything else fails. */
function moduleEntry(manifest: unknown): string | null {
  if (!isRecord(manifest)) return null;
  const exported = manifest.exports;
  if (exported !== undefined) {
    const root = isRecord(exported) && Object.hasOwn(exported, '.') ? exported['.'] : exported;
    if (typeof root === 'string') return relativeEntry(root);
    if (!isRecord(root)) return null;
    const imported = root.import;
    if (typeof imported === 'string') return relativeEntry(imported);
    if (isRecord(imported) && typeof imported.default === 'string') return relativeEntry(imported.default);
    return relativeEntry(root.default);
  }
  return relativeEntry(manifest.module ?? manifest.main);
}

/**
 * Loads the runtime from the daemon-verified trees: the model's own context limits, the bundle's tokenizer, and
 * `Laya.load` with only `layaLoadOptions`. Any shape it does not recognise refuses the load; it never falls back.
 */
export async function loadVerifiedLayaRuntime(payload: LayaLoadPayload): Promise<LayaRuntimeBinding> {
  const config = await jsonFile(resolve(payload.modelDir, 'laya_config.json'));
  if (!isRecord(config) || config.max_len !== LAYA_MAX_SEQUENCE_TOKENS || config.head_max_len !== LAYA_HEAD_MAX_TOKENS)
    throw new Error('the verified Laya model does not have its reviewed context limits');
  const tokenizerJson = await jsonFile(resolve(payload.modelDir, 'tokenizer', 'tokenizer.json'));
  const tokenizerConfig = await jsonFile(resolve(payload.modelDir, 'tokenizer', 'tokenizer_config.json'));
  const tokenizersEntry = moduleEntry(
    await jsonFile(resolve(payload.runtimeRoot, LAYA_TOKENIZERS_PACKAGE, 'package.json')),
  );
  if (tokenizersEntry === null) throw new Error('the verified tokenizer package has no module entry');
  const tokenizers = await importVerified(payload.runtimeRoot, `${LAYA_TOKENIZERS_PACKAGE}/${tokenizersEntry}`);
  if (typeof tokenizers.Tokenizer !== 'function') throw new Error('the verified tokenizer package has no Tokenizer');
  const tokenizer = new (tokenizers.Tokenizer as new (json: unknown, config: unknown) => unknown)(
    tokenizerJson,
    tokenizerConfig,
  ) as { readonly encode?: unknown };
  if (typeof tokenizer.encode !== 'function') throw new Error('the verified tokenizer cannot encode');
  const encode = tokenizer.encode.bind(tokenizer) as (text: string, options: unknown) => unknown;
  const countTokens = (text: string): number => {
    const encoded = encode(text, { add_special_tokens: false });
    const ids = isRecord(encoded) ? encoded.ids : undefined;
    if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id)))
      throw new Error('the verified tokenizer returned no token ids');
    return ids.length;
  };
  countTokens('boundary');
  const runtimeModule = await importVerified(payload.runtimeRoot, LAYA_RUNTIME_MODULE);
  const runtime = runtimeModule.Laya as { readonly load?: unknown } | undefined;
  if (runtime === undefined || runtime === null || typeof runtime.load !== 'function')
    throw new Error('the verified runtime has no Laya.load');
  const loaded = (await (runtime.load as (options: unknown) => Promise<unknown>).call(
    runtime,
    layaLoadOptions(payload.modelDir),
  )) as { readonly systemOne?: unknown; readonly close?: unknown } | null;
  if (loaded === null || typeof loaded.systemOne !== 'function' || typeof loaded.close !== 'function')
    throw new Error('the verified runtime did not load a System One model');
  const systemOne = loaded.systemOne.bind(loaded) as LayaRuntimeBinding['systemOne'];
  const close = loaded.close.bind(loaded) as () => unknown;
  return {
    countTokens,
    systemOne: (state, questions) => systemOne(state, questions),
    close: async () => {
      await close();
    },
  };
}
