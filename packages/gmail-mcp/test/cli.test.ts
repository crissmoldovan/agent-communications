import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gmailCommand, handoffText } from '@agentcomms/gmail';
import { serverHelp } from '../src/help.ts';

const ENTRY = fileURLToPath(new URL('../src/server.ts', import.meta.url));

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The bin's environment: a directory of the run's own for its configuration and its home, and nothing else from the
 * machine running the tests but `PATH`.
 *
 * The home goes under both of the names core reads it by: `HOME` on macOS and Linux, `USERPROFILE` on Windows, as
 * Node's own `homedir()` does there. This used to inherit the whole environment — the real home under both names, the
 * real `%LOCALAPPDATA%` — with one fixed `/tmp` directory shared by every run as its configuration.
 */
function binEnv(): NodeJS.ProcessEnv {
  // realpath: on macOS the temporary directory is a symlink, and core compares resolved paths.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-gmail-mcp-')));
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    NO_COLOR: '1',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
}

/** Starts the bin and closes its stdin, which is how a client ending a session looks to the server. */
function runBin(
  args: string[],
  { closeStdin = true, env = binEnv() }: { closeStdin?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', ENTRY, ...args],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    if (closeStdin) child.stdin.end();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the server did not exit; stderr: ${stderr.slice(0, 300)}`));
    }, 20_000);
    timer.unref();
  });
}

test('--help explains the options and writes nothing to stdout', async () => {
  const result = await runBin(['--help']);
  assert.equal(result.code, 0);
  // stdout belongs to the protocol, even when the process is only printing help.
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--inbox <alias>/);
  assert.match(result.stderr, /--read-only/);
  for (const flag of ['--config-dir', '--state-dir', '--data-dir', '--secrets-dir']) {
    assert.match(result.stderr, new RegExp(flag));
  }
  assert.doesNotMatch(result.stderr, /--downloads-dir/);
});

test('the wrapper strictly parses and applies all four registration path pins before startup', async () => {
  const env = binEnv();
  const home = env.HOME as string;
  const pinned = join(home, 'pinned');
  mkdirSync(pinned, { recursive: true });
  writeFileSync(
    join(pinned, 'config.json'),
    `${JSON.stringify({
      version: 1,
      secrets: { store: 'file' },
      inboxes: {
        work: {
          id: 'ibx_AAAAAAAAAAAAAAAA',
          provider: 'gmail',
          email: 'jo@example.test',
          identity: 'oidc',
          client: 'default',
          tier: 'read',
          grantedScopes: [],
          secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
          createdAt: '2026-10-05T00:00:00.000Z',
        },
      },
    })}\n`,
  );
  const result = await runBin(
    [
      '--config-dir',
      pinned,
      '--state-dir',
      join(home, 'pinned-state'),
      '--data-dir',
      join(home, 'pinned-data'),
      '--secrets-dir',
      join(home, 'pinned-secrets'),
      '--inbox',
      'work',
    ],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('the wrapper refuses unknown and empty path options as usage before startup', async () => {
  for (const args of [['--unknown'], ['--config-dir=']]) {
    const result = await runBin(args);
    assert.equal(result.code, 64, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage|non-empty|unknown/i);
  }
});

test('the server exits when its client disconnects, rather than lingering', async () => {
  const result = await runBin([]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '', 'a server that spoke to nobody must not print anything on stdout');
});

test('a pinned mailbox that does not exist fails at startup, not on the first call', async () => {
  const result = await runBin(['--inbox', 'missing']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing/);
});

/** The name in the nearest `package.json` above a file: the package Node says that module belongs to. */
function owningPackage(file: string): string | undefined {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name;
    } catch {
      // no manifest here; keep walking up
    }
  }
  return undefined;
}

test("Gmail's resolver URL is a module of Gmail's own package, never of this wrapper (CUE-403)", async () => {
  /*
   * A command for Gmail is located from a module of Gmail: from one of the wrapper's own, the locator finds the
   * wrapper's manifest, which is not Gmail, and gives no command. So the wrapper asks Gmail for the module to locate
   * from — the one its dependency was built as.
   */
  const gmail = await import('@agentcomms/gmail');
  assert.equal(gmail.PACKAGE_NAME, '@agentcomms/gmail');
  assert.match(gmail.RESOLVER_URL, /^file:/);
  assert.equal(owningPackage(fileURLToPath(gmail.RESOLVER_URL)), gmail.PACKAGE_NAME);
  assert.equal(owningPackage(ENTRY), '@agentcomms/gmail-mcp');
});

// ── The help's handoff: Gmail's own command, located from Gmail, never this wrapper or a bare name (CUE-403) ────────

/** A suite command by its bare name, in any case and with a Windows extension, followed by something to run with it. */
const BARE =
  /(?:^|[\s`'"([,])(?:agent-gmail|agent-gmail-mcp|agentcomms|agent-slack|agent-resend|agent-whatsapp)(?:\.(?:cmd|exe|ps1|bat))?\s+[\w<[-]/i;

/**
 * The words of the backticked command in a help: its words as JSON where Windows has no line that every shell reads
 * the same (a Node under `C:\\Program Files`), or the line read word by word. A word is quoted where the server's own
 * shell needs it — `'…'` on POSIX, `"…"` on Windows, where a runner's temporary folder is `C:\\Users\\RUNNER~1\\…` — and
 * the folders pinned here hold no quote of either kind, so a quoted word is what is between its quotes.
 */
function helpCommand(help: string): string[] {
  const line = /`([^`]+)`/.exec(help)?.[1];
  assert.ok(line, `no command in the help: ${help}`);
  if (line.startsWith('[')) return JSON.parse(line) as string[];
  return [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => (match[1] ?? match[2] ?? match[3]) as string);
}

/**
 * This Node as a command printed with `env` names it (CUE-492), worked out here rather than asked of core: the first
 * `node` on `env`'s PATH that is the same real file as `process.execPath`, as PATH spells it, and otherwise
 * `process.execPath`. A `~/.local/bin/node` or Homebrew `/opt/homebrew/bin/node` link stays the link.
 */
function nodeAsPathFindsIt(env: NodeJS.ProcessEnv): string {
  const own = process.execPath;
  const windows = process.platform === 'win32';
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  let real: string;
  try {
    real = realpathSync(own);
  } catch {
    return own;
  }
  const names = windows
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT')
        .split(';')
        .filter(Boolean)
        .map((extension) => `node${extension.toLowerCase()}`)
    : ['node'];
  const folders = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter((folder) => (windows ? /^[A-Za-z]:[\\/]/.test(folder) : folder !== '' && isAbsolute(folder)));
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        if (!same(realpathSync(candidate), real)) continue;
        return same(candidate, own) ? own : candidate;
      } catch {
        // not here, or not runnable: keep looking
      }
    }
  }
  return own;
}

/** Gmail's built CLI, as the wrapper's dependency declares it: what a command located from Gmail runs. */
function gmailBin(): string {
  const gmailEntry = fileURLToPath(new URL(import.meta.resolve('@agentcomms/gmail')));
  const root = dirname(dirname(gmailEntry));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    bin: Record<string, string>;
    agentcomms: { binary: string };
  };
  assert.equal(manifest.name, '@agentcomms/gmail');
  return join(root, manifest.bin[manifest.agentcomms.binary] as string);
}

test("--help names Gmail's own setup, located from the Gmail dependency for this server's folders (7d-gmail)", async () => {
  const env = binEnv();
  const home = env.HOME as string;
  const pinned = join(home, 'pinned');
  for (const args of [['--help'], ['--config-dir', pinned, '--help']]) {
    const result = await runBin(args, { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Set up mailboxes with Gmail's own CLI, from @agentcomms\/gmail: `/);
    const [program, entry, ...words] = helpCommand(result.stderr);
    // This Node, as the bin's PATH finds it, then Gmail's checked CLI entry — the wrapper's dependency, never the
    // wrapper itself.
    assert.equal(program, nodeAsPathFindsIt(env));
    assert.equal(realpathSync(entry ?? ''), realpathSync(gmailBin()));
    assert.equal(owningPackage(entry ?? ''), '@agentcomms/gmail');
    assert.deepEqual(words.slice(-1), ['setup']);
    // The folders this server would use, pinned: what it was given, or what its environment says.
    const configDir = words[words.indexOf('--config-dir') + 1];
    assert.equal(configDir, args.includes('--config-dir') ? pinned : join(home, 'config'));
    for (const flag of ['--config-dir', '--state-dir', '--data-dir', '--secrets-dir']) {
      assert.equal(words.filter((word) => word === flag).length, 1, `${flag}: ${words.join(' ')}`);
    }
    assert.doesNotMatch(result.stderr, BARE, 'a bare suite name');
  }
  // A usage error prints the same help, with the command located for the environment's folders.
  const refused = await runBin(['--unknown'], { env });
  assert.equal(refused.code, 64);
  assert.deepEqual(helpCommand(refused.stderr).slice(-1), ['setup']);
  assert.doesNotMatch(refused.stderr, BARE);
});

test('the help hands over a located Gmail command, or says why there is none — never a name in its place (7d-gmail)', () => {
  const env = binEnv();
  const located = gmailCommand(['setup'], { env, pathOverrides: { configDir: join(env.HOME as string, 'pinned') } });
  const help = serverHelp(located);
  assert.ok(help.includes(`\`${handoffText(located)}\``), help);
  assert.doesNotMatch(help, BARE);

  // Not locatable here — the Gmail package gone, say: the reason stands alone, with the other way to do it.
  const missing = {
    ok: false as const,
    reason: 'entry' as const,
    product: 'Gmail',
    package: '@agentcomms/gmail',
    version: '0.13.0',
    detail: 'its CLI entry is not a readable file',
    message:
      'Gmail 0.13.0 (@agentcomms/gmail) is not locatable here: its CLI entry is not a readable file. Install or update it through your usual route, then try again.',
  };
  const without = serverHelp(missing);
  assert.ok(
    without.includes(`Set up mailboxes with the Gmail CLI from @agentcomms/gmail. ${missing.message}`),
    without,
  );
  assert.doesNotMatch(without, /`/, 'no command, and nothing in its place');
  assert.doesNotMatch(without, BARE);
  // The rest of the help is the same either way.
  assert.equal(without.split('\n').slice(0, 10).join('\n'), help.split('\n').slice(0, 10).join('\n'));
});
