import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cursor, lineTree, RuleTextFailure, type TextLine } from '../src/rule-text/lines.ts';
import type { RuleTextError } from '../src/rule-text/types.ts';

/**
 * The rule text's lowest layer: lines become a tree by their two-space indentation, and each line is read by a cursor
 * that knows words, quoted text, numbers and JSON. The printer and the parser above it are tested in
 * `rule-text.test.ts`.
 */

function tree(text: string): { readonly lines: readonly TextLine[]; readonly errors: readonly RuleTextError[] } {
  const errors: RuleTextError[] = [];
  return { lines: lineTree(text, errors), errors };
}

function shape(lines: readonly TextLine[]): unknown[] {
  return lines.map((line) => [line.number, line.text, ...(line.children.length > 0 ? [shape(line.children)] : [])]);
}

function failure(run: () => unknown): RuleTextFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof RuleTextFailure) return error;
    throw error;
  }
  assert.fail('expected the cursor to refuse');
}

test('lines nest by two spaces, blank lines and trailing spaces are ignored, and any line ending works', () => {
  const { lines, errors } = tree('then\r\n  queue q, version 1  \n\n  dry run d, version 1\r    keep\nkeep a\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(shape(lines), [
    [
      1,
      'then',
      [
        [2, 'queue q, version 1'],
        [4, 'dry run d, version 1', [[5, 'keep']]],
      ],
    ],
    [6, 'keep a'],
  ]);
  assert.equal(lines[0]?.children[1]?.children[0]?.column, 5, 'a column counts the indentation');
});

test('a tab, an odd indent, a jump of two levels and an indented first line are refused where they stand', () => {
  assert.deepEqual(tree('then\n\tqueue q, version 1\n').errors, [
    { line: 2, column: 1, message: 'indent with spaces, two per level; this line has a tab in its indentation' },
  ]);
  assert.deepEqual(tree('then\n   queue q, version 1\n').errors, [
    { line: 2, column: 1, message: 'indent by two spaces per level; this line is indented by 3' },
  ]);
  assert.deepEqual(tree('then\n    queue q, version 1\n').errors, [
    {
      line: 2,
      column: 5,
      message:
        'this line is indented two levels deeper than the line above it; indent one level (two spaces) at a time',
    },
  ]);
  assert.deepEqual(tree('  when a new message arrives in a\n').errors, [
    { line: 1, column: 3, message: 'this line is indented, but no line above it opens a block' },
  ]);
});

test('quoted text is JSON, so any text round-trips: quotes, newlines, markup, unicode and a lone surrogate', () => {
  const samples = [
    'say "hi"',
    'two\nlines\r\tand a tab',
    '<script>alert(1)</script>',
    'café ☕ 🛰 ✓',
    String.fromCharCode(0x2028, 0x2029),
    '\ud800',
    '',
  ];
  for (const sample of samples) {
    const line = `question ${JSON.stringify(sample)}`;
    const [only] = tree(line).lines;
    assert.ok(only);
    const cursor = new Cursor(only);
    assert.equal(cursor.word(), 'question');
    assert.equal(cursor.string('the question'), sample);
    assert.equal(cursor.atEnd(), true);
  }
});

test('the cursor reads names bare or quoted, integers, JSON scalars and balanced JSON', () => {
  const [line] = tree('x cue/gmail "a b" 42 0.7 -1e+21 null true {"a":["]",{"b":"}"}]} [1,2] rest').lines;
  assert.ok(line);
  const cursor = new Cursor(line);
  assert.equal(cursor.word(), 'x');
  assert.equal(cursor.name('an account'), 'cue/gmail');
  assert.equal(cursor.name('an account'), 'a b');
  assert.equal(cursor.integer('a version'), 42);
  assert.equal(cursor.value('a value'), 0.7);
  assert.equal(cursor.value('a value'), -1e21);
  assert.equal(cursor.value('a value'), null);
  assert.equal(cursor.value('a value'), true);
  assert.deepEqual(cursor.json('a document'), { a: [']', { b: '}' }] });
  assert.deepEqual(cursor.json('a document'), [1, 2]);
  assert.equal(cursor.take('rest'), true);
  assert.equal(cursor.atEnd(), true);
});

test('take reads a whole phrase or nothing, so a near miss leaves the cursor where it was', () => {
  const [line] = tree('a new message leaves').lines;
  assert.ok(line);
  const cursor = new Cursor(line);
  assert.equal(cursor.take('a', 'new', 'message', 'arrives'), false);
  assert.equal(cursor.take('a', 'new'), true);
  assert.equal(cursor.word(), 'message');
});

test('the cursor names the column of what it refuses', () => {
  const [line] = tree('then\n  keep "unclosed').lines[0]?.children ?? [];
  assert.ok(line);
  const cursor = new Cursor(line);
  cursor.word();
  const unclosed = failure(() => cursor.string('the text'));
  assert.deepEqual([unclosed.line, unclosed.column], [2, 8]);
  assert.match(unclosed.message, /the text has no closing quote/);

  const [numbers] = tree('at most 07 an hour').lines;
  assert.ok(numbers);
  const count = new Cursor(numbers);
  count.take('at', 'most');
  const leading = failure(() => count.integer('the hourly cap'));
  assert.deepEqual(
    [leading.line, leading.column, leading.message],
    [1, 9, 'the hourly cap is a whole number, such as 60; found "07"'],
  );

  const [json] = tree('raw /x = {"a": }').lines;
  assert.ok(json);
  const raw = new Cursor(json);
  raw.take('raw');
  raw.word();
  raw.take('=');
  const broken = failure(() => raw.json('the raw value'));
  assert.deepEqual([broken.column, broken.message], [10, 'the raw value is not valid JSON']);
});
