import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CATALOGUE,
  canonicalRiskFlags,
  normaliseResendBody,
  RESEND_BODY_MAX_CODE_POINTS,
  sourceSchema,
  validateEvent,
} from '../src/index.ts';

const definition = CATALOGUE[4];
if (!definition) throw new Error('missing Resend received definition');
const minimal = definition.examples[0];
if (!minimal) throw new Error('missing Resend received example');

test('CAT-r1, CAT-r2 and CAT-r3: Resend flags are canonical and body limits count code points', () => {
  const accepted = {
    ...minimal,
    attachments: [
      {
        id: 'attachment',
        filename: 'safe.svg',
        contentType: null,
        size: null,
        inline: false,
        riskFlags: ['html-or-svg'],
      },
    ],
    attachmentCount: 1,
  };
  const acceptedAttachment = accepted.attachments[0];
  if (!acceptedAttachment) throw new Error('missing accepted attachment');
  assert.equal(validateEvent(definition, accepted).ok, true);
  const ordered = {
    ...accepted,
    attachments: [
      {
        ...acceptedAttachment,
        filename: 'safe\u200b.svg',
        riskFlags: ['hidden-characters-in-name', 'html-or-svg'],
      },
    ],
  };
  const orderedAttachment = ordered.attachments[0];
  if (!orderedAttachment) throw new Error('missing ordered attachment');
  assert.equal(validateEvent(definition, ordered).ok, true);
  const reversed = {
    ...ordered,
    attachments: [{ ...orderedAttachment, riskFlags: ['html-or-svg', 'hidden-characters-in-name'] }],
  };
  assert.equal(validateEvent(definition, reversed).ok, false);
  const reversedAttachment = reversed.attachments[0];
  if (!reversedAttachment) throw new Error('missing reversed attachment');
  assert.deepEqual(canonicalRiskFlags(reversedAttachment.riskFlags), ['hidden-characters-in-name', 'html-or-svg']);
  assert.equal(
    (sourceSchema(definition).properties as { body: { maxLength: number } }).body.maxLength,
    RESEND_BODY_MAX_CODE_POINTS,
  );
  assert.equal(
    validateEvent(definition, { ...minimal, body: '😀'.repeat(RESEND_BODY_MAX_CODE_POINTS), bodyTruncated: false }).ok,
    true,
  );
});

test('CAT-r4, CAT-r5, CAT-r6, CAT-r7 and CAT-r8: body normalisation preserves truncation and rejects malformed pairs', () => {
  const capped = normaliseResendBody({ text: 'a'.repeat(25_000).slice(0, 20_000), truncated: true });
  assert.equal(capped.body.length, 20_000);
  assert.equal(capped.bodyTruncated, true);
  assert.equal(normaliseResendBody({ text: '😀'.repeat(10_000), truncated: false }).bodyTruncated, false);
  assert.equal(normaliseResendBody({ text: `${'a'.repeat(19_999)}\ud83d`, truncated: true }).body.length, 19_999);
  assert.throws(() => normaliseResendBody({ text: `x\ud83dy`, truncated: false }));
  assert.equal(validateEvent(definition, { ...minimal, body: 'a'.repeat(20_001), bodyTruncated: false }).ok, false);
  assert.equal(validateEvent(definition, { ...minimal, body: 'body' }).ok, false);
  assert.equal(validateEvent(definition, { ...minimal, bodyTruncated: false }).ok, false);
});
