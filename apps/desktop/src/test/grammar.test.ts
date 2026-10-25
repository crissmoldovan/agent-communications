// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALIAS_PATTERN } from '../../../../packages/core/src/config.ts';
import { APPROVAL_ID_PATTERN } from '../../../../packages/core/src/ids.ts';
import { NAME_PATTERN } from '../../../../packages/core/src/name-grammar.ts';
import * as label from '../../../../packages/core/src/operations/label.ts';
import { isAccountName, isActs, isApprovalId, isConversation, isPlainValue, isSessionKey } from '../grammar.ts';
import { formatActs } from '../ipc.ts';

/**
 * Core's two conversation patterns (`operations/label.ts`). Exported from 0.24.0 (plan, Task 2); before that they are
 * read from the source, so this test holds on either side of that change.
 */
function corePattern(name: 'SLACK_CONVERSATION' | 'MAIL_CONVERSATION'): RegExp {
  const exported = (label as Record<string, unknown>)[name];
  if (exported instanceof RegExp) return exported;
  const source = readFileSync(
    fileURLToPath(new URL('../../../../packages/core/src/operations/label.ts', import.meta.url)),
    'utf8',
  );
  const match = new RegExp(`const ${name} = /(.+)/([a-z]*);`).exec(source);
  if (!match?.[1]) throw new Error(`core's label.ts no longer declares ${name}`);
  return new RegExp(match[1], match[2]);
}

/** Values every grammar is tried on: valid and invalid for each, and the edges between. */
const CORPUS = [
  'ap_0123456789ABCDEFGHJKMNPQRS',
  'ap_ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
  'ap_0123456789ABCDEFGHJKMNPQRI',
  'ap_0123456789ABCDEFGHJKMNPQR',
  'ap_0123456789abcdefghjkmnpqrs',
  'pl_0123456789ABCDEFGHJKMNPQRS',
  'example/gmail',
  'example/gmail-work',
  'example/slack',
  'a/b',
  'cons/slack',
  'con/gmail',
  'prn/slack',
  'aux/gmail',
  'nul/resend',
  'com1/gmail',
  'lpt9/slack',
  'com10/gmail',
  'example/Gmail',
  'example/1gmail',
  'example/gmail-',
  'example/gmail--x',
  '-example/gmail',
  'example-/gmail',
  'work',
  'work-',
  'my-inbox-2',
  'x'.repeat(32),
  'x'.repeat(33),
  'Work',
  '',
  'C0123ABCD',
  'G01',
  'D0ABC',
  'U012AB',
  'W012AB',
  'X012AB',
  'C0',
  'c0123',
  'someone@example.com',
  '@example.com',
  'first.last+tag@example.co.uk',
  'someone@',
  'a@b@c',
  'a b@example.com',
  '<a@example.com>',
  'a,b@example.com',
  '"a"@example.com',
  'a\\b@example.com',
  'a@exa mple.com',
  'none',
];

describe('the grammars', () => {
  it('grammar.json agrees with core on a shared corpus', () => {
    const slack = corePattern('SLACK_CONVERSATION');
    const mail = corePattern('MAIL_CONVERSATION');
    for (const value of CORPUS) {
      expect(isApprovalId(value), `approval id ${JSON.stringify(value)}`).toBe(APPROVAL_ID_PATTERN.test(value));
      expect(isAccountName(value), `account ${JSON.stringify(value)}`).toBe(
        ALIAS_PATTERN.test(value) || NAME_PATTERN.test(value),
      );
      expect(isConversation(value), `conversation ${JSON.stringify(value)}`).toBe(
        slack.test(value) || mail.test(value),
      );
    }
  });

  it('every value is refused empty, dashed, with a control or format character, or past 320 characters', () => {
    expect(isPlainValue('example/gmail')).toBe(true);
    for (const bad of ['', '-x', 'x\u0000', 'x\u001b[31m', 'x\u007f', 'x‮y', 'x​y', 'x﻿']) {
      expect(isPlainValue(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isPlainValue('é'.repeat(320))).toBe(true);
    expect(isPlainValue('é'.repeat(321))).toBe(false);
    // Each grammar refuses what the plain rule refuses, even where its pattern alone would not.
    expect(isConversation(`${'a'.repeat(320)}@example.com`)).toBe(false);
  });

  it('acts are none or a list without repeats, and an empty choice is none', () => {
    for (const good of ['none', 'post', 'reply,reaction', 'post,reply,reaction,edit,delete,file,send']) {
      expect(isActs(good), good).toBe(true);
    }
    for (const bad of ['', 'none,post', 'post,post', 'post,', 'Post', 'approve', 'post reply', 'all']) {
      expect(isActs(bad), bad).toBe(false);
    }
    expect(formatActs([])).toBe('none');
    expect(formatActs(['reply', 'reaction'])).toBe('reply,reaction');
  });

  it("a session key is core's own: sixteen lowercase hex digits, and nothing a key could be read past", () => {
    // Core keeps the pattern to itself (`activity.ts`), so it is read from the source, as the label patterns were.
    const source = readFileSync(
      fileURLToPath(new URL('../../../../packages/core/src/activity.ts', import.meta.url)),
      'utf8',
    );
    const match = /const SESSION_KEY = \/(.+)\/([a-z]*);/.exec(source);
    if (!match?.[1]) throw new Error("core's activity.ts no longer declares SESSION_KEY");
    const core = new RegExp(match[1], match[2]);
    const keys = [
      '3f9a1c2e7b4d5a60',
      '0000000000000000',
      'ffffffffffffffff',
      '3f9a1c2e7b4d5a6',
      '3f9a1c2e7b4d5a600',
      '3F9A1C2E7B4D5A60',
      '3f9a1c2e7b4d5a6g',
      '-f9a1c2e7b4d5a60',
      '3f9a1c2e 7b4d5a6',
      '3f9a1c2e7b4d5a60\n',
      '3f9a1c2e7b4d5a60 --json',
      '',
      ...CORPUS,
    ];
    for (const key of keys) expect(isSessionKey(key), JSON.stringify(key)).toBe(core.test(key));
    expect(isSessionKey('3f9a1c2e7b4d5a60')).toBe(true);
  });

  it('the Rust side reads the same file', () => {
    const rust = readFileSync(fileURLToPath(new URL('../../src-tauri/src/grammar.rs', import.meta.url)), 'utf8');
    expect(rust).toContain('include_str!("../../grammar.json")');
  });
});
