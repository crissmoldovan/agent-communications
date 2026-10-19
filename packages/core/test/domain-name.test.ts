import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normaliseMailConversation } from '../src/behaviour.ts';
import { asciiDomainName, decodePunycode, isAsciiDomainName } from '../src/domain-name.ts';

/*
 * Whether a behaviour rule's domain is one (0.22.0's six-platform dry run). Node's `domainToASCII` refuses `xn--a.test`
 * on Node 22.22 and 24.15 and accepts it on a later Node 24, so a rule naming it was unreadable, and its account allowed
 * nothing, on one runtime and read as written on another. These checks are core's own, the same on every Node.
 */

const text = (points: number[] | null): string | null => (points === null ? null : String.fromCodePoint(...points));

test('punycode decodes as RFC 3492’s own examples do', () => {
  for (const [encoded, decoded] of [
    ['egbpdaj6bu4bxfgehfvwxn', 'ليهمابتكلموشعربي؟'],
    ['ihqwcrb4cv8a8dqg056pqjye', '他们为什么不说中文'],
    ['3B-ww4c5e180e575a65lsy2b', '3年B組金八先生'],
    ['bcher-kva', 'bücher'],
    ['mnchen-3ya', 'münchen'],
    ['', ''],
  ] as const) {
    assert.equal(text(decodePunycode(encoded)), decoded, encoded);
  }
});

test('what is not punycode, or decodes to no Unicode scalar value, does not decode', () => {
  for (const [encoded, why] of [
    ['-', 'a delimiter with nothing before it is read as a digit, and is none'],
    ['a!b', 'a character that is no digit'],
    ['9', 'input that ends inside a number'],
    ['ü-a', 'a basic part outside ASCII'],
    ['ib9b', 'a surrogate (U+D800)'],
    ['9999z', 'past U+10FFFF'],
    ['99999999999999999999', 'overflow'],
  ] as const) {
    assert.equal(decodePunycode(encoded), null, `${encoded}: ${why}`);
  }
});

test('a domain name is letters, digits and hyphens in labels of 1–63, at most 253 in all', () => {
  const label = (length: number): string => 'a'.repeat(length);
  for (const domain of [
    'client.test',
    'eu.client.test',
    'CLIENT.Test',
    'a.b',
    '1.2.3.4',
    'x-y.test',
    `${label(63)}.test`,
    [label(63), label(63), label(63), label(61)].join('.'),
  ]) {
    assert.equal(isAsciiDomainName(domain), true, domain);
  }
  for (const [domain, why] of [
    ['', 'empty'],
    ['-x.test', 'a label starting with a hyphen'],
    ['x-.test', 'a label ending with a hyphen'],
    ['a_b.test', 'an underscore'],
    ['exa|mple.com', 'a character no name has'],
    ['a%b.test', 'a character no name has'],
    [`${label(64)}.test`, 'a label of 64'],
    [[label(63), label(63), label(63), label(62)].join('.'), '254 in all'],
    ['a..b', 'an empty label'],
    ['.a', 'an empty first label'],
    ['a.', 'a trailing dot: callers take one off first'],
    ['ab--c.test', '-- at the third and fourth characters, reserved for prefixes like xn--'],
    ['bücher.example', 'not ASCII'],
  ] as const) {
    assert.equal(isAsciiDomainName(domain), false, `${domain}: ${why}`);
  }
});

test('an xn-- label is a name only when it decodes to a Unicode label', () => {
  for (const domain of [
    'xn--bcher-kva.example',
    'XN--BCHER-KVA.EXAMPLE',
    'xn--mnchen-3ya.example',
    'xn--zca.test',
    'xn--compaa-7va5a.es',
    // Persian, with the zero-width non-joiner IDNA allows in context: the one format character a label may hold.
    'xn--mgbn2ecje63gr19l.test',
  ]) {
    assert.equal(isAsciiDomainName(domain), true, domain);
  }
  for (const [domain, why] of [
    ['xn--a.test', 'decodes to U+0080, a control'],
    ['xn--.test', 'decodes to nothing'],
    ['xn--ab.test', 'decodes to controls'],
    ['xn--abc-.test', 'ends with a hyphen, and is all ASCII'],
    ['xn--a-ecp.test', 'decodes to a⒈, which NFKC changes'],
    ['xn--a-wbb.test', 'decodes to a label starting with a combining mark'],
    ['xn--ab-11n.test', 'decodes to an Ogham space mark, a separator'],
    ['xn--a-so7g.test', 'decodes to a private-use character'],
    ['xn--ab-p1t.test', 'decodes to a left-to-right mark'],
    ['xn--9999z.test', 'decodes past U+10FFFF'],
  ] as const) {
    assert.equal(isAsciiDomainName(domain), false, `${domain}: ${why}`);
  }
});

test('a name is given in ASCII and lower case, from Unicode or from ASCII, and never when it is not one', () => {
  assert.equal(asciiDomainName('Bücher.EXAMPLE'), 'xn--bcher-kva.example');
  assert.equal(asciiDomainName('XN--BCHER-KVA.example'), 'xn--bcher-kva.example');
  assert.equal(asciiDomainName('MÜNCHEN.example'), 'xn--mnchen-3ya.example');
  assert.equal(asciiDomainName('Client.TEST'), 'client.test');
  for (const written of ['xn--a.test', 'bücher_x.example', 'exa|mple.com', '']) {
    assert.equal(asciiDomainName(written), null, written);
  }
});

test('a name in ASCII never reaches Node’s URL parser, so a Node that accepts more changes nothing', async (t) => {
  const url = (await import('node:url')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const asked: string[] = [];
  // As a later Node 24 does for `xn--a`, and more: this one accepts anything, and hands back what it was given.
  t.mock.method(url, 'domainToASCII', (domain: string) => {
    asked.push(domain);
    return domain.toLowerCase();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const conversation of ['bob@xn--a.test', '@xn--.test', '@xn--abc-.test', '@-x.test', '@a_b.test']) {
    assert.equal(normaliseMailConversation(conversation), null, conversation);
  }
  assert.equal(normaliseMailConversation('Kunde@XN--BCHER-KVA.example.'), 'kunde@xn--bcher-kva.example');
  assert.deepEqual(asked, [], 'nothing in ASCII was handed to it');
  // A name in Unicode still goes to it, and what it hands back is checked: here, Unicode, which is no ASCII name.
  assert.equal(normaliseMailConversation('kunde@bücher.example'), null);
  assert.deepEqual(asked, ['bücher.example']);
});
