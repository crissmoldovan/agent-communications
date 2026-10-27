import { createHmac } from 'node:crypto';
import { type SearchKey, searchSubkey } from './crypto.ts';
import { folded } from './rank.ts';

/**
 * What the words index holds (design 2026-10-26-local-search S11, as the note of 2026-10-27 amends it): keyed hashes of
 * the words, never the words.
 *
 * FTS5 keeps whatever tokens it is given, in the clear, and with `detail=full` where each one stood: the security review
 * of 2026-10-27 (M2) rebuilt a message's subject and text, in order, from `fts5vocab 'instance'` alone, with no key. So
 * the words are made into tokens here, in JS, and each is replaced by an HMAC-SHA256 under the `words` subkey of
 * Search's own key before FTS5 sees it:
 *
 * - **The words:** case and diacritics folded — `Factură` and `factura` are one, so are `înțeles` and `INTELES` — then
 *   every run of letters and digits. This is what the `unicode61 remove_diacritics 2` tokenizer did for English and
 *   Romanian, the two languages Search is checked in.
 * - **A token:** the first 128 bits of the HMAC, as 32 hex digits — one ASCII token to FTS5, which cannot tell one from
 *   another word without the key. A message gives each token once, sorted: no count and no order.
 * - **Prefixes:** a person may still be typing the last word of a search, so each word is also kept by its first 3 to 24
 *   characters, under a hash of their own kind; the last word of a search matches the word whole or as one of those.
 * - **No positions:** the table is `detail=none`. Each word is searched alone, so no phrase needs them; bm25, which needs
 *   them in a contentless table, is replaced by the same weighting without them (`SearchStore.wordsMatch`).
 *
 * What is still in the file without the key: which rows share a token, and how many tokens a row has — frequency and
 * co-occurrence, never a word or its place. With the key, a guessed word can be tested against the index; whoever has
 * the key can open the sealed text anyway.
 */

/** The fewest and the most characters a word is kept by as a prefix. */
export const MIN_PREFIX_CHARS = 3;
export const MAX_PREFIX_CHARS = 24;

/** The most words a search is split into, and the longest a word of a search may be. */
const MAX_QUERY_WORDS = 32;
const MAX_QUERY_WORD_CHARS = 64;

/** How much of the HMAC a token keeps: 128 bits. */
const TOKEN_BYTES = 16;

/** How many hashes one hasher remembers before it starts again: words repeat across messages, a run hashes each once. */
const CACHE_LIMIT = 50_000;

/** What a token looks like in the file. */
export const WORD_TOKEN: RegExp = /^[0-9a-f]{32}$/;

/** A text's words as the index keeps them, before they are hashed: case and diacritics folded, in order. */
export function wordTokens(text: string): string[] {
  return folded(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The words of a search: folded as a message's are, each once, at most 32 of them and 64 characters each. */
export function queryWords(text: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const token of wordTokens(text)) {
    const word = [...token].slice(0, MAX_QUERY_WORD_CHARS).join('');
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
    if (words.length === MAX_QUERY_WORDS) break;
  }
  return words;
}

/** The hashes of one key: a message's tokens, and a search's. */
export class WordHasher {
  readonly #key: Buffer;
  readonly #cache = new Map<string, string>();

  constructor(master: SearchKey) {
    this.#key = searchSubkey(master, 'words');
  }

  #hash(kind: 'word' | 'prefix', value: string): string {
    const input = `${kind}\0${value}`;
    const held = this.#cache.get(input);
    if (held !== undefined) return held;
    const made = createHmac('sha256', this.#key)
      .update(input, 'utf8')
      .digest()
      .subarray(0, TOKEN_BYTES)
      .toString('hex');
    if (this.#cache.size >= CACHE_LIMIT) this.#cache.clear();
    this.#cache.set(input, made);
    return made;
  }

  /** A whole word's token. */
  word(word: string): string {
    return this.#hash('word', word);
  }

  /** The token of a word's first characters — at most 24 of them. */
  prefix(start: string): string {
    return this.#hash('prefix', [...start].slice(0, MAX_PREFIX_CHARS).join(''));
  }

  /**
   * What the words index holds for a message: each word's token, and the tokens of its first 3 to 24 characters short
   * of the whole word — each once, sorted, space-separated.
   */
  document(subject: string | undefined, text: string): string {
    const tokens = new Set<string>();
    for (const word of [...wordTokens(subject ?? ''), ...wordTokens(text)]) {
      tokens.add(this.word(word));
      const chars = [...word];
      const longest = Math.min(chars.length - 1, MAX_PREFIX_CHARS);
      for (let length = MIN_PREFIX_CHARS; length <= longest; length += 1) {
        tokens.add(this.#hash('prefix', chars.slice(0, length).join('')));
      }
    }
    return [...tokens].sort().join(' ');
  }

  /**
   * A search's words, each as the words index's expression for it: its token quoted — the last word whole or as a
   * prefix, since a person may still be typing it. Empty when the search has no word.
   */
  terms(text: string): string[] {
    const words = queryWords(text);
    return words.map((word, index) =>
      index === words.length - 1 && [...word].length >= MIN_PREFIX_CHARS
        ? `("${this.word(word)}" OR "${this.prefix(word)}")`
        : `"${this.word(word)}"`,
    );
  }
}
