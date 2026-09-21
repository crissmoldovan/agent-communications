import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, open, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import { canPrompt } from '@agentcomms/core';
import { interactionFor } from '../src/cli/tui.ts';
import { GmailContext } from '../src/context.ts';
import { clientAdd } from '../src/operations/clients.ts';
import { CONSOLE_STEPS, findClientJson, setupState } from '../src/operations/setup.ts';
import { readBoundedStream } from '../src/operations/small-file.ts';
import { newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';

/** A well-formed Desktop client, for the cases that are about something other than its contents. */
const DESKTOP = { installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET, project_id: 'proj' } };

/** Fails rather than hanging: every case below is about a shape that used to block forever. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`still running after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

/** What Google actually issues. The fixtures used `client_id: 'a'`, which the real parser refuses. */
const googleId = (prefix: string) => `${prefix}-000000000000.apps.googleusercontent.com`;

/** A downloads directory with client files of known kinds and known ages. */
async function downloads(files: { name: string; body: unknown; minutesAgo: number }[]) {
  const dir = join(tempDir(), 'Downloads');
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const path = join(dir, file.name);
    await writeFile(path, typeof file.body === 'string' ? file.body : JSON.stringify(file.body));
    const when = new Date(Date.now() - file.minutesAgo * 60_000);
    await utimes(path, when, when);
  }
  return dir;
}

test('a Desktop client is offered ahead of a newer Web one', async () => {
  // The bug this exists for: sorting on the date alone put a Web application client at the top, because it
  // happened to be the most recent `client_secret*.json`. It is refused a moment later — so somebody who had just
  // created a Desktop client was handed a complaint about a web one they never chose.
  const dir = await downloads([
    {
      name: 'client_secret_old_desktop.json',
      body: { installed: { client_id: googleId('a'), client_secret: 's' } },
      minutesAgo: 600,
    },
    {
      name: 'client_secret_new_web.json',
      body: { web: { client_id: googleId('b'), client_secret: 's' } },
      minutesAgo: 1,
    },
  ]);

  const found = await findClientJson({ XDG_DOWNLOAD_DIR: dir } as NodeJS.ProcessEnv);
  assert.deepEqual(
    found.map((candidate) => candidate.kind),
    ['desktop', 'web'],
    'the usable one comes first even though the web one is nine hours newer',
  );
  assert.match(found[0]?.path ?? '', /old_desktop/);
});

test('among Desktop clients, the newest wins — and every one carries its date', async () => {
  const dir = await downloads([
    {
      name: 'client_secret_older.json',
      body: { installed: { client_id: googleId('a'), client_secret: 's' } },
      minutesAgo: 900,
    },
    {
      name: 'client_secret_newer.json',
      body: { installed: { client_id: googleId('b'), client_secret: 's' } },
      minutesAgo: 5,
    },
  ]);

  const found = await findClientJson({ XDG_DOWNLOAD_DIR: dir } as NodeJS.ProcessEnv);
  assert.match(found[0]?.path ?? '', /newer/, 'the one you just downloaded');
  // The date is shown because a person with several has no other way to tell them apart: the names are all
  // `client_secret_<numbers>.apps.googleusercontent.com.json`.
  for (const candidate of found) assert.ok(!Number.isNaN(Date.parse(candidate.modifiedAt)), candidate.path);
});

test('an unreadable file is listed rather than hidden, and sorts last', async () => {
  const dir = await downloads([
    { name: 'client_secret_broken.json', body: 'not json at all', minutesAgo: 1 },
    {
      name: 'client_secret_fine.json',
      body: { installed: { client_id: googleId('a'), client_secret: 's' } },
      minutesAgo: 400,
    },
  ]);

  const found = await findClientJson({ XDG_DOWNLOAD_DIR: dir } as NodeJS.ProcessEnv);
  assert.deepEqual(
    found.map((candidate) => candidate.kind),
    ['desktop', 'unreadable'],
    'hiding it would be worse: it may be the file they meant, and saying so beats silence',
  );
});

test('no downloads directory is an ordinary answer, not a failure', async () => {
  const found = await findClientJson({ XDG_DOWNLOAD_DIR: join(tempDir(), 'nope') } as NodeJS.ProcessEnv);
  assert.deepEqual(found, []);
});

test('every console step says what to do, and the two with traps say what not to', () => {
  assert.equal(CONSOLE_STEPS.length, 5);
  for (const step of CONSOLE_STEPS) {
    assert.ok(step.url.startsWith('https://console.cloud.google.com/'), step.id);
    assert.ok(step.why.length > 0, `${step.id} has no reason`);
    assert.ok(step.actions.length > 0, `${step.id} says nothing to do`);
  }

  // The two wrong answers that look more correct than the right ones. Both must be spelled out where the person
  // is standing, not left to a doc they are not reading.
  const audience = CONSOLE_STEPS.find((step) => step.id === 'audience');
  assert.match(audience?.actions.join(' ') ?? '', /PUBLISH APP/);
  assert.match(audience?.avoid.join(' ') ?? '', /seven days/);
  const client = CONSOLE_STEPS.find((step) => step.id === 'client');
  assert.match(client?.actions.join(' ') ?? '', /Desktop app/);
  assert.match(client?.avoid.join(' ') ?? '', /NOT Web application/);
});

// ── Which of the three interaction modes a run is ────────────────────────────────────────────────────────────

const tty = (isTTY: boolean) => ({ isTTY, write: () => true, on: () => undefined }) as never;

function modeFor(over: Partial<Parameters<typeof interactionFor>[0]> = {}) {
  return interactionFor({
    streams: { stdin: tty(true), stdout: tty(true), stderr: tty(true) } as never,
    env: {},
    json: false,
    noInput: false,
    noTui: false,
    canPrompt: true,
    ...over,
  });
}

test('a person at a terminal gets the rich prompts', () => {
  assert.equal(modeFor(), 'tui');
});

test('--json is never interactive, whatever the terminal says', () => {
  // A caller asking for one document is not going to answer a question, and a prompt drawn on the way would make
  // the document unparseable — which is the only reason the JSON surface exists.
  assert.equal(modeFor({ json: true }), 'none');
  assert.equal(modeFor({ noInput: true }), 'none');
  assert.equal(modeFor({ canPrompt: false }), 'none');
});

test('a pipe and CI are not interactive at all, and the real canPrompt says so', () => {
  /*
   * These used to be asserted with `canPrompt: true` handed in by the test, which is a state production never
   * reaches — `canPrompt` is false for a piped stdin and false in CI. So the test claimed pipes and CI got plain
   * prompts while the code gave them nothing, and the branch it exercised could not run.
   *
   * Asserted through the real helper now, so the test cannot disagree with the program again.
   */
  const streams = (stdin: boolean, stdout: boolean) =>
    ({ stdin: tty(stdin), stdout: tty(stdout), stderr: tty(true) }) as never;
  const realMode = (env: NodeJS.ProcessEnv, stdin: boolean, stdout: boolean) =>
    modeFor({ env, streams: streams(stdin, stdout), canPrompt: canPrompt(env, streams(stdin, stdout), {}) });

  assert.equal(realMode({}, false, true), 'none', 'a piped stdin');
  assert.equal(realMode({}, true, false), 'none', 'a piped stdout');
  for (const key of ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER']) {
    // Only `CI` is one canPrompt knows; the others reach it through the runner setting CI as well.
    assert.equal(realMode({ CI: '1', [key]: '1' }, true, true), 'none', key);
  }
});

test('stderr is the one thing canPrompt does not cover, because the list is drawn there', () => {
  // `canPrompt` checks stdin and stdout. The redrawing list goes to stderr, so a terminal with stderr redirected
  // can still answer questions — one line at a time.
  assert.equal(modeFor({ streams: { stdin: tty(true), stdout: tty(true), stderr: tty(false) } as never }), 'plain');
});

test('--no-tui is honoured on a terminal that could manage the other kind', () => {
  assert.equal(modeFor({ noTui: true }), 'plain');
});

/*
 * The download directory is somewhere else's software writes to, so a name matching `client_secret*.json` says
 * nothing about what is at the end of it. These four are the shapes a plain `readFile` would have followed,
 * blocked on, or read until the process died.
 */

test('a FIFO in the downloads directory does not hang the scan', async () => {
  const dir = await downloads([{ name: 'client_secret_real.json', body: DESKTOP, minutesAgo: 1 }]);
  const fifo = join(dir, 'client_secret_trap.json');
  const made = await new Promise<boolean>((resolve) => {
    execFile('mkfifo', [fifo], (error) => resolve(!error));
  });
  if (!made) return; // no mkfifo (Windows): the flag it exercises is 0 there anyway
  // Without O_NONBLOCK this call never returns: opening a FIFO for reading blocks until a writer appears.
  const found = await withTimeout(findClientJson({ XDG_DOWNLOAD_DIR: dir }), 5_000);
  assert.deepEqual(
    found.map((candidate) => candidate.path),
    [join(dir, 'client_secret_real.json')],
  );
});

test('a symlink wearing a client file name is not followed', async () => {
  const dir = await downloads([]);
  const secret = join(tempDir(), 'somewhere-else.json');
  await writeFile(secret, JSON.stringify(DESKTOP));
  await symlink(secret, join(dir, 'client_secret_link.json'));
  assert.deepEqual(await findClientJson({ XDG_DOWNLOAD_DIR: dir }), []);
});

test('a huge file is listed with its date, but never read', async () => {
  const dir = await downloads([]);
  const path = join(dir, 'client_secret_huge.json');
  const handle = await open(path, 'w');
  try {
    // Sparse: a 512MB file that costs nothing to create and would cost everything to read into a string.
    await handle.truncate(512 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  const when = new Date(Date.now() - 3 * 60_000);
  await utimes(path, when, when);

  const found = await withTimeout(findClientJson({ XDG_DOWNLOAD_DIR: dir }), 10_000);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.kind, 'unreadable');
  // The date survives the refusal: somebody choosing between files still needs to know which one is theirs.
  assert.equal(found[0]?.modifiedAt, when.toISOString());
});

test('a directory named like a client file is skipped entirely', async () => {
  const dir = await downloads([{ name: 'client_secret_real.json', body: DESKTOP, minutesAgo: 1 }]);
  await mkdir(join(dir, 'client_secret_folder.json'));
  const found = await findClientJson({ XDG_DOWNLOAD_DIR: dir });
  assert.deepEqual(
    found.map((candidate) => candidate.path),
    [join(dir, 'client_secret_real.json')],
  );
});

test('client add refuses a path that is not a small regular file', async () => {
  const harness = await newHarness({});
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = join(tempDir(), 'not-a-file');
  await mkdir(directory, { recursive: true });
  await assert.rejects(clientAdd(context, { path: directory, noProbe: true }), (error: CommsError) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /is not a file/);
    return true;
  });

  const huge = join(tempDir(), 'client_secret_huge.json');
  const handle = await open(huge, 'w');
  try {
    await handle.truncate(512 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  // `setup --client-json /dev/zero` arrives here. Reading it is what this refusal is instead of.
  await assert.rejects(withTimeout(clientAdd(context, { path: huge, noProbe: true }), 10_000), (error: CommsError) => {
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /too large to be a client JSON/);
    return true;
  });
});

test('a file the real parser would refuse is never called usable', async () => {
  /*
   * Everything here is a plausible-looking `client_secret*.json` that `client add` rejects. The classifier used
   * to be a second implementation of the parser's rules, and a second implementation drifts: first it accepted
   * `{"installed": true}`, then it accepted anything with a non-empty `client_id`. Both were offered to somebody
   * as a usable Desktop client and refused a moment later by the code that actually reads them.
   */
  const dir = await downloads([
    { name: 'client_secret_no_secret.json', body: { installed: { client_id: googleId('a') } }, minutesAgo: 1 },
    {
      name: 'client_secret_empty_secret.json',
      body: { installed: { client_id: googleId('b'), client_secret: '' } },
      minutesAgo: 2,
    },
    {
      name: 'client_secret_not_google.json',
      body: { installed: { client_id: 'a', client_secret: 's' } },
      minutesAgo: 3,
    },
    { name: 'client_secret_truthy.json', body: { installed: true }, minutesAgo: 4 },
    { name: 'client_secret_real.json', body: DESKTOP, minutesAgo: 5 },
  ]);

  const found = await findClientJson({ XDG_DOWNLOAD_DIR: dir } as NodeJS.ProcessEnv);
  const desktop = found.filter((candidate) => candidate.kind === 'desktop');
  assert.deepEqual(
    desktop.map((candidate) => candidate.path.split(/[\\/]/).pop()),
    ['client_secret_real.json'],
    'a file offered as usable must be one `client add` will actually accept',
  );
  // Every one of them is still listed — refusing to classify is not a reason to hide the file.
  assert.equal(found.length, 5);
});

test('the newest client wins even in a directory of hundreds, because dates come before the cut', async () => {
  /*
   * `readdir` returns names in whatever order the filesystem chose, which is not time. The scan used to take the
   * first forty of those and then sort *them* by date, so in a directory with more than forty matches the file
   * somebody downloaded a minute ago could simply be absent — from the one step whose entire job is to find it.
   *
   * Names here are shuffled relative to their ages, so passing by luck is not available.
   */
  const files = Array.from({ length: 120 }, (_, index) => ({
    name: `client_secret_${String((index * 37) % 120).padStart(3, '0')}.json`,
    body: DESKTOP,
    minutesAgo: 1000 - index,
  }));
  files.push({ name: 'client_secret_the_one_just_downloaded.json', body: DESKTOP, minutesAgo: 0 });
  const dir = await downloads(files);

  const found = await findClientJson({ XDG_DOWNLOAD_DIR: dir } as NodeJS.ProcessEnv);
  assert.match(found[0]?.path ?? '', /the_one_just_downloaded/, 'the newest file was not offered first');
  // Still bounded: hundreds of matches must not mean hundreds of opened files.
  assert.ok(found.length <= 40, `opened ${found.length} files`);
});

test('a registered server is what marks the agent step done, and it is matched on the package name', async () => {
  /*
   * `setupState` decides the MCP step is behind you by joining each registered server's command and args and
   * looking for `agentcomms/gmail` in the result. That is a string match against this package's own name, with
   * nothing tying the two together — rename or re-scope the package and every install silently reports the agent
   * step as still to do, forever, with no test going red.
   *
   * So the match is pinned here, in both spellings a client config can carry it, against a near miss that must
   * not count.
   */
  const home = await tempDir();
  // Ours, by package name, launched with npx.
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { gmail: { command: 'npx', args: ['-y', '@agentcomms/gmail-mcp@0.1.4'] } } }),
  );
  /*
   * Ours, by path — and this is the shape that matters most, because it is what the **default** installer writes.
   *
   * A segment matcher looking for `agentcomms` missed it entirely: the segment is `@agentcomms`. A correctly
   * registered managed install reported nothing, so setup would have said the agent step was still to do forever.
   * Both separators, because the matcher splits on them and a Windows path is the case nobody runs locally.
   */
  await mkdir(join(home, '.codex'), { recursive: true });
  // Built from the temp home rather than written out as a literal: a home-directory path in a fixture is a
  // machine-specific path, and this repository's own check refuses those — including in a comment explaining it.
  const managed = join(
    home,
    '.local',
    'share',
    'agent-comms',
    'runtime',
    '0.1.4',
    'node_modules',
    '@agentcomms',
    'gmail',
    'dist',
    'cli.mjs',
  );
  await writeFile(
    join(home, '.codex', 'config.toml'),
    ['[mcp_servers.gmail]', 'command = "node"', `args = ["${managed}", "mcp", "serve"]`].join('\n'),
  );
  // A Windows managed path, backslash-separated, which is the case nobody exercises locally.
  const windows = [
    'C:',
    'ProgramData',
    'agent-comms',
    'runtime',
    '0.1.4',
    'node_modules',
    '@agentcomms',
    'gmail-mcp',
    'dist',
    'server.mjs',
  ].join('\\\\');
  await mkdir(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
  await writeFile(
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    JSON.stringify({ mcpServers: { gmail: { command: 'node', args: [windows, 'mcp', 'serve'] } } }),
  );
  /*
   * Not ours — and in clients of their own, which is the point.
   *
   * The first version of this test put the near miss in `.claude.json` beside a real entry, so the client was
   * named either way and deleting the filter outright left the assertion green. A near miss only proves
   * something when it is the *only* thing that could name its client.
   */
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { gmail: { command: 'npx', args: ['-y', '@notagentcomms/gmail-mcp'] } } }),
  );
  await mkdir(join(home, '.gemini'), { recursive: true });
  await writeFile(
    join(home, '.gemini', 'settings.json'),
    JSON.stringify({
      mcpServers: {
        // A neighbour under the same scope. `startsWith('gmail')` called this ours.
        gmail: { command: 'node', args: ['/opt/node_modules/@agentcomms/gmail-evil/dist/cli.mjs', 'serve'] },
      },
    }),
  );

  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });
  const context = new GmailContext({ core: harness.core, env: { ...harness.env, HOME: home, USERPROFILE: home } });

  const state = await setupState(context, { scanDownloads: false });
  assert.deepEqual(
    state.registeredWith.sort(),
    ['claude-code', 'claude-desktop', 'codex'],
    'the registered servers were not matched',
  );
  assert.ok(!state.registeredWith.includes('cursor'), '@notagentcomms/gmail-mcp was counted as ours');
  assert.ok(!state.registeredWith.includes('gemini'), '@agentcomms/gmail-evil was counted as ours');
  assert.ok(state.done.includes('mcp'));
  assert.equal(state.next, 'done');
});

test('a client file that is valid JSON but not an object does not abort the scan', async () => {
  // `JSON.parse('null')` succeeds and returns null, whose `typeof` is 'object' — so the obvious guard lets it
  // through and the next property read throws. One junk file in a download directory and `setup` could not say
  // anything at all, because the TypeError came out of the whole scan rather than out of one candidate.
  const dir = await downloads([
    { name: 'client_secret_null.json', body: 'null', minutesAgo: 1 },
    { name: 'client_secret_array.json', body: '[1,2,3]', minutesAgo: 2 },
    { name: 'client_secret_number.json', body: '42', minutesAgo: 3 },
    { name: 'client_secret_string.json', body: '"a string"', minutesAgo: 4 },
    { name: 'client_secret_real.json', body: DESKTOP, minutesAgo: 5 },
  ]);

  const found = await findClientJson({ XDG_DOWNLOAD_DIR: dir } as NodeJS.ProcessEnv);
  assert.equal(found.length, 5, 'every candidate is still listed');
  assert.deepEqual(
    found.filter((candidate) => candidate.kind === 'desktop').map((candidate) => candidate.path.split(/[\\/]/).pop()),
    ['client_secret_real.json'],
  );
});

test('scanDownloads: false really does not scan', async () => {
  // The setup command asks for this five times in a row and a pinned server discards the result, so "skip it"
  // has to mean skipped rather than computed-and-ignored — a few hundred `lstat`s and up to forty opened files.
  const dir = await downloads([{ name: 'client_secret_real.json', body: DESKTOP, minutesAgo: 1 }]);
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: { ...harness.env, XDG_DOWNLOAD_DIR: dir } });

  assert.equal((await setupState(context)).candidates.length, 1, 'the default still scans');
  assert.deepEqual((await setupState(context, { scanDownloads: false })).candidates, []);
});

test('both scan bounds hold: how many are dated, and how many are opened', async () => {
  /*
   * Two separate limits, and the reorder test only pins the second one. Deleting the first — the cut on how many
   * names are dated at all — left that test green, because its assertion is on the forty that come back rather
   * than on the hundreds that were `lstat`ed to choose them. A directory with a hundred thousand matches would
   * then have been stat'd in full.
   *
   * Both are parameters rather than a test-only seam, so this asserts the real behaviour at small numbers.
   */
  const dir = await downloads(
    Array.from({ length: 12 }, (_, index) => ({
      name: `client_secret_${String(index).padStart(2, '0')}.json`,
      body: DESKTOP,
      minutesAgo: index,
    })),
  );
  const env = { XDG_DOWNLOAD_DIR: dir } as NodeJS.ProcessEnv;

  // Only three names are ever dated, so at most three can come back however many match.
  assert.equal((await findClientJson(env, { maxDated: 3 })).length, 3, 'the dating pass is not bounded');
  // And of those dated, only two are opened.
  assert.equal(
    (await findClientJson(env, { maxDated: 10, maxOpened: 2 })).length,
    2,
    'the opening pass is not bounded',
  );
  // Unbounded by these arguments, every one of the twelve is found — so the numbers above are the bounds doing it.
  assert.equal((await findClientJson(env)).length, 12);
});

test('a bounded stream stops at the limit rather than after it', async () => {
  /*
   * The pipe twins of `--file` and `--from <path>`. Both accumulated every chunk and let the size check happen
   * afterwards, which is no check at all when the thing upstream is `/dev/zero`: the process dies before any
   * limit is consulted. This one stops at the chunk that crosses the line, so it never holds more than the limit
   * plus one chunk, and it stops reading rather than draining.
   *
   * The function is tested rather than the two commands that call it: proving the wiring would mean piping 35MB
   * through a CLI test. Which limit each caller passes is one readable line, checked by reading it.
   */
  const stream = (chunks: string[]) =>
    Readable.from(
      (async function* () {
        for (const chunk of chunks) yield Buffer.from(chunk);
      })(),
    ) as unknown as NodeJS.ReadableStream;

  const under = await readBoundedStream(stream(['hello ', 'world']), 64);
  assert.deepEqual(under, { ok: true, text: 'hello world' });

  // Exactly at the limit is fine; one byte past it is not.
  assert.deepEqual(await readBoundedStream(stream(['abcde']), 5), { ok: true, text: 'abcde' });
  assert.deepEqual(await readBoundedStream(stream(['abcde', 'f']), 5), { ok: false, problem: 'too-large' });

  /*
   * And it stops reading rather than draining. Large but finite on purpose: an endless generator would prove the
   * same thing by hanging, and a test that hangs is a test that fails as a CI timeout twenty minutes later with
   * no message. This one ends either way — a reader that stops at the limit sees nine of these chunks, and one
   * that checks the total afterwards returns `ok` with 64MB of zeroes and fails on the next line.
   */
  let yielded = 0;
  const huge = Readable.from(
    (async function* () {
      for (let index = 0; index < 64 * 1024; index += 1) {
        yielded += 1;
        yield Buffer.alloc(1024, 0);
      }
    })(),
  ) as unknown as NodeJS.ReadableStream;
  assert.deepEqual(await readBoundedStream(huge, 8 * 1024), { ok: false, problem: 'too-large' });
  assert.ok(yielded < 64, `it drained ${yielded} chunks instead of stopping at the limit`);
});

test('a stream that faults mid-read is an outcome, not a crash', async () => {
  // `for await` turns the stream's `error` event into a rejection, which reached the CLI as `UNEXPECTED` — the
  // code this package reserves for something nobody thought about. A pipe closing early is not that.
  const broken = Readable.from(
    (async function* () {
      yield Buffer.from('half a ');
      throw new Error('the writer went away');
    })(),
  ) as unknown as NodeJS.ReadableStream;
  assert.deepEqual(await readBoundedStream(broken, 1024), { ok: false, problem: 'unreadable' });
});
