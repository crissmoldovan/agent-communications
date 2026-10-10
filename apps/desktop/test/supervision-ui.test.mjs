import assert from 'node:assert/strict';
import { test } from 'node:test';

// desktop-mutation: desktop-ui-command-surface
test('supervision settings invokes only the four pre-B3 native commands', async () => {
  const { supervisionCommands } = await import('../src/supervision.ts');
  const calls = [];
  const commands = supervisionCommands(async (command, args) => {
    calls.push({ command, args });
    return { revision: 1, keepCollectingAfterQuit: false, profileConfigured: true, state: 'idle', attached: false };
  });
  const selected = {
    executable: '/synthetic/agent-events',
    stateDir: '/synthetic/state',
    configDir: '/synthetic/config',
    expectedRevision: 0,
    keepCollectingAfterQuit: false,
  };
  await commands.status();
  await commands.start(selected);
  await commands.stop();
  await commands.openSecrets();
  assert.deepEqual(
    calls.map(({ command }) => command),
    ['desktop_supervision_status', 'desktop_start_daemon', 'desktop_quit_daemon', 'desktop_open_secrets'],
  );
  assert.deepEqual(calls[1].args, selected);
  assert.equal(calls[0].args, undefined);
  assert.equal(calls[2].args, undefined);
  assert.equal(calls[3].args, undefined);
});
