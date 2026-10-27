// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALIAS_PATTERN } from '../../../../packages/core/src/config.ts';
import { APPROVAL_ID_PATTERN } from '../../../../packages/core/src/ids.ts';
import { NAME_PATTERN } from '../../../../packages/core/src/name-grammar.ts';
import * as label from '../../../../packages/core/src/operations/label.ts';
import { searchQueryText } from '../../../../packages/core/src/operations/search.ts';
import { SEARCH_HANDLE } from '../../../../packages/core/src/search/capture.ts';
import { searchEndpoint } from '../../../../packages/core/src/search/endpoint-rule.ts';
import { PERSON_ID } from '../../../../packages/core/src/search/store.ts';
import grammar from '../../grammar.json';
import {
  isAccountName,
  isActs,
  isApprovalId,
  isConversation,
  isDeliveryId,
  isLaneName,
  isPersonId,
  isPersonLabel,
  isPlainValue,
  isQueueItemId,
  isRuleId,
  isSearchHandle,
  isSearchModelAddress,
  isSearchQuery,
  isSessionKey,
  isWindowId,
  refusedInSearchText,
} from '../grammar.ts';
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

  it("a queue item's id is qi_ and 26 of Crockford's letters: core's approval-id alphabet, the event service's prefix", () => {
    // The event service's queue is Task A's of 0.30.0 (design 2026-10-25-action-queue §8): its id is the contract's,
    // `qi_` and 26 of Crockford's letters, the same alphabet core's ids are made of.
    const crockford = APPROVAL_ID_PATTERN.source.replace(/^\^ap_/, '');
    expect(new RegExp(`^qi_${crockford}`, 'u').source).toBe(new RegExp(grammar.queueItemId, 'u').source);
    for (const good of [
      'qi_0123456789ABCDEFGHJKMNPQRS',
      'qi_ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      'qi_01J9Z8QF0000000000000000AB',
    ]) {
      expect(isQueueItemId(good), good).toBe(true);
    }
    for (const bad of [
      '',
      'qi_',
      'qi_0123456789ABCDEFGHJKMNPQR',
      'qi_0123456789ABCDEFGHJKMNPQRST',
      'qi_0123456789ABCDEFGHIJKMNPQR',
      'qi_0123456789ABCDEFGHJKLMNPQR',
      'qi_0123456789ABCDEFGHJKMNOPQR',
      'qi_0123456789ABCDEFGHJKMNPQRU',
      'qi_0123456789abcdefghjkmnpqrs',
      'QI_0123456789ABCDEFGHJKMNPQRS',
      'ap_0123456789ABCDEFGHJKMNPQRS',
      'qi_0123456789ABCDEFGHJKMNPQRS\n',
      'qi_0123456789ABCDEFGHJKMNPQRS --json',
      ' qi_0123456789ABCDEFGHJKMNPQRS',
    ]) {
      expect(isQueueItemId(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const value of CORPUS) expect(isQueueItemId(value), value).toBe(false);
  });

  it("a rule's id the Queue screen filters by is a word of letters, digits and ._:@-, as Rust checks it", () => {
    for (const good of ['rule-1', 'mail-asks', 'David_on_Slack', 'rule.v2', 'team:rule@1', 'r', 'r'.repeat(128)]) {
      expect(isRuleId(good), good).toBe(true);
    }
    for (const bad of [
      '',
      '-rule',
      '--json',
      '.rule',
      '_rule',
      'rule 1',
      'rule/1',
      'rule\\1',
      'rule\n',
      'rule\u202e',
      'rule\u200b',
      'r\u00e9gle',
      'rule;rm',
      'rule$(x)',
      'r'.repeat(129),
    ]) {
      expect(isRuleId(bad), JSON.stringify(bad)).toBe(false);
    }
    // The Rust side tries the same words (`grammar.rs`, `rule_ids_are_a_word_of_letters_digits_and_a_few_marks`).
    const rust = readFileSync(fileURLToPath(new URL('../../src-tauri/src/grammar.rs', import.meta.url)), 'utf8');
    expect(rust).toContain('pub fn rule_id(value: &str) -> bool');
    expect(rust).toContain('pub fn queue_item_id(value: &str) -> bool');
  });

  it("a lane's name is 1 to 40 lowercase letters, digits and -, and never read as an option", () => {
    // The event service's lane grammar (design 2026-10-25-routing §3.1): `[a-z0-9-]{1,40}`.
    expect(new RegExp(grammar.laneName, 'u').source).toBe(/^[a-z0-9-]{1,40}$/u.source);
    for (const good of ['david', 'billing', 'david-on-slack', 'a', '0', 'lane-2', 'x'.repeat(40)]) {
      expect(isLaneName(good), good).toBe(true);
    }
    for (const bad of [
      '',
      '-david',
      '--json',
      'David',
      'DAVID',
      'david_slack',
      'david.slack',
      'david slack',
      'david/slack',
      'david\\slack',
      'david\n',
      'david\u202e',
      'david\u200b',
      'd\u00e9vid',
      'david;rm',
      'david$(x)',
      'david --window 3f9a1c2e7b4d5a60',
      'x'.repeat(41),
    ]) {
      expect(isLaneName(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const value of CORPUS) {
      if (!/^[a-z0-9-]{1,40}$/.test(value) || value.startsWith('-')) expect(isLaneName(value), value).toBe(false);
    }
  });

  it("a window's id is a lowercase UUID, as Claude Code names a session, or an activity key", () => {
    for (const good of [
      '3f9a1c2e7b4d5a60',
      '0000000000000000',
      '0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(isWindowId(good), good).toBe(true);
    }
    for (const bad of [
      '',
      '3f9a1c2e7b4d5a6',
      '3f9a1c2e7b4d5a600',
      '3F9A1C2E7B4D5A60',
      '0F8B5C3E-2D41-4A7E-9C11-5B2E8D7F6A90',
      '0f8b5c3e2d414a7e9c115b2e8d7f6a90',
      '{0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90}',
      '0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a9',
      '0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90 --json',
      '-f9a1c2e7b4d5a60',
      '3f9a1c2e7b4d5a60\n',
      '3f9a1c2e7b4d5a6g',
      '../3f9a1c2e7b4d5',
      'david',
    ]) {
      expect(isWindowId(bad), JSON.stringify(bad)).toBe(false);
    }
    // Every activity key core makes is a window id.
    expect(isWindowId('3f9a1c2e7b4d5a60')).toBe(isSessionKey('3f9a1c2e7b4d5a60'));
    // The Rust side tries the same words (`grammar.rs`, `lane_names_…` and `window_ids_…`).
    const rust = readFileSync(fileURLToPath(new URL('../../src-tauri/src/grammar.rs', import.meta.url)), 'utf8');
    expect(rust).toContain('pub fn lane_name(value: &str) -> bool');
    expect(rust).toContain('pub fn window_id(value: &str) -> bool');
  });

  it("a delivery's id is a word of letters, digits, _ and -: the event service's UUIDs, never an option", () => {
    for (const good of ['0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70', 'dlv_example_1', 'D', '7', 'd'.repeat(128)]) {
      expect(isDeliveryId(good), good).toBe(true);
    }
    for (const bad of [
      '',
      '-dlv',
      '--json',
      '_dlv',
      'dlv.1',
      'dlv:1',
      'dlv@1',
      'dlv/1',
      '../dlv',
      'dlv 1',
      'dlv_1 --json',
      'dlv_1\n',
      'dlv_1‮',
      'dlv_1​',
      ' dlv_1',
      'délivery',
      'd'.repeat(129),
    ]) {
      expect(isDeliveryId(bad), JSON.stringify(bad)).toBe(false);
    }
    // The Rust side tries the same words (`grammar.rs`, `delivery_ids_are_a_word_of_letters_digits_underscores_…`).
    const rust = readFileSync(fileURLToPath(new URL('../../src-tauri/src/grammar.rs', import.meta.url)), 'utf8');
    expect(rust).toContain('pub fn delivery_id(value: &str) -> bool');
  });

  it("Search's ids, handles and model address are core's (0.35.0, design 2026-10-26-local-search §8)", () => {
    const people = [
      'p_K19FVJ41QS08HPWN3XC3RQ2K7B',
      'p_0123456789ABCDEFGHJKMNPQRS',
      'p_0123456789ABCDEFGHJKMNPQR',
      'p_0123456789ABCDEFGHJKMNPQRST',
      'p_0123456789ABCDEFGHIJKMNPQR',
      'p_0123456789abcdefghjkmnpqrs',
      'P_0123456789ABCDEFGHJKMNPQRS',
      'p_',
      ...CORPUS,
    ];
    for (const value of people) expect(isPersonId(value), JSON.stringify(value)).toBe(PERSON_ID.test(value));
    const handles = [
      'email:david@example.com',
      'email:first.last+tag@example.co.uk',
      'email:dávid@exämple.ro',
      'slack:T0ACME/U0DAVID',
      'slack:E0GRID/W0ABC',
      'email:',
      'email:david',
      'email:a@b@c',
      'email:<david@example.com>',
      'email:david@example.com ',
      'email:da vid@example.com',
      'slack:T0ACME',
      'slack:t0acme/u0david',
      'slack:T0ACME/U0DAVID/x',
      'david@example.com',
      ...CORPUS,
    ];
    for (const value of handles) expect(isSearchHandle(value), JSON.stringify(value)).toBe(SEARCH_HANDLE.test(value));
    const takes = (value: string): boolean => {
      try {
        searchEndpoint(value);
        return true;
      } catch {
        return false;
      }
    };
    for (const value of [
      'http://127.0.0.1:11434',
      'http://127.0.0.1:11434/',
      'http://[::1]:8080',
      'http://127.0.0.1:65535',
      'http://127.0.0.1:1',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://127.0.0.1:011434',
      'http://localhost:11434',
      'https://127.0.0.1:11434',
      'http://192.168.1.20:11434',
      'http://[::2]:11434',
      'http://127.0.0.1:11434/v1/systemone',
      'http://127.0.0.1:11434/api/embed',
      'http://user@127.0.0.1:11434',
      'http://127.0.0.1:11434?x',
      'http://127.0.0.1:11434#x',
      '',
    ]) {
      expect(isSearchModelAddress(value), JSON.stringify(value)).toBe(takes(value));
    }
  });

  it("a search's words and a person's label refuse exactly the characters core refuses in them, at every code point", () => {
    // Core refuses a C0 control (a line break and a tab among them) and anything `chars.ts` calls dangerous.
    const coreTakes = (value: string): boolean => {
      try {
        searchQueryText(value);
        return true;
      } catch {
        return false;
      }
    };
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      if (refusedInSearchText(char) === coreTakes(`a${char}b`)) {
        throw new Error(`U+${code.toString(16)}: the app and core disagree`);
      }
    }
    for (const good of ['invoices', '-draft', '--json', 'factură', ' invoices ', 'é'.repeat(500)]) {
      expect(isSearchQuery(good), good).toBe(true);
      expect(coreTakes(good), good).toBe(true);
    }
    for (const bad of ['', '   ', 'a\nb', 'a\tb', 'a\u202eb', 'a\u200bb', 'a\u2028b', 'é'.repeat(501)]) {
      expect(isSearchQuery(bad), JSON.stringify(bad)).toBe(false);
      expect(coreTakes(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of ['David', 'David Park', '-dash', 'd'.repeat(80)]) expect(isPersonLabel(good), good).toBe(true);
    for (const bad of ['', ' David', 'David ', 'Da\nvid', 'Da\u202evid', 'd'.repeat(81)]) {
      expect(isPersonLabel(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the Rust side reads the same file', () => {
    const rust = readFileSync(fileURLToPath(new URL('../../src-tauri/src/grammar.rs', import.meta.url)), 'utf8');
    expect(rust).toContain('include_str!("../../grammar.json")');
  });
});
