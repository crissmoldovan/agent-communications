import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = () => readFile(new URL('../src-tauri/src/supervisor.rs', import.meta.url), 'utf8');

// desktop-mutation: desktop-autostart-no-spawn
test('supervisor-autostart-no-spawn: default startup is inert', async () => {
  const text = await source();
  assert.match(text, /pub fn startup\(&self\) -> SupervisorStatus \{\s*self\.status\(\)/);
});

// desktop-mutation: desktop-preferences-race
test('supervisor-preferences-race: profile revision guards a start', async () => {
  const text = await source();
  assert.match(text, /if current\.revision != expected_revision/);
  assert.match(text, /profile changed while starting/);
});

// desktop-mutation: desktop-supervisor-late-spawn
test('supervisor-late-spawn: epoch fences child adoption', async () => {
  assert.match(await source(), /if ledger\.epoch != epoch \|\| ledger\.state != SupervisorState::Starting/);
});

// desktop-mutation: desktop-supervisor-cancel-handoff
test('supervisor-cancel-handoff: cancelled Start retains Quit reservation', async () => {
  assert.match(await source(), /else if ledger\.state == SupervisorState::Starting/);
});

// desktop-mutation: desktop-supervisor-stop-race
test('supervisor-stop-race: stop epoch is checked before clearing ownership', async () => {
  assert.match(await source(), /if ledger\.epoch != epoch \|\| ledger\.state != SupervisorState::Stopping/);
});

// desktop-mutation: desktop-supervisor-exact-identity
test('supervisor-exact-identity: stop cannot clear a different child', async () => {
  const text = (await source()).replace(/\s+/g, ' ');
  assert.match(text, /ledger\.owner\.as_ref\(\)\.map\(\|owner\| &owner\.identity\) != expected/);
});
