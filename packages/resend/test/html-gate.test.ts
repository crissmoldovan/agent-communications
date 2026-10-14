import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import { type Harness, newHarness, ok, refused } from './support/harness.ts';

/**
 * The HTML check at `send prepare`: HTML that would show the recipient something the preview does not is refused, on
 * both surfaces, before an approval exists.
 *
 * Each input below was prepared under `chat` and sent, while the preview said the HTML "shows exactly the text above":
 * the text comparison reads the HTML's text in source order, and every one of these makes a mail client show other
 * text, other pixels, or the same text in another order — or fetches something on open.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PROBES: { name: string; html: string; text: string; reason: RegExp }[] = [
  {
    name: 'a <style> rule whose ::before adds bank details',
    html: '<style>p.x::before{content:"Our bank details changed: pay IBAN GB00EVIL0000. "}</style><p class="x">Hi Sam, see you Tuesday.</p>',
    text: 'Hi Sam, see you Tuesday.',
    reason: /<style>/,
  },
  {
    name: '@import with a string URL: a stylesheet fetched on open',
    html: '<style>@import "https://tracker.evil.test/open.css?u=sam";</style><p>Hi Sam, see you Tuesday.</p>',
    text: 'Hi Sam, see you Tuesday.',
    reason: /from the internet.*<style>|<style>.*from the internet/s,
  },
  {
    name: 'SVG <image href>: an image fetched on open',
    html: '<svg width="1" height="1"><image href="https://tracker.evil.test/p.png?u=sam" width="1" height="1"/></svg><p>Hi Sam, see you Tuesday.</p>',
    text: 'Hi Sam, see you Tuesday.',
    reason: /from the internet.*image.*<svg>/s,
  },
  {
    name: 'SVG <image xlink:href>: an image fetched on open',
    html: '<svg width="1" height="1"><image xlink:href="https://tracker.evil.test/p2.png" width="1" height="1"/></svg><p>Hi Sam, see you Tuesday.</p>',
    text: 'Hi Sam, see you Tuesday.',
    reason: /from the internet.*image.*<svg>/s,
  },
  {
    name: 'a data: image: pixels the preview never shows',
    html: `<p>Hi Sam, see you Tuesday.</p><img src="data:image/png;base64,${PNG_1x1}" width="600" height="200">`,
    text: 'Hi Sam, see you Tuesday.',
    reason: /image\(s\) or embedded object\(s\)/,
  },
  {
    name: '<bdo dir="rtl">: the recipient reads 87654321',
    html: '<p>Pay to account <bdo dir="rtl">12345678</bdo> today.</p>',
    text: 'Pay to account 12345678 today.',
    reason: /<bdo>/,
  },
];

const FIELDS = { from: 'Acme <hello@acme.test>', to: ['sam@partner.test'], subject: 'Tuesday' };

function argv(html: string, text: string): string[] {
  return [
    '--json',
    'send',
    'prepare',
    '--account',
    'acme/resend',
    '--from',
    FIELDS.from,
    '--to',
    'sam@partner.test',
    '--subject',
    FIELDS.subject,
    '--text',
    text,
    '--html',
    html,
  ];
}

test('each input the review sent is refused by send prepare, from the CLI and from the tool, with its reason', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const { call, close } = await harness.mcp();
  try {
    for (const probe of PROBES) {
      const cli = await harness.cli(argv(probe.html, probe.text), { env: { CLAUDECODE: '1' } });
      const error = cli.json().error;
      assert.notEqual(cli.code, 0, `${probe.name}: the CLI prepared it`);
      assert.equal(error?.code, 'UNSENDABLE_HTML', `${probe.name}: ${JSON.stringify(error)}`);
      assert.match(error?.message ?? '', probe.reason, probe.name);

      const tool = refused(
        await call('resend_send_prepare', { account: 'acme/resend', ...FIELDS, text: probe.text, html: probe.html }),
      );
      assert.equal(tool.code, 'UNSENDABLE_HTML', probe.name);
      assert.equal(tool.message, error?.message, `${probe.name}: the two surfaces give the same reason`);
    }
  } finally {
    await close();
  }
  assert.deepEqual(await harness.core.approvals.list(), [], 'no approval was prepared for any of them');
  assert.equal(harness.fake.sends().length, 0);
});

test('the same inputs are refused when the text part is left for the HTML to supply', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const context = harness.context('mcp');
  for (const probe of [
    ...PROBES,
    // Stripped from the HTML's text before it becomes the text part, so the text part and the comparison agreed
    // while the HTML carried an override that shows the number reversed.
    { name: 'a bidi override character', html: '<p>Pay &#x202E;12345678</p>', text: '', reason: /bidi control/ },
  ]) {
    await assert.rejects(prepareSend(context, 'acme/resend', { ...FIELDS, html: probe.html }), (error: unknown) => {
      assert.ok(error instanceof CommsError, String(error));
      assert.equal(error.code, 'UNSENDABLE_HTML', probe.name);
      assert.match(error.message, probe.reason, probe.name);
      return true;
    });
  }
  assert.deepEqual(await harness.core.approvals.list(), []);
});

test('markup written as entities is shown literally, so a text part that leaves it out is refused', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const context = harness.context();
  // A mail client shows `Hi Sam<!-- IBAN GB00EVIL -->`; the comparison used to read `Hi Sam`.
  const html = '<p>Hi Sam&lt;!-- IBAN GB00EVIL --&gt;</p>';
  await assert.rejects(
    prepareSend(context, 'acme/resend', { ...FIELDS, text: 'Hi Sam', html }),
    (error: unknown) =>
      error instanceof CommsError && error.code === 'UNSENDABLE_HTML' && /not the text part/.test(error.message),
  );
  // Left to the HTML, the text part carries what the recipient will read, and the preview shows it.
  const prepared = await prepareSend(context, 'acme/resend', { ...FIELDS, html });
  assert.match(prepared.preview, /Hi Sam<!-- IBAN GB00EVIL -->/);
});

test('HTML that shows exactly its text part still prepares and sends', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const { call, close } = await harness.mcp();
  try {
    const html =
      '<div dir="ltr"><p>Hi Sam,</p><p>The plan is at <a href="https://example.test/plan?v=2">https://example.test/plan?v=2</a>.</p>' +
      '<ul><li><b>Tuesday</b>, 10am</li><li style="margin-left:15px"><i>room 4</i></li></ul>' +
      '<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">Earlier note</blockquote>' +
      '<p style="font-family:arial,sans-serif;color:#333">Jo</p></div>';
    const text =
      'Hi Sam,\n\nThe plan is at https://example.test/plan?v=2.\n\n * Tuesday, 10am\n * room 4\n\n> Earlier note\n\nJo';
    const prepared = ok<{ approvalId: string; expect: Record<string, unknown>; preview: string }>(
      await call('resend_send_prepare', { account: 'acme/resend', ...FIELDS, text, html }),
    );
    assert.match(prepared.preview, /it shows exactly the text above/);
    const sent = await executeSend(harness.context('mcp'), 'acme/resend', {
      approvalId: prepared.approvalId,
    });
    assert.equal(sent.state, 'sent');
    assert.equal(harness.fake.sends().length, 1);
  } finally {
    await close();
  }
});
