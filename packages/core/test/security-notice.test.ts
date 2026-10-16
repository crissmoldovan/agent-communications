import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderChannelPreview } from '../src/render.ts';
import { securityNotice } from '../src/update-gate.ts';
import { readUpdateCheck } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { LATEST, machine, markJobSetUp, seed } from './helpers/update-machine.ts';

/*
 * The security line (design 2026-10-16, U7): on `every-14-days`, `never`, and `auto` while its background job is not
 * set up, a release whose manifest declares a security fix puts one line first in the next send or post preview —
 * once — and the person's yes to that preview is the answer. One core helper, which every channel's prepare calls.
 */

const SECURITY = { version: LATEST, security: true, needsDecision: false };
const LINE = `A security fix is out (${LATEST}): update first, or approve to send anyway`;

test('a security release is asked about once, in the next send or post preview, on every level that does not install it', async () => {
  for (const config of [{}, { defaults: { updates: 'every-14-days' } }, { defaults: { updates: 'never' } }]) {
    const m = machine({}, config);
    await seed(m, { latest: LATEST, behind: true, release: SECURITY });
    assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION }), LINE, JSON.stringify(config));
    assert.equal(
      await securityNotice({ core: m.core, env: m.env, running: VERSION, act: 'post' }),
      null,
      'asked twice',
    );
    assert.equal((await readUpdateCheck(m.stateDir)).securityAsked, LATEST);
  }
  // Each act in its own words: a post is approved to post.
  const slack = machine();
  await seed(slack, { latest: LATEST, behind: true, release: SECURITY });
  assert.equal(
    await securityNotice({ core: slack.core, env: slack.env, running: VERSION, act: 'post' }),
    `A security fix is out (${LATEST}): update first, or approve to post anyway`,
  );
});

test('nothing is said when no security release is waiting, when the job installs it, when running it already, or switched off', async () => {
  const cases: [string, () => Promise<ReturnType<typeof machine>>][] = [
    [
      'not a security release',
      async () => {
        const m = machine();
        await seed(m, { latest: LATEST, behind: true, release: { ...SECURITY, security: false } });
        return m;
      },
    ],
    [
      'the facts are of another release',
      async () => {
        const m = machine();
        await seed(m, { latest: LATEST, behind: true, release: { ...SECURITY, version: '98.0.0' } });
        return m;
      },
    ],
    [
      'auto, with its background job set up: it installs within a day',
      async () => {
        const m = machine();
        await seed(m, { latest: LATEST, behind: true, release: SECURITY });
        markJobSetUp(m);
        return m;
      },
    ],
    [
      'already running it',
      async () => {
        const m = machine();
        await seed(m, { latest: VERSION, behind: false, release: { ...SECURITY, version: VERSION } });
        return m;
      },
    ],
    [
      'CI',
      async () => {
        const m = machine({ CI: 'true' });
        await seed(m, { latest: LATEST, behind: true, release: SECURITY });
        return m;
      },
    ],
  ];
  for (const [label, make] of cases) {
    const m = await make();
    assert.equal(await securityNotice({ core: m.core, env: m.env, running: VERSION }), null, label);
  }
  // A file nobody has written: nothing, and nothing thrown.
  const empty = machine();
  assert.equal(await securityNotice({ core: empty.core, env: empty.env, running: VERSION }), null);
});

test('a channel preview carries the line first, above everything it shows', () => {
  const rendered = renderChannelPreview({
    security: `A security fix is out (${LATEST}): update first, or approve to post anyway`,
    workspace: 'acme/slack',
    postingAs: 'Jo (U1)',
    channel: '#eng',
    body: 'shipping now',
    notifies: { channel: false, here: false, users: [], estimated: 0 },
    context: { approvalId: 'ap_1' },
  });
  assert.equal(rendered.split('\n')[0], `A security fix is out (${LATEST}): update first, or approve to post anyway`);
  assert.match(rendered.split('\n')[1] as string, /POST PREVIEW/);
});
