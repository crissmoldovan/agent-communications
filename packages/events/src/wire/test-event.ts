import { canonicalJson } from '../json.ts';
/** The fixed target-test CloudEvent: not a catalogue event and never built from caller input. */
export const TEST_CLOUD_EVENT: {
  readonly specversion: '1.0';
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: { readonly synthetic: true; readonly message: 'agent-communications test event' };
} = {
  specversion: '1.0',
  id: 'agentcomms-test-v1',
  source: 'urn:agentcomms:test',
  type: 'io.agentcomms.test.v1',
  time: '2000-01-01T00:00:00Z',
  datacontenttype: 'application/json',
  data: { synthetic: true, message: 'agent-communications test event' },
};

/** The exact canonical test-body bytes D3 fixes. */
export const TEST_CLOUD_EVENT_BYTES: string = canonicalJson({
  specversion: TEST_CLOUD_EVENT.specversion,
  id: TEST_CLOUD_EVENT.id,
  source: TEST_CLOUD_EVENT.source,
  type: TEST_CLOUD_EVENT.type,
  time: TEST_CLOUD_EVENT.time,
  datacontenttype: TEST_CLOUD_EVENT.datacontenttype,
  data: TEST_CLOUD_EVENT.data,
});

/** The only synthetic data a judge test receives. */
export const JUDGE_TEST_INPUT: { readonly synthetic: true; readonly message: 'agent-communications test event' } = {
  synthetic: true,
  message: 'agent-communications test event',
};
