/**
 * Unicode's own conformance files, read from their pinned, vendored sources and turned into vector files the runners
 * take (events phase A plan, decision 2, depth 3). They are derived here, at test time, rather than committed as
 * vectors: the pinned bytes are the only copy, and `pnpm verify:unicode` proves those are unicode.org's.
 *
 * Every code point travels as an integer, so a combining mark or a surrogate crosses into the bare realm and into a
 * browser exactly as the file writes it. Each file is handed over as JSON text, as a vector file is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PACKAGE_ROOT } from './realm.ts';

/** A derived vector file: the conformance file it comes from, its family, and its text. */
export interface ConformanceFile {
  readonly name: string;
  readonly family: string;
  readonly text: string;
  readonly vectors: number;
}

const SOURCES = join(PACKAGE_ROOT, 'vendor', 'unicode-15.1.0', 'sources');

/** A pinned source's text, decompressed. `pnpm verify:unicode` checks the bytes against their pin. */
export function sourceText(name: string): string {
  return gunzipSync(readFileSync(join(SOURCES, `${name}.gz`))).toString('utf8');
}

/** The data lines of a UCD file, comments and blanks dropped, split on `;` and trimmed. */
function dataLines(text: string): string[][] {
  const lines: string[][] = [];
  for (const raw of text.split('\n')) {
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (line !== '') lines.push(line.split(';').map((field) => field.trim()));
  }
  return lines;
}

const hexPoints = (field: string): number[] =>
  field === '' ? [] : field.split(/\s+/).map((part) => Number.parseInt(part, 16));

/** `[start, end]` ranges of the code points `included` accepts, from 0 to U+10FFFF. */
function rangesOf(included: (point: number) => boolean): [number, number][] {
  const ranges: [number, number][] = [];
  let start = -1;
  for (let point = 0; point <= 0x110000; point += 1) {
    const inside = point <= 0x10ffff && included(point);
    if (inside && start === -1) start = point;
    if (!inside && start !== -1) {
      ranges.push([start, point - 1]);
      start = -1;
    }
  }
  return ranges;
}

/** Every code point UnicodeData.txt 15.1 assigns, `<…, First>`/`<…, Last>` ranges included. */
export function assignedCodePoints(): Set<number> {
  const assigned = new Set<number>();
  let first: number | undefined;
  for (const fields of dataLines(sourceText('UnicodeData.txt'))) {
    const point = Number.parseInt(fields[0] as string, 16);
    const name = fields[1] as string;
    if (name.endsWith(', First>')) {
      first = point;
      continue;
    }
    if (name.endsWith(', Last>') && first !== undefined) {
      for (let at = first; at <= point; at += 1) assigned.add(at);
      first = undefined;
      continue;
    }
    assigned.add(point);
  }
  return assigned;
}

/**
 * NormalizationTest.txt 15.1, as the `unicode` family: one `normalizationTest` vector per part, whose lines are
 * `[c1, c2, c3, c4, c5]`, and one `nfcIdentity` vector of every assigned code point that Part 1 does not list.
 */
export function normalizationTestFile(): ConformanceFile {
  const parts = new Map<string, number[][][]>();
  let part = '';
  const listed = new Set<number>();
  for (const raw of sourceText('NormalizationTest.txt').split('\n')) {
    if (raw.startsWith('@')) {
      part = (raw.split(/\s/)[0] as string).slice(1);
      parts.set(part, []);
      continue;
    }
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (line === '') continue;
    const columns = line
      .split(';')
      .slice(0, 5)
      .map((field) => hexPoints(field.trim()));
    if (columns.length !== 5) throw new Error(`NormalizationTest.txt: a line without five columns: ${raw}`);
    parts.get(part)?.push(columns);
    if (part === 'Part1') listed.add(columns[0]?.[0] as number);
  }
  if ([...parts.keys()].join(',') !== 'Part0,Part1,Part2,Part3') {
    throw new Error(`NormalizationTest.txt has the parts ${[...parts.keys()].join(', ')}`);
  }
  const assigned = assignedCodePoints();
  const vectors = [
    ...[...parts].map(([name, lines]) => ({ kind: 'normalizationTest', name: `NormalizationTest.txt ${name}`, lines })),
    {
      kind: 'nfcIdentity',
      name: 'NormalizationTest.txt: every assigned code point Part 1 does not list is its own NFC',
      ranges: rangesOf((point) => assigned.has(point) && !listed.has(point)),
    },
  ];
  const description =
    'Derived at test time from the pinned NormalizationTest.txt 15.1: its NFC invariants for every line of Parts 0-3, and identity for every assigned code point outside Part 1.';
  return {
    name: 'NormalizationTest.txt',
    family: 'unicode',
    text: JSON.stringify({ family: 'unicode', description, vectors }),
    vectors: vectors.length,
  };
}

/**
 * CaseFolding.txt 15.1, as the `unicode` family: every `C` and `F` line as a `foldTable` vector; every code point with
 * a `T` or `S` line folding to its `C` or `F` mapping, or to itself, never to the `T` or `S` one; and every code point
 * with no `C` or `F` line folding to itself.
 */
export function caseFoldingFile(): ConformanceFile {
  const full = new Map<number, number[]>();
  const other = new Set<number>();
  for (const fields of dataLines(sourceText('CaseFolding.txt'))) {
    const point = Number.parseInt(fields[0] as string, 16);
    const status = fields[1] as string;
    if (status === 'C' || status === 'F') full.set(point, hexPoints(fields[2] as string));
    else other.add(point);
  }
  const vectors = [
    { kind: 'foldTable', name: 'CaseFolding.txt: every C and F line', mappings: [...full] },
    {
      kind: 'foldTable',
      name: 'CaseFolding.txt: a code point with a T or S line folds by its C or F line, or to itself',
      mappings: [...other].sort((a, b) => a - b).map((point) => [point, full.get(point) ?? [point]]),
    },
    {
      kind: 'foldIdentity',
      name: 'CaseFolding.txt: every code point with no C or F line folds to itself',
      ranges: rangesOf((point) => !full.has(point)),
    },
  ];
  const description =
    'Derived at test time from the pinned CaseFolding.txt 15.1: C and F exactly, T and S never, and every other code point unchanged.';
  return {
    name: 'CaseFolding.txt',
    family: 'unicode',
    text: JSON.stringify({ family: 'unicode', description, vectors }),
    vectors: vectors.length,
  };
}

/** One IdnaTestV2.txt line, read by the file's own column rules. */
export interface IdnaTestLine {
  /** The line number in IdnaTestV2.txt. */
  readonly line: number;
  readonly source: string;
  /** Column 4, `toAsciiN`: blank means the `toUnicode` value, which blank means the source. */
  readonly toAsciiN: string;
  /** Column 5, `toAsciiNStatus`: blank means the `toUnicodeStatus`, which blank means none; `[]` is none. */
  readonly toAsciiNStatus: readonly string[];
  /**
   * Whether the line's source or `toUnicode` value holds a code point UnicodeData.txt 15.1 does not assign. Its
   * Bidi_Class is then the UCD's default for its block, which no pinned source states (see `idnaTestFile`).
   */
  readonly unassigned: boolean;
}

/** A column's text with IdnaTestV2's `\uXXXX` and `\x{X…}` escapes replaced by the characters they stand for. */
function unescapeColumn(text: string): string {
  return text.replace(
    /\\u([0-9A-Fa-f]{4})|\\x\{([0-9A-Fa-f]+)\}/g,
    (_, four: string | undefined, any: string | undefined) =>
      String.fromCodePoint(Number.parseInt((four ?? any) as string, 16)),
  );
}

/** `[A, B]` as `['A', 'B']`; blank is `undefined`, so the caller can apply the file's defaulting rule. */
function statusColumn(text: string): string[] | undefined {
  if (text === '') return undefined;
  if (!text.startsWith('[') || !text.endsWith(']'))
    throw new Error(`IdnaTestV2.txt: a status that is not a list: ${text}`);
  const inner = text.slice(1, -1).trim();
  return inner === '' ? [] : inner.split(',').map((code) => code.trim());
}

/** Every IdnaTestV2.txt 15.1 line, with the nontransitional ToASCII columns resolved. */
export function idnaTestLines(): IdnaTestLine[] {
  const assigned = assignedCodePoints();
  const lines: IdnaTestLine[] = [];
  for (const [index, raw] of sourceText('IdnaTestV2.txt').split('\n').entries()) {
    const hash = raw.indexOf('#');
    const data = hash === -1 ? raw : raw.slice(0, hash);
    if (data.trim() === '') continue;
    const columns = data.split(';').map((column) => column.trim());
    if (columns.length !== 7) throw new Error(`IdnaTestV2.txt, line ${index + 1}: ${columns.length} columns, not 7`);
    const [source, toUnicode, toUnicodeStatus, toAsciiN, toAsciiNStatus] = columns.map(unescapeColumn) as string[];
    const unicode = toUnicode === '' ? (source as string) : (toUnicode as string);
    lines.push({
      line: index + 1,
      source: source as string,
      toAsciiN: toAsciiN === '' ? unicode : (toAsciiN as string),
      toAsciiNStatus: statusColumn(toAsciiNStatus as string) ?? statusColumn(toUnicodeStatus as string) ?? [],
      unassigned: codePoints(`${source}${unicode}`).some((point) => !assigned.has(point)),
    });
  }
  return lines;
}

/**
 * IdnaTestV2.txt 15.1, as the `idna` family: one `idnaTestV2` vector of every line, each `[line, source, toAsciiN,
 * statuses, unassigned]` with the strings as code points. The transitional columns are not read: D5 is
 * nontransitional.
 *
 * `unassigned` marks the lines whose Bidi status codes cannot be reproduced from the pinned sources. UTS #46's
 * CheckBidi reads the Bidi_Class of every code point of a label, a disallowed one included, and the class of a code
 * point UnicodeData.txt does not assign is the default the UCD gives its block (DerivedBidiClass.txt's `@missing`
 * lines), which none of the seven pinned files states. On those lines the runner holds everything else exactly — the
 * value, refusal, and every status code but the `B` ones — and requires `V6`, so the refusal never depends on them.
 */
export function idnaTestFile(): ConformanceFile {
  const lines = idnaTestLines().map((test) => [
    test.line,
    codePoints(test.source),
    codePoints(test.toAsciiN),
    test.toAsciiNStatus,
    test.unassigned,
  ]);
  const vectors = [{ kind: 'idnaTestV2', name: 'IdnaTestV2.txt: every line, toAsciiN and its status set', lines }];
  const description =
    'Derived at test time from the pinned IdnaTestV2.txt 15.1: for every line, the nontransitional toAsciiN value and its exact status set, by the file’s own column rules.';
  return {
    name: 'IdnaTestV2.txt',
    family: 'idna',
    text: JSON.stringify({ family: 'idna', description, vectors }),
    vectors: vectors.length,
  };
}

/** A string's code points, a surrogate without its partner as its own value. */
function codePoints(text: string): number[] {
  const points: number[] = [];
  for (const character of text) points.push(character.codePointAt(0) as number);
  return points;
}

/** Every derived conformance file, for `unicode.test.ts`, `idna.test.ts` and `pnpm verify:browser`. */
export function conformanceFiles(): ConformanceFile[] {
  return [normalizationTestFile(), caseFoldingFile(), idnaTestFile()];
}
