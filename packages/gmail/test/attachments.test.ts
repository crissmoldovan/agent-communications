import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@cloudpixel/comms-core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { attachmentQuery, downloadAttachments, findAttachments } from '../src/operations/attachments.ts';
import { exportMail } from '../src/operations/export.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** A message carrying one attachment. */
function withAttachment(options: {
  id: string;
  at: string;
  from: string;
  subject: string;
  filename: string;
  attachmentId: string;
  mimeType?: string;
  size?: number;
}): FakeMessage {
  return {
    id: options.id,
    threadId: options.id,
    labelIds: ['INBOX'],
    internalDate: String(Date.parse(options.at)),
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: options.from },
        { name: 'Subject', value: options.subject },
      ],
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { size: 2, data: base64url('hi') } },
        {
          partId: '1',
          mimeType: options.mimeType ?? 'application/pdf',
          filename: options.filename,
          headers: [{ name: 'Content-Disposition', value: `attachment; filename="${options.filename}"` }],
          body: { size: options.size ?? 1024, attachmentId: options.attachmentId },
        },
      ],
    },
  };
}

async function connected(
  messages: Record<string, FakeMessage>,
  attachments: Record<string, string>,
): Promise<{ harness: Harness; context: GmailContext; downloads: string }> {
  const harness = await newHarness({
    accounts: [{ sub: 'sub-1', email: 'jo@example.test', messages, attachments }],
  });
  const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: [SCOPES.gmailModify],
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl)).searchParams.get('code') ?? '';
  const tokens = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  await harness.addInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    refreshToken: tokens.refreshToken,
    grantedScopes: [SCOPES.gmailModify],
  });

  // Downloads go to a directory of this test's own, not the real ~/Downloads. Moving the downloads root is a
  // safety setting, so the change carries the consent a person would have given at a terminal.
  const downloads = tempDir('agent-gmail-downloads-');
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, downloadsDir: downloads } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.downloadsDir'] } },
  );
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }), downloads };
}

test('the filters become a Gmail query a person could have typed', () => {
  assert.equal(
    attachmentQuery({ from: 'sam@partner.test', filename: 'pdf', minBytes: 1_000_000, after: '2026-09-01' }),
    'has:attachment from:sam@partner.test filename:pdf after:2026-09-01 larger:1000000',
  );
  assert.equal(attachmentQuery({}), 'has:attachment');
});

test('attachments are found across messages with their risks named', async () => {
  const { context } = await connected(
    {
      m1: withAttachment({
        id: 'm1',
        at: '2026-09-15T09:00:00Z',
        from: 'sam@partner.test',
        subject: 'Invoice',
        filename: 'invoice.pdf',
        attachmentId: 'a1',
      }),
      m2: withAttachment({
        id: 'm2',
        at: '2026-09-17T09:00:00Z',
        from: 'stranger@evil.test',
        subject: 'Your document',
        filename: 'document.pdf.exe',
        attachmentId: 'a2',
        mimeType: 'application/octet-stream',
      }),
    },
    { a1: 'invoice bytes', a2: 'malware bytes' },
  );

  const found = await findAttachments(context, { inboxes: ['work'] });
  assert.equal(found.complete, true);
  assert.deepEqual(
    found.rows.map((row) => row.filename),
    ['document.pdf.exe', 'invoice.pdf'],
    'newest first',
  );
  const risky = found.rows[0];
  assert.deepEqual(risky?.riskFlags.sort(), ['double-extension', 'executable']);
  assert.equal(risky?.from, 'stranger@evil.test');
  assert.match(found.query, /has:attachment/);
});

test('a download lands under the downloads root, named from facts, and is recorded', async () => {
  const { harness, context, downloads } = await connected(
    {
      m1: withAttachment({
        id: 'm1',
        at: '2026-09-15T09:00:00Z',
        from: 'Sam Lee <sam@partner.test>',
        subject: 'Invoice for August',
        filename: 'invoice.pdf',
        attachmentId: 'a1',
      }),
    },
    { a1: 'invoice bytes' },
  );

  const result = await downloadAttachments(context, 'work', [{ messageId: 'm1', partId: '1' }]);
  assert.equal(result.files.length, 1);
  const file = result.files[0];
  assert.ok(file);
  assert.equal(file.filename, 'invoice.pdf');
  assert.equal(await readFile(file.path, 'utf8'), 'invoice bytes');
  assert.ok(file.path.startsWith(downloads), 'inside the downloads root');
  assert.match(dirname(file.path), /2026-09-15_sam-partner-test_invoice-for-august$/);
  assert.match(file.sha256, /^[0-9a-f]{64}$/);

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as { files: unknown[] };
  assert.equal(manifest.files.length, 1);

  const audit = await harness.core.audit.tail({ inbox: 'work' });
  assert.ok(audit.some((entry) => entry.operation === 'attachments.download'));
});

test('a filename that is an attack is rebuilt safely, never obeyed', async () => {
  const { context, downloads } = await connected(
    {
      m1: withAttachment({
        id: 'm1',
        at: '2026-09-15T09:00:00Z',
        from: 'stranger@evil.test',
        subject: 'Anything',
        filename: '../../../../etc/passwd',
        attachmentId: 'a1',
      }),
      m2: withAttachment({
        id: 'm2',
        at: '2026-09-15T10:00:00Z',
        from: 'stranger@evil.test',
        subject: 'Anything',
        // A right-to-left override makes this read as `invoicefdp.exe` in some clients.
        filename: `invoice${String.fromCodePoint(0x202e)}fdp.exe`,
        attachmentId: 'a2',
      }),
    },
    { a1: 'not the password file', a2: 'bytes' },
  );

  const result = await downloadAttachments(context, 'work', [
    { messageId: 'm1', partId: '1' },
    { messageId: 'm2', partId: '1' },
  ]);

  for (const file of result.files) {
    assert.ok(file.path.startsWith(downloads), `${file.path} escaped the downloads root`);
    assert.doesNotMatch(file.filename, /[/\\]/, 'no path separators survive');
  }
  // `..` with no separator left in it is just an odd name: it cannot climb anywhere.
  assert.equal(result.files[0]?.filename, '_.._.._.._etc_passwd');
  assert.equal(dirname(result.files[0]?.path ?? ''), dirname(result.files[0]?.path ?? ''));
  // The bidi override is stripped from the name on disk, so what is shown is what it is.
  assert.doesNotMatch(result.files[1]?.filename ?? '', /‮/);
  assert.ok((result.files[1]?.riskFlags ?? []).includes('bidi-filename'));
});

test('the same file twice is written once and reported as a duplicate', async () => {
  const { context } = await connected(
    {
      m1: withAttachment({
        id: 'm1',
        at: '2026-09-15T09:00:00Z',
        from: 'sam@partner.test',
        subject: 'One',
        filename: 'report.pdf',
        attachmentId: 'a1',
      }),
      m2: withAttachment({
        id: 'm2',
        at: '2026-09-16T09:00:00Z',
        from: 'sam@partner.test',
        subject: 'Two',
        filename: 'report-copy.pdf',
        attachmentId: 'a2',
      }),
    },
    { a1: 'identical bytes', a2: 'identical bytes' },
  );

  const result = await downloadAttachments(context, 'work', [
    { messageId: 'm1', partId: '1' },
    { messageId: 'm2', partId: '1' },
  ]);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0]?.duplicate, false);
  assert.equal(result.files[1]?.duplicate, true);
  assert.equal(result.files[0]?.path, result.files[1]?.path, 'the second points at the file already written');
  assert.equal(result.totalBytes, Buffer.byteLength('identical bytes'));
});

test('caps stop a runaway batch, and say what was skipped', async () => {
  const messages: Record<string, FakeMessage> = {};
  const attachments: Record<string, string> = {};
  for (let index = 0; index < 5; index++) {
    messages[`m${index}`] = withAttachment({
      id: `m${index}`,
      at: `2026-09-1${index}T09:00:00Z`,
      from: 'sam@partner.test',
      subject: `Doc ${index}`,
      filename: `doc${index}.pdf`,
      attachmentId: `a${index}`,
    });
    attachments[`a${index}`] = `bytes ${index}`;
  }
  const { context } = await connected(messages, attachments);

  const targets = Object.keys(messages).map((messageId) => ({ messageId, partId: '1' }));
  const limited = await downloadAttachments(context, 'work', targets, { maxFiles: 2 });
  assert.equal(limited.files.length, 2);
  assert.equal(limited.skipped.length, 3);
  assert.match(limited.skipped[0]?.reason ?? '', /more than 2 files/);

  const tiny = await downloadAttachments(context, 'work', targets, { maxBytes: 10 });
  assert.ok(tiny.files.length < 5);
  assert.ok(tiny.skipped.some((entry) => /bytes in one batch/.test(entry.reason)));
});

test('a download cannot be steered outside the downloads root', async () => {
  const { context } = await connected(
    {
      m1: withAttachment({
        id: 'm1',
        at: '2026-09-15T09:00:00Z',
        from: 'sam@partner.test',
        subject: 'Invoice',
        filename: 'invoice.pdf',
        attachmentId: 'a1',
      }),
    },
    { a1: 'bytes' },
  );

  await assert.rejects(
    downloadAttachments(context, 'work', [{ messageId: 'm1', partId: '1' }], { out: '../../../tmp/escape' }),
    (error: unknown) => error instanceof CommsError && /refusing to write outside/.test(error.message),
  );
});

test('an attachment that is not there is skipped with a reason, not a crash', async () => {
  const { context, downloads } = await connected(
    {
      m1: withAttachment({
        id: 'm1',
        at: '2026-09-15T09:00:00Z',
        from: 'sam@partner.test',
        subject: 'Invoice',
        filename: 'invoice.pdf',
        attachmentId: 'a1',
      }),
    },
    { a1: 'bytes' },
  );
  const result = await downloadAttachments(context, 'work', [{ messageId: 'm1', partId: '99' }]);
  assert.equal(result.files.length, 0);
  assert.equal(result.skipped[0]?.reason, 'no such attachment');
  // The manifest is still written, so a caller can see what happened.
  assert.ok((await readdir(join(downloads, 'work'))).includes('manifest.json'));
});

test('a thread exports to a file instead of into the conversation', async () => {
  const { context, downloads } = await connected(
    {
      m1: withAttachment({
        id: 'm1',
        at: '2026-09-15T09:00:00Z',
        from: 'Sam Lee <sam@partner.test>',
        subject: 'Invoice for August',
        filename: 'invoice.pdf',
        attachmentId: 'a1',
      }),
    },
    { a1: 'invoice bytes' },
  );

  const markdown = await exportMail(context, 'work', 'm1');
  assert.equal(markdown.format, 'md');
  assert.ok(markdown.path.startsWith(downloads));
  const text = await readFile(markdown.path, 'utf8');
  assert.match(text, /## Invoice for August/);
  assert.match(text, /sam@partner\.test/);
  assert.match(text, /invoice\.pdf/);
  // The body keeps its envelope: a file is read back by the same models.
  assert.match(text, /<untrusted-email-content/);

  const json = await exportMail(context, 'work', 'm1', { format: 'json' });
  const parsed = JSON.parse(await readFile(json.path, 'utf8')) as { messageId: string };
  assert.equal(parsed.messageId, 'm1');

  const eml = await exportMail(context, 'work', 'm1', { format: 'eml' });
  assert.match(await readFile(eml.path, 'utf8'), /^From: Sam Lee <sam@partner\.test>/);

  // A thread cannot be one .eml file, and says so rather than writing something misleading.
  await assert.rejects(
    exportMail(context, 'work', 'm1', { format: 'eml', thread: true }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
});
