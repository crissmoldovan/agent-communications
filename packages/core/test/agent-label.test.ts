import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_LABEL_WORDS,
  type AgentLabelRule,
  type AgentLabelSettings,
  classifyAgentLabelChange,
  fallbackLabelLine,
  fallbackTextPrefix,
  labelPhrase,
  readAgentLabelSettings,
  resolveIdentity,
} from '../src/agent-label.ts';

test('L2: the word list is fixed, in this order, with agent first', () => {
  assert.deepEqual([...AGENT_LABEL_WORDS], ['agent', 'assistant', 'twin', 'minion', 'bot', 'fake', 'AI']);
});

test('L1: the phrase is the name and the word in parentheses, never labelled twice', () => {
  assert.equal(labelPhrase('Cristian Moldovan', 'agent', 80), 'Cristian Moldovan (agent)');
  assert.equal(labelPhrase('Cristian Moldovan (twin)', 'twin', 80), 'Cristian Moldovan (twin)');
  assert.equal(labelPhrase('Acme Billing', 'AI', 100), 'Acme Billing (AI)');
});

test('L2: a phrase over the platform limit is refused, naming the limit, and never cut short', () => {
  assert.throws(() => labelPhrase('x'.repeat(75), 'assistant', 80), /80 characters/u);
});

test('L2: a name with parentheses, address characters or a hidden character is refused', () => {
  for (const name of [
    'Cristian (me)',
    'a<b',
    'a@b',
    'a,b',
    'a;b',
    'a:b',
    'a"b',
    'a\\b',
    'Cris‮tian',
    'Cris​tian',
    '',
    ' Cris',
    'Cris ',
  ]) {
    assert.throws(() => labelPhrase(name, 'agent', 80), /name/u, JSON.stringify(name));
  }
});

const settings = (rules: readonly AgentLabelRule[]): AgentLabelSettings => ({ rules });

test('L3: the message wins over a rule, a rule over the default, and the default is agent', () => {
  const s = settings([{ account: 'cue/slack', as: 'me' }]);
  assert.deepEqual(resolveIdentity(undefined, { account: 'cue/slack', kind: 'post' }), {
    identity: 'agent',
    source: 'default',
  });
  assert.deepEqual(resolveIdentity(s, { account: 'cue/slack', kind: 'post' }), {
    identity: 'me',
    source: 'rule',
    rule: { account: 'cue/slack', as: 'me' },
  });
  assert.deepEqual(resolveIdentity(s, { account: 'cue/slack', kind: 'post', requested: 'agent' }), {
    identity: 'agent',
    source: 'message',
  });
  assert.equal(resolveIdentity(undefined, { account: 'cue/slack', kind: 'post', requested: 'me' }).identity, 'me');
  assert.equal(resolveIdentity(s, { account: 'rgc/slack', kind: 'post' }).identity, 'agent', 'another account');
});

test('L4: the most specific matching rule wins: conversation and kinds, then conversation, then kinds, then the account', () => {
  const s = settings([
    { account: 'cue/slack', as: 'me' },
    { account: 'cue/slack', kinds: ['reaction'], as: 'agent' },
    { account: 'cue/slack', conversation: 'C1', as: 'agent' },
    { account: 'cue/slack', conversation: 'C1', kinds: ['reply'], as: 'me' },
  ]);
  const at = (kind: 'post' | 'reply' | 'reaction', channel: string) =>
    resolveIdentity(s, { account: 'cue/slack', kind, slack: { channel } }).identity;
  assert.equal(at('post', 'C2'), 'me', 'the bare account rule');
  assert.equal(at('reaction', 'C2'), 'agent', 'kinds beat the bare rule');
  assert.equal(at('post', 'C1'), 'agent', 'a conversation beats kinds');
  assert.equal(at('reply', 'C1'), 'me', 'a conversation with kinds beats a conversation');
});

test('L4: between equally specific rules, agent wins', () => {
  const s = settings([
    { account: 'cue/slack', conversation: 'C1', as: 'me' },
    { account: 'cue/slack', conversation: 'C1', as: 'agent' },
  ]);
  assert.equal(resolveIdentity(s, { account: 'cue/slack', kind: 'post', slack: { channel: 'C1' } }).identity, 'agent');
});

test('L4: a Slack rule names a channel, or the person a direct message is with', () => {
  const s = settings([{ account: 'cue/slack', conversation: 'U123', as: 'me' }]);
  assert.equal(
    resolveIdentity(s, { account: 'cue/slack', kind: 'post', slack: { channel: 'D9', dmWith: 'U123' } }).identity,
    'me',
  );
  assert.equal(
    resolveIdentity(s, { account: 'cue/slack', kind: 'post', slack: { channel: 'D8', dmWith: 'U456' } }).identity,
    'agent',
  );
});

test('L4: a mail rule matches only when every recipient matches its address or @domain, ignoring case', () => {
  const s = settings([{ account: 'cue/gmail', conversation: '@Acme.com', as: 'me' }]);
  const at = (recipients: string[]) =>
    resolveIdentity(s, { account: 'cue/gmail', kind: 'send', mail: { recipients } }).identity;
  assert.equal(at(['ana@acme.com', 'BOB@ACME.COM']), 'me');
  assert.equal(at(['ana@acme.com', 'eve@other.com']), 'agent', 'one recipient outside the rule');
  assert.equal(at([]), 'agent', 'no recipient matches nothing');
  assert.equal(at(['ana@sub.acme.com']), 'agent', 'a subdomain is a different domain');
  const exact = settings([{ account: 'cue/gmail', conversation: 'ana@acme.com', as: 'me' }]);
  assert.equal(
    resolveIdentity(exact, { account: 'cue/gmail', kind: 'reply', mail: { recipients: ['Ana@Acme.com'] } }).identity,
    'me',
  );
});

test('L5: what loosens — a me rule added, an agent rule removed, the word, the name, an icon — and what tightens', () => {
  const me = { account: 'cue/slack', as: 'me' } as const;
  const agent = { account: 'cue/slack', conversation: 'C1', as: 'agent' } as const;
  const paths = (before: AgentLabelSettings | undefined, after: AgentLabelSettings | undefined) =>
    classifyAgentLabelChange(before, after).map((change) => change.path);
  assert.deepEqual(paths(undefined, { rules: [me] }), ['agentLabel.rules']);
  assert.deepEqual(paths({ rules: [agent] }, { rules: [] }), ['agentLabel.rules']);
  assert.deepEqual(paths({ rules: [me] }, { rules: [] }), [], 'removing a me rule tightens');
  assert.deepEqual(paths(undefined, { rules: [agent] }), [], 'adding an agent rule tightens');
  assert.deepEqual(paths(undefined, { word: 'twin' }), ['agentLabel.word']);
  assert.deepEqual(paths({ word: 'twin' }, undefined), ['agentLabel.word'], 'back to agent is still a change of word');
  assert.deepEqual(paths(undefined, { name: 'Cristian Moldovan' }), ['agentLabel.name']);
  assert.deepEqual(paths(undefined, { slackIcons: { acc_A: ':criss-agent:' } }), ['agentLabel.slackIcons']);
  assert.deepEqual(paths({ word: 'twin' }, { word: 'twin' }), [], 'nothing changed');
});

test('reading stored settings fails safe: an unknown word is agent, and a malformed rule list is ignored whole', () => {
  assert.deepEqual(readAgentLabelSettings(undefined), {});
  assert.equal(readAgentLabelSettings({ word: 'human' }).word, undefined);
  assert.equal(readAgentLabelSettings({ word: 'twin' }).word, 'twin');
  const broken = readAgentLabelSettings({
    rules: [
      { account: 'cue/slack', as: 'me' },
      { account: 'cue/slack', conversation: 'C1', as: 'nobody' },
    ],
  });
  assert.equal(broken.rules, undefined, 'one bad rule drops them all, so nothing is unlabelled by a rule');
  assert.equal(readAgentLabelSettings({ name: 'Cris (me)' }).name, undefined, 'an invalid name is no name');
  assert.deepEqual(readAgentLabelSettings({ slackIcons: { acc_A: ':ok:', acc_B: 'no colons' } }).slackIcons, {
    acc_A: ':ok:',
  });
});

test('S3: the fallback carries the phrase in its context line and at the front of its text', () => {
  assert.equal(fallbackLabelLine('Cristian Moldovan (agent)'), 'Sent by Cristian Moldovan (agent)');
  assert.equal(fallbackTextPrefix('Cristian Moldovan (agent)'), 'Cristian Moldovan (agent): ');
});

test('agentLabelOf reads a configuration that has no agentLabel as the defaults', async () => {
  const { agentLabelOf } = await import('../src/agent-label.ts');
  assert.deepEqual(agentLabelOf({}), {});
  assert.equal(agentLabelOf({ agentLabel: { word: 'minion' } }).word, 'minion');
});
