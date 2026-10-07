import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCloudEvent,
  CATALOGUE,
  cloudEventBytes,
  encodeUntrustedExtension,
  JUDGE_TEST_INPUT,
  TEST_CLOUD_EVENT,
  TEST_CLOUD_EVENT_BYTES,
  utf8Encode,
  validateCloudEventType,
} from '../src/index.ts';

const gmail = CATALOGUE[0];
if (gmail === undefined) throw new Error('catalogue example is unavailable');
const event = gmail.examples[1];
if (event === undefined) throw new Error('catalogue example is unavailable');

const common = {
  deliveryId: 'delivery-1',
  installationId: 'install: one',
  ruleId: 'rule/one',
  ruleVersion: 1,
  targetId: 'target one',
  targetVersion: 2,
} as const;

test('MAP-h: the CloudEvents structured envelope has D6 attributes, source account id, subject and occurredAt', () => {
  const cloudEvent = buildCloudEvent(gmail, event, { ...common, data: { id: event.id } });
  assert.deepEqual(cloudEvent, {
    specversion: '1.0',
    id: 'delivery-1',
    source: 'urn:agentcomms:install%3A%20one:ibx_ABCDEFGHIJKLMNOP',
    type: 'com.agentcomms.gmail.message.received.v1',
    time: event.occurredAt,
    datacontenttype: 'application/json',
    dataschema: 'urn:agentcomms:schema:delivery:rule%2Fone:v1:target%20one:v2',
    subject: 'message-1',
    agentcommsrule: 'rule%2Fone@1',
    data: { id: event.id },
  });
  assert.equal(
    cloudEventBytes(cloudEvent),
    '{"agentcommsrule":"rule%2Fone@1","data":{"id":"0123456789abcdef0123456789abcdef"},"datacontenttype":"application/json","dataschema":"urn:agentcomms:schema:delivery:rule%2Fone:v1:target%20one:v2","id":"delivery-1","source":"urn:agentcomms:install%3A%20one:ibx_ABCDEFGHIJKLMNOP","specversion":"1.0","subject":"message-1","time":"2026-10-07T12:00:00Z","type":"com.agentcomms.gmail.message.received.v1"}',
  );
});

test('MAP-i: a rule-defined CloudEvent type is merely a non-empty string and is used byte for byte', () => {
  for (const value of [
    ' ',
    'é',
    '😀',
    'x'.repeat(1000),
    'io.agentcomms.control.installation-reset.v1',
    ' leading and trailing ',
  ]) {
    const valid = validateCloudEventType(value);
    assert.deepEqual(valid, { ok: true, value });
    assert.equal(buildCloudEvent(gmail, event, { ...common, data: {}, cloudEventType: value }).type, value);
  }
  for (const value of ['', 1, null]) assert.equal(validateCloudEventType(value).ok, false, String(value));
});

test('MAP-f: agentcommsuntrusted is unique raw-pointer order encoded after sorting, and only names strings', () => {
  const data = { é: 'accent', '😀': 'astral', ',': 'comma', nested: { value: 'nested' } };
  assert.equal(
    encodeUntrustedExtension(data, ['/😀', '/nested/value', '/,', '/é', '/é']),
    '%2F%2C,%2Fnested%2Fvalue,%2F%C3%A9,%2F%F0%9F%98%80',
  );
  assert.equal(encodeUntrustedExtension('text', ['']), '');
  assert.throws(() => encodeUntrustedExtension(data, ['/missing']), /untrusted/u);
  assert.throws(() => encodeUntrustedExtension({ value: null }, ['/value']), /string/u);
  const cloudEvent = buildCloudEvent(gmail, event, {
    ...common,
    data,
    untrusted: ['/😀', '/nested/value', '/,', '/é'],
  });
  assert.equal(cloudEvent.agentcommsuntrusted, '%2F%2C,%2Fnested%2Fvalue,%2F%C3%A9,%2F%F0%9F%98%80');
  assert.equal(Object.hasOwn(buildCloudEvent(gmail, event, { ...common, data: {} }), 'agentcommsuntrusted'), false);
});

test('MAP-g: components use RFC 3986 UTF-8 percent encoding with uppercase hex and refuse a lone surrogate', () => {
  const cloudEvent = buildCloudEvent(gmail, event, {
    ...common,
    installationId: "a:/% é😀!'()*",
    ruleId: "r:/% é😀!'()*",
    targetId: "t:/% é😀!'()*",
    data: {},
  });
  assert.equal(cloudEvent.source, 'urn:agentcomms:a%3A%2F%25%20%C3%A9%F0%9F%98%80%21%27%28%29%2A:ibx_ABCDEFGHIJKLMNOP');
  assert.equal(cloudEvent.agentcommsrule, 'r%3A%2F%25%20%C3%A9%F0%9F%98%80%21%27%28%29%2A@1');
  assert.match(cloudEvent.dataschema, /t%3A%2F%25%20%C3%A9%F0%9F%98%80%21%27%28%29%2A/u);
  assert.throws(() => buildCloudEvent(gmail, event, { ...common, installationId: '\uD800', data: {} }));
});

test('D3-b: the fixed test event and judge input are literal contract values', () => {
  assert.deepEqual(TEST_CLOUD_EVENT, {
    specversion: '1.0',
    id: 'agentcomms-test-v1',
    source: 'urn:agentcomms:test',
    type: 'io.agentcomms.test.v1',
    time: '2000-01-01T00:00:00Z',
    datacontenttype: 'application/json',
    data: { synthetic: true, message: 'agent-communications test event' },
  });
  assert.equal(
    TEST_CLOUD_EVENT_BYTES,
    '{"data":{"message":"agent-communications test event","synthetic":true},"datacontenttype":"application/json","id":"agentcomms-test-v1","source":"urn:agentcomms:test","specversion":"1.0","time":"2000-01-01T00:00:00Z","type":"io.agentcomms.test.v1"}',
  );
  assert.deepEqual(JUDGE_TEST_INPUT, { synthetic: true, message: 'agent-communications test event' });
  assert.deepEqual(Array.from(utf8Encode(TEST_CLOUD_EVENT_BYTES)).slice(0, 8), [123, 34, 100, 97, 116, 97, 34, 58]);
});
