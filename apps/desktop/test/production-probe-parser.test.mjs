import assert from 'node:assert/strict';
import { test } from 'node:test';

// desktop-mutation: desktop-probe-report-fields
test('desktop probe parser extracts and validates every emitted field', async () => {
  const { parseProbeReport } = await import('./e2e/probe-report.mjs');
  const report = parseProbeReport(
    'desktop-probe:settings:2:1,1,0,1,1:complete:1,ipc:1,origin:1,attacks:fetch-1|xhr-1|websocket-1|eventsource-1|beacon-1|image-1|css-1|script-1|frame-1|form-1|download-1|popup-1|custom-1|navigation-1',
  );

  assert.deepEqual(report, {
    label: 'settings',
    windows: 2,
    counters: [1, 1, 0, 1, 1],
    complete: true,
    ipc: true,
    origin: true,
    attacks: {
      fetch: true,
      xhr: true,
      websocket: true,
      eventsource: true,
      beacon: true,
      image: true,
      css: true,
      script: true,
      frame: true,
      form: true,
      download: true,
      popup: true,
      custom: true,
      navigation: true,
    },
  });
  assert.equal(
    parseProbeReport('desktop-probe:settings:2:1,1,0,1,1:complete:1,ipc:1,origin:1,attacks:fetch-1|fetch-1'),
    undefined,
    'a duplicate or incomplete attack field must not be accepted',
  );
});
