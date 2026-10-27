import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Config, ConfigStore, changedSettings, classifyChange, parseConfig } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { DEFAULT_TAKING, readTakingSettings, takingFor } from '../src/taking.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Taking messages, the settings (design 2026-10-26-taking-messages §4, §5): `config.json` keeps `taking` beside
 * `behaviour`, every write keeps it, it is read failing closed, and `classifyChange` judges it — a take no longer
 * required, a 👀 on taking, a longer wait before a message nobody took counts, and no reminder of one are loosenings;
 * the rest applies at once.
 */

const CREATED = '2026-09-20T00:00:00.000Z';
const GMAIL_ID = 'ibx_AAAAAAAAAAAAAAAA';
const SLACK_ID = 'acc_AAAAAAAAAAAAAAAA';
const RESEND_ID = 'acc_RRRRRRRRRRRRRRRR';
const WHATSAPP_ID = 'acc_WWWWWWWWWWWWWWWW';

const inbox = {
  id: GMAIL_ID,
  provider: 'gmail',
  email: 'jo@acme.test',
  identity: 'oidc',
  client: 'desktop',
  tier: 'send',
  contacts: false,
  grantedScopes: [],
  secretRef: `gmail:refresh:${GMAIL_ID}`,
  internalDomains: ['acme.test'],
  createdAt: CREATED,
};
const slack = {
  id: SLACK_ID,
  platform: 'slack',
  workspace: 'T_ACME',
  userId: 'U_AAAA',
  tier: 'send',
  mode: 'send',
  grantedScopes: [],
  secretRef: `slack:token:${SLACK_ID}`,
  createdAt: CREATED,
};
const resend = { ...slack, id: RESEND_ID, platform: 'resend', secretRef: `resend:key:${RESEND_ID}` };
const whatsapp = { ...slack, id: WHATSAPP_ID, platform: 'whatsapp', secretRef: `whatsapp:x:${WHATSAPP_ID}` };

function body(taking?: unknown): Record<string, unknown> {
  return {
    version: 2,
    inboxes: { 'acme/gmail': inbox },
    accounts: { 'acme/slack': slack, 'acme/resend': resend, 'acme/whatsapp': whatsapp },
    ...(taking === undefined ? {} : { taking }),
  };
}

const config = (taking?: unknown): Config => parseConfig(JSON.stringify(body(taking)));
const withTaking = (base: Config, taking: unknown): Config => ({ ...structuredClone(base), taking }) as Config;
const entry = (accountId: string, account: string, over: Record<string, unknown> = {}) => ({
  accountId,
  account,
  ...over,
});

test('every Gmail mailbox and Slack and Resend account takes messages, with the defaults until changed; WhatsApp none', () => {
  const settings = readTakingSettings(config());
  assert.deepEqual(
    settings.accounts.map((account) => [account.account, account.channel, account.required, account.stored]),
    [
      ['acme/gmail', 'gmail', false, false],
      ['acme/resend', 'resend', false, false],
      ['acme/slack', 'slack', false, false],
    ],
  );
  assert.deepEqual(settings.problems, []);
  assert.deepEqual(takingFor(config(), SLACK_ID), {
    ...DEFAULT_TAKING,
    accountId: SLACK_ID,
    account: 'acme/slack',
    channel: 'slack',
    stored: false,
  });
});

test('an entry binds to its account by id, and follows a rename', () => {
  const renamed = parseConfig(
    JSON.stringify({
      ...body({ accounts: [entry(SLACK_ID, 'acme/slack', { required: true, acknowledge: 'eyes' })] }),
      accounts: { 'beta/slack': slack, 'acme/resend': resend },
    }),
  );
  const found = takingFor(renamed, SLACK_ID);
  assert.equal(found.required, true);
  assert.equal(found.acknowledge, 'eyes');
});

test('what cannot be read is read as the stricter value, and named for doctor', () => {
  // The whole block.
  for (const broken of ['on', [], { accounts: 'all' }]) {
    const settings = readTakingSettings(config(broken));
    assert.ok(
      settings.accounts.every((account) => account.required),
      JSON.stringify(broken),
    );
    assert.equal(settings.problems.length, 1);
  }
  // An entry that is not an object may have been about any account.
  const anyone = readTakingSettings(config({ accounts: ['acme/slack'] }));
  assert.ok(anyone.accounts.every((account) => account.required));
  // Each field on its own.
  const fields = readTakingSettings(
    config({
      accounts: [
        entry(SLACK_ID, 'acme/slack', {
          required: 'yes',
          acknowledge: 'loudly',
          unclaimed: { afterMinutes: 1000, notify: 'maybe' },
        }),
      ],
    }),
  );
  const slackRead = fields.accounts.find((account) => account.accountId === SLACK_ID);
  assert.equal(slackRead?.required, true);
  assert.equal(slackRead?.acknowledge, 'nothing');
  assert.deepEqual(slackRead?.unclaimed, { afterMinutes: 5, notify: true });
  assert.equal(fields.problems.length, 4);
  assert.equal(fields.accounts.find((account) => account.accountId === GMAIL_ID)?.required, false, 'only its account');
});

test('a 👀 is Slack’s alone: on a mailbox it is read as nothing', () => {
  const read = takingFor(config({ accounts: [entry(GMAIL_ID, 'acme/gmail', { acknowledge: 'eyes' })] }), GMAIL_ID);
  assert.equal(read.acknowledge, 'nothing');
});

test('an entry whose account has gone applies by name, and only what it demands', () => {
  const orphan = { accountId: 'acc_GGGGGGGGGGGGGGGG', account: 'acme/slack', required: true, acknowledge: 'eyes' };
  const read = takingFor(config({ accounts: [orphan] }), SLACK_ID);
  assert.equal(read.required, true, 'the restriction is held');
  assert.equal(read.acknowledge, 'nothing', 'the 👀 is not carried to an account nobody chose it for');
});

test('two entries for one account are held to what both demand', () => {
  const read = takingFor(
    config({
      accounts: [
        entry(SLACK_ID, 'acme/slack', {
          required: false,
          acknowledge: 'eyes',
          unclaimed: { afterMinutes: 60, notify: false },
        }),
        entry(SLACK_ID, 'acme/slack', {
          required: true,
          acknowledge: 'nothing',
          unclaimed: { afterMinutes: 30, notify: false },
        }),
      ],
    }),
    SLACK_ID,
  );
  assert.deepEqual(
    { required: read.required, acknowledge: read.acknowledge, unclaimed: read.unclaimed },
    { required: true, acknowledge: 'nothing', unclaimed: { afterMinutes: 30, notify: false } },
  );
});

// ── Judging a change ───────────────────────────────────────────────────────────────────────────────────────────

test('a take no longer required is a loosening, bound to the account by id; required again applies at once', () => {
  const on = config({ accounts: [entry(SLACK_ID, 'acme/slack', { required: true })] });
  const off = withTaking(on, { accounts: [entry(SLACK_ID, 'acme/slack', { required: false })] });
  assert.deepEqual(classifyChange(on, off).changes, [
    { path: 'taking.acme/slack.required', before: true, after: false, id: SLACK_ID },
  ]);
  assert.deepEqual(classifyChange(off, on).changes, []);
  // Removing the entry is the same loosening: the default is off.
  assert.deepEqual(classifyChange(on, withTaking(on, undefined)).loosened, ['taking.acme/slack.required']);
  // Fixing an unreadable block to the defaults is one too: it was read as on, with the soonest reminder.
  assert.deepEqual(classifyChange(config('broken'), config()).loosened.sort(), [
    'taking.acme/gmail.required',
    'taking.acme/gmail.unclaimed.afterMinutes',
    'taking.acme/resend.required',
    'taking.acme/resend.unclaimed.afterMinutes',
    'taking.acme/slack.required',
    'taking.acme/slack.unclaimed.afterMinutes',
  ]);
});

test('a 👀 on taking, a longer wait and no reminder are loosenings; saying nothing, sooner and a reminder apply at once', () => {
  const quiet = config();
  const eyes = withTaking(quiet, { accounts: [entry(SLACK_ID, 'acme/slack', { acknowledge: 'eyes' })] });
  assert.deepEqual(classifyChange(quiet, eyes).changes, [
    { path: 'taking.acme/slack.acknowledge', before: 'nothing', after: 'eyes', id: SLACK_ID },
  ]);
  assert.deepEqual(classifyChange(eyes, quiet).changes, []);
  // Security review of 0.35.0 (LOW): hearing later, or not at all, of a message nobody took loosens the person's
  // oversight, so the person agrees to it; hearing sooner applies at once.
  const later = withTaking(quiet, {
    accounts: [entry(SLACK_ID, 'acme/slack', { unclaimed: { afterMinutes: 240, notify: false } })],
  });
  assert.deepEqual(classifyChange(quiet, later).changes, [
    { path: 'taking.acme/slack.unclaimed.afterMinutes', before: 15, after: 240, id: SLACK_ID },
    { path: 'taking.acme/slack.unclaimed.notify', before: true, after: false, id: SLACK_ID },
  ]);
  assert.deepEqual(classifyChange(later, quiet).changes, []);
  const sooner = withTaking(quiet, {
    accounts: [entry(SLACK_ID, 'acme/slack', { unclaimed: { afterMinutes: 5, notify: true } })],
  });
  assert.deepEqual(classifyChange(quiet, sooner).changes, []);
});

test('changedSettings records the block, so an approval binds the whole change', () => {
  const on = config({ accounts: [entry(SLACK_ID, 'acme/slack', { required: true })] });
  const off = withTaking(on, { accounts: [entry(SLACK_ID, 'acme/slack', { required: false })] });
  const changes = changedSettings(on, off).filter((change) => change.path === 'taking.accounts');
  assert.equal(changes.length, 1);
});

test('every write keeps taking, and a loosening written without consent is refused', async () => {
  const dir = join(tempDir('comms-taking-config-'), 'config');
  mkdirSync(dir);
  const file = join(dir, 'config.json');
  const taking = { accounts: [entry(SLACK_ID, 'acme/slack', { required: true })] };
  writeFileSync(file, `${JSON.stringify(body(taking), null, 2)}\n`);
  const store = new ConfigStore(dir);
  await store.update((current) => ({ ...current, defaults: { ...current.defaults } }));
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { taking?: unknown }).taking, taking);
  await assert.rejects(
    store.update((current) => ({
      ...current,
      taking: { accounts: [entry(SLACK_ID, 'acme/slack', { required: false })] },
    })),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );
});
