import assert from 'node:assert/strict';
import { test } from 'node:test';

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// desktop-mutation: desktop-ui-stale-reply
test('supervision lifecycle: hidden or closed settings drops paused command replies', async () => {
  const { WindowLifecycle, supervisionCommands } = await import('../src/supervision.ts');
  const operations = [
    ['desktop_supervision_status', (commands) => commands.status()],
    [
      'desktop_start_daemon',
      (commands) =>
        commands.start({
          executable: '/synthetic/agent-events',
          stateDir: '/synthetic/state',
          configDir: '/synthetic/config',
          expectedRevision: 1,
          keepCollectingAfterQuit: false,
        }),
    ],
    ['desktop_quit_daemon', (commands) => commands.stop()],
  ];
  for (const [command, invoke] of operations) {
    for (const invalidate of ['hide', 'close', 'purge']) {
      const paused = deferred();
      const updates = [];
      const commands = supervisionCommands(async (received) => {
        assert.equal(received, command);
        return paused.promise;
      });
      const lifecycle = new WindowLifecycle();
      const request = lifecycle.request();
      const result = invoke(commands).then((next) => lifecycle.publish(request, () => updates.push(next)));

      lifecycle[invalidate]();
      paused.resolve({ state: 'running' });
      await result;

      assert.deepEqual(updates, [], `${command}: ${invalidate} must invalidate the pending command`);
    }
  }
});
