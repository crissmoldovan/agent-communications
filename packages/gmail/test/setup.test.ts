import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, open, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import { interactionFor } from '../src/cli/tui.ts';
import { GmailContext } from '../src/context.ts';
import { clientAdd } from '../src/operations/clients.ts';
import { CONSOLE_STEPS, findClientJson } from '../src/operations/setup.ts';
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
      body: { installed: { client_id: 'a', client_secret: 's' } },
      minutesAgo: 600,
    },
    { name: 'client_secret_new_web.json', body: { web: { client_id: 'b', client_secret: 's' } }, minutesAgo: 1 },
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
    { name: 'client_secret_older.json', body: { installed: { client_id: 'a', client_secret: 's' } }, minutesAgo: 900 },
    { name: 'client_secret_newer.json', body: { installed: { client_id: 'b', client_secret: 's' } }, minutesAgo: 5 },
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
    { name: 'client_secret_fine.json', body: { installed: { client_id: 'a', client_secret: 's' } }, minutesAgo: 400 },
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

test('a pipe at either end falls back to plain, not to nothing', () => {
  // The list is drawn on stderr and steered from stdin. Either being a pipe breaks it in a different way, and
  // neither means nobody is there: `setup < answers.txt` is still a setup somebody wants to happen.
  assert.equal(modeFor({ streams: { stdin: tty(false), stdout: tty(true), stderr: tty(true) } as never }), 'plain');
  assert.equal(modeFor({ streams: { stdin: tty(true), stdout: tty(true), stderr: tty(false) } as never }), 'plain');
});

test('CI gets plain prompts, because a redrawing list in a log helps nobody', () => {
  for (const key of ['CI', 'GITHUB_ACTIONS', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER']) {
    assert.equal(modeFor({ env: { [key]: '1' } }), 'plain', key);
  }
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
