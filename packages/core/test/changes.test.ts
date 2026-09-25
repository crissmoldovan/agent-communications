import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  beginChangeApproval,
  type ChangeSpec,
  claimChange,
  finishChangeApproval,
  governingChangePolicy,
  prepareChange,
} from '../src/changes.ts';
import type { Streams } from '../src/cli-runtime.ts';
import {
  type AccountConfig,
  type Config,
  ConfigStore,
  classifyChange,
  effectiveChangePolicy,
  emptyConfig,
  type InboxConfig,
  parseConfig,
} from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Change approvals (design 2026-09-25 §3): a loosening of the configuration, or an act that cannot be taken back,
 * agreed to from a chat or at a terminal. The fixtures run on a clock of their own, so nothing here depends on when
 * the suite runs.
 */

const CREATED = '2026-09-20T00:00:00.000Z';
const ACME = 'acc_AAAAAAAAAAAAAAAA';
const OTHER = 'acc_BBBBBBBBBBBBBBBB';
const MAIL = 'ibx_AAAAAAAAAAAAAAAA';

function account(id: string, over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id,
    platform: 'slack',
    workspace: 'T_ACME',
    userId: `U_${id.slice(-4)}`,
    tier: 'read',
    mode: 'read',
    grantedScopes: [],
    secretRef: `slack/token/${id}`,
    createdAt: CREATED,
    ...over,
  };
}

function inbox(id: string, over: Partial<InboxConfig> = {}): InboxConfig {
  return {
    id,
    provider: 'gmail',
    email: 'jo@acme.test',
    identity: 'oidc',
    client: 'desktop',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:refresh:${id}`,
    internalDomains: ['acme.test'],
    createdAt: CREATED,
    ...over,
  };
}

/** A version-2 configuration, parsed as the store would read it. */
function configOf(body: Record<string, unknown>): Config {
  return parseConfig(JSON.stringify({ version: 2, ...body }));
}

function clock(start = Date.parse('2026-09-25T10:00:00.000Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

/**
 * A core over a temp directory, holding `body` as its configuration.
 *
 * Written to disk directly rather than through `ConfigStore.update`: the fixtures start from settings that were
 * loosened long ago, and the store would — rightly — ask for consent to write them.
 */
function coreWith(body: Record<string, unknown>) {
  const dir = tempDir();
  const time = clock();
  const write = (next: Record<string, unknown>) =>
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ version: 2, ...next }, null, 2)}\n`);
  write(body);
  const core = openCore({ env: { AGENT_COMMS_CONFIG_DIR: dir, HOME: dir }, now: time.now });
  return { core, time, write, dir };
}

/** `acme/slack` widened from read to send, as a reauth in `send` mode would write it. */
async function widening(core: Core, name = 'acme/slack'): Promise<ChangeSpec> {
  const before = await core.config.load();
  const after = structuredClone(before);
  const held = after.accounts[name] as AccountConfig;
  after.accounts[name] = { ...held, mode: 'send', tier: 'send' };
  return { account: name, before, after, effects: ['signs in to Slack again and stores a token that can post'] };
}

function refusedWith(code: string, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, code, error.message);
    assert.match(error.message, pattern);
    return true;
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* changePolicy is a safety setting                                                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

test('changePolicy: absent reads as chat, and a config without it is written back without it', async () => {
  const empty = emptyConfig();
  assert.equal(empty.defaults.changePolicy, undefined);
  assert.equal(effectiveChangePolicy(empty), 'chat');
  // Upgrading changes nothing silently: an unrelated write does not record a choice nobody made.
  const store = new ConfigStore(tempDir());
  await store.update((config) => ({ ...config, defaults: { ...config.defaults, timezone: 'Europe/London' } }));
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).defaults.changePolicy, undefined);
  // And a value that is not a change policy is refused, as a bad send policy is.
  assert.throws(() => configOf({ defaults: { changePolicy: 'never' } }), /changePolicy/);
});

test('changePolicy: its own, else the default, else chat', () => {
  const config = configOf({
    defaults: { changePolicy: 'confirm' },
    accounts: { 'acme/slack': account(ACME, { changePolicy: 'chat' }), 'other/slack': account(OTHER) },
    inboxes: { 'acme/gmail': inbox(MAIL) },
  });
  assert.equal(effectiveChangePolicy(config, { account: 'acme/slack' }), 'chat');
  assert.equal(effectiveChangePolicy(config, { account: 'other/slack' }), 'confirm');
  assert.equal(effectiveChangePolicy(config, { inbox: 'acme/gmail' }), 'confirm');
  assert.equal(effectiveChangePolicy(config, { account: 'not/connected' }), 'confirm');
  assert.equal(effectiveChangePolicy(config), 'confirm');
});

test('classifyChange: the default change policy moved confirm → chat is a loosening; chat → confirm is not', () => {
  const confirm = configOf({ defaults: { changePolicy: 'confirm' } });
  const chat = configOf({});
  assert.deepEqual(classifyChange(confirm, chat).changes, [
    { path: 'defaults.changePolicy', before: 'confirm', after: 'chat' },
  ]);
  assert.deepEqual(classifyChange(confirm, configOf({ defaults: { changePolicy: 'chat' } })).loosened, [
    'defaults.changePolicy',
  ]);
  assert.deepEqual(classifyChange(chat, confirm).loosened, [], 'tightening asks nobody');
});

test('classifyChange: an inbox’s or an account’s change policy loosened, or inheriting a looser default, is a loosening', () => {
  const at = (inboxPolicy?: 'chat' | 'confirm', accountPolicy?: 'chat' | 'confirm', defaults?: 'chat' | 'confirm') =>
    configOf({
      ...(defaults ? { defaults: { changePolicy: defaults } } : {}),
      inboxes: { 'acme/gmail': inbox(MAIL, inboxPolicy ? { changePolicy: inboxPolicy } : {}) },
      accounts: { 'acme/slack': account(ACME, accountPolicy ? { changePolicy: accountPolicy } : {}) },
    });
  assert.deepEqual(classifyChange(at('confirm'), at('chat')).changes, [
    { path: 'inboxes.acme/gmail.changePolicy', before: 'confirm', after: 'chat', id: MAIL },
  ]);
  assert.deepEqual(classifyChange(at(undefined, 'confirm'), at(undefined, 'chat')).changes, [
    { path: 'accounts.acme/slack.changePolicy', before: 'confirm', after: 'chat', id: ACME },
  ]);
  // Both inherit the default, so loosening the default loosens each of them too.
  assert.deepEqual(classifyChange(at(undefined, undefined, 'confirm'), at()).loosened, [
    'inboxes.acme/gmail.changePolicy',
    'accounts.acme/slack.changePolicy',
    'defaults.changePolicy',
  ]);
  assert.deepEqual(classifyChange(at('chat', 'chat'), at('confirm', 'confirm')).loosened, [], 'tightening');
});

test('classifyChange: a new inbox or account looser than the default in force before it existed is a loosening', () => {
  const before = configOf({ defaults: { changePolicy: 'confirm' } });
  const withInbox = (over: Partial<InboxConfig>) =>
    configOf({ defaults: { changePolicy: 'confirm' }, inboxes: { 'acme/gmail': inbox(MAIL, over) } });
  const withAccount = (over: Partial<AccountConfig>) =>
    configOf({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME, over) } });

  // Measured against the default before it existed, and new: no id on the before side.
  assert.deepEqual(classifyChange(before, withInbox({ changePolicy: 'chat' })).changes, [
    { path: 'inboxes.acme/gmail.changePolicy', before: 'confirm', after: 'chat' },
  ]);
  assert.deepEqual(classifyChange(before, withAccount({ changePolicy: 'chat' })).loosened, [
    'accounts.acme/slack.changePolicy',
  ]);
  // Inheriting the default, or naming it, is no loosening.
  assert.deepEqual(classifyChange(before, withInbox({})).loosened, []);
  assert.deepEqual(classifyChange(before, withAccount({ changePolicy: 'confirm' })).loosened, []);
});

test('classifyChange: an account’s change policy is measured across a reauth’s new id', () => {
  // A reauth mints a new id for the same person in the same workspace. Matched by id alone, the renewed account would
  // be measured against the default — `chat` — and `confirm` → `chat` across a reauth would read as no change.
  const before = configOf({ accounts: { 'acme/slack': account(ACME, { userId: 'U_ME', changePolicy: 'confirm' }) } });
  const after = configOf({ accounts: { 'acme/slack': account(OTHER, { userId: 'U_ME', changePolicy: 'chat' }) } });
  assert.deepEqual(classifyChange(before, after).changes, [
    { path: 'accounts.acme/slack.changePolicy', before: 'confirm', after: 'chat', id: ACME },
  ]);
});

test('classifyChange: reports the values it judged, not the raw fields', () => {
  // An inherited default is what the inbox had; a new account is measured against the default before it and starts
  // from `read`; an unrecorded store is the keychain.
  const before = configOf({ defaults: { sendPolicy: 'confirm' }, inboxes: { 'acme/gmail': inbox(MAIL) } });
  const after = configOf({
    inboxes: { 'acme/gmail': inbox(MAIL) },
    accounts: { 'zed/slack': account(OTHER, { mode: 'send', tier: 'send' }) },
    secrets: { store: 'file' },
  });
  assert.deepEqual(classifyChange(before, after).changes, [
    { path: 'inboxes.acme/gmail.sendPolicy', before: 'confirm', after: 'chat', id: MAIL },
    { path: 'accounts.zed/slack.sendPolicy', before: 'confirm', after: 'chat' },
    { path: 'accounts.zed/slack.mode', before: 'read', after: 'send' },
    { path: 'defaults.sendPolicy', before: 'confirm', after: 'chat' },
    { path: 'secrets.store', before: 'keychain', after: 'file' },
  ]);
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The consent a change approval yields                                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */

test('a consent carrying approved values lets exactly that change through, and not the same path moved further', async () => {
  const store = new ConfigStore(tempDir());
  writeFileSync(
    store.path,
    JSON.stringify({ version: 2, accounts: { 'acme/slack': account(ACME, { sendPolicy: 'never' }) } }),
  );
  const path = 'accounts.acme/slack.sendPolicy';
  const to = (sendPolicy: 'chat' | 'confirm') => (config: Config) => {
    config.accounts['acme/slack'] = { ...(config.accounts['acme/slack'] as AccountConfig), sendPolicy };
    return config;
  };
  const neverToConfirm = { path, before: 'never', after: 'confirm', id: ACME };
  const approved = { kind: 'loosening-consent' as const, paths: [path], changes: [neverToConfirm] };
  // The path matches and the value does not: approved never → confirm, asked for never → chat.
  await assert.rejects(
    store.update(to('chat'), { consent: approved }),
    refusedWith('LOOSENING_REFUSED', /this is not the change that was approved: accounts\.acme\/slack\.sendPolicy/),
  );
  assert.equal((await store.load()).accounts['acme/slack']?.sendPolicy, 'never', 'nothing was written');
  // A different account under the same name is a different change, whatever the values.
  await assert.rejects(
    store.update(to('confirm'), { consent: { ...approved, changes: [{ ...neverToConfirm, id: OTHER }] } }),
    refusedWith('LOOSENING_REFUSED', /not the change that was approved/),
  );
  await store.update(to('confirm'), { consent: approved });
  assert.equal((await store.load()).accounts['acme/slack']?.sendPolicy, 'confirm');
  // A terminal consent names paths alone, and is judged as it always was.
  await store.update(to('chat'), { consent: { kind: 'loosening-consent', paths: [path] } });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Prepare, preview, approve, apply                                                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

test('under chat, a prepared change shows before → after in words, and is claimed once for exactly that write', async () => {
  const { core } = coreWith({ accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });

  assert.equal(prepared.policy, 'chat');
  assert.deepEqual(prepared.loosened, [{ path: 'accounts.acme/slack.mode', before: 'read', after: 'send', id: ACME }]);
  assert.match(
    prepared.preview,
    /^CHANGE PREVIEW · approval ap_\w+ · approved by a yes in the chat · nothing has been changed/,
  );
  assert.match(prepared.preview, /\nLet acme\/slack post\nFor: account acme\/slack\n/);
  assert.match(prepared.preview, /acme\/slack mode: read → send — it will be able to send, not only read/);
  assert.match(prepared.preview, /It also:\n {2}- signs in to Slack again and stores a token that can post/);
  assert.match(prepared.next, /If they say yes, claim approval/);

  // Nothing was written, and the write still needs consent.
  assert.equal((await core.config.load()).accounts['acme/slack']?.mode, 'read');
  await assert.rejects(
    core.config.update(() => spec.after),
    refusedWith('LOOSENING_REFUSED', /accounts\.acme\/slack\.mode/),
  );

  const consent = await claimChange(core, prepared.approvalId, await widening(core), { surface: 'mcp' });
  assert.deepEqual(consent.paths, ['accounts.acme/slack.mode']);
  await core.config.update(() => spec.after, { consent });
  assert.equal((await core.config.load()).accounts['acme/slack']?.mode, 'send');

  // Single use.
  await assert.rejects(
    claimChange(core, prepared.approvalId, spec, { surface: 'mcp' }),
    refusedWith('APPROVAL_REQUIRED', /nothing was changed: the approval is used/),
  );
});

test('drift between preview and apply voids the approval, and says what moved', async () => {
  /** `acme/slack` from `never` to `policy`, as well as widened. */
  const withSendPolicy = (spec: ChangeSpec, sendPolicy: 'chat' | 'confirm'): ChangeSpec => {
    const after = structuredClone(spec.after);
    after.accounts['acme/slack'] = { ...(after.accounts['acme/slack'] as AccountConfig), sendPolicy };
    return { ...spec, after };
  };
  const cases: [string, (spec: ChangeSpec) => ChangeSpec, RegExp][] = [
    // Approved never → confirm, applied never → chat: the same path, a different value.
    [
      'a different value',
      (spec) => withSendPolicy(spec, 'chat'),
      /accounts\.acme\/slack\.sendPolicy would not move between the values that were approved/,
    ],
    [
      'a different setting',
      (spec) => {
        const after = structuredClone(spec.after);
        after.defaults.riskEscalation = false;
        return { ...spec, after };
      },
      /it loosens different settings from the ones approved/,
    ],
    [
      'different effects',
      (spec) => ({ ...spec, effects: ['removes every token'] }),
      /what it does outside the configuration is not what was approved/,
    ],
  ];
  for (const [name, drift, reason] of cases) {
    const { core } = coreWith({ accounts: { 'acme/slack': account(ACME, { sendPolicy: 'never' }) } });
    const spec = withSendPolicy(await widening(core), 'confirm');
    const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
    await assert.rejects(
      claimChange(core, prepared.approvalId, drift(spec), { surface: 'mcp' }),
      refusedWith('APPROVAL_VOID', new RegExp(`nothing was changed: ${reason.source}`)),
      name,
    );
    // Voided for good: the change as prepared no longer claims it either.
    await assert.rejects(
      claimChange(core, prepared.approvalId, spec, { surface: 'mcp' }),
      refusedWith('APPROVAL_VOID', /was voided/),
      name,
    );
  }
});

test('an account replaced under the same name between preview and apply is not the one approved', async () => {
  const { core, write } = coreWith({ accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  // Somebody removed acme/slack and connected a different workspace under the name.
  write({ accounts: { 'acme/slack': account(OTHER, { workspace: 'T_ELSEWHERE' }) } });
  await assert.rejects(
    claimChange(core, prepared.approvalId, await widening(core), { surface: 'mcp' }),
    refusedWith('APPROVAL_VOID', /"acme\/slack" is not the account it was when this was approved/),
  );
});

test('under confirm, a change is not claimable until a person approved it at a terminal — then it is, once', async () => {
  const { core } = coreWith({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  assert.equal(prepared.policy, 'confirm');
  assert.match(prepared.preview, /approved by a code typed at a terminal/);
  assert.match(prepared.next, new RegExp(`\`agentcomms approve ${prepared.approvalId}\``));

  await assert.rejects(claimChange(core, prepared.approvalId, spec, { surface: 'mcp' }), (error: CommsError) => {
    assert.equal(error.code, 'APPROVAL_PENDING');
    assert.match(error.message, /needs a person to approve it at a terminal first/);
    assert.match(error.hint ?? '', new RegExp(`agentcomms approve ${prepared.approvalId}`));
    return true;
  });
  assert.equal((await core.approvals.get(prepared.approvalId))?.state, 'pending', 'waiting is not voiding');

  const prompt = await beginChangeApproval(core, prepared.approvalId, { surface: 'cli' });
  assert.equal(prompt.preview, prepared.preview, 'the terminal shows what the chat showed');
  await finishChangeApproval(core, prepared.approvalId, prompt.challenge.toLowerCase(), { surface: 'cli' });

  const consent = await claimChange(core, prepared.approvalId, spec, { surface: 'mcp' });
  await core.config.update(() => spec.after, { consent });
  assert.equal((await core.config.load()).accounts['acme/slack']?.mode, 'send');
});

test('under confirm, an approval given anywhere but a terminal does not count', async () => {
  const { core } = coreWith({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  const record = await core.approvals.get(prepared.approvalId);
  const challenge = await core.approvals.issueChallenge(prepared.approvalId, 'change');
  const bound = { draftMessageId: record?.digest ?? '', digest: record?.digest ?? '' };
  await core.approvals.approve(prepared.approvalId, 'elicitation', bound, challenge, 'change');
  await assert.rejects(
    claimChange(core, prepared.approvalId, spec, { surface: 'mcp' }),
    refusedWith('APPROVAL_VOID', /the change policy is confirm, and this was not approved at a terminal/),
  );
});

test('loosening the change policy itself is approved under the policy in force before it', async () => {
  const { core } = coreWith({ defaults: { changePolicy: 'confirm' } });
  const before = await core.config.load();
  const after = structuredClone(before);
  after.defaults.changePolicy = 'chat';
  const prepared = await prepareChange(
    core,
    { before, after, summary: 'Approve changes in chat from now on' },
    { surface: 'mcp' },
  );
  assert.equal(prepared.policy, 'confirm', 'confirm → chat is asked under confirm, not under the chat it asks for');
  assert.match(prepared.preview, /default change policy: confirm → chat — a yes in the chat will be enough/);
  await assert.rejects(
    claimChange(core, prepared.approvalId, { before, after }, { surface: 'mcp' }),
    refusedWith('APPROVAL_PENDING', /at a terminal first/),
  );

  // And chat → confirm is a tightening, which needs nobody: there is nothing to prepare.
  await assert.rejects(
    prepareChange(core, { before: after, after: before, summary: 'Back to confirm' }, { surface: 'mcp' }),
    refusedWith('USAGE', /nothing to approve/),
  );
});

test('the strictest policy over everything a change touches governs it', () => {
  const config = configOf({
    defaults: { changePolicy: 'confirm' },
    accounts: { 'acme/slack': account(ACME, { changePolicy: 'chat' }), 'other/slack': account(OTHER) },
  });
  const target = { kind: 'account' as const, name: 'acme/slack', id: ACME };
  const mode = { path: 'accounts.acme/slack.mode', before: 'read', after: 'send', id: ACME };
  // The account's own override governs a change to it.
  assert.equal(governingChangePolicy(config, { target, loosened: [mode] }), 'chat');
  // The default governs one to another account, to a new one, and to the whole configuration.
  assert.equal(
    governingChangePolicy(config, { target: { ...target, name: 'other/slack', id: OTHER }, loosened: [] }),
    'confirm',
  );
  assert.equal(
    governingChangePolicy(config, { target: { kind: 'account', name: 'zed/slack' }, loosened: [] }),
    'confirm',
  );
  assert.equal(governingChangePolicy(config, { target: null, loosened: [] }), 'confirm');
  // A change to acme/slack that also loosens a default is governed by the default too.
  const caps = { path: 'defaults.sendCaps', before: { perHour: 20 }, after: { perHour: 99 } };
  assert.equal(governingChangePolicy(config, { target, loosened: [mode, caps] }), 'confirm');
  // And one that loosens another account is governed by that account's policy.
  const other = { path: 'accounts.other/slack.mode', before: 'read', after: 'send', id: OTHER };
  assert.equal(governingChangePolicy(config, { target, loosened: [mode, other] }), 'confirm');
});

test('a policy tightened after prepare governs the claim; one loosened after prepare does not release it', async () => {
  const tightened = coreWith({ accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(tightened.core);
  const underChat = await prepareChange(tightened.core, { ...spec, summary: 'x' }, { surface: 'mcp' });
  assert.equal(underChat.policy, 'chat');
  tightened.write({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME) } });
  await assert.rejects(
    claimChange(tightened.core, underChat.approvalId, spec, { surface: 'mcp' }),
    refusedWith('APPROVAL_PENDING', /at a terminal first/),
  );

  const loosened = coreWith({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME) } });
  const again = await widening(loosened.core);
  const underConfirm = await prepareChange(loosened.core, { ...again, summary: 'x' }, { surface: 'mcp' });
  loosened.write({ accounts: { 'acme/slack': account(ACME) } });
  const live = await widening(loosened.core);
  await assert.rejects(
    claimChange(loosened.core, underConfirm.approvalId, live, { surface: 'mcp' }),
    refusedWith('APPROVAL_PENDING', /at a terminal first/),
  );
});

test('a change approval expires ten minutes after it is prepared', async () => {
  const { core, time } = coreWith({ accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'x' }, { surface: 'mcp' });
  time.advance(10 * 60 * 1000);
  await assert.rejects(
    claimChange(core, prepared.approvalId, spec, { surface: 'mcp' }),
    refusedWith('APPROVAL_EXPIRED', /nothing was changed: the approval expired/),
  );
});

test('the policy in force is read from the file, never from the before a caller passes', async () => {
  const { core } = coreWith({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  // A caller whose idea of the configuration says `chat` — stale, or made up — gets the policy the file says.
  const claimsChat = structuredClone(spec.before);
  claimsChat.defaults.changePolicy = 'chat';
  const after = structuredClone(spec.after);
  after.defaults.changePolicy = 'chat';
  const forged = { ...spec, before: claimsChat, after };
  const prepared = await prepareChange(core, { ...forged, summary: 'x' }, { surface: 'mcp' });
  assert.equal(prepared.policy, 'confirm');
  // And at the claim too: the record's policy aside, the live one alone would refuse it.
  const record = await core.approvals.get(prepared.approvalId);
  const file = join(core.approvals.directory, `${prepared.approvalId}.json`);
  writeFileSync(file, JSON.stringify({ ...record, policy: 'chat', requiredPolicy: 'chat' }));
  await assert.rejects(
    claimChange(core, prepared.approvalId, forged, { surface: 'mcp' }),
    refusedWith('APPROVAL_PENDING', /at a terminal first/),
  );
});

test('a claimed consent still refuses the write if the account changes between the claim and the write', async () => {
  const { core, write } = coreWith({ accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  const consent = await claimChange(core, prepared.approvalId, spec, { surface: 'mcp' });
  // A sign-in can take minutes. Meanwhile a different workspace was connected under the name.
  write({ accounts: { 'acme/slack': account(OTHER, { workspace: 'T_ELSEWHERE' }) } });
  const widen = (config: Config) => {
    config.accounts['acme/slack'] = { ...(config.accounts['acme/slack'] as AccountConfig), mode: 'send', tier: 'send' };
    return config;
  };
  await assert.rejects(
    core.config.update(widen, { consent }),
    refusedWith('LOOSENING_REFUSED', /this is not the change that was approved: accounts\.acme\/slack\.mode/),
  );
  assert.equal((await core.config.load()).accounts['acme/slack']?.mode, 'read');
});

test('an act that cannot be taken back is bound to the mailbox or workspace it was shown for', async () => {
  // Replaced under the same name before the removal was applied: it would remove something nobody was shown.
  const cases = [
    {
      kind: 'account' as const,
      name: 'acme/slack',
      was: { accounts: { 'acme/slack': account(ACME) } },
      now: { accounts: { 'acme/slack': account(OTHER, { workspace: 'T_ELSEWHERE' }) } },
    },
    {
      kind: 'inbox' as const,
      name: 'acme/gmail',
      was: { inboxes: { 'acme/gmail': inbox(MAIL) } },
      now: { inboxes: { 'acme/gmail': inbox('ibx_BBBBBBBBBBBBBBBB', { email: 'someone@else.test' }) } },
    },
  ];
  for (const { kind, name, was, now } of cases) {
    const { core, write } = coreWith(was);
    const removal = async (): Promise<ChangeSpec> => {
      const before = await core.config.load();
      const after = structuredClone(before);
      delete after[kind === 'inbox' ? 'inboxes' : 'accounts'][name];
      return { [kind]: name, before, after, effects: [`deletes the credential stored for ${name}`] };
    };
    const prepared = await prepareChange(core, { ...(await removal()), summary: `Remove ${name}` }, { surface: 'cli' });
    write(now);
    await assert.rejects(
      claimChange(core, prepared.approvalId, await removal(), { surface: 'cli' }),
      refusedWith('APPROVAL_VOID', new RegExp(`"${name}" is not the ${kind} it was when this was approved`)),
      kind,
    );
  }
});

test('an act that cannot be taken back is approved by its effects alone, and its consent loosens nothing', async () => {
  const { core } = coreWith({ accounts: { 'acme/slack': account(ACME), 'other/slack': account(OTHER) } });
  const before = await core.config.load();
  const after = structuredClone(before);
  delete after.accounts['acme/slack'];
  const removal = { account: 'acme/slack', before, after, effects: ['deletes the token stored for acme/slack'] };
  const prepared = await prepareChange(core, { ...removal, summary: 'Remove acme/slack' }, { surface: 'cli' });
  assert.deepEqual(prepared.loosened, []);
  assert.match(
    prepared.preview,
    /For: account acme\/slack\n\nIt loosens no safety setting\.\n\nIt also:\n {2}- deletes the token/,
  );

  const consent = await claimChange(core, prepared.approvalId, removal, { surface: 'cli' });
  assert.deepEqual(consent, { kind: 'loosening-consent', paths: [], changes: [] });
  // Spent on anything that loosens, it permits nothing.
  const widened = structuredClone(after);
  widened.accounts['other/slack'] = {
    ...(widened.accounts['other/slack'] as AccountConfig),
    mode: 'send',
    tier: 'send',
  };
  await assert.rejects(
    core.config.update(() => widened, { consent }),
    refusedWith('LOOSENING_REFUSED', /other\/slack\.mode/),
  );
  await core.config.update(() => after, { consent });
  assert.equal((await core.config.load()).accounts['acme/slack'], undefined);
});

test('prepare refuses a change with nothing to approve, one about nothing connected, and one about two things', async () => {
  const { core } = coreWith({ accounts: { 'acme/slack': account(ACME) } });
  const config = await core.config.load();
  await assert.rejects(
    prepareChange(core, { before: config, after: config, summary: 'nothing' }, { surface: 'mcp' }),
    refusedWith('USAGE', /nothing to approve/),
  );
  await assert.rejects(
    prepareChange(
      core,
      { account: 'zed/slack', before: config, after: config, effects: ['x'], summary: 's' },
      { surface: 'mcp' },
    ),
    refusedWith('NOT_FOUND', /zed\/slack/),
  );
  await assert.rejects(
    prepareChange(
      core,
      { account: 'acme/slack', inbox: 'acme/gmail', before: config, after: config, effects: ['x'], summary: 's' },
      { surface: 'mcp' },
    ),
    refusedWith('USAGE', /one inbox or one account, not both/),
  );
  await assert.rejects(
    prepareChange(core, { before: config, after: config, effects: ['x'], summary: '  ' }, { surface: 'mcp' }),
    refusedWith('USAGE', /needs a summary/),
  );
});

test('the terminal shows only a change that reproduces its own digest, and only a change', async () => {
  const { core } = coreWith({ accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  // The record says it widens something else than it is bound to: the screen would lie, so it is never shown.
  const file = join(core.approvals.directory, `${prepared.approvalId}.json`);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.change.loosened[0].after = 'read';
  writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(
    beginChangeApproval(core, prepared.approvalId, { surface: 'cli' }),
    refusedWith('BAD_DATA', /does not describe the change it is bound to/),
  );

  // A send's approval is not approved here.
  const send = await core.approvals.create({
    inboxId: MAIL,
    draftId: 'r-1',
    draftMessageId: 'm-1',
    digest: 'd-1',
    policy: 'confirm',
    requiredPolicy: 'confirm',
    riskFlags: [],
    expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'hi' },
  });
  await assert.rejects(
    beginChangeApproval(core, send.approvalId, { surface: 'cli' }),
    refusedWith('USAGE', /is for a send, not a configuration change/),
  );
  assert.equal((await core.approvals.get(send.approvalId))?.challengeHash, undefined, 'no challenge was issued');
});

test('every step is in the audit trail: surface, policy and outcome', async () => {
  const { core } = coreWith({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);
  const prepared = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  await claimChange(core, prepared.approvalId, spec, { surface: 'mcp' }).catch(() => undefined);
  await assert.rejects(finishChangeApproval(core, prepared.approvalId, 'ZZZZ', { surface: 'cli' }));
  const prompt = await beginChangeApproval(core, prepared.approvalId, { surface: 'cli' });
  await assert.rejects(finishChangeApproval(core, prepared.approvalId, 'ZZZZ', { surface: 'cli' }));
  await finishChangeApproval(core, prepared.approvalId, prompt.challenge, { surface: 'cli' });
  await claimChange(core, prepared.approvalId, spec, { surface: 'mcp' });

  const lines = (await core.audit.tail()).map((line) => ({
    operation: line.operation,
    outcome: line.outcome,
    surface: line.surface,
    policy: line.policy,
    approvalId: line.approvalId,
    inboxId: line.inboxId,
    alias: line.alias,
  }));
  const on = { approvalId: prepared.approvalId, inboxId: ACME, alias: 'acme/slack', policy: 'confirm' };
  assert.deepEqual(lines, [
    { operation: 'change.prepare', outcome: 'ok', surface: 'mcp', ...on },
    { operation: 'change.claim', outcome: 'refused', surface: 'mcp', ...on },
    { operation: 'change.approve', outcome: 'refused', surface: 'cli', ...on },
    { operation: 'change.approve', outcome: 'refused', surface: 'cli', ...on },
    { operation: 'change.approve', outcome: 'ok', surface: 'cli', ...on },
    { operation: 'change.claim', outcome: 'ok', surface: 'mcp', ...on },
  ]);
  const tail = await core.audit.tail();
  assert.match(tail[1]?.reason ?? '', /needs a person to approve it at a terminal first/);
  assert.match(tail[3]?.reason ?? '', /the challenge did not match/);
  assert.deepEqual(tail[0]?.ids, { paths: ['accounts.acme/slack.mode'] });
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* `agentcomms approve`                                                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Streams that are a terminal, and a person at it who types whatever `answer` returns for the code shown. */
function terminal(answer: (challenge: string) => string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let shown = '';
  stdout.on('data', (chunk) => {
    shown += String(chunk);
  });
  stderr.on('data', (chunk) => {
    const asked = /Type (\w{4}) to approve this change/.exec(String(chunk));
    if (asked?.[1]) stdin.write(`${answer(asked[1])}\n`);
  });
  return { streams: { stdin, stdout, stderr } as unknown as Streams, shown: () => shown };
}

test('agentcomms approve: a person reads the change and types the code; Enter cancels it', async () => {
  const { approveChangeAtTerminal } = await import('../src/cli.ts');
  const { core } = coreWith({ defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(ACME) } });
  const spec = await widening(core);

  const first = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  const person = terminal((code) => code);
  const approved = await approveChangeAtTerminal(core, first.approvalId, {}, { color: false }, person.streams);
  assert.deepEqual(approved, { approvalId: first.approvalId, state: 'approved' });
  assert.match(person.shown(), /CHANGE PREVIEW/);
  assert.match(person.shown(), /acme\/slack mode: read → send/);
  const record = await core.approvals.get(first.approvalId);
  assert.equal(record?.state, 'approved');
  assert.equal(record?.approvedVia, 'terminal');

  const second = await prepareChange(core, { ...spec, summary: 'Let acme/slack post' }, { surface: 'mcp' });
  const declines = terminal(() => '');
  const cancelled = await approveChangeAtTerminal(core, second.approvalId, {}, { color: false }, declines.streams);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await core.approvals.get(second.approvalId))?.state, 'revoked');
});
