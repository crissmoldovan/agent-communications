/**
 * How a search finds and orders what it found (design 2026-10-26-local-search §6): the words, the meaning, and the two
 * fused. Pure functions over what the store gives, so the ranking can be checked against a synthetic corpus with a
 * deterministic embedder, and nothing here reads a file or a socket.
 */

/** The most terms a query is split into, and the longest a term may be. */
const MAX_TERMS = 32;
const MAX_TERM_CHARS = 64;

/**
 * A query's terms: its runs of letters and digits, in order, each once, case kept — what an excerpt is centred on. The
 * words index takes a query's words folded and hashed instead (`words.ts`).
 */
export function queryTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of text.normalize('NFC').matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = [...match[0]].slice(0, MAX_TERM_CHARS).join('');
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/** Folds case and diacritics, as the words index does before it hashes a word: `Factură` and `factura` are one. */
export function folded(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * About 240 characters of `text` around the first term it holds — or its start — on one line, with `…` where cut.
 * Found by the folded text, so a term without its diacritics finds the word with them.
 */
export function excerpt(text: string, terms: readonly string[], size = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  if (chars.length <= size) return flat;
  // Folding can change lengths only by marks, which are dropped character by character: map each folded position back.
  const foldedChars: string[] = [];
  const origin: number[] = [];
  chars.forEach((char, index) => {
    for (const part of folded(char)) {
      foldedChars.push(part);
      origin.push(index);
    }
  });
  const haystack = foldedChars.join('');
  let at = -1;
  for (const term of terms) {
    const found = haystack.indexOf(folded(term));
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const centre = at === -1 ? 0 : (origin[at] ?? 0);
  const start = Math.max(0, Math.min(centre - Math.floor(size / 3), chars.length - size));
  const end = Math.min(chars.length, start + size);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('').trim()}${end < chars.length ? '…' : ''}`;
}

/** The dot product of two vectors of one length: their cosine, since both are normalised. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) sum += (a[index] ?? 0) * (b[index] ?? 0);
  return sum;
}

/** The `limit` rows closest to `query`, by an exact scan: closest first, newer first on ties. */
export function nearest(
  query: Float32Array,
  rows: readonly { readonly id: number; readonly at: number; readonly vector: Float32Array }[],
  limit: number,
): number[] {
  return rows
    .map((row) => ({ id: row.id, at: row.at, score: row.vector.length === query.length ? dot(query, row.vector) : -2 }))
    .filter((row) => row.score > -2)
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, limit)
    .map((row) => row.id);
}

/** The constant of reciprocal-rank fusion (§6): 60, as the method's authors use it. */
export const RRF_K = 60;

/**
 * Two ranked lists fused by reciprocal rank: each row scores 1/(k + rank) in each list it is in, and rows are ordered by
 * the sum, newer first on ties. Each row's rank in each list — 1-based, or null — goes with it.
 */
export function fuse(
  words: readonly number[],
  meaning: readonly number[],
  at: ReadonlyMap<number, number>,
  k: number = RRF_K,
): { id: number; words: number | null; meaning: number | null }[] {
  const scores = new Map<number, { score: number; words: number | null; meaning: number | null }>();
  const add = (ids: readonly number[], which: 'words' | 'meaning') => {
    ids.forEach((id, index) => {
      const held = scores.get(id) ?? { score: 0, words: null, meaning: null };
      held.score += 1 / (k + index + 1);
      held[which] = index + 1;
      scores.set(id, held);
    });
  };
  add(words, 'words');
  add(meaning, 'meaning');
  return [...scores.entries()]
    .sort(([a, x], [b, y]) => y.score - x.score || (at.get(b) ?? 0) - (at.get(a) ?? 0))
    .map(([id, held]) => ({ id, words: held.words, meaning: held.meaning }));
}
