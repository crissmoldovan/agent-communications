import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Compiled production paths:
// ../src-tauri/capabilities/settings.json
// ../src-tauri/build.rs
// ../src-tauri/src/commands/secrets.rs
// ../src-tauri/src/control/secret_window_capability.rs
// ../src-tauri/src/control/types.rs
// ../src-tauri/src/control/b3_contract.rs

function native(binary, name) {
  const result = spawnSync(
    'cargo',
    [
      'test',
      '--offline',
      '--manifest-path',
      'apps/desktop/src-tauri/Cargo.toml',
      '--test',
      binary,
      name,
      '--',
      '--exact',
    ],
    { cwd: new URL('../../../', import.meta.url), env: process.env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${name} failed (captured output is not emitted)`);
  assert.match(result.stdout, /running 1 test/u);
  assert.match(result.stdout, /test result: ok\. 1 passed; 0 failed/u);
}

// desktop-mutation: desktop-secret-capability
test('secret-boundary: native command manifest grants exactly eight families', () =>
  native('secret_boundary', 'secret_manifest_grants_exactly_eight_families_only_to_secrets'));

// desktop-mutation: desktop-secret-app-manifest
test('secret-boundary: application command declarations include all secret families', () =>
  native('secret_boundary', 'secret_manifest_grants_exactly_eight_families_only_to_secrets'));

// desktop-mutation: desktop-secret-raw-command-probe
test('secret-boundary: raw command invocation respects all three native labels', () =>
  native('secret_boundary', 'secret_raw_commands_use_native_window_authority'));

// desktop-mutation: desktop-secret-raw-command-probe-non-secret
test('secret-boundary: production secret registration refuses a non-secret command', () =>
  native('secret_boundary', 'secret_raw_commands_use_native_window_authority'));

// desktop-mutation: desktop-secret-forged-window-label
test('secret-boundary: a forged window label cannot produce a native capability', () =>
  native('secret_boundary', 'secret_capability_is_native_and_zeroizing'));

// desktop-mutation: desktop-secret-pipe
test('secret-boundary: spawned pipe key matches Node and closes its descriptor', (t) => {
  if (process.platform === 'win32') return t.skip('Unix inherited-pipe authority is unavailable on Windows');
  native('secret_boundary', 'spawned_capability_uses_only_inherited_pipe_and_matches_node_hmac');
});

// desktop-mutation: desktop-secret-no-echo
test('secret-no-echo: hidden operations cannot return a reveal or extra fields', () =>
  native('secret_audit', 'hidden_input_operations_never_accept_reveal_or_extra_fields'));

// desktop-mutation: desktop-secret-native-close-race
test('secret-close-race: native lifecycle clears pending response generations', () =>
  native('secret_audit', 'native_lifecycle_invalidates_all_pending_results'));

// desktop-mutation: desktop-secret-generic-dispatch
test('secret-boundary: generic dispatch cannot reach any secret operation', () =>
  native('secret_boundary', 'generic_dispatch_refuses_all_secret_operations'));

// desktop-mutation: desktop-secret-native-stream-close
test('secret-close-race: native lifecycle closes the in-flight secret connection', (t) => {
  if (process.platform === 'win32') return t.skip('Windows control is unavailable');
  native('secret_audit', 'native_lifecycle_closes_pending_secret_stream');
});
