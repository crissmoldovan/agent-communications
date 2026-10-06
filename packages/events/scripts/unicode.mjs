#!/usr/bin/env node
/**
 * The Unicode 15.1 tables of `@agentcomms/events`, generated from the Unicode Consortium's own files (events phase A
 * plan, decision 2).
 *
 *   pnpm sync:unicode                                    # check the vendored sources' pins, then write the tables
 *   pnpm verify:unicode                                  # --check: regenerate in memory and compare, writing nothing
 *   node packages/events/scripts/unicode.mjs --fetch     # once, by hand: download, verify against the pins, vendor
 *
 * Why the library carries its own tables: a host's `normalize`, `toLowerCase` and URL parser follow the host's ICU,
 * and Node and every webview have their own Unicode version. Conditions fold case and normalise, and `domainIs`
 * compares IDNA domains, so a host table would let Node and the app disagree about any character assigned after 15.1
 * (design 2026-10-05, §2 and D5). The tables are generated from pinned files instead, and every `pnpm verify` proves
 * they still are.
 *
 * `vendor/unicode-15.1.0/SOURCES.json` pins every file: its URL, its byte size and the SHA-256 of the file exactly as
 * unicode.org publishes it. The sources are committed gzip-compressed under `sources/`, while the pin is on the
 * decompressed bytes, so a reviewer can re-download and hash them. Generation refuses any source whose size or hash
 * is not its pin's, and `--check` also refuses a generated file that differs, is missing, or should not be there.
 *
 * The generated modules hold integer arrays only, never packed strings, and decode them lazily, on first use, so
 * importing the package does no work. This script is not part of the published package, and is the only thing in
 * it that reads a file or the network: `--fetch` is run by hand, and never by a test.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

/** The vendored Unicode directory of this package. */
export const VENDOR = fileURLToPath(new URL('../vendor/unicode-15.1.0/', import.meta.url));

const say = (line) => process.stdout.write(`${line}\n`);

/** The highest code point. */
const MAX = 0x10ffff;

/** RFC 5893's Bidi classes, in the order the generated table numbers them. Any other class is not in the table. */
export const BIDI_CLASS_NAMES = Object.freeze(['L', 'R', 'AL', 'AN', 'EN', 'ES', 'CS', 'ET', 'ON', 'BN', 'NSM']);

/** Joining types as RFC 5892's ContextJ rules read them. `U` (Non_Joining) is every code point not listed. */
export const JOINING_TYPE_NAMES = Object.freeze(['U', 'D', 'R', 'L', 'T', 'C']);

/** UTS #46's status values, in the order the generated table numbers them. */
export const IDNA_STATUS_NAMES = Object.freeze([
  'valid',
  'ignored',
  'mapped',
  'deviation',
  'disallowed',
  'disallowed_STD3_valid',
  'disallowed_STD3_mapped',
]);

/** The pinned files the tables are generated from, by the name `SOURCES.json` gives them. */
export const SOURCE_NAMES = Object.freeze([
  'CaseFolding.txt',
  'UnicodeData.txt',
  'CompositionExclusions.txt',
  'DerivedJoiningType.txt',
  'IdnaMappingTable.txt',
]);

// ---------------------------------------------------------------------------------------------------------------
// Parsing. Each reader takes a file's text and refuses, naming the file and the line, anything it does not expect.
// ---------------------------------------------------------------------------------------------------------------

/** The data lines of a UCD file: comments and blank lines dropped, each with its 1-based line number. */
function dataLines(text) {
  const lines = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (line !== '') lines.push({ number: index + 1, line, fields: line.split(';').map((field) => field.trim()) });
  }
  return lines;
}

function refuse(file, number, why) {
  throw new Error(`${file}, line ${number}: ${why}`);
}

/** One hexadecimal code point. */
function codePoint(text, file, number) {
  if (!/^[0-9A-F]{4,6}$/.test(text)) refuse(file, number, `"${text}" is not a code point`);
  const value = Number.parseInt(text, 16);
  if (value > MAX) refuse(file, number, `${text} is beyond U+10FFFF`);
  return value;
}

/** `XXXX` or `XXXX..YYYY`, as `[start, end]`. */
function codePointRange(text, file, number) {
  const [first, last, extra] = text.split('..');
  if (extra !== undefined) refuse(file, number, `"${text}" is not a code point range`);
  const start = codePoint(first, file, number);
  const end = last === undefined ? start : codePoint(last, file, number);
  if (end < start) refuse(file, number, `"${text}" ends before it starts`);
  return [start, end];
}

/** A space-separated code point sequence, possibly empty. */
function codePoints(text, file, number) {
  return text === '' ? [] : text.split(/\s+/).map((part) => codePoint(part, file, number));
}

/** CaseFolding.txt: the `C` and `F` mappings, by code point. `S` and `T` are never used (design D5). */
export function parseCaseFolding(text, file = 'CaseFolding.txt') {
  const mappings = new Map();
  for (const { number, fields } of dataLines(text)) {
    const [code, status, mapping] = fields;
    if (fields.length !== 4 || fields[3] !== '') refuse(file, number, 'expected "code; status; mapping;"');
    if (!['C', 'F', 'S', 'T'].includes(status)) refuse(file, number, `unknown status "${status}"`);
    if (status !== 'C' && status !== 'F') continue;
    const point = codePoint(code, file, number);
    if (mappings.has(point)) refuse(file, number, `a second C or F mapping for ${code}`);
    const target = codePoints(mapping, file, number);
    if (target.length === 0) refuse(file, number, 'an empty mapping');
    mappings.set(point, target);
  }
  return mappings;
}

/**
 * UnicodeData.txt, as records `{ start, end, category, combiningClass, bidiClass, decomposition }`, where a
 * `<…, First>` and `<…, Last>` pair is one record spanning the range.
 */
export function parseUnicodeData(text, file = 'UnicodeData.txt') {
  const records = [];
  let open;
  for (const { number, fields } of dataLines(text)) {
    if (fields.length !== 15) refuse(file, number, `expected 15 fields, found ${fields.length}`);
    const [code, name, category, ccc, bidiClass, decomposition] = fields;
    const point = codePoint(code, file, number);
    if (!/^[0-9]{1,3}$/.test(ccc) || Number(ccc) > 254) refuse(file, number, `"${ccc}" is not a combining class`);
    const record = {
      start: point,
      end: point,
      category,
      combiningClass: Number(ccc),
      bidiClass,
      decomposition,
    };
    if (name.endsWith(', First>')) {
      if (open !== undefined) refuse(file, number, 'a range starts inside another');
      open = { record, name: name.slice(0, -', First>'.length) };
      continue;
    }
    if (name.endsWith(', Last>')) {
      if (open === undefined || open.name !== name.slice(0, -', Last>'.length)) {
        refuse(file, number, 'a range ends that did not start');
      }
      open.record.end = point;
      records.push(open.record);
      open = undefined;
      continue;
    }
    if (open !== undefined) refuse(file, number, 'a range is not closed');
    const last = records.at(-1);
    if (last !== undefined && last.end >= point) refuse(file, number, 'code points are not in order');
    records.push(record);
  }
  if (open !== undefined) throw new Error(`${file}: a range is not closed at the end of the file`);
  return records;
}

/** CompositionExclusions.txt: the code points listed (the commented-out derived sections are not). */
export function parseCompositionExclusions(text, file = 'CompositionExclusions.txt') {
  const points = [];
  for (const { number, fields } of dataLines(text)) {
    if (fields.length !== 1) refuse(file, number, 'expected one code point or range');
    const [start, end] = codePointRange(fields[0], file, number);
    for (let point = start; point <= end; point += 1) points.push(point);
  }
  return points;
}

/** DerivedJoiningType.txt: `[start, end, type]` for every listed range. */
export function parseJoiningTypes(text, file = 'DerivedJoiningType.txt') {
  const ranges = [];
  for (const { number, fields } of dataLines(text)) {
    if (fields.length !== 2) refuse(file, number, 'expected "range; type"');
    const type = JOINING_TYPE_NAMES.indexOf(fields[1]);
    if (type === -1) refuse(file, number, `unknown joining type "${fields[1]}"`);
    ranges.push([...codePointRange(fields[0], file, number), type]);
  }
  return ranges;
}

/**
 * IdnaMappingTable.txt: `{ start, end, status, mapping }` for every line, where `mapping` is the code point sequence
 * of a mapped, deviation or STD3-mapped line (possibly empty) and `undefined` otherwise. The IDNA2008 column
 * (`NV8`, `XV8`) is not part of UTS #46 processing and is not kept. The lines must cover every code point, in order.
 */
export function parseIdnaMapping(text, file = 'IdnaMappingTable.txt') {
  const entries = [];
  let next = 0;
  for (const { number, fields } of dataLines(text)) {
    if (fields.length < 2 || fields.length > 4) refuse(file, number, 'expected "range; status[; mapping[; idna2008]]"');
    const [start, end] = codePointRange(fields[0], file, number);
    if (start !== next) refuse(file, number, `expected the line for U+${hex(next)}`);
    next = end + 1;
    const status = IDNA_STATUS_NAMES.indexOf(fields[1]);
    if (status === -1) refuse(file, number, `unknown status "${fields[1]}"`);
    const name = fields[1];
    const hasMapping = name === 'mapped' || name === 'deviation' || name === 'disallowed_STD3_mapped';
    const mapping = hasMapping ? codePoints(fields[2] ?? '', file, number) : undefined;
    if (!hasMapping && (fields[2] ?? '') !== '') refuse(file, number, `a ${name} code point has a mapping`);
    if (hasMapping && name !== 'deviation' && mapping.length === 0) refuse(file, number, 'an empty mapping');
    if (fields[3] !== undefined && !['NV8', 'XV8'].includes(fields[3])) {
      refuse(file, number, `unknown IDNA2008 status "${fields[3]}"`);
    }
    entries.push({ start, end, status, mapping });
  }
  if (next !== MAX + 1) throw new Error(`${file}: the table ends at U+${hex(next - 1)}, not U+10FFFF`);
  return entries;
}

const hex = (value) => value.toString(16).toUpperCase().padStart(4, '0');

// ---------------------------------------------------------------------------------------------------------------
// Tables: the logical content of every generated module, as flat integer arrays.
// ---------------------------------------------------------------------------------------------------------------

/**
 * `[start, end, value]` triples (or `[start, end]` pairs when `value` is absent), sorted, with every two adjacent
 * ranges of the same value merged into one.
 */
function mergeRanges(ranges, withValue) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) throw new Error(`overlapping ranges at U+${hex(range[0])}`);
    if (last !== undefined && last[1] + 1 === range[0] && (!withValue || last[2] === range[2])) last[1] = range[1];
    else merged.push(withValue ? [range[0], range[1], range[2]] : [range[0], range[1]]);
  }
  return merged.flat();
}

/** `[codePoint, length, ...sequence]` records, by code point. */
function sequenceRecords(map) {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([point, sequence]) => [point, sequence.length, ...sequence]);
}

/** A canonical decomposition field (no `<tag>`), as a code point sequence; a compatibility one, or none, is `undefined`. */
function canonicalDecomposition(field, file) {
  if (field === '' || field.startsWith('<')) return undefined;
  return codePoints(field, file, 0);
}

/**
 * Every table, from the five sources' texts: `{ caseFolding, combiningClasses, decompositions,
 * compositionExclusions, marks, viramas, bidiClasses, joiningTypes, idnaRanges, idnaMappings }`, each a flat array of
 * integers:
 *
 * - `caseFolding`: `[codePoint, length, ...folded]`, CaseFolding's `C` and `F` lines only.
 * - `combiningClasses`: `[start, end, class]` for every non-zero canonical combining class.
 * - `decompositions`: `[codePoint, length, ...decomposition]`, every canonical (not compatibility) decomposition, one
 *   step, as UnicodeData gives it. Hangul syllables are not listed: they decompose algorithmically.
 * - `compositionExclusions`: `[start, end]` of Full_Composition_Exclusion: CompositionExclusions.txt, every singleton
 *   decomposition, and every decomposition of a non-starter or starting with one.
 * - `marks`: `[start, end]` of General_Category Mark (`Mn`, `Mc`, `Me`).
 * - `viramas`: `[start, end]` of canonical combining class 9 (Virama).
 * - `bidiClasses`: `[start, end, class]`, `class` an index into `BIDI_CLASS_NAMES`, for the classes RFC 5893 names.
 * - `joiningTypes`: `[start, end, type]`, `type` an index into `JOINING_TYPE_NAMES`, for every type but `U`.
 * - `idnaRanges`: `[start, end, status, mapping]`, covering every code point, `status` an index into
 *   `IDNA_STATUS_NAMES` and `mapping` the offset of the mapping's record in `idnaMappings`, or -1 for none.
 * - `idnaMappings`: `[length, ...sequence]` records, each distinct mapping once, in order of first use.
 */
export function buildTables(sources) {
  for (const name of SOURCE_NAMES) {
    if (typeof sources[name] !== 'string') throw new Error(`no text for ${name}`);
  }
  const folding = parseCaseFolding(sources['CaseFolding.txt']);
  const data = parseUnicodeData(sources['UnicodeData.txt']);
  const excluded = parseCompositionExclusions(sources['CompositionExclusions.txt']);
  const joining = parseJoiningTypes(sources['DerivedJoiningType.txt']);
  const idna = parseIdnaMapping(sources['IdnaMappingTable.txt']);

  const classes = new Map();
  const decompositions = new Map();
  for (const record of data) {
    if (record.combiningClass !== 0) {
      for (let point = record.start; point <= record.end; point += 1) classes.set(point, record.combiningClass);
    }
    const decomposition = canonicalDecomposition(record.decomposition, 'UnicodeData.txt');
    if (decomposition !== undefined) {
      if (record.start !== record.end)
        throw new Error(`UnicodeData.txt: the range at U+${hex(record.start)} decomposes`);
      decompositions.set(record.start, decomposition);
    }
  }
  const classOf = (point) => classes.get(point) ?? 0;

  const exclusions = new Set(excluded);
  for (const point of excluded) {
    if (!decompositions.has(point))
      throw new Error(`CompositionExclusions.txt: U+${hex(point)} has no canonical decomposition`);
  }
  for (const [point, decomposition] of decompositions) {
    const singleton = decomposition.length === 1;
    const nonStarter = classOf(point) !== 0 || classOf(decomposition[0]) !== 0;
    if (singleton || nonStarter) exclusions.add(point);
  }

  const mappingOffsets = new Map();
  const idnaMappings = [];
  const idnaRanges = [];
  for (const entry of idna) {
    let offset = -1;
    if (entry.mapping !== undefined) {
      const key = entry.mapping.join(' ');
      if (!mappingOffsets.has(key)) {
        mappingOffsets.set(key, idnaMappings.length);
        idnaMappings.push(entry.mapping.length, ...entry.mapping);
      }
      offset = mappingOffsets.get(key);
    }
    const last = idnaRanges.at(-1);
    if (last !== undefined && last[2] === entry.status && last[3] === offset) last[1] = entry.end;
    else idnaRanges.push([entry.start, entry.end, entry.status, offset]);
  }

  return {
    caseFolding: sequenceRecords(folding),
    combiningClasses: mergeRanges(
      [...classes].map(([point, value]) => [point, point, value]),
      true,
    ),
    decompositions: sequenceRecords(decompositions),
    compositionExclusions: mergeRanges(
      [...exclusions].map((point) => [point, point]),
      false,
    ),
    marks: mergeRanges(
      data.filter((record) => ['Mn', 'Mc', 'Me'].includes(record.category)).map((record) => [record.start, record.end]),
      false,
    ),
    viramas: mergeRanges(
      [...classes].filter(([, value]) => value === 9).map(([point]) => [point, point]),
      false,
    ),
    bidiClasses: mergeRanges(
      data
        .filter((record) => BIDI_CLASS_NAMES.includes(record.bidiClass))
        .map((record) => [record.start, record.end, BIDI_CLASS_NAMES.indexOf(record.bidiClass)]),
      true,
    ),
    joiningTypes: mergeRanges(
      joining.filter((range) => range[2] !== 0),
      true,
    ),
    idnaRanges: idnaRanges.flat(),
    idnaMappings,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering: the generated modules, as text.
// ---------------------------------------------------------------------------------------------------------------

/** One array literal: `per` integers to a line, or as many as fit in 118 columns when `per` is absent. */
function integers(values, per) {
  const lines = [];
  if (per !== undefined) {
    for (let at = 0; at < values.length; at += per) lines.push(`    ${values.slice(at, at + per).join(', ')},`);
  } else {
    let line = '';
    for (const value of values) {
      const next = `${value},`;
      if (line !== '' && line.length + 1 + next.length > 114) {
        lines.push(`    ${line}`);
        line = next;
      } else line = line === '' ? next : `${line} ${next}`;
    }
    if (line !== '') lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

/** Lines of records whose second field is a length: `[codePoint, length, ...sequence]`, one record per line. */
function recordLines(values) {
  const lines = [];
  for (let at = 0; at < values.length; ) {
    const size = 2 + values[at + 1];
    lines.push(`    ${values.slice(at, at + size).join(', ')},`);
    at += size;
  }
  return lines.join('\n');
}

/** `[length, ...sequence]` records, one per line. */
function mappingLines(values) {
  const lines = [];
  for (let at = 0; at < values.length; ) {
    const size = 1 + values[at];
    lines.push(`    ${values.slice(at, at + size).join(', ')},`);
    at += size;
  }
  return lines.join('\n');
}

function header(pins, what) {
  const width = Math.max(...pins.map((pin) => pin.name.length));
  return [
    `// ${what}`,
    '//',
    '// Generated by packages/events/scripts/unicode.mjs from the Unicode Character Database and the UTS #46 IDNA',
    '// mapping table, version 15.1.0. Do not edit; run `pnpm sync:unicode`.',
    '//',
    '// Generated from these files, by the SHA-256 of each as unicode.org publishes it:',
    ...pins.map((pin) => `//   ${pin.name.padEnd(width)}  ${pin.sha256}`),
    '//',
    '// The data is the Unicode Consortium\u2019s, under the Unicode License v3: see ../LICENSE.',
    '',
  ].join('\n');
}

/** A range-table module's shared parts: the lazily decoded table and a binary search over it. */
function rangeSearch(name, stride) {
  return [
    `let ${name}: Int32Array | undefined;`,
    '',
    `/** The index of the range holding \`codePoint\` in the ${stride}-wide table, or -1. */`,
    `function find${name[0].toUpperCase()}${name.slice(1)}(codePoint: number): number {`,
    `  ${name} ??= Int32Array.from(${name}Data());`,
    '  let low = 0;',
    `  let high = ${name}.length / ${stride} - 1;`,
    '  while (low <= high) {',
    '    const middle = (low + high) >> 1;',
    `    const at = middle * ${stride};`,
    `    if (codePoint < (${name}[at] as number)) high = middle - 1;`,
    `    else if (codePoint > (${name}[at + 1] as number)) low = middle + 1;`,
    '    else return at;',
    '  }',
    '  return -1;',
    '}',
  ].join('\n');
}

/** A function returning one table's integers, so they are built on first use rather than when the module loads. */
function dataFunction(name, lines, what) {
  const words = what.split(' ');
  const comment = [];
  for (const word of words) {
    const last = comment.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= 116) comment[comment.length - 1] = `${last} ${word}`;
    else comment.push(word);
  }
  const doc = comment.length === 1 ? [`/** ${comment[0]} */`] : ['/**', ...comment.map((line) => ` * ${line}`), ' */'];
  return [...doc, `function ${name}Data(): number[] {`, '  return [', lines, '  ];', '}'].join('\n');
}

/** Every generated module, by file name, from the tables and the pins they were made from. */
export function renderModules(tables, pins) {
  // The five files the tables are made from. The two test files and the licence are pinned and checked too, but
  // nothing here is generated from them.
  const sources = SOURCE_NAMES.map((name) => {
    const pin = pins.find((candidate) => candidate.name === name);
    if (pin === undefined) throw new Error(`SOURCES.json pins no ${name}`);
    return pin;
  });
  const files = new Map();

  files.set(
    'version.ts',
    [
      header(sources, 'The Unicode version of every table here, and the pinned sources they were generated from.'),
      '/** The Unicode version every table of this library follows, whatever the host\u2019s own is. */',
      "export const UNICODE_VERSION: '15.1.0' = '15.1.0';",
      '',
      '/** The SHA-256 of every source file the tables were generated from, by file name. */',
      'export const UNICODE_SOURCES: Readonly<Record<string, string>> = {',
      ...sources.map((pin) => `  '${pin.name}': '${pin.sha256}',`),
      '};',
      '',
    ].join('\n'),
  );

  files.set(
    'case-folding.ts',
    [
      header(sources, 'Full case folding: CaseFolding.txt\u2019s C and F mappings, never S or T (design D5).'),
      dataFunction(
        'folding',
        recordLines(tables.caseFolding),
        '`[codePoint, length, ...folded]` per line, by code point.',
      ),
      '',
      'let folding: Map<number, readonly number[]> | undefined;',
      '',
      '/** What `codePoint` folds to under full case folding, or `undefined` when it folds to itself. */',
      'export function caseFolding(codePoint: number): readonly number[] | undefined {',
      '  if (folding === undefined) {',
      '    folding = new Map();',
      '    const data = foldingData();',
      '    for (let at = 0; at < data.length; ) {',
      '      const length = data[at + 1] as number;',
      '      folding.set(data[at] as number, Object.freeze(data.slice(at + 2, at + 2 + length)));',
      '      at += 2 + length;',
      '    }',
      '  }',
      '  return folding.get(codePoint);',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'normalization.ts',
    [
      header(
        sources,
        'What NFC needs: canonical combining classes, canonical decompositions and Full_Composition_Exclusion.',
      ),
      dataFunction(
        'classes',
        integers(tables.combiningClasses, 3),
        '`[start, end, class]` per line: every non-zero canonical combining class.',
      ),
      '',
      rangeSearch('classes', 3),
      '',
      '/** The canonical combining class of `codePoint`: 0 for a starter. */',
      'export function combiningClass(codePoint: number): number {',
      '  const at = findClasses(codePoint);',
      '  return at === -1 ? 0 : ((classes as Int32Array)[at + 2] as number);',
      '}',
      '',
      dataFunction(
        'decompositions',
        recordLines(tables.decompositions),
        '`[codePoint, length, ...decomposition]` per line: canonical decompositions, one step. Hangul is algorithmic.',
      ),
      '',
      'let decompositions: Map<number, readonly number[]> | undefined;',
      '',
      '/** Every canonical decomposition, one step, by code point. */',
      'export function canonicalDecompositions(): ReadonlyMap<number, readonly number[]> {',
      '  if (decompositions === undefined) {',
      '    decompositions = new Map();',
      '    const data = decompositionsData();',
      '    for (let at = 0; at < data.length; ) {',
      '      const length = data[at + 1] as number;',
      '      decompositions.set(data[at] as number, Object.freeze(data.slice(at + 2, at + 2 + length)));',
      '      at += 2 + length;',
      '    }',
      '  }',
      '  return decompositions;',
      '}',
      '',
      '/** The canonical decomposition of `codePoint`, one step, or `undefined` when it has none. */',
      'export function canonicalDecomposition(codePoint: number): readonly number[] | undefined {',
      '  return canonicalDecompositions().get(codePoint);',
      '}',
      '',
      dataFunction(
        'exclusions',
        integers(tables.compositionExclusions, 2),
        '`[start, end]` per line: Full_Composition_Exclusion.',
      ),
      '',
      rangeSearch('exclusions', 2),
      '',
      '/** Whether `codePoint` is Full_Composition_Exclusion: never the result of canonical composition. */',
      'export function isCompositionExcluded(codePoint: number): boolean {',
      '  return findExclusions(codePoint) !== -1;',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'marks.ts',
    [
      header(sources, 'General_Category Mark, and canonical combining class 9 (Virama).'),
      dataFunction('marks', integers(tables.marks, 2), '`[start, end]` per line: General_Category Mn, Mc and Me.'),
      '',
      rangeSearch('marks', 2),
      '',
      '/** Whether `codePoint` is a combining mark: General_Category Mark (UTS #46 validity criterion 6). */',
      'export function isMark(codePoint: number): boolean {',
      '  return findMarks(codePoint) !== -1;',
      '}',
      '',
      dataFunction('viramas', integers(tables.viramas, 2), '`[start, end]` per line: canonical combining class 9.'),
      '',
      rangeSearch('viramas', 2),
      '',
      '/** Whether `codePoint` is a virama: canonical combining class 9 (RFC 5892, Appendix A.1 and A.2). */',
      'export function isVirama(codePoint: number): boolean {',
      '  return findViramas(codePoint) !== -1;',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'bidi-class.ts',
    [
      header(sources, 'Bidi_Class, for the classes RFC 5893 names.'),
      '/** The Bidi classes RFC 5893\u2019s rules name. */',
      "export type BidiClass = 'L' | 'R' | 'AL' | 'AN' | 'EN' | 'ES' | 'CS' | 'ET' | 'ON' | 'BN' | 'NSM';",
      '',
      `const NAMES: readonly BidiClass[] = [${BIDI_CLASS_NAMES.map((name) => `'${name}'`).join(', ')}];`,
      '',
      dataFunction(
        'bidi',
        integers(tables.bidiClasses, 3),
        '`[start, end, class]` per line, `class` an index into `NAMES`.',
      ),
      '',
      rangeSearch('bidi', 3),
      '',
      '/**',
      ' * The Bidi_Class of `codePoint`, or `undefined` when it is unassigned or has a class RFC 5893 does not name',
      ' * (B, S, WS and the explicit embedding, override and isolate controls), which no rule of RFC 5893 allows.',
      ' */',
      'export function bidiClass(codePoint: number): BidiClass | undefined {',
      '  const at = findBidi(codePoint);',
      '  return at === -1 ? undefined : NAMES[(bidi as Int32Array)[at + 2] as number];',
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'joining-type.ts',
    [
      header(sources, 'Joining_Type, as RFC 5892\u2019s ContextJ rules read it.'),
      '/** A Joining_Type value. `U` (Non_Joining) is every code point DerivedJoiningType.txt does not list. */',
      "export type JoiningType = 'U' | 'D' | 'R' | 'L' | 'T' | 'C';",
      '',
      `const NAMES: readonly JoiningType[] = [${JOINING_TYPE_NAMES.map((name) => `'${name}'`).join(', ')}];`,
      '',
      dataFunction(
        'joining',
        integers(tables.joiningTypes, 3),
        '`[start, end, type]` per line, `type` an index into `NAMES`; every type but U.',
      ),
      '',
      rangeSearch('joining', 3),
      '',
      '/** The Joining_Type of `codePoint`. */',
      'export function joiningType(codePoint: number): JoiningType {',
      '  const at = findJoining(codePoint);',
      "  return at === -1 ? 'U' : (NAMES[(joining as Int32Array)[at + 2] as number] as JoiningType);",
      '}',
      '',
    ].join('\n'),
  );

  files.set(
    'idna-mapping.ts',
    [
      header(sources, 'The UTS #46 IDNA mapping table: every code point\u2019s status, and its mapping.'),
      '/** A UTS #46 status value. */',
      'export type IdnaStatus =',
      ...IDNA_STATUS_NAMES.map((name, index) => `  | '${name}'${index === IDNA_STATUS_NAMES.length - 1 ? ';' : ''}`),
      '',
      `const STATUSES: readonly IdnaStatus[] = [`,
      ...IDNA_STATUS_NAMES.map((name) => `  '${name}',`),
      '];',
      '',
      dataFunction(
        'ranges',
        integers(tables.idnaRanges, 4),
        '`[start, end, status, mapping]` per line, covering every code point: `status` an index into `STATUSES`, `mapping` an offset into the mappings, or -1.',
      ),
      '',
      rangeSearch('ranges', 4),
      '',
      dataFunction(
        'mappings',
        mappingLines(tables.idnaMappings),
        '`[length, ...sequence]` per line: every distinct mapping once.',
      ),
      '',
      'let mappings: Int32Array | undefined;',
      '',
      '/** The UTS #46 status of `codePoint`. */',
      'export function idnaStatus(codePoint: number): IdnaStatus {',
      '  const at = findRanges(codePoint);',
      "  if (at === -1) throw new RangeError('not a code point: ' + String(codePoint));",
      '  return STATUSES[(ranges as Int32Array)[at + 2] as number] as IdnaStatus;',
      '}',
      '',
      '/**',
      ' * The mapping of `codePoint`, for a mapped, deviation or STD3-mapped code point (possibly empty: the deviation',
      ' * joiners map to nothing), or `undefined` for any other.',
      ' */',
      'export function idnaMapping(codePoint: number): readonly number[] | undefined {',
      '  const at = findRanges(codePoint);',
      "  if (at === -1) throw new RangeError('not a code point: ' + String(codePoint));",
      '  const offset = (ranges as Int32Array)[at + 3] as number;',
      '  if (offset === -1) return undefined;',
      '  mappings ??= Int32Array.from(mappingsData());',
      '  const length = mappings[offset] as number;',
      '  return Array.from(mappings.subarray(offset + 1, offset + 1 + length));',
      '}',
      '',
    ].join('\n'),
  );

  return files;
}

// ---------------------------------------------------------------------------------------------------------------
// The vendor directory: pins, sources and the generated files.
// ---------------------------------------------------------------------------------------------------------------

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** `SOURCES.json`'s pins: `{ name, url, bytes, sha256, vendored }`, `vendored` relative to the vendor directory. */
export function readPins(vendor = VENDOR) {
  const path = join(vendor, 'SOURCES.json');
  if (!existsSync(path)) throw new Error(`${shown(vendor, path)} is missing`);
  const pins = JSON.parse(readFileSync(path, 'utf8')).files;
  if (!Array.isArray(pins)) throw new Error(`${shown(vendor, path)} has no "files" list`);
  for (const pin of pins) {
    const keys = Object.keys(pin).sort().join(',');
    if (keys !== 'bytes,name,sha256,url,vendored')
      throw new Error(`${shown(vendor, path)}: a pin has the keys ${keys}`);
  }
  return pins;
}

/**
 * A path as messages show it: from the vendor directory's own name (`unicode-15.1.0/sources/…`), with forward
 * slashes, so a message names the file wherever the directory is.
 */
function shown(vendor, path) {
  return [basename(vendor), ...relative(vendor, path).split(sep)].filter((part) => part !== '').join('/');
}

/** The bytes a pin vendors, as unicode.org published them: decompressed for a `.gz`. */
function vendoredBytes(vendor, pin) {
  const path = join(vendor, pin.vendored);
  const raw = readFileSync(path);
  return pin.vendored.endsWith('.gz') ? gunzipSync(raw) : raw;
}

/**
 * Every pinned file's text, checked: each vendored file exists and its bytes are exactly its pin's size and SHA-256.
 * Returns `{ texts, problems }`, where each problem is a sentence naming the file.
 */
export function readSources(vendor = VENDOR) {
  const pins = readPins(vendor);
  const texts = {};
  const problems = [];
  for (const pin of pins) {
    const path = join(vendor, pin.vendored);
    if (!existsSync(path)) {
      problems.push(`${shown(vendor, path)} is missing: it should hold ${pin.name}, from ${pin.url}`);
      continue;
    }
    let bytes;
    try {
      bytes = vendoredBytes(vendor, pin);
    } catch (error) {
      problems.push(`${shown(vendor, path)} cannot be read as ${pin.name}: ${error.message}`);
      continue;
    }
    if (bytes.length !== pin.bytes) {
      problems.push(
        `${shown(vendor, path)} holds ${bytes.length} bytes of ${pin.name}, and SOURCES.json pins ${pin.bytes}`,
      );
      continue;
    }
    const digest = sha256(bytes);
    if (digest !== pin.sha256) {
      problems.push(
        `${shown(vendor, path)}: the SHA-256 of ${pin.name} is ${digest}, and SOURCES.json pins ${pin.sha256}`,
      );
      continue;
    }
    texts[pin.name] = bytes.toString('utf8');
  }
  const expected = new Set(pins.filter((pin) => pin.vendored.startsWith('sources/')).map((pin) => pin.vendored));
  const directory = join(vendor, 'sources');
  if (existsSync(directory)) {
    for (const name of readdirSync(directory).sort()) {
      if (!expected.has(`sources/${name}`))
        problems.push(`${shown(vendor, join(directory, name))} is not a pinned source`);
    }
  }
  return { pins, texts, problems };
}

/** The generated modules the vendored sources make, after checking their pins. Throws on any pin problem. */
export function generate(vendor = VENDOR) {
  const { pins, texts, problems } = readSources(vendor);
  if (problems.length > 0) {
    throw new Error(
      `the vendored Unicode sources do not match their pins:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return renderModules(buildTables(texts), pins);
}

/**
 * What `--check` finds: every pin problem, and every generated file that differs from what the sources make, is
 * missing, or is not one the generator makes. Empty when the tables match their pinned sources.
 */
export function checkVendor(vendor = VENDOR) {
  const { pins, texts, problems } = readSources(vendor);
  if (problems.length > 0) return problems;
  const modules = renderModules(buildTables(texts), pins);
  const directory = join(vendor, 'generated');
  const present = existsSync(directory) ? readdirSync(directory).sort() : [];
  for (const [name, text] of modules) {
    const path = join(directory, name);
    if (!present.includes(name)) problems.push(`${shown(vendor, path)} is missing — run \`pnpm sync:unicode\``);
    else if (readFileSync(path, 'utf8') !== text) {
      problems.push(`${shown(vendor, path)} is not what the pinned sources generate — run \`pnpm sync:unicode\``);
    }
  }
  for (const name of present) {
    if (!modules.has(name)) problems.push(`${shown(vendor, join(directory, name))} is not a table the generator makes`);
  }
  return problems;
}

/** Writes the generated modules, removing any file the generator does not make. */
function sync(vendor) {
  const modules = generate(vendor);
  const directory = join(vendor, 'generated');
  mkdirSync(directory, { recursive: true });
  for (const name of readdirSync(directory)) if (!modules.has(name)) rmSync(join(directory, name));
  for (const [name, text] of modules) writeFileSync(join(directory, name), text);
  say(`Unicode 15.1.0 tables written: ${[...modules.keys()].join(', ')}`);
}

/** Downloads every pinned file, verifies each against its pin, and only when all match writes them. */
async function fetchAll(vendor) {
  const pins = readPins(vendor);
  const downloaded = [];
  const problems = [];
  for (const pin of pins) {
    const response = await fetch(pin.url);
    if (!response.ok) {
      problems.push(`${pin.url}: HTTP ${response.status}`);
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    if (bytes.length !== pin.bytes || digest !== pin.sha256) {
      problems.push(
        `${pin.url} is ${bytes.length} bytes with SHA-256 ${digest}; SOURCES.json pins ${pin.bytes} bytes and ${pin.sha256}`,
      );
      continue;
    }
    downloaded.push({ pin, bytes });
  }
  if (problems.length > 0) {
    process.stderr.write(`Nothing was written: the files at the source no longer match their pins.\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  for (const { pin, bytes } of downloaded) {
    const path = join(vendor, pin.vendored);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, pin.vendored.endsWith('.gz') ? gzipSync(bytes, { level: 9 }) : bytes);
    say(`  ${pin.name}: ${pin.bytes} bytes, SHA-256 ${pin.sha256} — ${pin.vendored}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['--check', '--fetch']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0 || args.length > 1) {
    process.stderr.write('usage: unicode.mjs [--check | --fetch]\n');
    process.exit(2);
  }
  if (args[0] === '--fetch') {
    await fetchAll(VENDOR);
    return;
  }
  if (args[0] === '--check') {
    const problems = checkVendor(VENDOR);
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`);
      process.exit(1);
    }
    const pins = readPins(VENDOR);
    const tables = readdirSync(join(VENDOR, 'generated')).length;
    say(
      `Unicode 15.1.0 tables match their pinned sources: ${pins.length} files checked by size and SHA-256, ${tables} tables regenerated and identical`,
    );
    return;
  }
  sync(VENDOR);
}

// Run directly, generate, check or fetch. Imported — by its test — it only lends its functions.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) await main();
