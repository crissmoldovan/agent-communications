import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gatedChange } from '../src/change-flow.ts';
import { activitySettingsChange } from '../src/operations/activity.ts';
import { searchDeleteEverything, searchQuery, searchSettingsChange } from '../src/operations/search.ts';
import { captureForSearch, resetCaptureForTests, type SearchCapture } from '../src/search/capture.ts';
import { ensureSearchKey, readSearchKey, SEARCH_KEY_REF, searchSecretStore } from '../src/search/crypto.ts';
import { searchEndpoint } from '../src/search/endpoint-rule.ts';
import { searchPaths } from '../src/search/folder.ts';
import { pruneSearchIndex, runSearchIndex } from '../src/search/indexer.ts';
import { isCloudModelName, searchModelName } from '../src/search/models.ts';
import { OllamaClient } from '../src/search/ollama.ts';
import { loadSearchSqlite } from '../src/search/sqlite.ts';
import { runMain } from './helpers/main-in-process.ts';
import {
  MAIL,
  QWEN_LOCAL,
  RESEND,
  type SearchMachine,
  SLACK,
  searchMachine,
  startFakeOllama,
  WHATSAPP,
} from './helpers/search.ts';

/*
 * Search on this machine's guards (design 2026-10-26-local-search, S1, S9, S11, S12, S13, §7, §9), each a test written
 * before the code it holds and seen to fail once with the guard broken: who may (an agent's marker, an MCP server's
 * process), where the words may go (loopback only), which models (the reviewed list, never remote), what is encrypted
 * at rest, what retention deletes, and Delete everything. Every test runs in a temporary home with synthetic accounts,
 * a secret store in memory and stand-ins for tmutil and fdesetup; the only connection made is to a fake Ollama on
 * 127.0.0.1, and the test preload seals the rest.
 */

const DAY = 24 * 60 * 60 * 1000;

function on(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: 'on', accounts: [MAIL.id, SLACK.id], ...extra };
}

function mail(over: Partial<SearchCapture> = {}): SearchCapture {
  return {
    channel: 'gmail',
    direction: 'in',
    sourceId: '18c0000000000001',
    threadId: '18c0000000000001',
    from: { address: 'David.Park@Acme.Example', name: 'David Park' },
    subject: 'The October invoice',
    text: 'Hi, could you send me the invoice for October? Thanks.',
    at: Date.now() - 60_000,
    partial: false,
    ...over,
  };
}

async function capture(machine: SearchMachine, account: { id: string }, captures: SearchCapture[], now?: number) {
  resetCaptureForTests();
  return captureForSearch(machine.core, account, captures, {
    secrets: machine.deps.secrets,
    ...(now === undefined ? {} : { now: () => now }),
    warn: () => undefined,
  });
}

async function index(machine: SearchMachine) {
  return runSearchIndex(machine.core, { budgetMs: 5_000, waitMs: 2_000 }, machine.deps);
}

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

function errorOf(run: { json: () => Record<string, unknown> }): { code: string; details?: Record<string, unknown> } {
  return run.json().error as { code: string; details?: Record<string, unknown> };
}

// ── Who may (S13) ──────────────────────────────────────────────────────────────────────────────────────────────

const PERSON_ONLY: readonly (readonly string[])[] = [
  ['search', 'query', 'invoice'],
  ['search', 'people'],
  ['search', 'person', 'p_0000000000000000000000000A'],
  ['search', 'show', '18c0000000000001'],
  ['search', 'index'],
  ['search', 'rebuild'],
  ['search', 'link', 'p_0000000000000000000000000A', 'p_0000000000000000000000000B'],
  ['search', 'unlink', 'email:david@acme.example'],
  ['search', 'label', 'p_0000000000000000000000000A', 'David'],
  ['search', 'on'],
  ['search', 'accounts', 'add', MAIL.alias],
  ['search', 'model', 'set', 'http://127.0.0.1:11434'],
];

const ANYWHERE: readonly (readonly string[])[] = [
  ['search', 'status'],
  ['search', 'off'],
  ['search', 'accounts', 'remove', SLACK.alias],
  ['search', 'model', 'none'],
  ['search', 'delete', '--all', '--confirm'],
];

for (const [marker, value, reason] of [
  ['CLAUDECODE', '1', 'AGENT_MARKER'],
  ['CODEX_SANDBOX', 'seatbelt', 'AGENT_MARKER'],
  ['AGENTCOMMS_MCP_SERVER', 'core', 'MCP_SERVER_PROCESS'],
] as const) {
  test(`GUARD: every person-only search command is refused under ${marker}, before anything is read or kept`, async () => {
    const machine = searchMachine(on());
    await ensureSearchKey(machine.secrets, searchPaths(machine.stateDir).keyLock);
    for (const words of PERSON_ONLY) {
      const run = await runMain([...words, '--json'], { ...machine.env, [marker]: value }, process.platform, {
        search: machine.deps,
      });
      assert.equal(run.code, 10, `${words.join(' ')}: ${run.stdout}`);
      const error = errorOf(run);
      assert.equal(error.code, 'APPROVAL_REQUIRED', words.join(' '));
      assert.equal(error.details?.reason, reason, words.join(' '));
    }
    // Nothing was made by any of them: no database, no inbox.
    assert.equal(existsSync(searchPaths(machine.stateDir).database), false);
  });

  test(`GUARD: status and the tightenings still work under ${marker}`, async () => {
    const machine = searchMachine(on({ model: { address: 'http://127.0.0.1:9', name: QWEN_LOCAL.name } }));
    for (const words of ANYWHERE) {
      const run = await runMain([...words, '--json'], { ...machine.env, [marker]: value }, process.platform, {
        search: machine.deps,
      });
      assert.equal(run.code, 0, `${words.join(' ')}: ${run.stdout}${run.stderr}`);
    }
    const config = JSON.parse(readFileSync(join(machine.configDir, 'config.json'), 'utf8')) as {
      search: { enabled: string; accounts: string[]; model: unknown };
    };
    assert.equal(config.search.enabled, 'off');
    assert.deepEqual(config.search.accounts, [MAIL.id]);
    assert.equal(config.search.model, null);
  });
}

test('GUARD: the operations refuse by themselves, whatever surface calls them', async () => {
  const machine = searchMachine(on());
  await assert.rejects(
    searchQuery(machine.core, { text: 'invoice' }, { env: { CLAUDECODE: '1' }, deps: machine.deps }),
    {
      code: 'APPROVAL_REQUIRED',
    },
  );
  await assert.rejects(
    searchQuery(machine.core, { text: 'invoice' }, { env: { AGENTCOMMS_MCP_SERVER: 'gmail' }, deps: machine.deps }),
    { code: 'APPROVAL_REQUIRED' },
  );
  assert.throws(() => searchSettingsChange(machine.core, { enabled: 'on' }, 'cli', { env: { GEMINI_CLI: '1' } }), {
    code: 'APPROVAL_REQUIRED',
  });
  // A tightening is anyone's.
  assert.doesNotThrow(() =>
    searchSettingsChange(machine.core, { enabled: 'off' }, 'cli', { env: { GEMINI_CLI: '1' } }),
  );
});

test('GUARD: no MCP tool reads what Search keeps: every search command is an exception row with no tool', () => {
  const table = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../capabilities.json', import.meta.url)), 'utf8'),
  ) as { capabilities: { id: string; cli: string | null; mcp: string | null; status: string; reason?: string }[] };
  const rows = table.capabilities.filter((row) => row.cli?.startsWith('search ') && row.id.startsWith('core.'));
  assert.ok(rows.length >= 17, `found ${rows.length} rows`);
  for (const row of rows) {
    assert.equal(row.mcp, null, row.id);
    assert.equal(row.status, 'exception', row.id);
    assert.ok((row.reason ?? '').length > 40, row.id);
  }
  assert.equal(
    table.capabilities.some((row) => /search/.test(row.mcp ?? '') && row.id.startsWith('core.')),
    false,
  );
});

test('GUARD: under test, Search never reaches the system keychain: a test that forgot its own store fails', async () => {
  // No secrets block in this configuration: the store in force is the system keychain.
  const machine = searchMachine(on());
  await assert.rejects(searchSecretStore(machine.core), /system keychain/u);
  resetCaptureForTests();
  assert.equal(await captureForSearch(machine.core, MAIL, [mail()], { warn: () => undefined }), 0);
  await assert.rejects(runSearchIndex(machine.core, { budgetMs: 0, waitMs: 1_000 }), /system keychain/u);
  // Taken back: each refusal above was caused on purpose, and the preload fails a process that leaves one.
  const attempts = (globalThis as unknown as Record<symbol, string[] | undefined>)[
    Symbol.for('agentcomms.test.real-home-attempts.v1')
  ];
  assert.deepEqual(attempts?.splice(0), [
    "the system keychain, for Search's key",
    "the system keychain, for Search's key",
    "the system keychain, for Search's key",
  ]);
});

// ── Loopback only (S9) ─────────────────────────────────────────────────────────────────────────────────────────

const VECTORS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/search-endpoint-vectors.json', import.meta.url)), 'utf8'),
) as { refused: string[]; taken: { given: string; address: string; host: string; port: number }[] };

test('GUARD: the model server is a literal 127.0.0.1 or ::1 with its port — the judges’ vectors, and more', () => {
  for (const url of VECTORS.refused) {
    assert.throws(() => searchEndpoint(url), /local model server's URL/u, url);
  }
  for (const taken of VECTORS.taken) {
    assert.deepEqual(searchEndpoint(taken.given), { address: taken.address, host: taken.host, port: taken.port });
  }
  // Pinned to the event service's own list: every URL its judge setup refuses, this refuses too.
  const judges = readFileSync(
    fileURLToPath(new URL('../../events-daemon/test/judge-setup.test.ts', import.meta.url)),
    'utf8',
  );
  const block = /refuses a local model server that is not on this machine[\s\S]*?\]\) \{/u.exec(judges)?.[0] ?? '';
  const theirs = [...block.matchAll(/'(https?:\/\/[^']+)'/gu)].map((match) => match[1] as string);
  assert.ok(theirs.length >= 9, 'the event service’s vectors were found');
  for (const url of theirs) assert.ok(VECTORS.refused.includes(url), `${url} is refused here too`);
});

test('GUARD: a model server address off this machine is refused before anything is called, in settings and in the client', async () => {
  const machine = searchMachine(on());
  for (const address of ['http://localhost:11434', 'http://10.0.0.5:11434', 'https://127.0.0.1:11434']) {
    assert.throws(() => searchSettingsChange(machine.core, { model: { address } }, 'cli', { env: {} }), {
      code: 'USAGE',
    });
    assert.throws(() => new OllamaClient(address, QWEN_LOCAL.name), { code: 'USAGE' });
  }
  // A hand-edited address off this machine reads as no model: words only, and nothing is called.
  const exchanged: string[] = [];
  machine.write(on({ model: { address: 'http://ollama.example:11434', name: QWEN_LOCAL.name } }));
  await capture(machine, MAIL, [mail()]);
  const run = await runSearchIndex(
    machine.core,
    { budgetMs: 1_000, waitMs: 1_000 },
    {
      ...machine.deps,
      exchange: async (endpoint) => {
        exchanged.push(endpoint.address);
        return { status: 500, body: '' };
      },
    },
  );
  assert.equal(run.inserted, 1);
  assert.equal(run.model, null);
  assert.deepEqual(exchanged, []);
});

// ── The reviewed models, never remote (S9) ─────────────────────────────────────────────────────────────────────

test('GUARD: only the reviewed models are taken, and a …cloud name never is', () => {
  assert.equal(searchModelName('qwen3-embedding:0.6b'), 'qwen3-embedding:0.6b');
  assert.equal(searchModelName('embeddinggemma'), 'embeddinggemma:latest');
  assert.equal(searchModelName('bge-m3'), 'bge-m3:latest');
  for (const name of [
    'llama3',
    'nomic-embed-text',
    'qwen3-embedding:8b',
    'qwen3-embedding:0.6b-cloud',
    'bge-m3:cloud',
    '',
  ]) {
    assert.equal(searchModelName(name), undefined, name);
  }
  assert.equal(isCloudModelName('gpt-oss:120b-cloud'), true);
  const machine = searchMachine(on());
  for (const name of ['llama3', 'deepseek-v3.1:671b-cloud']) {
    assert.throws(
      () =>
        searchSettingsChange(machine.core, { model: { address: 'http://127.0.0.1:11434', name } }, 'cli', { env: {} }),
      { code: 'USAGE' },
    );
  }
});

test('GUARD: a model Ollama lists as remote is refused, and no message is sent to it', async () => {
  for (const listed of [
    { ...QWEN_LOCAL, remote_host: 'https://ollama.com:443' },
    { ...QWEN_LOCAL, remote_model: 'qwen3-embedding:0.6b' },
  ]) {
    const ollama = await startFakeOllama([listed]);
    try {
      const machine = searchMachine(on({ model: { address: ollama.address, name: QWEN_LOCAL.name } }), {
        exchange: undefined,
      });
      await capture(machine, MAIL, [mail()]);
      const run = await index(machine);
      assert.equal(run.model?.state, 'remote-refused');
      assert.equal(run.embedded, 0);
      assert.deepEqual(
        ollama.requests.map((request) => request.path),
        ['/api/tags'],
        'only the list was asked for',
      );
      const found = await searchQuery(machine.core, { text: 'invoice' }, { env: {}, deps: machine.deps });
      assert.equal(found.mode, 'words');
      assert.equal(found.hits.length, 1);
      assert.equal(
        ollama.requests.some((request) => request.path === '/api/embed'),
        false,
      );
    } finally {
      await ollama.close();
    }
  }
});

// ── Encrypted at rest (S11) ────────────────────────────────────────────────────────────────────────────────────

test('GUARD: inbox lines and kept records are ciphertext: a planted name, subject and sentence are in no file under state', async () => {
  const ollama = await startFakeOllama([QWEN_LOCAL]);
  try {
    const machine = searchMachine(on({ model: { address: ollama.address, name: QWEN_LOCAL.name } }));
    const name = 'Quillon Marrowfax';
    const subject = 'Zephyrine budget recap';
    const sentence = 'The vault code is TANGERINE-KETTLE-4417, keep it.';
    await capture(machine, MAIL, [
      mail({ from: { address: 'q.marrowfax@acme.example', name }, subject, text: sentence }),
    ]);
    const inboxFiles = filesBelow(searchPaths(machine.stateDir).inbox);
    assert.equal(inboxFiles.length, 1);
    for (const marker of [name, subject, sentence, 'TANGERINE', 'Marrowfax', 'q.marrowfax']) {
      assert.equal(readFileSync(inboxFiles[0] as string, 'utf8').includes(marker), false, `inbox holds ${marker}`);
    }
    const run = await index(machine);
    assert.equal(run.inserted, 1);
    assert.equal(run.embedded, 1);
    const files = filesBelow(machine.stateDir);
    assert.ok(files.some((file) => file.endsWith('search.sqlite')));
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const marker of [name, 'Marrowfax', sentence, subject]) {
        assert.equal(bytes.includes(Buffer.from(marker, 'utf8')), false, `${file} holds ${marker}`);
      }
    }
    // The words as the words index would have folded them are in no file either: it holds keyed hashes (M2). The
    // sender's address is a handle, kept plain for lookups (S11), so its words are not looked for here.
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const token of ['tangerine', 'kettle', 'zephyrine', 'quillon', 'budget', 'recap']) {
        assert.equal(bytes.includes(Buffer.from(token, 'utf8')), false, `${file} holds ${token}`);
      }
    }
    // What is not encrypted, and is pinned here: the vectors. The words index finds nothing by a word without the key.
    const sqlite = await loadSearchSqlite();
    const db = new sqlite.DatabaseSync(searchPaths(machine.stateDir).database, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM words WHERE words MATCH 'tangerine'").get()?.n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM vectors').get()?.n, 1);
      const record = db.prepare('SELECT encrypted_record FROM messages').get()?.encrypted_record as Uint8Array;
      assert.equal(Buffer.from(record).includes(Buffer.from('TANGERINE')), false);
      assert.equal(Buffer.from(record)[0], 1, 'packed record format v1');
    } finally {
      db.close();
    }
    // Owner-only: the folder 700, every file 600.
    if (process.platform !== 'win32') {
      assert.equal(statSync(searchPaths(machine.stateDir).dir).mode & 0o777, 0o700);
      for (const file of filesBelow(searchPaths(machine.stateDir).dir)) {
        assert.equal(statSync(file).mode & 0o077, 0, `${file} is private`);
      }
    }
  } finally {
    await ollama.close();
  }
});

/** The words index read as someone without the key would read it: each term, and where it stood, row by row. */
async function wordsWithoutTheKey(machine: SearchMachine): Promise<{ doc: number; term: string; offset: unknown }[]> {
  const sqlite = await loadSearchSqlite();
  const raw = new sqlite.DatabaseSync(searchPaths(machine.stateDir).database);
  try {
    raw.exec("CREATE VIRTUAL TABLE temp.v USING fts5vocab(main, words, 'instance')");
    return raw.prepare('SELECT doc, term, offset FROM temp.v ORDER BY doc, col, offset').all() as {
      doc: number;
      term: string;
      offset: unknown;
    }[];
  } finally {
    raw.close();
  }
}

test('GUARD: the words index holds keyed hashes of words, never the words: without the key no message is read back from it, in order or out of it (review 2026-10-27, M2)', async () => {
  const machine = searchMachine(on());
  // The review's scenario: a message whose subject and text were rebuilt, in order, from `fts5vocab 'instance'`.
  const secret = 'The new salary for Ioana is 9731 lei and the door code is marmotlantern';
  await capture(machine, MAIL, [
    mail({ sourceId: '18c00000000000m1', subject: 'Quarterly salaries', text: secret }),
    ...Array.from({ length: 30 }, (_, at) =>
      mail({ sourceId: `18c00000000001${String(at).padStart(2, '0')}`, subject: `lunch ${at}`, text: `note ${at}` }),
    ),
  ]);
  assert.equal((await index(machine)).inserted, 31);
  const terms = await wordsWithoutTheKey(machine);
  assert.ok(terms.length > 0);
  const words = new Set(terms.map((entry) => entry.term));
  for (const word of ['salary', 'ioana', '9731', 'lei', 'door', 'code', 'marmotlantern', 'quarterly', 'salaries']) {
    assert.equal(words.has(word), false, `the words index holds "${word}"`);
  }
  for (const entry of terms) {
    assert.match(entry.term, /^[0-9a-f]{32}$/u, 'a term is a keyed hash, nothing a word can be read from');
    assert.equal(entry.offset, null, 'no position is kept: the order of the words is not in the file');
  }
  for (const file of filesBelow(searchPaths(machine.stateDir).dir)) {
    const bytes = readFileSync(file);
    for (const word of ['salary', 'ioana', 'marmotlantern', 'salaries']) {
      assert.equal(bytes.includes(Buffer.from(word, 'utf8')), false, `${file} holds ${word}`);
    }
  }
  // With the key, the words still find it — whole, folded, and the last one as a prefix.
  for (const words of ['marmotlantern', 'IOANA salary', 'door marmotlan', 'Quarterly']) {
    const found = await searchQuery(machine.core, { text: words }, { env: {}, deps: machine.deps });
    assert.equal(found.hits[0]?.sourceId, '18c00000000000m1', words);
  }
});

test('GUARD: an index a 0.35 test build made, whose words index held the words, is rebuilt with keyed hashes on its first open — the words leave the file, and the same words find the same message (M2)', async () => {
  const machine = searchMachine(on());
  await capture(machine, MAIL, [
    mail({ sourceId: '18c00000000000n1', subject: 'Gate code', text: 'the gate code is plumquandary' }),
    mail({ sourceId: '18c00000000000n2', subject: 'Lunch', text: 'lunch on friday' }),
  ]);
  await index(machine);
  // The file as that build left it: its words table, holding the words, and schema 1.
  const paths = searchPaths(machine.stateDir);
  const sqlite = await loadSearchSqlite();
  const old = new sqlite.DatabaseSync(paths.database);
  old.exec('DROP TABLE words');
  old.exec(
    "CREATE VIRTUAL TABLE words USING fts5(subject, text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
  );
  const ids = old.prepare('SELECT id, source_id FROM messages').all() as { id: number; source_id: string }[];
  for (const row of ids) {
    const [subject, text] =
      row.source_id === '18c00000000000n1'
        ? ['Gate code', 'the gate code is plumquandary']
        : ['Lunch', 'lunch on friday'];
    old.prepare('INSERT INTO words(rowid, subject, text) VALUES (?, ?, ?)').run(row.id, subject, text);
  }
  old.exec("UPDATE meta SET value = '1' WHERE key = 'schema'");
  old.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  old.close();
  const holds = () => filesBelow(paths.dir).some((file) => readFileSync(file).includes(Buffer.from('plumquandary')));
  assert.equal(holds(), true, 'the old words index holds the word');
  // Upkeep with no key opens it first — a prune — and the words go at once; their hashes need the key, so they wait.
  await pruneSearchIndex(machine.core, machine.deps);
  assert.equal(holds(), false, 'the words left the file at the first open, before any key was asked for');
  // The first open with the key makes the hashes from the sealed text, and the same words find the same message.
  const found = await searchQuery(machine.core, { text: 'plumquandary' }, { env: {}, deps: machine.deps });
  assert.deepEqual(
    found.hits.map((hit) => hit.sourceId),
    ['18c00000000000n1'],
  );
  assert.equal(holds(), false);
  const after = new sqlite.DatabaseSync(paths.database, { readOnly: true });
  try {
    assert.equal(after.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.value, '2');
  } finally {
    after.close();
  }
  assert.ok((await wordsWithoutTheKey(machine)).every((entry) => /^[0-9a-f]{32}$/u.test(entry.term)));
});

test('GUARD: a record moved to another row does not open, and a line sealed with another key is not kept', async () => {
  const machine = searchMachine(on());
  await capture(machine, MAIL, [
    mail(),
    mail({ sourceId: '18c0000000000002', subject: 'Second', text: 'second message' }),
  ]);
  await index(machine);
  const sqlite = await loadSearchSqlite();
  const db = new sqlite.DatabaseSync(searchPaths(machine.stateDir).database);
  db.exec('UPDATE messages SET encrypted_record = (SELECT encrypted_record FROM messages WHERE id = 2) WHERE id = 1');
  db.close();
  const found = await searchQuery(machine.core, { text: 'invoice October second' }, { env: {}, deps: machine.deps });
  assert.deepEqual(
    found.hits.map((hit) => hit.sourceId),
    ['18c0000000000002'],
    'the row whose record was swapped is not shown',
  );
  // The master replaced: a capture sealed under the old one is taken and refused, never kept.
  await capture(machine, MAIL, [mail({ sourceId: '18c0000000000003' })]);
  machine.secrets.values.delete(SEARCH_KEY_REF);
  await ensureSearchKey(machine.secrets, searchPaths(machine.stateDir).keyLock);
  await assert.rejects(index(machine), /key this machine no longer has/u);
});

// ── Capture: only what was in hand, only what is kept (S1, S2) ────────────────────────────────────────────────────

test('GUARD: nothing is kept while Search is off, for an account left out, from the account’s own handles, or from Resend and WhatsApp', async () => {
  const machine = searchMachine({ enabled: 'off', accounts: [MAIL.id, SLACK.id] });
  assert.equal(await capture(machine, MAIL, [mail()]), 0);
  assert.equal(existsSync(searchPaths(machine.stateDir).dir), false, 'off: not even a folder');
  machine.write({ enabled: 'on', accounts: [SLACK.id] });
  assert.equal(await capture(machine, MAIL, [mail()]), 0, 'the mailbox is left out');
  machine.write(on());
  assert.equal(
    await capture(machine, MAIL, [mail({ from: { address: 'JO@acme.test', name: 'Jo' } })]),
    0,
    'its own address',
  );
  assert.equal(
    await captureForSearch(machine.core, MAIL, [mail({ from: { address: 'jo.sendas@acme.test' } })], {
      secrets: machine.deps.secrets,
      own: ['jo.sendas@acme.test'],
    }),
    0,
    'a send-as address',
  );
  assert.equal(
    await capture(machine, SLACK, [
      {
        channel: 'slack',
        direction: 'in',
        sourceId: 'C0GENERAL/1700000001.000100',
        from: { userId: SLACK.userId },
        text: 'my own message',
        at: Date.now(),
        partial: false,
      },
    ]),
    0,
    'its own Slack user',
  );
  assert.equal(await capture(machine, MAIL, [mail()]), 1);
  // Resend and WhatsApp cannot be included at all.
  for (const alias of [RESEND.alias, WHATSAPP.alias]) {
    const change = searchSettingsChange(machine.core, { account: alias, include: true }, 'cli', { env: {} });
    await assert.rejects(gatedChange(machine.core, change, { surface: 'cli', channel: 'core' }), { code: 'USAGE' });
  }
});

test('GUARD: a capture never throws and never holds a call long, whatever fails', async () => {
  const machine = searchMachine(on());
  const said: string[] = [];
  resetCaptureForTests();
  const started = Date.now();
  const kept = await captureForSearch(machine.core, MAIL, [mail()], {
    secrets: async () => {
      throw new Error('the keychain is locked');
    },
    warn: (line) => said.push(line),
  });
  assert.equal(kept, 0);
  assert.ok(Date.now() - started < 2_500);
  assert.equal(said.length, 1);
  assert.doesNotMatch(said[0] ?? '', /invoice/u, 'what is said holds no text');
  // A second failure in the same process is not said again.
  await captureForSearch(machine.core, MAIL, [mail()], {
    secrets: async () => {
      throw new Error('still locked');
    },
    warn: (line) => said.push(line),
  });
  assert.equal(said.length, 1);
  // Garbage in: nothing kept, nothing thrown.
  assert.equal(
    await capture(machine, MAIL, [
      { ...mail(), sourceId: '../../etc/passwd' },
      { ...mail(), channel: 'whatsapp' as never },
      { ...mail(), text: '', subject: '' },
    ]),
    0,
  );
});

test('a capture costs about one encryption and one append: its budget, measured', async () => {
  const machine = searchMachine(on());
  await capture(machine, MAIL, [mail()]);
  const times: number[] = [];
  for (let at = 0; at < 50; at += 1) {
    const started = performance.now();
    await captureForSearch(machine.core, MAIL, [mail({ sourceId: `18c00000000010${String(at).padStart(2, '0')}` })], {
      secrets: machine.deps.secrets,
    });
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] ?? 0;
  console.log(`# capture: median ${median.toFixed(2)} ms over 50 (budget about 5 ms)`);
  assert.ok(median < 25, `median ${median} ms`);
});

// ── Retention follows Activity's days (S12) ────────────────────────────────────────────────────────────────────

test('GUARD: what is past Activity’s days is deleted — rows, words and vectors — and lowering the days prunes at once', async () => {
  const ollama = await startFakeOllama([QWEN_LOCAL]);
  try {
    const machine = searchMachine(on({ model: { address: ollama.address, name: QWEN_LOCAL.name } }));
    const now = Date.now();
    await capture(machine, MAIL, [mail({ sourceId: '18c00000000000a1', text: 'old invoice' })], now - 40 * DAY);
    await capture(machine, MAIL, [mail({ sourceId: '18c00000000000a2', text: 'recent invoice' })], now - 10 * DAY);
    await capture(machine, MAIL, [mail({ sourceId: '18c00000000000a3', text: 'fresh invoice' })], now - DAY);
    // The forty-day-old capture's file is pruned by its day even before the indexer sees it.
    const run = await index(machine);
    assert.equal(run.inserted, 2);
    const kept = async () =>
      (await searchQuery(machine.core, { text: 'invoice' }, { env: {}, deps: machine.deps })).hits
        .map((hit) => hit.sourceId)
        .sort();
    assert.deepEqual(await kept(), ['18c00000000000a2', '18c00000000000a3']);
    // Activity keeps 7 days now: applied at once, and Search's rows go with it.
    const change = activitySettingsChange(machine.core, { retentionDays: 7 }, 'cli');
    await gatedChange(machine.core, change, { surface: 'cli', channel: 'core' });
    const sqlite = await loadSearchSqlite();
    const db = new sqlite.DatabaseSync(searchPaths(machine.stateDir).database, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get()?.n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM vectors').get()?.n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM words WHERE words MATCH 'recent'").get()?.n, 0);
    } finally {
      db.close();
    }
    assert.deepEqual(await kept(), ['18c00000000000a3']);
  } finally {
    await ollama.close();
  }
});

test('GUARD: an account taken out of Search loses its rows at once', async () => {
  const machine = searchMachine(on());
  await capture(machine, MAIL, [mail()]);
  await capture(machine, SLACK, [
    {
      channel: 'slack',
      direction: 'in',
      sourceId: 'C0GENERAL/1700000001.000100',
      from: { userId: 'U0DAVID' },
      text: 'the invoice is attached',
      at: Date.now(),
      partial: false,
    },
  ]);
  await index(machine);
  const change = searchSettingsChange(machine.core, { account: MAIL.alias, include: false }, 'cli', { env: {} });
  const outcome = await gatedChange(machine.core, change, { surface: 'cli', channel: 'core' });
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.status === 'applied' ? outcome.result.deleted : -1, 1);
  const found = await searchQuery(machine.core, { text: 'invoice' }, { env: {}, deps: machine.deps });
  assert.deepEqual(
    found.hits.map((hit) => hit.channel),
    ['slack'],
  );
});

test('GUARD: the day’s first agentcomms command prunes what Activity’s days no longer keep, once a day', async () => {
  const machine = searchMachine(on());
  const now = Date.now();
  await capture(machine, MAIL, [mail({ sourceId: '18c00000000000b1', text: 'ten days old invoice' })], now - 10 * DAY);
  await capture(machine, MAIL, [mail({ sourceId: '18c00000000000b2', text: 'fresh invoice' })], now - DAY);
  await index(machine);
  // Seven days now, written by hand, as another release or a person might: no prune ran when it changed.
  machine.write(on(), { retentionDays: 7 });
  const count = async () => {
    const sqlite = await loadSearchSqlite();
    const db = new sqlite.DatabaseSync(searchPaths(machine.stateDir).database, { readOnly: true });
    try {
      return Number(db.prepare('SELECT count(*) AS n FROM messages').get()?.n);
    } finally {
      db.close();
    }
  };
  assert.equal(await count(), 2);
  const paths = await runMain(['paths', '--json'], machine.env, process.platform, { search: machine.deps });
  assert.equal(paths.code, 0);
  assert.equal(await count(), 1, 'any command, the first of the day');
  assert.equal(
    readFileSync(join(searchPaths(machine.stateDir).dir, '.pruned-day'), 'utf8').trim(),
    new Date().toISOString().slice(0, 10),
  );
});

test('GUARD: after Delete everything, a process that kept the old key in memory seals with the new one', async () => {
  const machine = searchMachine(on());
  resetCaptureForTests();
  const keep = (id: string) =>
    captureForSearch(machine.core, MAIL, [mail({ sourceId: id })], {
      secrets: machine.deps.secrets,
      warn: () => undefined,
    });
  assert.equal(await keep('18c00000000000c1'), 1);
  const first = await readSearchKey(machine.secrets);
  await searchDeleteEverything(machine.core, { all: true, confirm: true }, 'cli', { deps: machine.deps });
  // The same process captures again, without being told: the old key is gone from the store and from its memory.
  assert.equal(await keep('18c00000000000c2'), 1);
  const second = await readSearchKey(machine.secrets);
  assert.ok(first && second);
  assert.notEqual(second.keyId, first.keyId);
  const run = await index(machine);
  assert.equal(run.refused, 0, 'nothing sealed for a key nobody has');
  assert.equal(run.inserted, 1);
  // A key made by another process is seen too: its id is noted beside the folder.
  machine.secrets.values.delete(SEARCH_KEY_REF);
  await searchDeleteEverything(machine.core, { all: true, confirm: true }, 'cli', { deps: machine.deps });
  await index(machine);
  const third = await readSearchKey(machine.secrets);
  assert.ok(third);
  assert.equal(await keep('18c00000000000c3'), 1);
  assert.equal((await index(machine)).inserted, 1);
});

// ── Delete everything (§7) ─────────────────────────────────────────────────────────────────────────────────────

test('GUARD: delete everything leaves no file and no key, and a later run starts empty under a new key', async () => {
  const machine = searchMachine(on());
  const marker = 'Wistful Periwinkle';
  await capture(machine, MAIL, [mail({ from: { address: 'w.p@acme.example', name: marker } })]);
  await index(machine);
  await capture(machine, MAIL, [mail({ sourceId: '18c0000000000009' })]);
  const before = await readSearchKey(machine.secrets);
  assert.ok(before);
  await assert.rejects(searchDeleteEverything(machine.core, { all: true }, 'cli', { deps: machine.deps }), {
    code: 'USAGE',
  });
  const result = await searchDeleteEverything(machine.core, { all: true, confirm: true }, 'cli', {
    deps: machine.deps,
  });
  assert.equal(result.keyDeleted, true);
  assert.ok(result.files >= 2);
  assert.equal(existsSync(searchPaths(machine.stateDir).dir), false);
  assert.equal(machine.secrets.values.has(SEARCH_KEY_REF), false);
  for (const file of filesBelow(machine.stateDir)) {
    assert.equal(readFileSync(file).includes(Buffer.from(marker)), false, file);
  }
  // The audit line says it happened, and nothing of what was kept.
  const [line] = (await machine.core.audit.tail({ limit: 5 })).filter((record) => record.operation === 'search.delete');
  assert.ok(line);
  assert.equal(JSON.stringify(line).includes('invoice'), false);
  // Search stays on: what it keeps from now on starts empty, under a new key.
  const run = await index(machine);
  assert.equal(run.taken, 0);
  const after = await readSearchKey(machine.secrets);
  assert.ok(after);
  assert.notEqual(after.keyId, before.keyId);
  const found = await searchQuery(machine.core, { text: 'invoice' }, { env: {}, deps: machine.deps });
  assert.equal(found.hits.length, 0);
});
