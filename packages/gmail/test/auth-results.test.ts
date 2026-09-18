import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAuthResults, readSenderWarnings } from '../src/domain/auth-results.ts';

const GOOGLE =
  'mx.google.com; dkim=pass header.i=@partner.test header.d=partner.test; spf=pass smtp.mailfrom=sam@partner.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=partner.test';

test('only Google’s own verdict is read; a forged header in the message is ignored', () => {
  const headers = [
    // A sender can put this in the message body-headers; it looks exactly like the real thing.
    { name: 'Authentication-Results', value: 'mx.google.com.evil.test; dkim=pass; spf=pass; dmarc=pass' },
    { name: 'Authentication-Results', value: GOOGLE },
    { name: 'Authentication-Results', value: 'internal.relay.test; dkim=fail' },
    { name: 'From', value: 'Sam Lee <sam@partner.test>' },
  ];
  const results = readAuthResults(headers, 'Sam Lee <sam@partner.test>');
  assert.equal(results.evaluatedBy, 'mx.google.com');
  assert.equal(results.spf, 'pass');
  assert.equal(results.dkim, 'pass');
  assert.equal(results.dkimDomain, 'partner.test');
  assert.equal(results.dmarc, 'pass');
  assert.equal(results.aligned, true);
  assert.equal(results.ignoredHeaders, 2);
});

test('a message with no verdict from Google says so, rather than reporting a pass', () => {
  const results = readAuthResults([{ name: 'Authentication-Results', value: 'evil.test; dkim=pass; dmarc=pass' }], 'a@b.test');
  assert.equal(results.evaluatedBy, null);
  assert.equal(results.dkim, null);
  assert.equal(results.dmarc, null);
  assert.equal(results.aligned, null);
  assert.equal(results.ignoredHeaders, 1);
});

test('DKIM alignment compares the signed domain with the From domain', () => {
  const signedElsewhere = readAuthResults(
    [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=mailer.test; spf=pass; dmarc=fail' }],
    'Sam <sam@partner.test>',
  );
  assert.equal(signedElsewhere.aligned, false, 'signed by a different domain than it claims to be from');

  const subdomain = readAuthResults(
    [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=partner.test' }],
    'Sam <sam@mail.partner.test>',
  );
  assert.equal(subdomain.aligned, true);

  const failed = readAuthResults([{ name: 'Authentication-Results', value: 'mx.google.com; dkim=fail' }], 'a@b.test');
  assert.equal(failed.aligned, null, 'nothing to align when DKIM did not pass');
});

test('the two sender tricks that mislead a reader are reported as facts', () => {
  const lookalike = readSenderWarnings('"billing@yourbank.test" <attacker@evil.test>', undefined);
  assert.equal(lookalike.displayNameContainsOtherAddress, true);
  assert.equal(lookalike.fromDomain, 'evil.test');
  assert.equal(lookalike.replyToDiffers, false);

  const redirected = readSenderWarnings('Sam <sam@partner.test>', 'accounts@other.test');
  assert.equal(redirected.replyToDiffers, true);
  assert.deepEqual(redirected.replyToDomains, ['other.test']);

  const ordinary = readSenderWarnings('Sam Lee <sam@partner.test>', 'Sam Lee <sam@partner.test>');
  assert.equal(ordinary.replyToDiffers, false);
  assert.equal(ordinary.displayNameContainsOtherAddress, false);

  // A display name repeating the sender's own address is not a trick.
  const honest = readSenderWarnings('"sam@partner.test" <sam@partner.test>', undefined);
  assert.equal(honest.displayNameContainsOtherAddress, false);
});
