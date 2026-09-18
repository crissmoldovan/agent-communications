import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandHome, resolvePaths } from '../src/paths.ts';

const home = join('/', 'h', 'jo');

test('defaults follow ~/.config on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const paths = resolvePaths({ env: {}, platform, home });
    assert.equal(paths.configDir, join(home, '.config', 'agent-communications'));
    assert.equal(paths.stateDir, join(home, '.config', 'agent-communications', 'state'));
    assert.equal(paths.dataDir, join(home, '.local', 'share', 'agent-communications'));
    assert.equal(paths.downloadsDir, join(home, 'Downloads', 'agent-communications'));
  }
});

test('XDG variables are honoured, and the explicit override wins over them', () => {
  const xdg = resolvePaths({ env: { XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' }, platform: 'darwin', home });
  assert.equal(xdg.configDir, join('/x/cfg', 'agent-communications'));
  assert.equal(xdg.dataDir, join('/x/data', 'agent-communications'));
  const explicit = resolvePaths({
    env: { XDG_CONFIG_HOME: '/x/cfg', AGENT_COMMS_CONFIG_DIR: '/o/cfg', AGENT_COMMS_STATE_DIR: '/o/state' },
    platform: 'linux',
    home,
  });
  assert.equal(explicit.configDir, '/o/cfg');
  assert.equal(explicit.stateDir, '/o/state');
});

test('Windows uses APPDATA and LOCALAPPDATA', () => {
  const paths = resolvePaths({ env: { APPDATA: '/w/roaming', LOCALAPPDATA: '/w/local' }, platform: 'win32', home });
  assert.equal(paths.configDir, join('/w/roaming', 'agent-communications'));
  assert.equal(paths.dataDir, join('/w/local', 'agent-communications'));
});

test('expandHome expands only a leading tilde', () => {
  assert.equal(expandHome('~', home), home);
  assert.equal(expandHome('~/Documents', home), join(home, 'Documents'));
  assert.equal(expandHome('/abs/~/x', home), '/abs/~/x');
  assert.equal(expandHome('~other/x', home), '~other/x');
});
