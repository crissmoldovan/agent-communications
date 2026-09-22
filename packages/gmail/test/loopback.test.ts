import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLoopback } from '../src/auth/loopback.ts';

/**
 * The page at the end of the sign-in.
 *
 * It is the last thing a person sees, and it used to say "Signed in — you can close this tab" and nothing else:
 * no mention of which mailbox was being connected, of which address it was meant to be, or of the fact that
 * nothing had been stored yet. Somebody connecting six accounts in a row saw the same six words each time.
 *
 * What it must **not** do is name the account as though it were settled. This page is served the moment Google
 * redirects, before the authorization code has been exchanged for anything, so the account that was actually
 * granted is not known here — and the whole reason `--email` exists is that a person can pick a different one on
 * the consent screen. "Signed in as X" would be a guess printed as a fact, and it would hide exactly the mismatch
 * the check downstream is there to catch.
 */

const ABOUT = { alias: 'work', mode: 'add', tier: 'organize', expectEmail: 'jo@example.test' } as const;

/** Drives one redirect against a live listener and returns what the browser would have been shown. */
async function fetchPage(
  options: Parameters<typeof startLoopback>[0],
  query: string,
): Promise<{ status: number; html: string }> {
  const listener = await startLoopback(options);
  try {
    const response = await fetch(`${listener.redirectUri}?${query}`);
    return { status: response.status, html: await response.text() };
  } finally {
    await listener.close();
  }
}

test('the page names the mailbox, the address asked for, and the access requested', async () => {
  const { status, html } = await fetchPage(
    { state: 'st_1', about: { ...ABOUT }, timeoutMs: 5_000 },
    'state=st_1&code=abc',
  );
  assert.equal(status, 200);
  assert.match(html, /agent-gmail/, 'the page does not say what produced it');
  assert.match(html, /Connecting/);
  assert.match(html, /work/);
  assert.match(html, /jo@example\.test/);
  assert.match(html, /organize/);
});

test('the page does not claim the account is connected, because it does not know yet', async () => {
  const { html } = await fetchPage({ state: 'st_2', about: { ...ABOUT }, timeoutMs: 5_000 }, 'state=st_2&code=abc');
  // The exact wording is free to change; what it may not do is assert the outcome.
  assert.doesNotMatch(html, /signed in as/i, 'the page named an account that has not been verified');
  assert.doesNotMatch(html, /connected as/i);
  assert.match(html, /Nothing is stored yet/i, 'the page does not say the sign-in is unfinished');
  assert.match(html, /refused/i, 'the page does not say a different account is refused');
});

test('a re-authorisation says so, rather than saying it is connecting something new', async () => {
  const { html } = await fetchPage(
    { state: 'st_3', about: { ...ABOUT, mode: 'reauth' }, timeoutMs: 5_000 },
    'state=st_3&code=abc',
  );
  assert.match(html, /Re-authorising/);
  assert.doesNotMatch(html, /Connecting/);
});

test('an alias is escaped, because it comes from a flag or an MCP call', async () => {
  /*
   * `alias` and the expected address are caller-supplied, and this page renders them into HTML on a port the
   * browser has open. The alias validator would refuse this one today — which is the argument for escaping
   * rather than against it, since the page must not depend on a rule enforced somewhere else entirely.
   */
  const nasty = '<img src=x onerror=alert(1)>';
  const { html } = await fetchPage(
    { state: 'st_4', about: { ...ABOUT, alias: nasty }, timeoutMs: 5_000 },
    'state=st_4&code=abc',
  );
  assert.doesNotMatch(html, /<img src=x/, 'the alias was written into the page as markup');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the alias was not shown at all');
});

test('the failure page is branded too, names the mailbox, and says nothing changed', async () => {
  const { html } = await fetchPage(
    { state: 'st_5', about: { ...ABOUT }, timeoutMs: 5_000 },
    'state=st_5&error=access_denied',
  );
  assert.match(html, /agent-gmail/);
  assert.match(html, /Not signed in/);
  assert.match(html, /work/);
  assert.match(html, /Nothing was changed/i);
});

test('a caller that supplies nothing still gets a usable page', async () => {
  // `about` is optional, so a listener started without it must not render "undefined" at somebody.
  const { status, html } = await fetchPage({ state: 'st_6', timeoutMs: 5_000 }, 'state=st_6&code=abc');
  assert.equal(status, 200);
  assert.match(html, /agent-gmail/);
  assert.doesNotMatch(html, /undefined/);
});

test('a request with the wrong state is refused, and does not leak what is being connected', async () => {
  // A stray tab or another process on this machine gets the failure page; it must not learn the address either.
  const { status, html } = await fetchPage(
    { state: 'st_7', about: { ...ABOUT }, timeoutMs: 5_000 },
    'state=nope&code=x',
  );
  assert.equal(status, 400);
  assert.doesNotMatch(html, /jo@example\.test/, 'a request with the wrong state was told the address');
  assert.doesNotMatch(html, /work/, 'a request with the wrong state was told which mailbox');
});
