import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ActQuery,
  allowedAct,
  BEHAVIOUR_ACTS,
  type BehaviourSettings,
  classifyBehaviourChange,
  readBehaviourSettings,
} from '../src/behaviour.ts';
import { type Config, parseConfig } from '../src/config.ts';

/*
 * Task 1 of the behaviour rules (design 2026-10-19-agent-behaviour-rules, B2 and B3): what an agent may do, per account
 * and per conversation, read so that a value this release cannot read only ever narrows what is allowed.
 */

const CREATED = '2026-09-20T00:00:00.000Z';
const GMAIL_ID = 'ibx_AAAAAAAAAAAAAAAA';
const SLACK_ID = 'acc_AAAAAAAAAAAAAAAA';
const GONE_ID = 'acc_GGGGGGGGGGGGGGGG';

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
const account = {
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

/** A version-2 configuration with one mailbox and one workspace, and `behaviour` as given (absent when undefined). */
function config(behaviour?: unknown): Config {
  return parseConfig(
    JSON.stringify({
      version: 2,
      inboxes: { 'acme/gmail': inbox },
      accounts: { 'acme/slack': account },
      ...(behaviour === undefined ? {} : { behaviour }),
    }),
  );
}

const withRules = (rules: unknown): Config => config({ rules });

const slack = (places: string[][], acts: ActQuery['acts']): ActQuery => ({
  accountId: SLACK_ID,
  account: 'acme/slack',
  places,
  acts,
});
const mail = (recipients: string[], acts: ActQuery['acts']): ActQuery => ({
  accountId: GMAIL_ID,
  account: 'acme/gmail',
  places: recipients.map((address) => [address]),
  acts,
});

test('the acts a rule may name, exactly, in order', () => {
  assert.deepEqual([...BEHAVIOUR_ACTS], ['post', 'reply', 'reaction', 'edit', 'delete', 'file', 'send']);
  assert.ok(Object.isFrozen(BEHAVIOUR_ACTS));
});

test('no rule allows everything', () => {
  for (const settings of [config(), config({}), withRules([])]) {
    assert.deepEqual(allowedAct(settings, slack([['C0GENERAL']], ['post'])), {
      allowed: true,
      rule: null,
      allowedActs: 'all',
    });
    assert.deepEqual(allowedAct(settings, mail(['bob@client.test'], ['send'])), {
      allowed: true,
      rule: null,
      allowedActs: 'all',
    });
  }
  // A rule for one account says nothing about another.
  const other = withRules([{ account: 'acme/slack', accountId: SLACK_ID, acts: [] }]);
  assert.deepEqual(allowedAct(other, mail(['bob@client.test'], ['send'])), {
    allowed: true,
    rule: null,
    allowedActs: 'all',
  });
});

test('the most specific rule wins: address over domain over account', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, acts: ['send', 'reply'] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@client.test', acts: ['reply'] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'bob@client.test', acts: ['send'] },
  ]);
  // The address's own rule allows send, though its domain's does not.
  assert.deepEqual(allowedAct(settings, mail(['bob@client.test'], ['send'])), {
    allowed: true,
    rule: { account: 'acme/gmail', conversation: 'bob@client.test' },
    allowedActs: ['send'],
  });
  // Another address there has only the domain's rule.
  assert.deepEqual(allowedAct(settings, mail(['carol@client.test'], ['send'])), {
    allowed: false,
    act: 'send',
    place: 'carol@client.test',
    rule: { account: 'acme/gmail', conversation: '@client.test' },
    allowedActs: ['reply'],
  });
  // And an address elsewhere has the account's.
  assert.deepEqual(allowedAct(settings, mail(['dan@other.test'], ['send'])), {
    allowed: true,
    rule: { account: 'acme/gmail' },
    allowedActs: ['reply', 'send'],
  });
  // A subdomain is covered by its domain's rule (lead's call, after review): an `@domain` rule holds all of it.
  assert.deepEqual(allowedAct(settings, mail(['eve@eu.client.test'], ['send'])), {
    allowed: false,
    act: 'send',
    place: 'eve@eu.client.test',
    rule: { account: 'acme/gmail', conversation: '@client.test' },
    allowedActs: ['reply'],
  });

  // Slack: a channel's rule over the account's, even where the channel's allows more.
  const workspace = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, acts: ['reply'] },
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'C0GENERAL', acts: ['post', 'reply'] },
  ]);
  assert.deepEqual(allowedAct(workspace, slack([['C0GENERAL']], ['post'])), {
    allowed: true,
    rule: { account: 'acme/slack', conversation: 'C0GENERAL' },
    allowedActs: ['post', 'reply'],
  });
  assert.deepEqual(allowedAct(workspace, slack([['C0RANDOM']], ['post'])), {
    allowed: false,
    act: 'post',
    place: 'C0RANDOM',
    rule: { account: 'acme/slack' },
    allowedActs: ['reply'],
  });
  // With no place at all, the account's rule decides.
  assert.deepEqual(allowedAct(workspace, slack([], ['post'])), {
    allowed: false,
    act: 'post',
    place: null,
    rule: { account: 'acme/slack' },
    allowedActs: ['reply'],
  });
});

test("a DM's D and U rules give the narrower", () => {
  const settings = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'D0BOB', acts: ['reply', 'reaction'] },
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'U0BOB', acts: ['reply'] },
  ]);
  assert.deepEqual(allowedAct(settings, slack([['D0BOB', 'U0BOB']], ['reply'])), {
    allowed: true,
    rule: { account: 'acme/slack', conversation: 'D0BOB' },
    allowedActs: ['reply'],
  });
  // The reaction the D rule allows, the U rule does not: the U rule is the one that refuses.
  assert.deepEqual(allowedAct(settings, slack([['D0BOB', 'U0BOB']], ['reaction'])), {
    allowed: false,
    act: 'reaction',
    place: 'U0BOB',
    rule: { account: 'acme/slack', conversation: 'U0BOB' },
    allowedActs: ['reply'],
  });
});

test("a DM is ruled by the person's U rule when no D rule exists", () => {
  const settings = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, acts: ['post', 'reply', 'reaction'] },
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'U0BOB', acts: ['reaction'] },
  ]);
  assert.deepEqual(allowedAct(settings, slack([['D0BOB', 'U0BOB']], ['post'])), {
    allowed: false,
    act: 'post',
    place: 'U0BOB',
    rule: { account: 'acme/slack', conversation: 'U0BOB' },
    allowedActs: ['reaction'],
  });
  // A DM with somebody else has the account's rule.
  assert.equal(allowedAct(settings, slack([['D0ANN', 'U0ANN']], ['post'])).allowed, true);
});

test('every place must allow every act', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@client.test', acts: ['reply'] },
  ]);
  // One recipient allowed, one in a domain that forbids send: the whole send is refused, naming the second.
  assert.deepEqual(allowedAct(settings, mail(['ann@ok.test', 'bob@client.test'], ['send'])), {
    allowed: false,
    act: 'send',
    place: 'bob@client.test',
    rule: { account: 'acme/gmail', conversation: '@client.test' },
    allowedActs: ['reply'],
  });
  // In the other order too.
  const reversed = allowedAct(settings, mail(['bob@client.test', 'ann@ok.test'], ['send']));
  assert.equal(reversed.allowed, false);
  assert.equal(!reversed.allowed && reversed.place, 'bob@client.test');
  // Allowed everywhere: what is allowed across them all, and the rule that narrowed it.
  assert.deepEqual(allowedAct(settings, mail(['ann@ok.test', 'bob@client.test'], ['reply'])), {
    allowed: true,
    rule: { account: 'acme/gmail', conversation: '@client.test' },
    allowedActs: ['reply'],
  });
});

test('a file in a thread needs file and reply', () => {
  const replyOnly = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'C0GENERAL', acts: ['reply'] },
  ]);
  assert.deepEqual(allowedAct(replyOnly, slack([['C0GENERAL']], ['reply', 'file'])), {
    allowed: false,
    act: 'file',
    place: 'C0GENERAL',
    rule: { account: 'acme/slack', conversation: 'C0GENERAL' },
    allowedActs: ['reply'],
  });
  const topLevelFiles = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'C0GENERAL', acts: ['post', 'file'] },
  ]);
  const inThread = allowedAct(topLevelFiles, slack([['C0GENERAL']], ['reply', 'file']));
  assert.equal(inThread.allowed, false);
  assert.equal(!inThread.allowed && inThread.act, 'reply');
  assert.equal(allowedAct(topLevelFiles, slack([['C0GENERAL']], ['post', 'file'])).allowed, true);
  const threadFiles = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'C0GENERAL', acts: ['reply', 'file'] },
  ]);
  assert.equal(allowedAct(threadFiles, slack([['C0GENERAL']], ['reply', 'file'])).allowed, true);
  assert.equal(allowedAct(threadFiles, slack([['C0GENERAL']], ['post', 'file'])).allowed, false);
});

test('an empty acts list allows nothing', () => {
  const settings = withRules([{ account: 'acme/slack', accountId: SLACK_ID, acts: [] }]);
  for (const act of BEHAVIOUR_ACTS) {
    assert.deepEqual(allowedAct(settings, slack([['C0GENERAL']], [act])), {
      allowed: false,
      act,
      place: 'C0GENERAL',
      rule: { account: 'acme/slack' },
      allowedActs: [],
    });
  }
});

test('an orphaned rule applies by name', () => {
  // Its id is held by no account here — the account it was added for was removed and connected again.
  const orphan = withRules([{ account: 'acme/slack', accountId: GONE_ID, acts: ['reply'] }]);
  assert.deepEqual(allowedAct(orphan, slack([['C0GENERAL']], ['post'])), {
    allowed: false,
    act: 'post',
    place: 'C0GENERAL',
    rule: { account: 'acme/slack' },
    allowedActs: ['reply'],
  });
  // One whose id another account holds binds to that account, whatever name it carries.
  const bound = withRules([{ account: 'acme/slack', accountId: GMAIL_ID, acts: ['reply'] }]);
  assert.equal(allowedAct(bound, slack([['C0GENERAL']], ['post'])).allowed, true);
  assert.equal(allowedAct(bound, mail(['bob@client.test'], ['send'])).allowed, false);
  // And one that carries no id at all matches by name.
  const unbound = withRules([{ account: 'acme/slack', acts: ['reply'] }]);
  assert.equal(allowedAct(unbound, slack([['C0GENERAL']], ['post'])).allowed, false);
});

test('an unknown act narrows its rule', () => {
  const settings = withRules([{ account: 'acme/slack', accountId: SLACK_ID, acts: ['reply', 'teleport', 7, 'reply'] }]);
  const read = readBehaviourSettings(settings);
  assert.deepEqual(read.rules, [{ account: 'acme/slack', accountId: SLACK_ID, acts: ['reply'] }]);
  assert.deepEqual(read.unreadable, []);
  assert.equal(allowedAct(settings, slack([['C0GENERAL']], ['reply'])).allowed, true);
  assert.equal(allowedAct(settings, slack([['C0GENERAL']], ['post'])).allowed, false);
  // A rule of nothing but unknown acts allows nothing.
  const none = withRules([{ account: 'acme/slack', accountId: SLACK_ID, acts: ['teleport'] }]);
  assert.deepEqual(readBehaviourSettings(none).rules[0]?.acts, []);
  assert.equal(allowedAct(none, slack([['C0GENERAL']], ['reply'])).allowed, false);
});

test('an unreadable rule makes its account allow nothing, and others keep theirs', () => {
  const settings = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, acts: 'reply' },
    { account: 'acme/gmail', accountId: GMAIL_ID, acts: ['send'] },
  ]);
  const read = readBehaviourSettings(settings);
  assert.deepEqual(read.rules, [{ account: 'acme/gmail', accountId: GMAIL_ID, acts: ['send'] }]);
  assert.equal(read.unreadable.length, 1);
  assert.equal(read.unreadable[0]?.account, 'acme/slack');
  assert.match(read.unreadable[0]?.reason ?? '', /acts/);
  for (const act of BEHAVIOUR_ACTS) {
    assert.deepEqual(allowedAct(settings, slack([['C0GENERAL']], [act])), {
      allowed: false,
      act,
      place: 'C0GENERAL',
      rule: { account: 'acme/slack' },
      allowedActs: [],
    });
  }
  assert.equal(allowedAct(settings, mail(['bob@client.test'], ['send'])).allowed, true);

  // Every bad shape is unreadable, and names its account where it has one.
  const shapes: [unknown, string | null][] = [
    [{ account: 'acme/slack', acts: ['reply'], conversation: '#general' }, 'acme/slack'],
    [{ account: 'acme/slack', acts: ['reply'], conversation: '' }, 'acme/slack'],
    [{ account: 'acme/slack', acts: ['reply'], accountId: 42 }, 'acme/slack'],
    [{ account: 'acme/slack' }, 'acme/slack'],
    [{ account: '', acts: [] }, null],
    [{ acts: ['reply'] }, null],
    ['acme/slack', null],
    [null, null],
    [['acme/slack'], null],
  ];
  for (const [rule, named] of shapes) {
    const one = readBehaviourSettings(withRules([rule]));
    assert.deepEqual(one.rules, [], JSON.stringify(rule));
    assert.equal(one.unreadable.length, 1, JSON.stringify(rule));
    assert.equal(one.unreadable[0]?.account, named, JSON.stringify(rule));
  }
  // One that names no account could have been meant for any of them, so every account allows nothing.
  for (const behaviour of [{ rules: [42] }, { rules: 'none' }, 'off', null, []]) {
    const settingsOf = config(behaviour);
    assert.equal(readBehaviourSettings(settingsOf).unreadable[0]?.account, null, JSON.stringify(behaviour));
    assert.equal(allowedAct(settingsOf, slack([['C0GENERAL']], ['reply'])).allowed, false, JSON.stringify(behaviour));
    assert.equal(allowedAct(settingsOf, mail(['bob@client.test'], ['send'])).allowed, false, JSON.stringify(behaviour));
  }
  // An unreadable rule carrying its account's id binds by it too, so a rename does not shed it.
  const byId = withRules([{ account: 'acme/old-name', accountId: SLACK_ID, acts: 'reply' }]);
  assert.equal(readBehaviourSettings(byId).unreadable[0]?.accountId, SLACK_ID);
  assert.equal(allowedAct(byId, slack([['C0GENERAL']], ['reply'])).allowed, false);
});

test('readBehaviourSettings never throws, and returns copies', () => {
  const stored = { account: 'acme/slack', accountId: SLACK_ID, conversation: 'C0GENERAL', acts: ['reply'] };
  const settings = withRules([stored]);
  const read = readBehaviourSettings(settings);
  read.rules[0]?.acts.push('post');
  assert.deepEqual(readBehaviourSettings(settings).rules[0]?.acts, ['reply']);
  const cyclic: Record<string, unknown> = { account: 'acme/slack', acts: ['reply'] };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => readBehaviourSettings(Object.assign(config(), { behaviour: { rules: [cyclic] } })));
  // Nor does a value that throws when read.
  const hostile = config();
  Object.defineProperty(hostile, 'behaviour', {
    get(): unknown {
      throw new Error('no');
    },
  });
  assert.equal(readBehaviourSettings(hostile).unreadable.length, 1);
  assert.equal(allowedAct(hostile, slack([['C0GENERAL']], ['reply'])).allowed, false);
});

test('addresses and domains match regardless of case', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@Client.TEST', acts: ['reply'] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'Ann@Partner.TEST', acts: ['reply'] },
  ]);
  // Stored lower-cased, as the label's are.
  assert.deepEqual(
    readBehaviourSettings(settings).rules.map((rule) => rule.conversation),
    ['@client.test', 'ann@partner.test'],
  );
  for (const recipient of ['Bob@Client.TEST', 'bob@client.test', 'BOB@CLIENT.TEST']) {
    const decision = allowedAct(settings, mail([recipient], ['send']));
    assert.equal(decision.allowed, false, recipient);
    assert.deepEqual(!decision.allowed && decision.rule, { account: 'acme/gmail', conversation: '@client.test' });
  }
  assert.equal(allowedAct(settings, mail(['ANN@partner.test'], ['send'])).allowed, false);
  // The domain is what follows the last @: a quoted local part cannot hide it.
  assert.equal(allowedAct(settings, mail(['"x@y"@client.test'], ['send'])).allowed, false);
});

/*
 * One domain has more than one spelling: Unicode and its ASCII (punycode) form, and with or without the trailing dot of
 * a fully qualified name. Resend keeps a recipient's domain in ASCII, so a rule written `@bücher.example` compared as written
 * would never meet `kunde@xn--bcher-kva.example`, and the restriction would silently not hold. Both sides are compared in one
 * form — lower-cased, one trailing dot off, the domain in ASCII — so every spelling meets every other.
 */
test('a Unicode rule holds a recipient whose domain is in ASCII (punycode)', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@Bücher.EXAMPLE', acts: [] },
  ]);
  assert.deepEqual(
    readBehaviourSettings(settings).rules.map((rule) => rule.conversation),
    ['@xn--bcher-kva.example'],
    'kept in the one form it is compared in',
  );
  for (const recipient of ['kunde@xn--bcher-kva.example', 'Kunde@XN--BCHER-KVA.EXAMPLE', 'kunde@bücher.example']) {
    const decision = allowedAct(settings, mail([recipient], ['send']));
    assert.equal(decision.allowed, false, recipient);
    assert.equal(!decision.allowed && decision.place, recipient, 'the refusal names the recipient as it was given');
  }
  assert.equal(
    allowedAct(settings, mail(['kunde@buecher.example'], ['send'])).allowed,
    true,
    'another domain is not it',
  );
});

test('a punycode rule holds a recipient whose domain is in Unicode, an address rule as well as a domain rule', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@xn--mnchen-3ya.example', acts: [] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'Ann@XN--BCHER-KVA.example', acts: ['reply'] },
  ]);
  assert.equal(allowedAct(settings, mail(['amt@münchen.example'], ['send'])).allowed, false);
  assert.equal(allowedAct(settings, mail(['amt@MÜNCHEN.example'], ['send'])).allowed, false);
  assert.equal(allowedAct(settings, mail(['ann@bücher.example'], ['send'])).allowed, false);
  assert.equal(allowedAct(settings, mail(['ann@bücher.example'], ['reply'])).allowed, true);
});

test('a trailing dot names the same domain, on the rule and on the recipient', () => {
  const dotted = withRules([{ account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@client.test.', acts: [] }]);
  assert.deepEqual(
    readBehaviourSettings(dotted).rules.map((rule) => rule.conversation),
    ['@client.test'],
  );
  assert.equal(allowedAct(dotted, mail(['bob@client.test'], ['send'])).allowed, false);
  const plain = withRules([{ account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@client.test', acts: [] }]);
  for (const recipient of ['bob@client.test.', 'Bob@Client.TEST.']) {
    assert.equal(allowedAct(plain, mail([recipient], ['send'])).allowed, false, recipient);
  }
  const address = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'bob@client.test.', acts: [] },
  ]);
  assert.equal(allowedAct(address, mail(['bob@client.test'], ['send'])).allowed, false);
});

test('a rule whose domain is not one is unreadable, so its account allows nothing', () => {
  for (const conversation of ['@exa|mple.com', 'bob@xn--a.test', '@client.test..', '@.', 'bob@a%b.test']) {
    const settings = withRules([
      { account: 'acme/gmail', accountId: GMAIL_ID, conversation, acts: ['send'] },
      { account: 'acme/slack', accountId: SLACK_ID, acts: ['reply'] },
    ]);
    const read = readBehaviourSettings(settings);
    assert.deepEqual(
      read.rules.map((rule) => rule.account),
      ['acme/slack'],
      conversation,
    );
    assert.equal(read.unreadable.length, 1, conversation);
    assert.equal(read.unreadable[0]?.account, 'acme/gmail', conversation);
    assert.match(read.unreadable[0]?.reason ?? '', /domain/, conversation);
    assert.ok(!(read.unreadable[0]?.reason ?? '').includes(conversation), 'nothing from the file is repeated');
    // Fail closed: the mailbox allows nothing, anywhere; the workspace keeps its own rule.
    for (const recipient of ['bob@client.test', 'ann@elsewhere.test']) {
      const decision = allowedAct(settings, mail([recipient], ['send']));
      assert.equal(decision.allowed, false, `${conversation} → ${recipient}`);
      assert.deepEqual(!decision.allowed && decision.allowedActs, []);
    }
    assert.equal(allowedAct(settings, slack([['C0GENERAL']], ['reply'])).allowed, true);
  }
});

test('a recipient whose domain is not one meets only its account rule', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, acts: ['reply'] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@exa.test', acts: ['reply', 'send'] },
  ]);
  const decision = allowedAct(settings, mail(['bob@exa|.test'], ['send']));
  assert.equal(decision.allowed, false);
  assert.deepEqual(!decision.allowed && decision.rule, { account: 'acme/gmail' }, 'the account rule decides');
  assert.equal(allowedAct(settings, mail(['bob@exa.test'], ['send'])).allowed, true);
});

/*
 * An address has more spellings than its case (lead's call, after review): `ceo+x@client.test` reaches the mailbox of
 * `ceo@client.test`, and Gmail ignores dots and reads `googlemail.com` as `gmail.com`. A rule written one way held none
 * of the others, so an agent could reach the person a rule names by writing their address another way.
 */
test('an address rule holds every +tag of the address, on the rule and on the recipient', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, acts: ['send', 'reply'] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'ceo@client.test', acts: [] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'cfo+board@client.test', acts: [] },
  ]);
  for (const recipient of ['ceo+x@client.test', 'CEO+Board@Client.TEST', 'ceo@client.test', 'cfo@client.test']) {
    const decision = allowedAct(settings, mail([recipient], ['send']));
    assert.equal(decision.allowed, false, recipient);
    assert.equal(!decision.allowed && decision.place, recipient, 'the refusal names the recipient as it was given');
  }
  assert.equal(allowedAct(settings, mail(['cfo+other@client.test'], ['send'])).allowed, false, 'a tag on both sides');
  // Not another mailbox: dots count outside Gmail, and a tag is only what follows the first `+` after a name.
  for (const recipient of ['c.e.o@client.test', 'ceox@client.test', 'ceo@eu.client.test']) {
    assert.equal(allowedAct(settings, mail([recipient], ['send'])).allowed, true, recipient);
  }
});

test('at Gmail, dots and googlemail.com reach the same mailbox, for an address rule and a domain rule', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'jo.lee@gmail.com', acts: [] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@googlemail.com', acts: ['reply'] },
  ]);
  for (const recipient of ['jolee@gmail.com', 'j.o.l.e.e@googlemail.com', 'Jo.Lee+news@GoogleMail.com']) {
    const decision = allowedAct(settings, mail([recipient], ['reply']));
    assert.equal(decision.allowed, false, recipient);
    assert.deepEqual(!decision.allowed && decision.rule, { account: 'acme/gmail', conversation: 'jo.lee@gmail.com' });
  }
  // Another Gmail address is the domain rule's, written for googlemail.com and holding gmail.com.
  assert.deepEqual(allowedAct(settings, mail(['sam@gmail.com'], ['send'])), {
    allowed: false,
    act: 'send',
    place: 'sam@gmail.com',
    rule: { account: 'acme/gmail', conversation: '@googlemail.com' },
    allowedActs: ['reply'],
  });
});

test('a domain rule covers its subdomains, and a subdomain rule wins over its parent', () => {
  const settings = withRules([
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@client.test', acts: [] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@eu.client.test', acts: ['reply', 'send'] },
    { account: 'acme/gmail', accountId: GMAIL_ID, conversation: 'boss@eu.client.test', acts: ['reply'] },
  ]);
  // The parent's rule holds a subdomain no rule of its own names, however deep.
  for (const recipient of ['x@us.client.test', 'x@a.b.client.test', 'x@client.test']) {
    const decision = allowedAct(settings, mail([recipient], ['reply']));
    assert.equal(decision.allowed, false, recipient);
    assert.deepEqual(!decision.allowed && decision.rule, { account: 'acme/gmail', conversation: '@client.test' });
  }
  // The longest domain that covers the recipient wins, here and in a subdomain of it.
  for (const recipient of ['ana@eu.client.test', 'ana@paris.eu.client.test']) {
    assert.deepEqual(
      allowedAct(settings, mail([recipient], ['send'])),
      {
        allowed: true,
        rule: { account: 'acme/gmail', conversation: '@eu.client.test' },
        allowedActs: ['reply', 'send'],
      },
      recipient,
    );
  }
  // An address over every domain.
  const boss = allowedAct(settings, mail(['boss@eu.client.test'], ['send']));
  assert.deepEqual(!boss.allowed && boss.rule, { account: 'acme/gmail', conversation: 'boss@eu.client.test' });
  // A name that only ends the same way is not a subdomain.
  assert.equal(allowedAct(settings, mail(['x@otherclient.test'], ['send'])).allowed, true);
  // Changing the subdomain's rule is measured where it holds: widening it past its parent loosens.
  const before = readBehaviourSettings(
    withRules([{ account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@client.test', acts: [] }]),
  );
  const after = readBehaviourSettings(settings);
  const change = classifyBehaviourChange(before, after, {
    before: [{ id: GMAIL_ID, account: 'acme/gmail' }],
    after: [{ id: GMAIL_ID, account: 'acme/gmail' }],
  });
  assert.equal(change.loosens, true);
  assert.ok(
    change.deltas.some(
      (delta) => delta.scope.conversation === '@eu.client.test' && delta.before.length === 0 && delta.after !== 'all',
    ),
    JSON.stringify(change.deltas),
  );
});

/*
 * A Slack post may name its channel by name — Slack resolves `eng` or `#eng` to a room — and a place that is not a
 * conversation id met no conversation rule, only the account's: `{C0ENG: [reply]}` let a post into #eng named so. The
 * channels refuse such a destination at prepare; beneath that, every rule of the account holds it (lead's call, after
 * review), as a DM whose person could not be read is held to every person's rule.
 */
test('a Slack place that is no conversation id is held to every rule of its account', () => {
  const settings = withRules([
    { account: 'acme/slack', accountId: SLACK_ID, acts: ['post', 'reply', 'reaction'] },
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'C0ENG', acts: ['reply', 'reaction'] },
    { account: 'acme/slack', accountId: SLACK_ID, conversation: 'C0RANDOM', acts: ['post', 'reaction'] },
  ]);
  for (const place of ['eng', '#eng', 'c0eng', 'general', 'C0ENG ', '']) {
    for (const act of ['post', 'reply'] as const) {
      const decision = allowedAct(settings, slack([[place]], [act]));
      assert.equal(decision.allowed, false, `${JSON.stringify(place)} ${act}`);
    }
    // What every rule allows is allowed: a reaction, here.
    assert.equal(allowedAct(settings, slack([[place]], ['reaction'])).allowed, true, JSON.stringify(place));
  }
  // The ids themselves are as they were.
  assert.equal(allowedAct(settings, slack([['C0ENG']], ['reply'])).allowed, true);
  assert.equal(allowedAct(settings, slack([['C0RANDOM']], ['post'])).allowed, true);
  // With no rule at all, nothing holds it: everything, as before.
  assert.equal(allowedAct(withRules([]), slack([['eng']], ['post'])).allowed, true);
  // A mail place is not a Slack one.
  assert.equal(
    allowedAct(
      withRules([{ account: 'acme/gmail', accountId: GMAIL_ID, conversation: '@client.test', acts: [] }]),
      mail(['bob@other.test'], ['send']),
    ).allowed,
    true,
  );
});

/*
 * A rule whose account name no account here could ever have held nothing, silently: `*`, a name in capitals, a name in
 * the other version's grammar, a former name (never given again). A former name of an account still here holds that
 * account; any other such rule is unreadable, and with no account it can name it holds every account (lead's call,
 * after review).
 */
test('a rule naming an account no account could ever have is unreadable, and holds every account', () => {
  for (const name of ['*', 'Acme/Gmail', 'acme', 'acme/gmail ', 'acme/Slack']) {
    const settings = withRules([{ account: name, acts: ['reply'] }]);
    const read = readBehaviourSettings(settings);
    assert.deepEqual(read.rules, [], name);
    assert.equal(read.unreadable.length, 1, name);
    assert.equal(read.unreadable[0]?.account, null, `${name}: it names no account, so it holds every account`);
    assert.ok(!(read.unreadable[0]?.reason ?? '').includes(name), 'nothing from the file is repeated');
    assert.equal(allowedAct(settings, slack([['C0GENERAL']], ['reply'])).allowed, false, name);
    assert.equal(allowedAct(settings, mail(['bob@client.test'], ['reply'])).allowed, false, name);
  }
  // In a version-1 configuration, a plain name is a name an account can have, and the other grammar is not.
  const plain = (account: string): Config =>
    parseConfig(
      JSON.stringify({
        version: 1,
        inboxes: { acme: inbox },
        accounts: {},
        behaviour: { rules: [{ account, acts: ['reply'] }] },
      }),
    );
  assert.deepEqual(readBehaviourSettings(plain('acme')).unreadable, []);
  assert.deepEqual(readBehaviourSettings(plain('gone')).unreadable, [], 'an orphan by a name an account may have');
  assert.equal(readBehaviourSettings(plain('acme/gmail')).unreadable[0]?.account, null);
});

test('a former name holds the account it names now, and one whose account is gone holds every account', () => {
  const named = (rules: unknown[], formerNames: unknown): Config =>
    parseConfig(
      JSON.stringify({
        version: 2,
        inboxes: { 'acme/gmail': inbox },
        accounts: { 'acme/slack': account },
        formerNames,
        behaviour: { rules },
      }),
    );
  const formerNames = {
    inboxes: { acme: { name: 'acme/gmail', id: GMAIL_ID }, 'old/gmail': { name: 'old/gmail-2', id: GONE_ID } },
    accounts: {},
  };
  // The mailbox was `acme`: a rule left under that name holds it, and nothing else.
  const renamed = named([{ account: 'acme', acts: ['reply'] }], formerNames);
  assert.deepEqual(readBehaviourSettings(renamed).rules, [{ account: 'acme/gmail', acts: ['reply'] }]);
  assert.equal(allowedAct(renamed, mail(['bob@client.test'], ['send'])).allowed, false);
  assert.equal(allowedAct(renamed, slack([['C0GENERAL']], ['post'])).allowed, true);
  // A former name whose account is gone can never be given again: it holds every account.
  const gone = named([{ account: 'old/gmail', acts: ['reply'] }], formerNames);
  assert.equal(readBehaviourSettings(gone).unreadable[0]?.account, null);
  assert.equal(allowedAct(gone, slack([['C0GENERAL']], ['reply'])).allowed, false);
});

const ruleSet = (rules: BehaviourSettings['rules']): BehaviourSettings => ({ rules, unreadable: [] });

test('classify: a subset tightens; adding an act, removing a rule, or a conversation wider than its account loosens', () => {
  const account = (acts: BehaviourSettings['rules'][number]['acts']) => ({
    account: 'acme/slack',
    accountId: SLACK_ID,
    acts,
  });
  const channel = (acts: BehaviourSettings['rules'][number]['acts']) => ({
    account: 'acme/slack',
    accountId: SLACK_ID,
    conversation: 'C0GENERAL',
    acts,
  });

  // A subset tightens.
  assert.deepEqual(
    classifyBehaviourChange(ruleSet([account(['post', 'reply', 'reaction'])]), ruleSet([account(['reply'])])),
    {
      loosens: false,
      deltas: [{ scope: { account: 'acme/slack' }, before: ['post', 'reply', 'reaction'], after: ['reply'] }],
    },
  );
  // The first rule tightens from everything.
  assert.deepEqual(classifyBehaviourChange(ruleSet([]), ruleSet([account(['reply'])])), {
    loosens: false,
    deltas: [{ scope: { account: 'acme/slack' }, before: 'all', after: ['reply'] }],
  });
  // Nothing moved, nothing to say.
  assert.deepEqual(classifyBehaviourChange(ruleSet([account(['reply'])]), ruleSet([account(['reply'])])), {
    loosens: false,
    deltas: [],
  });

  // Adding an act loosens.
  assert.deepEqual(classifyBehaviourChange(ruleSet([account(['reply'])]), ruleSet([account(['reply', 'post'])])), {
    loosens: true,
    deltas: [{ scope: { account: 'acme/slack' }, before: ['reply'], after: ['post', 'reply'] }],
  });
  // Removing a rule loosens.
  assert.deepEqual(classifyBehaviourChange(ruleSet([account(['reply'])]), ruleSet([])), {
    loosens: true,
    deltas: [{ scope: { account: 'acme/slack' }, before: ['reply'], after: 'all' }],
  });
  // A conversation rule wider than its account's loosens, at that conversation.
  assert.deepEqual(
    classifyBehaviourChange(ruleSet([account(['reply'])]), ruleSet([account(['reply']), channel(['post', 'reply'])])),
    {
      loosens: true,
      deltas: [
        { scope: { account: 'acme/slack', conversation: 'C0GENERAL' }, before: ['reply'], after: ['post', 'reply'] },
      ],
    },
  );
  // One no wider tightens, or moves nothing.
  assert.equal(
    classifyBehaviourChange(
      ruleSet([account(['post', 'reply'])]),
      ruleSet([account(['post', 'reply']), channel(['reply'])]),
    ).loosens,
    false,
  );
  // Removing a conversation rule loosens unless the account rule it falls back to is no wider.
  assert.deepEqual(
    classifyBehaviourChange(ruleSet([account(['reply']), channel(['post', 'reply'])]), ruleSet([account(['reply'])])),
    {
      loosens: false,
      deltas: [
        { scope: { account: 'acme/slack', conversation: 'C0GENERAL' }, before: ['post', 'reply'], after: ['reply'] },
      ],
    },
  );
  assert.deepEqual(
    classifyBehaviourChange(
      ruleSet([account(['post', 'reply']), channel(['reply'])]),
      ruleSet([account(['post', 'reply'])]),
    ),
    {
      loosens: true,
      deltas: [
        { scope: { account: 'acme/slack', conversation: 'C0GENERAL' }, before: ['reply'], after: ['post', 'reply'] },
      ],
    },
  );
  // A domain rule removed under an address rule moves the domain, not the address.
  const gmail = (conversation: string | undefined, acts: BehaviourSettings['rules'][number]['acts']) => ({
    account: 'acme/gmail',
    accountId: GMAIL_ID,
    ...(conversation === undefined ? {} : { conversation }),
    acts,
  });
  assert.deepEqual(
    classifyBehaviourChange(
      ruleSet([gmail('@client.test', ['reply']), gmail('bob@client.test', ['reply'])]),
      ruleSet([gmail('bob@client.test', ['reply'])]),
    ),
    {
      loosens: true,
      deltas: [{ scope: { account: 'acme/gmail', conversation: '@client.test' }, before: ['reply'], after: 'all' }],
    },
  );
});

test('classify: a DM loosened by removing its D rule is a loosening, though no single level widened', () => {
  const rule = (conversation: string | undefined, acts: BehaviourSettings['rules'][number]['acts']) => ({
    account: 'acme/slack',
    accountId: SLACK_ID,
    ...(conversation === undefined ? {} : { conversation }),
    acts,
  });
  // The DM with Bob was reply only (D ∩ U); with the D rule gone it is the U rule's reply and reaction.
  const before = ruleSet([
    rule(undefined, ['reply']),
    rule('D0BOB', ['post', 'reply']),
    rule('U0BOB', ['reply', 'reaction']),
  ]);
  const after = ruleSet([rule(undefined, ['reply']), rule('U0BOB', ['reply', 'reaction'])]);
  const { loosens, deltas } = classifyBehaviourChange(before, after);
  assert.equal(loosens, true);
  assert.deepEqual(deltas, [
    { scope: { account: 'acme/slack', conversation: 'D0BOB' }, before: ['post', 'reply'], after: ['reply'] },
    {
      scope: { account: 'acme/slack', conversation: 'D0BOB with U0BOB' },
      before: ['reply'],
      after: ['reply', 'reaction'],
    },
  ]);
});

test('classify: an unreadable rule counts as nothing allowed, so fixing it loosens and breaking it tightens', () => {
  const readable = ruleSet([{ account: 'acme/slack', accountId: SLACK_ID, acts: ['reply'] }]);
  const broken: BehaviourSettings = {
    rules: [],
    unreadable: [{ account: 'acme/slack', accountId: SLACK_ID, reason: 'x' }],
  };
  assert.deepEqual(classifyBehaviourChange(broken, readable), {
    loosens: true,
    deltas: [{ scope: { account: 'acme/slack' }, before: [], after: ['reply'] }],
  });
  assert.equal(classifyBehaviourChange(readable, broken).loosens, false);
  // One that names no account holds every account, and any account no rule names.
  const everywhere: BehaviourSettings = { rules: [], unreadable: [{ account: null, reason: 'x' }] };
  const fixed = classifyBehaviourChange(everywhere, ruleSet([]));
  assert.equal(fixed.loosens, true);
  assert.deepEqual(fixed.deltas, [{ scope: { account: '*' }, before: [], after: 'all' }]);
});

test('classify: with the accounts given, a rename moves nothing and a new account is measured by its name', () => {
  const rule = {
    account: 'acme/slack',
    accountId: SLACK_ID,
    acts: ['reply'] as BehaviourSettings['rules'][number]['acts'],
  };
  const renamed = { ...rule, account: 'acme/slack-main' };
  assert.deepEqual(
    classifyBehaviourChange(ruleSet([rule]), ruleSet([renamed]), {
      before: [{ id: SLACK_ID, account: 'acme/slack' }],
      after: [{ id: SLACK_ID, account: 'acme/slack-main' }],
    }),
    { loosens: false, deltas: [] },
  );
  // An orphan by name, then an account connected under that name: it was ruled before it existed, so nothing loosens.
  const orphan = { account: 'acme/slack', accountId: GONE_ID, acts: rule.acts };
  assert.deepEqual(
    classifyBehaviourChange(ruleSet([orphan]), ruleSet([orphan]), {
      before: [],
      after: [{ id: SLACK_ID, account: 'acme/slack' }],
    }),
    { loosens: false, deltas: [] },
  );
  // An account removed with its rule loosened in the same write is still a loosening.
  assert.equal(
    classifyBehaviourChange(ruleSet([rule]), ruleSet([{ ...rule, acts: ['post', 'reply'] }]), {
      before: [{ id: SLACK_ID, account: 'acme/slack' }],
      after: [],
    }).loosens,
    true,
  );
  // An account removed and nothing else: its rules stay, as an orphan, and nothing loosens.
  assert.equal(
    classifyBehaviourChange(ruleSet([rule]), ruleSet([rule]), {
      before: [{ id: SLACK_ID, account: 'acme/slack' }],
      after: [],
    }).loosens,
    false,
  );
});
