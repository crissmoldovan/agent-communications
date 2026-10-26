/**
 * The models Search may use to make messages searchable by meaning (design 2026-10-26-local-search, S9): a short,
 * reviewed list, each run by the person's own Ollama on this machine. A model off the list is refused, so what the
 * screens say about quality stays honest; a name that ends in `cloud` is refused whatever it is, since Ollama runs such
 * models on someone else's computer through the local server.
 *
 * Each profile says how a query and a message are written for the model — Qwen's instruction, EmbeddingGemma's
 * `task: … | query:` — and how many dimensions a vector keeps. 512 for the two that offer it through Ollama's
 * `dimensions` (Matryoshka-trained: the first 512 of the full vector, normalised again); BGE-M3 has no such training,
 * so it keeps its own 1024.
 *
 * The default — the one the app offers to pull — is Qwen's (open question 4 of the design, its default: Apache-2.0 and
 * a 32K context).
 *
 * Imports nothing: the settings reader, which `config.ts` imports, uses it.
 */

export interface SearchModelProfile {
  /** The name with its tag, as Ollama lists it. */
  readonly name: string;
  /** Other names the person may type for it: the name without its tag, or with another tag for the same weights. */
  readonly aliases: readonly string[];
  /** How many numbers a vector keeps. */
  readonly dimensions: number;
  /** Whether Ollama is asked for `dimensions` (true), or the model's own size is what comes back (false). */
  readonly asksDimensions: boolean;
  /** The download, as Ollama's library page gave it (read 2026-10-26). */
  readonly download: string;
  readonly licence: string;
  /** How much one message may hold before Ollama cuts it, in tokens. */
  readonly context: string;
  /** A search's words, as the model reads a query. */
  readonly query: (text: string) => string;
  /** A message, as the model reads a document. */
  readonly document: (subject: string | undefined, text: string) => string;
}

const QWEN: SearchModelProfile = Object.freeze({
  name: 'qwen3-embedding:0.6b',
  aliases: Object.freeze([]),
  dimensions: 512,
  asksDimensions: true,
  download: '639 MB',
  licence: 'Apache-2.0',
  context: '32K',
  query: (text: string) =>
    `Instruct: Given a question about past messages, retrieve the messages that answer it\nQuery: ${text}`,
  document: (subject: string | undefined, text: string) => (subject ? `${subject}\n${text}` : text),
});

const GEMMA: SearchModelProfile = Object.freeze({
  name: 'embeddinggemma:latest',
  aliases: Object.freeze(['embeddinggemma', 'embeddinggemma:300m']),
  dimensions: 512,
  asksDimensions: true,
  download: '622 MB',
  licence: 'Gemma Terms of Use',
  context: '2K',
  query: (text: string) => `task: search result | query: ${text}`,
  document: (subject: string | undefined, text: string) => `title: ${subject || 'none'} | text: ${text}`,
});

const BGE: SearchModelProfile = Object.freeze({
  name: 'bge-m3:latest',
  aliases: Object.freeze(['bge-m3', 'bge-m3:567m']),
  dimensions: 1024,
  asksDimensions: false,
  download: '1.2 GB',
  licence: 'MIT',
  context: '8K',
  query: (text: string) => text,
  document: (subject: string | undefined, text: string) => (subject ? `${subject}\n${text}` : text),
});

/** The reviewed list, the default first. */
export const SEARCH_MODELS: readonly SearchModelProfile[] = Object.freeze([QWEN, GEMMA, BGE]);

/** The model the app offers to pull, and the one `search model set` uses when no name is given. */
export const DEFAULT_SEARCH_MODEL: string = QWEN.name;

/** A name Ollama runs elsewhere: `…cloud`, `…:…-cloud`. */
export function isCloudModelName(name: string): boolean {
  return /cloud$/i.test(name.trim());
}

/** The profile for a name the person typed or the file holds — by its name or one of its aliases — or undefined. */
export function searchModelProfile(name: unknown): SearchModelProfile | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128 || isCloudModelName(name)) return undefined;
  return SEARCH_MODELS.find((profile) => profile.name === name || profile.aliases.includes(name));
}

/** The name as it is stored and as Ollama lists it, for a name on the list; undefined for any other. */
export function searchModelName(name: unknown): string | undefined {
  return searchModelProfile(name)?.name;
}
