import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { interactionFor } from '../src/cli/tui.ts';
import { CONSOLE_STEPS, findClientJson } from '../src/operations/setup.ts';
import { tempDir } from './support/harness.ts';

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
