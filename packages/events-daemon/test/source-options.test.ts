import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyGmailSourceOptionChange,
  classifySourceOptionChange,
  type GmailSourceOptions,
  normaliseGmailSourceOptions,
  normaliseResendSourceOptions,
  normaliseSlackSourceOptions,
  normaliseSourceOptions,
  normaliseWhatsAppSourceOptions,
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

test('D4: every Phase-D source option has one strict canonical variant', () => {
  const slack = { channel: 'slack', conversations: ['C00000001', 'C00000002'] } as const;
  const resend = { channel: 'resend', kinds: ['received', 'status'] } as const;
  const whatsapp = { channel: 'whatsapp', chats: ['120363000000001@g.us', '15550000001@s.whatsapp.net'] } as const;

  assert.deepEqual(normaliseSlackSourceOptions(slack), slack);
  assert.deepEqual(normaliseResendSourceOptions(resend), resend);
  assert.deepEqual(normaliseWhatsAppSourceOptions(whatsapp), whatsapp);
  assert.deepEqual(normaliseWhatsAppSourceOptions({ channel: 'whatsapp', chats: 'all-allowed' }), {
    channel: 'whatsapp',
    chats: 'all-allowed',
  });

  const invalid: readonly unknown[] = [
    { channel: 'slack', conversations: [] },
    { channel: 'slack', conversations: ['C00000001', 'C00000001'] },
    { channel: 'slack', conversations: ['C00000002', 'C00000001'] },
    { channel: 'slack', conversations: [''] },
    { channel: 'resend', kinds: [] },
    { channel: 'resend', kinds: ['received', 'received'] },
    { channel: 'resend', kinds: ['status', 'received'] },
    { channel: 'resend', kinds: ['sent'] },
    { channel: 'whatsapp', chats: [] },
    { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net', '15550000001@s.whatsapp.net'] },
    { channel: 'whatsapp', chats: ['15550000002@s.whatsapp.net', '15550000001@s.whatsapp.net'] },
    { channel: 'whatsapp', chats: [''] },
    { channel: 'whatsapp', chats: 'all_allowed' },
    { channel: 'whatsapp', chatJids: ['15550000001@s.whatsapp.net'] },
    { channel: 'slack', conversationIds: ['C00000001'] },
  ];
  for (const value of invalid) assert.throws(() => normaliseSourceOptions(value), /source|conversation|kind|chat/i);
});

test('D2/D4: the source-option dispatcher classifies only strict source subsets as tightenings', () => {
  const cases: ReadonlyArray<readonly [unknown, unknown, 'same' | 'tightening' | 'loosening']> = [
    [
      { channel: 'slack', conversations: ['C00000001', 'C00000002'] },
      { channel: 'slack', conversations: ['C00000001'] },
      'tightening',
    ],
    [
      { channel: 'slack', conversations: ['C00000001'] },
      { channel: 'slack', conversations: ['C00000001', 'C00000002'] },
      'loosening',
    ],
    [
      { channel: 'slack', conversations: ['C00000001', 'C00000002'] },
      { channel: 'slack', conversations: ['C00000001', 'C00000003'] },
      'loosening',
    ],
    [{ channel: 'resend', kinds: ['received', 'status'] }, { channel: 'resend', kinds: ['received'] }, 'tightening'],
    [{ channel: 'resend', kinds: ['received'] }, { channel: 'resend', kinds: ['received', 'status'] }, 'loosening'],
    [
      { channel: 'whatsapp', chats: 'all-allowed' },
      { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net'] },
      'tightening',
    ],
    [
      { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net'] },
      { channel: 'whatsapp', chats: 'all-allowed' },
      'loosening',
    ],
    [
      { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net', '15550000002@s.whatsapp.net'] },
      { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net'] },
      'tightening',
    ],
    [
      { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net'] },
      { channel: 'whatsapp', chats: ['15550000001@s.whatsapp.net', '15550000002@s.whatsapp.net'] },
      'loosening',
    ],
  ];
  for (const [before, after, expected] of cases) {
    assert.equal(
      classifySourceOptionChange(before, after),
      expected,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
  }
  assert.throws(
    () =>
      classifySourceOptionChange(
        { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
        { channel: 'slack', conversations: ['C00000001'] },
      ),
    /same channel|source/i,
  );
});
