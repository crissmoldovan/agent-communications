import { createHash } from 'node:crypto';

/**
 * Laya's two immutable prompt templates (E2-2, D11). The reviewed manifest lists which of them a release offers; their
 * content lives here, in the daemon's worker source, so a semantic change is a new id and a new manifest entry, never
 * an edit. Each has a stable SHA-256 over its canonical content, which the D11 gate subject binds.
 *
 * This module is loaded inside the isolated worker as well as by the daemon: it imports Node built-ins only.
 */
export const LAYA_NOUL_TEMPLATE_ID = 'laya-noul-v1' as const;
export const LAYA_CHOICE2_TEMPLATE_ID = 'laya-choice2-v1' as const;
export type LayaTemplateId = typeof LAYA_NOUL_TEMPLATE_ID | typeof LAYA_CHOICE2_TEMPLATE_ID;

export interface LayaTemplateOption {
  readonly label: string;
  readonly text: string;
}

export interface LayaTemplate {
  readonly id: LayaTemplateId;
  /** The runtime question type the template asks. */
  readonly type: 'noul' | 'choice';
  /** Every option in the runtime's own order, rendered as `<label>: <text>` (npm-receptron-laya-0.1.2-render). */
  readonly options: readonly LayaTemplateOption[];
  /** The option whose probability is the judge's value: `true` for `noul`, the affirmative key for `choice`. */
  readonly affirmative: string;
}

/**
 * `laya-noul-v1` asks one `noul` question; the runtime renders a `noul` question's two options itself, as
 * `false: no, the statement does not hold` and `true: yes, the statement holds`, and its answer is P(true).
 * `laya-choice2-v1` asks the same question as a two-option `choice` with neutral keys, the model card's workaround for
 * issue #156, and its value is the probability of the affirmative key.
 */
const TEMPLATES: Readonly<Record<LayaTemplateId, LayaTemplate>> = Object.freeze({
  [LAYA_CHOICE2_TEMPLATE_ID]: Object.freeze({
    id: LAYA_CHOICE2_TEMPLATE_ID,
    type: 'choice',
    options: Object.freeze([
      Object.freeze({ label: 'a', text: 'yes, the statement holds' }),
      Object.freeze({ label: 'b', text: 'no, the statement does not hold' }),
    ]),
    affirmative: 'a',
  }),
  [LAYA_NOUL_TEMPLATE_ID]: Object.freeze({
    id: LAYA_NOUL_TEMPLATE_ID,
    type: 'noul',
    options: Object.freeze([
      Object.freeze({ label: 'false', text: 'no, the statement does not hold' }),
      Object.freeze({ label: 'true', text: 'yes, the statement holds' }),
    ]),
    affirmative: 'true',
  }),
});

/** Every template id this worker source implements, in raw UTF-8 byte order (the manifest's order). */
export const LAYA_TEMPLATE_IDS: readonly LayaTemplateId[] = Object.freeze(
  (Object.keys(TEMPLATES) as LayaTemplateId[]).sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  ),
);

export function isLayaTemplateId(value: unknown): value is LayaTemplateId {
  return typeof value === 'string' && Object.hasOwn(TEMPLATES, value);
}

export function layaTemplate(id: LayaTemplateId): LayaTemplate {
  const template = TEMPLATES[id];
  if (template === undefined) throw new Error('the Laya prompt template is not one this worker implements');
  return template;
}

/** The template's canonical content: fixed key order, so the bytes and their digest never depend on construction. */
export function canonicalLayaTemplate(id: LayaTemplateId): string {
  const template = layaTemplate(id);
  return JSON.stringify({
    id: template.id,
    type: template.type,
    options: template.options.map((option) => ({ label: option.label, text: option.text })),
    affirmative: template.affirmative,
  });
}

/** The stable SHA-256 of one template's canonical content, for the D11 gate subject. */
export function layaTemplateDigest(id: LayaTemplateId): string {
  return createHash('sha256').update(canonicalLayaTemplate(id), 'utf8').digest('hex');
}

/** D11's version-1 context: the manifest's `context.maxTokens`, and `laya_config.json`'s `max_len` (hf-laya-onnx-config). */
export const LAYA_MAX_SEQUENCE_TOKENS = 512;
/** `laya_config.json`'s `head_max_len` (hf-laya-onnx-config). */
export const LAYA_HEAD_MAX_TOKENS = 192;
/** The runtime cuts each option to 48 tokens (npm-receptron-laya-0.1.2-render). */
export const LAYA_OPTION_MAX_TOKENS = 48;

/** The runtime replaces every literal `[MASK]` with a space before it encodes (npm-receptron-laya-0.1.2-render). */
function unmasked(text: string): string {
  return text.replaceAll('[MASK]', ' ');
}

/**
 * The complete, uncut text segments the runtime encodes for one request, as it lays them out: the head
 * `<type> question: <instructions>`, each option as `" " + "<label>: <text>"`, then the state as given. The worker
 * counts these with the bundle's own tokenizer before it runs anything, so the runtime never gets to cut one.
 */
export function layaLayout(
  id: LayaTemplateId,
  input: Readonly<{ instructions: string; state: string }>,
): Readonly<{ head: string; options: readonly string[]; state: string }> {
  const template = layaTemplate(id);
  return {
    head: `${template.type} question: ${unmasked(input.instructions)}`,
    options: template.options.map((option) => ` ${unmasked(`${option.label}: ${option.text}`)}`),
    state: unmasked(input.state),
  };
}
