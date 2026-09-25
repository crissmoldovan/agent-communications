import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { expandHome, homeDirectory, resolvePaths } from '../src/paths.ts';

const home = join('/', 'h', 'jo');

// resolvePaths returns absolute paths, so on Windows they carry the current drive letter.
test('defaults follow ~/.config on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const paths = resolvePaths({ env: {}, platform, home });
    assert.equal(paths.configDir, resolve(home, '.config', 'agent-communications'));
    assert.equal(paths.stateDir, resolve(home, '.config', 'agent-communications', 'state'));
    assert.equal(paths.dataDir, resolve(home, '.local', 'share', 'agent-communications'));
    assert.equal(paths.downloadsDir, resolve(home, 'Downloads', 'agent-communications'));
  }
});

test('XDG variables are honoured, and the explicit override wins over them', () => {
  const xdg = resolvePaths({ env: { XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' }, platform: 'darwin', home });
  assert.equal(xdg.configDir, resolve('/x/cfg', 'agent-communications'));
  assert.equal(xdg.dataDir, resolve('/x/data', 'agent-communications'));
  const explicit = resolvePaths({
    env: { XDG_CONFIG_HOME: '/x/cfg', AGENT_COMMS_CONFIG_DIR: '/o/cfg', AGENT_COMMS_STATE_DIR: '/o/state' },
    platform: 'linux',
    home,
  });
  assert.equal(explicit.configDir, resolve('/o/cfg'));
  assert.equal(explicit.stateDir, resolve('/o/state'));
});

test('Windows uses APPDATA and LOCALAPPDATA', () => {
  const paths = resolvePaths({ env: { APPDATA: '/w/roaming', LOCALAPPDATA: '/w/local' }, platform: 'win32', home });
  assert.equal(paths.configDir, resolve('/w/roaming', 'agent-communications'));
  assert.equal(paths.dataDir, resolve('/w/local', 'agent-communications'));
  // Tokens, approvals and the audit log stay out of the roaming profile, which a domain copies between machines.
  assert.equal(paths.stateDir, resolve('/w/local', 'agent-communications', 'state'));
  assert.equal(paths.secretsDir, resolve('/w/local', 'agent-communications', 'secrets'));

  // An explicit config directory means that directory: everything stays together inside it.
  const explicit = resolvePaths({
    env: { AGENT_COMMS_CONFIG_DIR: '/o/cfg', APPDATA: '/w/roaming', LOCALAPPDATA: '/w/local' },
    platform: 'win32',
    home,
  });
  assert.equal(explicit.stateDir, resolve('/o/cfg', 'state'));
  assert.equal(explicit.secretsDir, resolve('/o/cfg', 'secrets'));
});

test('elsewhere, state and secrets sit beside the configuration', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const paths = resolvePaths({ env: {}, platform, home });
    assert.equal(paths.stateDir, resolve(paths.configDir, 'state'));
    assert.equal(paths.secretsDir, resolve(paths.configDir, 'secrets'));
  }
});

test('the home in the environment given is the one used, so a temporary HOME keeps everything inside it', () => {
  /*
   * `homedir()` reads the running process's own environment, not the one passed in. Every harness here sets a
   * temporary HOME, and data and downloads still resolved to the real ones — install tests wrote their backups into
   * the maintainer's data directory, hundreds a day. Nothing else passes `home`; the environment has to be enough.
   */
  const posix = resolvePaths({
    env: { HOME: '/tmp/fake-home', AGENT_COMMS_CONFIG_DIR: '/tmp/fake-home/cfg' },
    platform: 'linux',
  });
  assert.equal(posix.dataDir, resolve('/tmp/fake-home/.local/share/agent-communications'));
  assert.equal(posix.downloadsDir, resolve('/tmp/fake-home/Downloads/agent-communications'));

  // Windows reads USERPROFILE, as Node's own homedir() does there; a HOME set by a Unix-style shell is not it.
  const windows = resolvePaths({ env: { USERPROFILE: 'C:\\Users\\fake', HOME: '/c/elsewhere' }, platform: 'win32' });
  assert.ok(windows.downloadsDir.startsWith(resolve('C:\\Users\\fake')), windows.downloadsDir);
});

test('expandHome expands only a leading tilde', () => {
  assert.equal(expandHome('~', home), home);
  assert.equal(expandHome('~/Documents', home), join(home, 'Documents'));
  assert.equal(expandHome('/abs/~/x', home), '/abs/~/x');
  assert.equal(expandHome('~other/x', home), '~other/x');
});

test('homeDirectory falls back the way Windows needs, and never yields an empty string', () => {
  // The bug this replaces: `env.HOME ?? ''`. Windows sets USERPROFILE, not HOME, so `home` became `''`, which is not
  // nullish — `expandHome`'s own default never fired, `~` expanded to `''`, and `resolve('')` is the process's
  // current working directory. An attachment jail rooted at `['~']` then allowed whatever directory the server was
  // started in, and the `~/.*` deny rule stopped covering the real home.
  const posixHome = join('/', 'h', 'jo');
  const windowsHome = join('/', 'u', 'jo');
  assert.equal(homeDirectory({ HOME: posixHome } as NodeJS.ProcessEnv), posixHome);
  assert.equal(homeDirectory({ USERPROFILE: windowsHome } as NodeJS.ProcessEnv), windowsHome);
  assert.equal(homeDirectory({ HOME: posixHome, USERPROFILE: windowsHome } as NodeJS.ProcessEnv), posixHome);

  // `||` not `??`: an empty HOME is exactly as broken as an absent one, and was the shape of the bug.
  assert.equal(homeDirectory({ HOME: '', USERPROFILE: windowsHome } as NodeJS.ProcessEnv), windowsHome);

  // With neither set it falls back to the OS, never to the empty string.
  const fallback = homeDirectory({} as NodeJS.ProcessEnv);
  assert.ok(fallback.length > 0);
  assert.notEqual(fallback, '');

  // And the whole point: `~` never expands to something `resolve` turns into the cwd.
  assert.notEqual(expandHome('~', homeDirectory({} as NodeJS.ProcessEnv)), '');
});
