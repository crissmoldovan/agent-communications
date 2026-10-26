/**
 * The locals a rule literal reads inside a test body or a helper, with values taken from the same test file, for the
 * literals a module's top level cannot evaluate as they stand. A key is `<path>#<n>`: the file and the literal's place
 * in it, counted from 1 in source order, as `sites.ts` counts it. Each expression is evaluated in the test module's own
 * scope; `__each` repeats a variant for each item of a list (`__item`), and `__replace` rewrites the literal's text
 * first. Several variants give several documents. A literal added before one of these shifts its number: the harvest
 * then reports the literal it could not evaluate, and its entry here moves with it.
 */
export default {
  'packages/events-daemon/test/b3-cli-mcp-parity.test.ts#3': [
    {
      target:
        "({ targetId: 'target-owner-fence', version: 1, kind: 'webhook', url: { kind: 'plain', value: 'https://receiver.invalid:443/events' }, approvedAddressSet: ['8.8.8.8'], signing: 'standard-webhooks', ordering: 'strict', retryLimit: 20, representation: 'plain' })",
    },
  ],
  'packages/events-daemon/test/b3-target-test.test.ts#1': [
    { target: "({ targetId: 'target-test', version: 1, kind: 'dry-run', retentionMs: 60_000 })" },
  ],
  'packages/events-daemon/test/d-source-events.test.ts#1': [
    { event: "({ type: 'slack.message.posted', version: 1 })" },
    { event: "({ type: 'resend.email.received', version: 1 })" },
    { event: "({ type: 'resend.email.status_changed', version: 1 })" },
  ],
  'packages/events-daemon/test/d-source-events.test.ts#2': [
    {
      versions: '({ createRule: (x) => x })',
      ruleInput: "({ ruleId: 'rule-d-source-slack', options: { channel: 'slack', conversations: ['C-clean'] } })",
      input: "({ source: 'slack', accountId: 'acc_CLEANSLACKEVENTS' })",
      event: "'slack.message.posted'",
      mapping: "({ accountName: { $path: '/account/name' }, channel: { $path: '/channel' } })",
    },
    {
      versions: '({ createRule: (x) => x })',
      ruleInput: "({ ruleId: 'rule-d-source-whatsapp', options: { channel: 'whatsapp', chats: 'all-allowed' } })",
      input: "({ source: 'whatsapp', accountId: 'acc_GHIJKLMNOPQRSTUV' })",
      event: "'whatsapp.message.received'",
      mapping: "({ chatKind: { $path: '/chat/kind' } })",
    },
    {
      versions: '({ createRule: (x) => x })',
      ruleInput: "({ ruleId: 'rule-d-source-resend', options: { channel: 'resend', kinds: ['received', 'status'] } })",
      input: "({ source: 'resend', accountId: 'acc_DEFGHIJKLMNOPQRS' })",
      event: "'resend.email.received'",
      mapping: "({ constant: 'safe' })",
    },
  ],
  'packages/events-daemon/test/d-source-replacement.test.ts#1': [
    { __each: 'cases', entry: '__item', version: '1', old: 'true' },
    { __each: 'cases', entry: '__item', version: '2', old: 'false' },
  ],
  'packages/events-daemon/test/d-source-taint-fence.test.ts#1': [
    { versions: '({ createRule: (x) => x })', accountId: "'acc_ABCDEFGHIJKLMNOP'" },
  ],
  'packages/events-daemon/test/d-source-write-fence.test.ts#1': [
    {
      __each: "['slack', 'resend', 'whatsapp']",
      source: '__item',
      accountId: "'d9-' + __item",
      id: "'d9-evaluate-' + __item",
      event:
        "(__item === 'slack' ? slackMessagePostedV1 : __item === 'resend' ? resendEmailReceivedV1 : whatsappMessageReceivedV1)",
      options:
        "(__item === 'slack' ? { channel: 'slack', conversations: ['C-d9'] } : __item === 'resend' ? { channel: 'resend', kinds: ['received'] } : { channel: 'whatsapp', chats: ['chat@example.test'] })",
    },
  ],
  'packages/events-daemon/test/disclosure-fence.test.ts#2': [
    { source: "({ channel: 'slack', conversations: ['C00000001'] })", version: '1' },
    { source: "({ channel: 'slack', conversations: ['C00000001', 'C00000002'] })", version: '2' },
  ],
  'packages/events-daemon/test/event-identity-ingest.test.ts#1': [
    {
      accountId: "'ibx_ABCDEFGHIJKLMNOP'",
      target: "({ targetId: 'target-identity', version: 1, kind: 'dry-run', retentionMs: 3_600_000 })",
    },
  ],
  'packages/events-daemon/test/event-taint-platform.test.ts#1': [
    { __each: 'channelCases()', input: '__item', agentic: 'false' },
    { __each: 'channelCases()', input: '__item', agentic: 'true' },
  ],
  'packages/events-daemon/test/judge-final-e2e.test.ts#1': [
    {
      setup:
        "({ ids: { ruleId: 'rule-e13-owner', accountId: 'ibx_E13OWNERAAAAAAA', judgeId: 'judge-e13-owner', targetId: 'target-e13-owner' } })",
      judge:
        "({ judgeId: 'judge-e13-owner', version: 1, kind: 'local-endpoint', provider: 'ollama', model: 'e13-owner-model', endpoint: 'http://127.0.0.1:49200/v1/systemone', approvedAddressSet: ['127.0.0.1'], promptTemplate: 'ollama-noul-v1', protocol: 'noul' })",
      target: "({ targetId: 'target-e13-owner', version: 1, kind: 'dry-run', retentionMs: 3_600_000 })",
      onUncertain: "'hold'",
    },
  ],
  'packages/events-daemon/test/judge-final-e2e.test.ts#2': [{ onUncertain: "'no-match'" }, { onUncertain: "'hold'" }],
  'packages/events-daemon/test/laya-e2e.test.ts#1': [
    { judge: 'layaJudge(SHIPPED_MANIFEST)', onUncertain: "'no-match'" },
    { judge: 'layaJudge(SHIPPED_MANIFEST)', onUncertain: "'hold'" },
  ],
  'packages/events-daemon/test/laya-purge-closure.test.ts#1': [{ ruleId: "'rule-e2-t6-a'", accountId: 'ACCOUNT_A' }],
  'packages/events-daemon/test/phase-d-owner-e2e.test.ts#1': [{ firstId: "'ibx_AAAAAAAAAAAAAAAA'" }],
  'packages/events-daemon/test/phase-d-owner-e2e.test.ts#2': [
    {
      __each:
        "[['gmail', 'ibx_OWNERGMAIL00000', { channel: 'gmail', labels: 'inbox', includeSpamTrash: false }, 'gmail.message.received'], ['slack', 'acc_OWNERSLACK00000', { channel: 'slack', conversations: ['C-owner'] }, 'slack.message.posted'], ['resend-received', 'acc_OWNERRESEND0000', { channel: 'resend', kinds: ['received'] }, 'resend.email.received'], ['resend-status', 'acc_OWNERRESEND0000', { channel: 'resend', kinds: ['status'] }, 'resend.email.status_changed'], ['whatsapp', 'acc_OWNERWHATSAPP00', { channel: 'whatsapp', chats: ['chat-owner'] }, 'whatsapp.message.received']]",
      name: '__item[0]',
      accountId: '__item[1]',
      options: '__item[2]',
      eventType: '__item[3]',
      target: "({ targetId: 'four-source-target', version: 1, kind: 'dry-run', retentionMs: 86_400_000 })",
    },
  ],
  'packages/events-daemon/test/revocation.test.ts#1': [
    { target: "({ targetId: 'target-purge', version: 1, kind: 'dry-run', retentionMs: 86_400_000 })" },
  ],
  'packages/events-daemon/test/support/browser-sse-fixture.ts#1': [
    {
      subscriber:
        "({ subscriberId: 'subscriber-browser-sse', version: 1, kind: 'sse', authority: { host: '127.0.0.1', port: 49201 }, origins: ['http://127.0.0.1:49202'], retentionMs: 60_000 })",
      target:
        "({ targetId: 'target-browser-sse', version: 1, kind: 'sse', subscriberId: 'subscriber-browser-sse', subscriberVersion: 1, representation: 'plain' })",
    },
  ],
  'packages/events-daemon/test/support/judge-adversarial-fixture.ts#1': [
    {
      row: "({ id: 'exact-input-row', scenario: 'exact-input' })",
      judge:
        "({ judgeId: 'judge-e11-exact-input-row', version: 1, kind: 'local-endpoint', provider: 'ollama', model: 'synthetic-model', endpoint: 'http://127.0.0.1:49152/v1/systemone', approvedAddressSet: [INJECTED_HOST], promptTemplate: 'ollama-noul-v1', protocol: 'noul' })",
      rowRetention: "retention({ scenario: 'exact-input' })",
    },
    {
      row: "({ id: 'dns-rebinding-row', scenario: 'dns-rebinding' })",
      judge:
        "({ judgeId: 'judge-e11-dns-rebinding-row', version: 1, kind: 'typesafe', provider: 'typesafe', model: 'jev-1.13.0', endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT, promptTemplate: 'typesafe-jev-v1', protocol: 'noul' })",
      rowRetention: "retention({ scenario: 'hold-expiry' })",
    },
  ],
  'packages/events-daemon/test/support/phase-d-cutover.ts#1': [
    {
      __replace: [
        ['this.#retention', '__retention'],
        ['this.source', '__source'],
      ],
      __source: "'slack'",
      __retention: 'retention',
      ruleId: "'rule-cutover'",
      version: '1',
      accountIds: "['acc_ABCDEFGHIJKLMNOP']",
      options: "({ channel: 'slack', conversations: ['C-cutover'] })",
      mapping: "'v1'",
      deliveryRateCap: '60',
    },
    {
      __replace: [
        ['this.#retention', '__retention'],
        ['this.source', '__source'],
      ],
      __source: "'resend'",
      __retention: 'retention',
      ruleId: "'rule-cutover'",
      version: '2',
      accountIds: "['acc_ABCDEFGHIJKLMNOP', 'acc_BCDEFGHIJKLMNOPQ']",
      options: "({ channel: 'resend', kinds: ['status'] })",
      mapping: "'v2'",
      deliveryRateCap: '30',
    },
  ],
  'test/events-daemon-e2e.test.mjs#1': [
    {
      inbox: "({ id: 'ibx_E2EAAAAAAAAAAAAA' })",
      target: "({ targetId: 'dry-e2e', version: 1, kind: 'dry-run', retentionMs: 3_600_000 })",
    },
  ],
};
