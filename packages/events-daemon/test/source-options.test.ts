import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyGmailSourceOptionChange,
  type GmailSourceOptions,
  normaliseGmailSourceOptions,
} from '../src/domain/source-options.ts';

const inbox: GmailSourceOptions = { channel: 'gmail', labels: 'inbox', includeSpamTrash: false };
const any: GmailSourceOptions = { channel: 'gmail', labels: 'any', includeSpamTrash: false };
const labels = (values: readonly string[], includeSpamTrash = false): GmailSourceOptions => ({
  channel: 'gmail',
  labels: values,
  includeSpamTrash,
});

test('D4: Gmail source options require the Gmail channel and canonical non-empty raw-UTF-8 label sets', () => {
  assert.deepEqual(normaliseGmailSourceOptions(labels(['a', 'é'])), labels(['a', 'é']));
  assert.deepEqual(
    normaliseGmailSourceOptions(labels(['\uE000', '𐀀'])),
    labels(['\uE000', '𐀀']),
    'raw UTF-8 puts U+E000 before U+10000, unlike UTF-16 lexical order',
  );
  for (const invalid of [
    { channel: 'slack', labels: ['channel-1'], includeSpamTrash: false },
    { channel: 'gmail', labels: [], includeSpamTrash: false },
    { channel: 'gmail', labels: ['a', 'a'], includeSpamTrash: false },
    { channel: 'gmail', labels: ['é', 'a'], includeSpamTrash: false },
    { channel: 'gmail', labels: ['INBOX'], includeSpamTrash: false },
    { channel: 'gmail', labels: 'unknown', includeSpamTrash: false },
  ]) {
    assert.throws(() => normaliseGmailSourceOptions(invalid), /source option|Gmail|label/i);
  }
});

test('D2/D4: Gmail selector and spam-trash changes classify every narrowing and loosening precisely', () => {
  const cases: ReadonlyArray<readonly [GmailSourceOptions, GmailSourceOptions, 'same' | 'tightening' | 'loosening']> = [
    [inbox, inbox, 'same'],
    [any, inbox, 'tightening'],
    [inbox, any, 'loosening'],
    [labels(['label-a', 'label-b']), labels(['label-a']), 'tightening'],
    [labels(['label-a']), labels(['label-a', 'label-b']), 'loosening'],
    [inbox, labels(['label-a']), 'loosening'],
    [labels(['label-a']), inbox, 'loosening'],
    [labels(['label-a']), labels(['label-a'], true), 'loosening'],
    [labels(['label-a'], true), labels(['label-a']), 'tightening'],
    [any, labels(['label-a'], true), 'loosening'],
  ];
  for (const [before, after, expected] of cases) {
    assert.equal(
      classifyGmailSourceOptionChange(before, after),
      expected,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
  }
});
