import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isKeptSenderDomain, senderDomainOf } from '../src/domain/sender-domain.ts';

/*
 * 0.33.0 design §3.3: Analyse counts a judge's answers per sending domain. The domain is kept only when it is already a
 * plain lowercase ASCII hostname, as `domainIs` compares one, so what is kept is letters, digits, hyphens and dots.
 */

const RECEIVED = ['gmail.message.received', 1] as const;

test('SENDER-DOMAIN: only a plain ASCII hostname from the From address is kept', () => {
  for (const [address, expected] of [
    ['someone@billing.shop.example', 'billing.shop.example'],
    ['"quoted@odd"@example.test', 'example.test'],
    ['someone@EXAMPLE.test', null],
    ['someone@xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['someone@bücher.example', null],
    ['someone@localhost', null],
    ['someone@-bad.example', null],
    ['someone@bad-.example', null],
    ['someone@exa mple.test', null],
    ['someone@example.test>', null],
    ['someone@', null],
    ['@example.test', null],
    ['no-at-sign', null],
    [`someone@${'a'.repeat(64)}.example`, null],
  ] as const)
    assert.equal(senderDomainOf(...RECEIVED, { from: { address } }), expected, address);
  assert.equal(senderDomainOf(...RECEIVED, {}), null, 'a projection without the address');
  assert.equal(senderDomainOf(...RECEIVED, { from: { address: 42 } }), null);
  assert.equal(
    senderDomainOf('slack.message.posted', 1, { from: { address: 'someone@example.test' } }),
    null,
    'an event type with no From address',
  );
  assert.equal(senderDomainOf('unknown.event', 1, { from: { address: 'someone@example.test' } }), null);
  assert.equal(isKeptSenderDomain(`${'a.'.repeat(126)}ab`), false, 'longer than 253');
});
