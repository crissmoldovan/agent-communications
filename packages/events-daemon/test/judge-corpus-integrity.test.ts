import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import * as corpusVerifier from '../../../scripts/verify-events-adversarial-corpus.mjs';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import { verifyPhaseETestManifest } from '../../../scripts/verify-events-phase-e-tests.mjs';

// Fake credential shapes are assembled at run time, so this file never holds a literal the repository's own secret
// scanner (scripts/verify-skills.mjs) would flag. The strings the tests pass to the corpus scanner are unchanged.
const SK_FAKE = ['sk', 'a'.repeat(32)].join('-');
const API_KEY = ['api', 'key'].join('_');
const PRIVATE_KEY_HEADER = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

const { assertAdversarialCorpusFileInventory, assertScriptedResponseInventory, assertSyntheticFixtureText } =
  corpusVerifier;

const corpusUrl = new URL('./fixtures/judges/adversarial-v1.jsonl', import.meta.url);
const manifestUrl = new URL('./fixtures/judges/adversarial-v1.manifest.json', import.meta.url);
const journalUrl = new URL('./fixtures/judges/adversarial-v1.journal.json', import.meta.url);
const sharedManifestUrl = new URL('./fixtures/judges/case-manifest.json', import.meta.url);
const fixtureHelperUrl = new URL('./support/judge-adversarial-fixture.ts', import.meta.url);

const rowKeys = new Set(['schema', 'id', 'category', 'response', 'scenario', 'subject', 'expected']);
const responseKinds = new Set([
  'noul-low',
  'noul-hold',
  'noul-match',
  'provider-match-low',
  'wrong-type-score',
  'truncated',
  'multiple-json',
  'nan',
  'infinite',
  'range-high',
  'tool',
  'hostile-reason',
  'redirect',
  'oversize',
  'output-limit',
]);
const categories = new Set([
  'provider-match',
  'injection-envelope-forgery',
  'control-unicode',
  'exact-input-taint',
  'truncated-json',
  'multiple-json',
  'wrong-nan-infinite-range-score',
  'provider-match-tools',
  'hostile-reason-text',
  'redirect',
  'oversize-response',
  'token-refusal',
  'request-cap',
  'disabled-kind',
  'disable-race',
  'revoke-race',
  'budget-activation',
  'budget-race',
  'post-io-unknown',
  'response-after-hold',
  'response-after-expiry',
  'userinfo-host-drift',
  'dns-rebinding',
]);
const outcomes = new Set(['matched', 'no-match', 'hold', 'hold-expired']);
const reservations = new Set(['settled', 'released', 'none']);
const projections = new Set(['purged', 'retained']);
const scenarios = new Set([
  'exact-input',
  'input-token-limit',
  'request-cap',
  'kind-disabled',
  'kind-disable-race',
  'rule-revocation-race',
  'budget-inactive',
  'budget-race',
  'post-io-unknown',
  'hold',
  'hold-expiry',
  'late-response-expiry',
  'endpoint-userinfo',
  'endpoint-host-drift',
  'endpoint-host-drift-race',
  'dns-rebinding',
]);

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  message: string,
): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${message}: object`);
  assert.notEqual(value, null, `${message}: non-null`);
  assert.equal(Array.isArray(value), false, `${message}: not an array`);
  for (const key of Object.keys(value as object))
    assert.equal(allowed.has(key), true, `${message}: no unknown key ${key}`);
}

test('E11 adversarial corpus integrity: every row, digest, journal and shared manifest pairing is synthetic and exact', async () => {
  const inventory = await assertAdversarialCorpusFileInventory();
  const [corpus, manifestText, journalText, sharedText, helperText] = await Promise.all([
    readFile(fileURLToPath(corpusUrl)),
    readFile(fileURLToPath(manifestUrl), 'utf8'),
    readFile(fileURLToPath(journalUrl), 'utf8'),
    readFile(fileURLToPath(sharedManifestUrl), 'utf8'),
    readFile(fileURLToPath(fixtureHelperUrl), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText) as {
    schema?: unknown;
    files?: unknown;
    corpus?: unknown;
    sha256?: unknown;
    cases?: unknown[];
    journal?: unknown;
    journalSha256?: unknown;
  };
  exactKeys(
    manifest,
    new Set(['schema', 'files', 'corpus', 'sha256', 'journal', 'journalSha256', 'cases']),
    'adversarial manifest schema',
  );
  assert.equal(manifest.schema, 'agentcomms.events.judge-adversarial-manifest-v1', 'manifest schema version');
  assert.equal(manifest.corpus, 'adversarial-v1.jsonl', 'manifest corpus name');
  assert.equal(manifest.sha256, sha256(corpus), 'manifest pins the whole corpus bytes');
  assert.equal(manifest.journal, 'adversarial-v1.journal.json', 'manifest journal name');
  assert.equal(manifest.journalSha256, sha256(journalText), 'manifest pins the whole journal bytes');
  const declaredHashes = new Set<string>([manifest.sha256 as string, manifest.journalSha256 as string]);
  for (const entry of manifest.cases ?? []) {
    if (typeof (entry as { sha256?: unknown }).sha256 === 'string')
      declaredHashes.add((entry as { sha256: string }).sha256);
  }
  await Promise.all(
    inventory.files.map(async (file: string) =>
      assertSyntheticFixtureText({
        text: await readFile(join(inventory.repositoryRoot, file), 'utf8'),
        file,
        declaredHashes,
        sourcePath: join(inventory.repositoryRoot, file),
      }),
    ),
  );
  assertSyntheticFixtureText({
    text: sharedText,
    file: 'case-manifest.json',
    declaredHashes,
    checkKeyRuns: false,
  });
  assert.match(
    helperText,
    /import \{ TYPESAFE_SYSTEM_ONE_ENDPOINT \} from '\.\.\/\.\.\/src\/domain\/judges\.ts';/u,
    'the DNS-rebinding case references the typed production endpoint instead of hiding a fixture host literal',
  );
  assert.match(
    helperText,
    /row\.scenario === 'dns-rebinding'[\s\S]{0,180}return \['203\.0\.113\.17'\];/u,
    'the TypeSafe DNS-rebinding resolution is injected to one documentation address',
  );
  assert.match(
    helperText,
    /row\.scenario === 'hold-expiry'[\s\S]{0,160}sqliteTransactionNow\(eventStore\.database\)/u,
    'the hold-expiry case stages from the SQLite transaction clock instead of a calendar-dependent fixture clock',
  );
  assert.equal(
    /https?:\/\/[^\s"'<>`)]+/iu.test(helperText),
    true,
    'the helper contains only its explicit sealed synthetic URL template',
  );
  assert.equal(Array.isArray(manifest.cases), true, 'manifest case inventory');

  const rows = corpus
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => ({ line, value: JSON.parse(line) as Record<string, unknown> }));
  const ids = new Set<string>();
  for (const { value } of rows) {
    exactKeys(value, rowKeys, 'corpus row schema');
    assert.equal(value.schema, 'agentcomms.events.judge-adversarial-v1', 'corpus row schema version');
    assert.equal(typeof value.id, 'string', 'corpus row id');
    assert.equal(ids.has(value.id as string), false, `corpus row id ${String(value.id)} is unique`);
    ids.add(value.id as string);
    assert.equal(categories.has(value.category as string), true, `${String(value.id)} category is closed`);
    assert.equal(responseKinds.has(value.response as string), true, `${String(value.id)} response is closed`);
    if (value.scenario !== undefined)
      assert.equal(scenarios.has(value.scenario as string), true, `${String(value.id)} scenario is closed`);
    if (value.subject !== undefined)
      assert.equal(typeof value.subject, 'string', `${String(value.id)} subject is a string`);
    exactKeys(
      value.expected,
      new Set([
        'outcome',
        'reservation',
        'projection',
        'taint',
        'requests',
        'transportCalls',
        'connectionAttempts',
        'responseAccepted',
        'decisionCount',
        'deliveryCount',
        'metadataState',
        'refusal',
      ]),
      `${String(value.id)} expected`,
    );
    const expected = value.expected as Record<string, unknown>;
    assert.equal(outcomes.has(expected.outcome as string), true, `${String(value.id)} outcome is closed`);
    assert.equal(reservations.has(expected.reservation as string), true, `${String(value.id)} reservation is closed`);
    assert.equal(projections.has(expected.projection as string), true, `${String(value.id)} projection is closed`);
    assert.equal(typeof expected.taint, 'boolean', `${String(value.id)} taint is boolean`);
    assert.equal(
      Number.isSafeInteger(expected.requests) && (expected.requests as number) >= 0,
      true,
      `${String(value.id)} request count is a non-negative integer`,
    );
    assert.equal(
      Number.isSafeInteger(expected.transportCalls) && (expected.transportCalls as number) >= 0,
      true,
      `${String(value.id)} transport call count is exact`,
    );
    assert.equal(
      Number.isSafeInteger(expected.connectionAttempts) && (expected.connectionAttempts as number) >= 0,
      true,
      `${String(value.id)} connection attempt count is exact`,
    );
    assert.equal(typeof expected.responseAccepted, 'boolean', `${String(value.id)} response acceptance is explicit`);
    assert.equal(expected.decisionCount, 1, `${String(value.id)} expects exactly one durable decision`);
    assert.equal(
      Number.isSafeInteger(expected.deliveryCount) && (expected.deliveryCount as number) >= 0,
      true,
      `${String(value.id)} delivery count is exact`,
    );
    assert.equal(typeof expected.metadataState, 'string', `${String(value.id)} metadata state is exact`);
    if (expected.refusal !== undefined)
      assert.equal(typeof expected.refusal, 'string', `${String(value.id)} refusal code is exact when refused`);
    if (expected.responseAccepted === false)
      assert.equal(typeof expected.refusal, 'string', `${String(value.id)} rejected work names its exact refusal`);
  }
  assert.deepEqual(
    [...new Set(rows.map(({ value }) => value.category as string))].sort(),
    [...categories].sort(),
    'the corpus carries every E-6 adversarial category and no unrecognised category',
  );
  const manifestCases = new Map(
    (manifest.cases as unknown[]).map((entry) => {
      exactKeys(entry, new Set(['id', 'sha256']), 'manifest case schema');
      assert.equal(typeof entry.id, 'string', 'manifest case id');
      assert.equal(typeof entry.sha256, 'string', 'manifest case digest');
      return [entry.id as string, entry.sha256 as string] as const;
    }),
  );
  assert.equal((manifest.cases as unknown[]).length, rows.length, 'the manifest has no duplicate or unpaired case');
  assert.equal(manifestCases.size, rows.length, 'every corpus row has exactly one manifest digest');
  for (const { line, value } of rows)
    assert.equal(manifestCases.get(value.id as string), sha256(`${line}\n`), `${String(value.id)} manifest row hash`);

  const journal = JSON.parse(journalText) as Record<string, unknown>;
  exactKeys(
    journal,
    new Set(['schema', 'destination', 'method', 'path', 'unsealedAttempts', 'goldens', 'responses', 'requests']),
    'journal schema',
  );
  assert.equal(journal.schema, 'agentcomms.events.judge-adversarial-journal-v1', 'journal schema');
  assert.equal(journal.destination, '127.0.0.1:49152', 'journal destination is sealed loopback');
  assert.equal(journal.method, 'POST', 'journal request method');
  assert.equal(journal.path, '/v1/systemone', 'journal request path');
  assert.equal(journal.unsealedAttempts, 0, 'journal records no unsealed attempt');
  assert.equal(typeof journal.goldens, 'object', 'journal has named golden request bytes');
  assert.notEqual(journal.goldens, null, 'journal golden request map is non-null');
  assert.equal(Array.isArray(journal.goldens), false, 'journal golden request map is not an array');
  const goldens = journal.goldens as Record<string, unknown>;
  for (const [id, bytes] of Object.entries(goldens))
    assert.equal(typeof bytes, 'string', `${id}: golden request bytes are stored as exact UTF-8`);
  assert.equal(typeof journal.responses, 'object', 'journal has named scripted response bytes');
  assert.notEqual(journal.responses, null, 'journal scripted response map is non-null');
  assert.equal(Array.isArray(journal.responses), false, 'journal scripted response map is not an array');
  const responses = journal.responses as Record<string, unknown>;
  assertScriptedResponseInventory({
    responses,
    expectedKinds: responseKinds,
    file: 'adversarial-v1.journal.json',
  });
  assert.deepEqual(
    Object.keys(responses).sort(),
    [...responseKinds].sort(),
    'journal pins every response kind exactly',
  );
  for (const [id, value] of Object.entries(responses)) {
    assert.equal(Array.isArray(value), true, `${id}: scripted response is an ordered byte-chunk array`);
    assert.equal((value as unknown[]).length > 0, true, `${id}: scripted response has at least one byte chunk`);
    for (const [index, chunk] of (value as unknown[]).entries()) {
      assert.equal(typeof chunk, 'object', `${id}[${index}]: scripted response chunk is an object`);
      assert.notEqual(chunk, null, `${id}[${index}]: scripted response chunk is non-null`);
      assert.equal(Array.isArray(chunk), false, `${id}[${index}]: scripted response chunk is not an array`);
      const record = chunk as Record<string, unknown>;
      if ('utf8' in record) {
        exactKeys(record, new Set(['utf8']), `${id}[${index}]: scripted UTF-8 response chunk`);
        assert.equal(typeof record.utf8, 'string', `${id}[${index}]: scripted response UTF-8 is exact`);
      } else {
        exactKeys(record, new Set(['fillByte', 'count']), `${id}[${index}]: scripted fill response chunk`);
        assert.equal(
          Number.isSafeInteger(record.fillByte) &&
            (record.fillByte as number) >= 0 &&
            (record.fillByte as number) <= 255,
          true,
          `${id}[${index}]: scripted response fill byte is bounded`,
        );
        assert.equal(
          Number.isSafeInteger(record.count) && (record.count as number) >= 0,
          true,
          `${id}[${index}]: scripted response fill count is exact`,
        );
      }
    }
  }
  assert.equal(typeof journal.requests, 'object', 'journal maps every row to exact golden requests');
  assert.notEqual(journal.requests, null, 'journal request map is non-null');
  assert.equal(Array.isArray(journal.requests), false, 'journal request map is not an array');
  const requests = journal.requests as Record<string, unknown>;
  assert.deepEqual(Object.keys(requests).sort(), [...ids].sort(), 'journal has one request inventory for every row');
  const referencedGoldens = new Set<string>();
  for (const { value } of rows) {
    const id = value.id as string;
    const requestKeys = requests[id];
    assert.equal(Array.isArray(requestKeys), true, `${id}: journal request inventory is an array`);
    assert.equal(
      (requestKeys as unknown[]).length,
      (value.expected as Record<string, unknown>).requests,
      `${id}: journal stores the exact expected request count`,
    );
    for (const key of requestKeys as unknown[]) {
      assert.equal(typeof key, 'string', `${id}: journal golden reference is a string`);
      assert.equal(typeof goldens[key as string], 'string', `${id}: journal golden reference resolves`);
      referencedGoldens.add(key as string);
    }
  }
  assert.deepEqual([...referencedGoldens].sort(), Object.keys(goldens).sort(), 'journal has no unused request golden');

  const shared = JSON.parse(sharedText) as { cases?: unknown[] };
  const sharedE11 = (shared.cases ?? []).filter((entry) => (entry as { task?: unknown }).task === 'E11') as Array<{
    id?: unknown;
  }>;
  assert.equal(sharedE11.length, 11, 'all eleven Task 11 destructive mutations have shared-manifest owners');
  assert.deepEqual(
    sharedE11.map((entry) => entry.id).sort(),
    [
      'e11-corpus-integrity-allowlist',
      'e11-corpus-manifest-pairing',
      'e11-envelope-provenance',
      'e11-host-drift-before-byte',
      'e11-journal-exactness',
      'e11-late-hold-response',
      'e11-provider-match-authority',
      'e11-range-token-cap',
      'e11-refusal-content-free',
      'e11-response-fixture-pinning',
      'e11-wrong-type-score',
    ],
    'each Task 11 mutation has one exact shared-manifest pairing',
  );
  assert.equal(
    typeof verifyPhaseETestManifest,
    'function',
    'the shared-manifest verifier is the imported production gate',
  );
});

test('E11 adversarial corpus integrity: TypeScript structural aliases cannot bypass the closed scanner', () => {
  const hashes = new Set<string>();
  const rejected = [
    {
      text: "const endpoint = '/v1/systemone'",
      message: /complete string literal/u,
      reason: 'a relative endpoint literal is refused',
    },
    {
      text: "const config = { endpoint: 'not-a-url' }",
      message: /complete string literal/u,
      reason: 'a non-URL endpoint literal is refused',
    },
    {
      text: "const host = globalThis['process']['env'].PROVIDER_HOST",
      message: /process\.env/u,
      reason: 'a bracketed global process.env read is refused',
    },
    {
      text: 'const host = globalThis[`process`][`env`].PROVIDER_HOST',
      message: /process\.env/u,
      reason: 'a template-keyed global process.env read is refused',
    },
    {
      text: "const host = globalThis[('process' as string)][('env' as string)].PROVIDER_HOST",
      message: /process\.env/u,
      reason: 'a wrapped-key global process.env read is refused',
    },
    {
      text: "import { env } from 'node:process'; const host = env.PROVIDER_HOST",
      message: /process\.env/u,
      reason: 'an imported process.env binding is refused',
    },
    {
      text: "async function f() { const { env } = await import('node:process'); return env.PROVIDER_HOST; }",
      message: /process\.env/u,
      reason: 'a dynamically imported process.env binding is refused',
    },
    {
      text: "const { 'process': proc } = globalThis; const { 'env': environment } = proc; const host = environment.PROVIDER_HOST;",
      message: /process\.env/u,
      reason: 'a destructured process.env alias is refused',
    },
    {
      text: "import(('node:process' as string)).then(({ env }) => env.PROVIDER_HOST);",
      message: /process\.env/u,
      reason: 'a wrapped dynamic process import is refused',
    },
    {
      text: "const moduleName = 'node:process'; import(moduleName).then((proc) => proc.env.PROVIDER_HOST);",
      message: /process\.env/u,
      reason: 'a variable dynamic process import is refused',
    },
    {
      text: 'declare const source: { value: string }; class Config { endpoint = source.value; }',
      message: /complete string literal/u,
      reason: 'a class endpoint field cannot hide a computed URL',
    },
    {
      text: 'declare const source: { value: string }; function connect(endpoint = source.value) { return endpoint; }',
      message: /complete string literal/u,
      reason: 'a default endpoint parameter cannot hide a computed URL',
    },
    {
      text: 'declare const source: { endpoint: string }; const { endpoint } = source;',
      message: /complete string literal/u,
      reason: 'an endpoint destructuring binding cannot hide a computed URL',
    },
    {
      text: 'declare const config: { endpoint?: string }; declare const source: { value: string }; config.endpoint ??= source.value;',
      message: /complete string literal/u,
      reason: 'a compound endpoint assignment cannot hide a computed URL',
    },
    {
      text: "declare const config: { endpoint: string }; config[('endpoint' as string)] = 'https://customer.example.org';",
      message: /complete string literal|host .* must end/u,
      reason: 'a wrapped endpoint key cannot hide a URL assignment',
    },
    {
      text: "declare const config: { endpoint: string }; config.endpoint += 'https://local.example';",
      message: /complete string literal/u,
      reason: 'a compound URL write is refused even when its right side is a literal URL',
    },
    {
      text: "declare const config: object; declare const source: { value: string }; Reflect.set(config, 'endpoint', source.value);",
      message: /complete string literal/u,
      reason: 'a reflective endpoint write cannot hide a computed URL',
    },
    {
      text: "declare const config: object; declare const source: { value: string }; Object.defineProperty(config, 'endpoint', { value: source.value });",
      message: /complete string literal/u,
      reason: 'a defined endpoint property cannot hide a computed URL',
    },
    {
      text: "declare const config: object; declare const source: { value: string }; const write = Reflect.set; write(config, 'endpoint', source.value);",
      message: /complete string literal/u,
      reason: 'an aliased reflective endpoint write cannot hide a computed URL',
    },
    {
      text: "declare const config: { api_key?: string }; config.api_key ??= 'synthetic';",
      message: /credential assignment/u,
      reason: 'a compound credential assignment is refused',
    },
    {
      text: "declare const config: { api_key?: string }; config[('api_key' as string)] = 'synthetic';",
      message: /credential assignment/u,
      reason: 'a wrapped credential key is refused',
    },
    {
      text: 'class Config { constructor(public endpoint: string) {} }',
      message: /complete string literal/u,
      reason: 'a constructor endpoint parameter property is refused',
    },
    {
      text: 'class Capture { constructor(public api_key: string) {} }',
      message: /credential assignment/u,
      reason: 'a constructor credential parameter property is refused',
    },
    {
      text: 'class Capture { constructor(public server: string) {} }',
      message: /captured provider-response shape/u,
      reason: 'a constructor provider parameter property is refused',
    },
    {
      text: "const response = { get ['x-request-id']() { return 'capture'; } };",
      message: /captured provider-response shape/u,
      reason: 'a provider-shaped accessor is refused',
    },
    {
      text: 'const response = { server() { return undefined; } };',
      message: /captured provider-response shape/u,
      reason: 'a provider-shaped method is refused',
    },
    {
      text: `enum Credentials { ${API_KEY} = 'synthetic' }`,
      message: /credential assignment/u,
      reason: 'a credential-shaped enum member is refused',
    },
    {
      text: "enum Capture { server = 'synthetic' }",
      message: /captured provider-response shape/u,
      reason: 'a provider-shaped enum member is refused',
    },
    {
      text: 'declare const source: { promise: Promise<string> }; async function f() { const pending = source.promise; const destination = await pending; }',
      message: /closed computed-string allowlist/u,
      reason: 'a shadowed allowed await identifier is refused',
    },
    {
      text: "const evaluator = { admit: async () => 'synthetic-result' }; declare const admission: unknown; async function f() { const pending = evaluator.admit(admission); const destination = await pending; }",
      message: /closed computed-string allowlist/u,
      reason: 'a local evaluator cannot impersonate the admitted production result',
    },
    {
      text: [
        "import { EventEvaluator } from '../../src/runtime/evaluate.ts';",
        'declare const options: ConstructorParameters<typeof EventEvaluator>[0];',
        "declare const admission: Parameters<EventEvaluator['admit']>[0];",
        'let evaluator = new EventEvaluator(options);',
        'evaluator = new EventEvaluator(options);',
        'const pending = evaluator.admit(admission);',
        'const result = await pending;',
      ].join('\n'),
      message: /immutable production evaluator|closed computed-string allowlist/u,
      reason: 'a reassigned production evaluator cannot authorize an allowed await',
    },
    {
      text: [
        "import { EventEvaluator } from '../../src/runtime/evaluate.ts';",
        'declare const options: ConstructorParameters<typeof EventEvaluator>[0];',
        "declare const admission: Parameters<EventEvaluator['admit']>[0];",
        'const evaluator = new EventEvaluator(options);',
        "evaluator.admit = async () => 'synthetic-result';",
        'const pending = evaluator.admit(admission);',
        'const result = await pending;',
      ].join('\n'),
      message: /immutable production evaluator|closed computed-string allowlist/u,
      reason: 'a monkeypatched production evaluator cannot authorize an allowed await',
    },
    {
      text: [
        "import { EventEvaluator } from '../../src/runtime/evaluate.ts';",
        'declare const options: ConstructorParameters<typeof EventEvaluator>[0];',
        "declare const admission: Parameters<EventEvaluator['admit']>[0];",
        "declare const source: { admit: EventEvaluator['admit'] };",
        'const evaluator = new EventEvaluator(options);',
        'const alias = evaluator;',
        'alias.admit = source.admit;',
        'const pending = evaluator.admit(admission);',
        'const result = await pending;',
      ].join('\n'),
      message: /closed computed-string allowlist/u,
      reason: 'an evaluator alias cannot conceal a monkeypatch before an allowed await',
    },
    {
      text: 'declare function makeConfig(): { endpoint: string }; const TEST_EVENT = makeConfig(); const event = { ...TEST_EVENT }',
      message: /closed computed-string allowlist/u,
      reason: 'a shadowed allowed object spread is refused',
    },
    {
      text: 'declare const source: { endpoint: string }; const TEST_EVENT = Object.freeze({ get endpoint() { return source.endpoint; } }); const event = { ...TEST_EVENT };',
      message: /complete string literal|closed computed-string allowlist/u,
      reason: 'a frozen getter cannot hide a computed endpoint behind the allowed event spread',
    },
    {
      text: "declare const source: { value: string }; let field = 'synthetic'; field = source.value; const TEST_EVENT = Object.freeze({ body: field }); const event = { ...TEST_EVENT };",
      message: /immutable frozen fixture leaf|closed computed-string allowlist/u,
      reason: 'a mutable leaf cannot hide a computed value in the allowed event spread',
    },
    {
      text: "declare const source: { value: string }; const leaf = { value: 'synthetic' }; leaf.value = source.value; const TEST_EVENT = Object.freeze({ body: leaf }); const event = { ...TEST_EVENT };",
      message: /closed computed-string allowlist/u,
      reason: 'a nested mutable leaf cannot hide a computed value in the allowed event spread',
    },
    {
      text: "declare const source: { value: string }; const root = '/'; function join() { return source.value; } const value = join(root, 'packages', 'events-daemon');",
      message: /imported node:path join/u,
      reason: 'a local join cannot impersonate the allowlisted path operation',
    },
    {
      text: 'declare const source: { value: string }; declare const mutation: { testName: string }; function exactTestName() { return source.value; } const value = exactTestName(mutation.testName);',
      message: /declared exactTestName helper/u,
      reason: 'a shadowed exactTestName cannot impersonate the allowlisted helper',
    },
    {
      text: `const pattern = /${SK_FAKE}/u`,
      message: /recognised secret-looking material/u,
      reason: 'secret material in a TypeScript regex literal is refused',
    },
    {
      text: 'const pattern = /aaaaaaaaaaaaaaaaaaaaaaaa/u',
      message: /undeclared token or key-shaped string/u,
      reason: 'a key-like run in a TypeScript regex literal is refused',
    },
    {
      text: `class Capture { ${API_KEY} = 'synthetic' }`,
      message: /credential assignment/u,
      reason: 'a credential-shaped class field is refused',
    },
    {
      text: `function capture(${API_KEY} = 'synthetic') { return ${API_KEY}; }`,
      message: /credential assignment/u,
      reason: 'a credential-shaped default parameter is refused',
    },
    {
      text: 'declare const source: object; const { api_key } = source',
      message: /credential assignment/u,
      reason: 'a credential-shaped destructuring binding is refused',
    },
    {
      text: "class Capture { ['x-request-id'] = 'capture' }",
      message: /captured provider-response shape/u,
      reason: 'a provider-shaped class field is refused',
    },
    {
      text: [
        "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
        'const unrelated = { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT };',
      ].join('\n'),
      message: /production TypeSafe endpoint/u,
      reason: 'the production endpoint constant is refused outside the DNS-rebinding fixture shape',
    },
    {
      text: [
        "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
        'function unrelated() {',
        '  const hostedJudge = { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT };',
        '  return hostedJudge;',
        '}',
      ].join('\n'),
      message: /production TypeSafe endpoint/u,
      reason: 'a hostedJudge name alone cannot authorize the production endpoint constant',
    },
    {
      text: [
        "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
        "const judge = { kind: 'typesafe' };",
        "const unrelated = { ...(judge.kind === 'typesafe' ? { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT } : {}) };",
      ].join('\n'),
      message: /production TypeSafe endpoint/u,
      reason: 'a TypeSafe-shaped spread outside the DNS-selected judge flow is refused',
    },
    {
      text: [
        "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
        'declare function consume(value: unknown): void;',
        'export async function runAdversarialCase(row: { scenario: string }) {',
        '  const localJudge = {};',
        '  const hostedJudge = { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT };',
        "  const judge = row.scenario === 'dns-rebinding' ? hostedJudge : localJudge;",
        '  consume(hostedJudge);',
        '  return judge;',
        '}',
      ].join('\n'),
      message: /production TypeSafe endpoint/u,
      reason: 'the hosted TypeSafe object may flow only through the DNS-rebinding selector',
    },
    {
      text: [
        "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
        'export function runAdversarialCase() {',
        "  const row = { scenario: 'dns-rebinding' };",
        '  const localJudge = {};',
        '  const hostedJudge = { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT };',
        "  const judge = row.scenario === 'dns-rebinding' ? hostedJudge : localJudge;",
        '  return judge;',
        '}',
      ].join('\n'),
      message: /production TypeSafe endpoint/u,
      reason: 'a locally constructed row cannot authorize the production TypeSafe endpoint',
    },
    {
      text: [
        "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
        'interface AdversarialCorpusCase { scenario: string }',
        'export function runAdversarialCase(row: AdversarialCorpusCase) {',
        "  row.scenario = 'dns-rebinding';",
        '  const localJudge = {};',
        '  const hostedJudge = { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT };',
        "  const judge = row.scenario === 'dns-rebinding' ? hostedJudge : localJudge;",
        '  return judge;',
        '}',
      ].join('\n'),
      message: /production TypeSafe endpoint/u,
      reason: 'a mutated corpus row cannot authorize the production TypeSafe endpoint',
    },
    {
      text: [
        "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
        'interface AdversarialCorpusCase { readonly scenario?: string }',
        'export function runAdversarialCase(row: AdversarialCorpusCase) {',
        "  const localJudge = { kind: 'local-endpoint' };",
        "  const hostedJudge = { kind: 'typesafe', endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT };",
        "  const judge = row.scenario === 'dns-rebinding' ? hostedJudge : localJudge;",
        "  judge.kind = 'typesafe';",
        "  return { ...(judge.kind === 'typesafe' ? { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT } : {}) };",
        '}',
      ].join('\n'),
      message: /production TypeSafe endpoint/u,
      reason: 'a mutated selected judge cannot authorize the production TypeSafe endpoint',
    },
    {
      text: "const value = new (URL)('/v1', 'https://local.example')",
      message: /URL must be a complete string literal/u,
      reason: 'a parenthesized URL constructor is refused',
    },
    {
      text: "const value = new globalThis.URL('/v1', 'https://local.example')",
      message: /URL must be a complete string literal/u,
      reason: 'a global URL constructor is refused',
    },
    {
      text: "const Constructor = URL; const value = new Constructor('/v1', 'https://local.example')",
      message: /URL must be a complete string literal/u,
      reason: 'an aliased URL constructor is refused',
    },
    {
      text: 'export async function send(destination: string) { return await fetch(destination); }',
      message: /URL must be a complete string literal/u,
      reason: 'a fetch destination cannot be supplied by a non-literal parameter',
    },
    {
      text: 'declare const destination: string; const request = fetch.bind(globalThis); request(destination);',
      message: /URL must be a complete string literal/u,
      reason: 'a bound fetch alias cannot conceal a dynamic destination',
    },
    {
      text: 'declare const destination: string; const request = fetch; request(destination);',
      message: /URL must be a complete string literal/u,
      reason: 'a fetch alias cannot conceal a dynamic destination',
    },
    {
      text: "import https from 'node:https'; declare const destination: string; https.get(destination);",
      message: /URL must be a complete string literal/u,
      reason: 'an HTTPS helper cannot receive a dynamic destination',
    },
    {
      text: `let marker: number;\nlabel:// ${SK_FAKE}\nmarker = 1;`,
      message: /recognised secret-looking material/u,
      reason: 'a secret after a colon-slash-slash comment marker is refused',
    },
    {
      text: "const npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = 'synthetic'",
      message: /recognised secret-looking material/u,
      reason: 'a secret-shaped identifier is refused',
    },
    {
      text: 'class Capture { #npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = 1; }',
      message: /recognised secret-looking material/u,
      reason: 'a secret-shaped private identifier is refused',
    },
    {
      text: `#!/usr/bin/env ${SK_FAKE}\nconst safe = true;`,
      message: /recognised secret-looking material/u,
      reason: 'secret material in a hashbang is refused',
    },
  ] as const;
  for (const probe of rejected)
    assert.throws(
      () =>
        assertSyntheticFixtureText({
          text: probe.text,
          file: 'typescript-structural-negative.ts',
          declaredHashes: hashes,
        }),
      probe.message,
      probe.reason,
    );
});

test('E11 adversarial corpus integrity: an unrecognised host, key-shaped token, and captured-provider response each fail the allowlist scan', () => {
  const hashes = new Set<string>();
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'https://customer.example.org/path',
        file: 'host-negative',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a non-allowlisted literal URL is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'Customer.Example.ORG',
        file: 'mixed-case-host-negative',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a mixed-case example.org host is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "['customer', 'example', 'org'].join('.')",
        file: 'fragmented-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'a fragmented example.org host is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const dot = '.'; ['customer', 'example', 'org'].join(dot)",
        file: 'variable-join-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host joined through a variable separator is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: [
          'const sep = String.fromCharCode(46);',
          "const prefix = ['h', 't', 't', 'p', 's', ':', '/', '/', 'customer'].join('');",
          "const destination = [prefix, 'example', 'org'].join(sep);",
          "const config = { ['endpoint']: destination };",
        ].join('\n'),
        file: 'computed-endpoint-property-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist|complete string literal/u,
    'a URL assembled through a renamed separator and computed endpoint property is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "['customer', 'example', 'org'].join(String.fromCharCode(46))",
        file: 'character-code-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host joined through a character-code separator is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const dot = '.'; 'customer' + dot + 'example' + dot + 'org'",
        file: 'concatenated-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host assembled by concatenation is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is deliberate source text for the scanner.
        text: "const dot = '.'; `customer${dot}example${dot}org`",
        file: 'interpolated-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host assembled by template interpolation is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is deliberate source text for the scanner.
        text: "const label = 'example'; const suffix = 'org'; const endpoint = `https://${label}.${suffix}/v1`",
        file: 'template-url-negative.ts',
        declaredHashes: hashes,
      }),
    /URL.*complete string literal/u,
    'an example.org URL assembled through a template is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "declare const exampleOrg: string; const endpoint = new URL('/v1', exampleOrg)",
        file: 'variable-url-negative.ts',
        declaredHashes: hashes,
      }),
    /URL.*complete string literal/u,
    'an example.org URL assembled through a variable is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'const host = process.env.PROVIDER_HOST',
        file: 'environment-host-negative.ts',
        declaredHashes: hashes,
      }),
    /process\.env/u,
    'a process.env host is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'const host = process?.env.PROVIDER_HOST',
        file: 'optional-environment-host-negative.ts',
        declaredHashes: hashes,
      }),
    /process\.env/u,
    'an optional process.env host is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'const { env } = process; const host = env.PROVIDER_HOST',
        file: 'destructured-environment-host-negative.ts',
        declaredHashes: hashes,
      }),
    /process\.env/u,
    'a destructured process.env host is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "'customer'.concat('.', 'example', '.', 'org')",
        file: 'concat-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host assembled with concat is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "'customer-DOT-example-DOT-org'.replaceAll('-DOT-', '.')",
        file: 'replacement-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host assembled with replacement is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'String.fromCodePoint(99,117,115,116,111,109,101,114,46,101,120,97,109,112,108,101,46,111,114,103)',
        file: 'code-point-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host assembled from code points is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'Buffer.from([99,117,115,116,111,109,101,114,46,101,120,97,109,112,108,101,46,111,114,103]).toString()',
        file: 'buffer-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an example.org host assembled from bytes is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "atob('Y3VzdG9tZXIuZXhhbXBsZS5vcmc=')",
        file: 'base64-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist|undeclared.*key-shaped/u,
    'an example.org host assembled from Base64 is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const base64 = 'Y3VzdG9tZXIuZXhhbXBsZS5vcmc='; const decode: any = globalThis.atob; decode(base64)",
        file: 'any-alias-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist|undeclared.*key-shaped/u,
    'a host decoded through an any-typed alias is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const base64 = 'Y3VzdG9tZXIuZXhhbXBsZS5vcmc='; (globalThis.atob as any)(base64)",
        file: 'any-cast-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist|undeclared.*key-shaped/u,
    'a host decoded through an any cast is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const base64 = 'Y3VzdG9tZXIuZXhhbXBsZS5vcmc='; eval('atob(base64)')",
        file: 'eval-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist|undeclared.*key-shaped/u,
    'a host decoded through eval is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "declare function decode(value: string): string | undefined; const base64 = 'Y3VzdG9tZXIuZXhhbXBsZS5vcmc='; decode(base64) ?? ''",
        file: 'union-host-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist|undeclared.*key-shaped/u,
    'a host decoded through a string union is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const host = 'customer\\x2eexample\\x2eorg'",
        file: 'hex-escaped-host-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a host hidden in hexadecimal string escapes is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const host = 'customer\\u002eexample\\u002eorg'",
        file: 'unicode-escaped-host-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a host hidden in Unicode string escapes is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"host":"customer\\u002eexample\\u002eorg"}',
        file: 'decoded-json-host-negative.json',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a host hidden in an escaped JSON fixture value is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const host = 'customer.example.biz'",
        file: 'uncommon-tld-host-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a real host with an uncommon TLD in a TypeScript literal is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const host = 'customer.example.org;ignored'",
        file: 'punctuated-host-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a real host followed by punctuation in a TypeScript literal is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const host = 'customer.example.org.'",
        file: 'trailing-dot-host-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a trailing-dot real hostname is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const host = 'customer.example.ts'",
        file: 'source-suffix-host-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a bare real hostname is not mistaken for a source filename',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is deliberate source text for the scanner.
        text: 'declare const row: { id: string }; const host = `${row.id}:customer\\x2eexample\\x2eorg`',
        file: 'hex-escaped-template-tail-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a host hidden in a hexadecimal-escaped computed-template tail is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is deliberate source text for the scanner.
        text: 'declare const row: { id: string }; const host = `${row.id}:customer\\u002eexample\\u002eorg`',
        file: 'unicode-escaped-template-tail-negative.ts',
        declaredHashes: hashes,
      }),
    /host .* must end/u,
    'a host hidden in a Unicode-escaped computed-template tail is refused',
  );
  const secretPrefixes = [
    'npm_',
    'glpat-',
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
    'sk-',
    'sk_live_',
    'sk_test_',
    'rk_',
    're_',
    'SG.',
    'xoxa-',
    'xoxb-',
    'xoxp-',
    'xoxr-',
    'xoxs-',
    'AKIA',
    'ASIA',
    'AIza',
    'ya29.',
  ] as const;
  for (const prefix of secretPrefixes)
    assert.throws(
      () =>
        assertSyntheticFixtureText({
          text: JSON.stringify({ value: `${prefix}${'a'.repeat(32)}` }),
          file: 'token-prefix-negative.json',
          declaredHashes: hashes,
        }),
      /recognised secret-looking material/u,
      `${prefix} with a low-entropy body is refused`,
    );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"value":"eyJaaaaaaaa.aaaaaaaa.aaaaaaaa"}',
        file: 'jwt-negative.json',
        declaredHashes: hashes,
      }),
    /recognised secret-looking material/u,
    'a JWT-shaped string is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: `{"value":"${PRIVATE_KEY_HEADER}"}`,
        file: 'pem-negative.json',
        declaredHashes: hashes,
      }),
    /recognised secret-looking material/u,
    'a PEM begin marker is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"value":"api_key=synthetic"}',
        file: 'credential-assignment-negative.json',
        declaredHashes: hashes,
      }),
    /credential assignment/u,
    'an api_key assignment is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"value":"aaaaaaaaaaaaaaaaaaaaaaaa"}',
        file: 'key-run-negative.json',
        declaredHashes: hashes,
      }),
    /undeclared token or key-shaped string/u,
    'a 24-character low-entropy key-like run is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"value":"aaaaaaaaaaaaaaaaaaaaaaa="}',
        file: 'base64-key-run-negative.json',
        declaredHashes: hashes,
      }),
    /undeclared token or key-shaped string/u,
    'a padded Base64 key-like run is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"value":"alpha-bravo-charlie-delta"}',
        file: 'separated-key-run-negative.json',
        declaredHashes: hashes,
      }),
    /undeclared token or key-shaped string/u,
    'a separator-bearing 24-character key-like run is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const value = 'aaaaaaaaaaaaaaaaaaaaaaaa'",
        file: 'typescript-key-run-negative.ts',
        declaredHashes: hashes,
      }),
    /undeclared token or key-shaped string/u,
    'a 24-character key-like run in a TypeScript literal is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const value = 'prefix aaaaaaaaaaaaaaaaaaaaaaaa suffix'",
        file: 'embedded-typescript-key-run-negative.ts',
        declaredHashes: hashes,
      }),
    /undeclared token or key-shaped string/u,
    'an embedded 24-character key-like run in a TypeScript literal is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate scanner input.
        text: 'declare const row: { id: string }; const value = `${row.id}:aaaaaaaaaaaaaaaaaaaaaaaa`',
        file: 'template-key-run-negative.ts',
        declaredHashes: hashes,
      }),
    /undeclared token or key-shaped string/u,
    'a 24-character key-like run in a template segment is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"id":"aaaaaaaaaaaaaaaaaaaaaaaa"}',
        file: 'structural-field-key-run-negative.json',
        declaredHashes: hashes,
      }),
    /undeclared token or key-shaped string/u,
    'a key-like run cannot hide in a structural JSON field',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: `const config = { ${API_KEY}: 'synthetic' }`,
        file: 'typescript-credential-negative.ts',
        declaredHashes: hashes,
      }),
    /credential assignment/u,
    'a credential-shaped TypeScript property is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: `const ${API_KEY} = 'synthetic'`,
        file: 'typescript-credential-variable-negative.ts',
        declaredHashes: hashes,
      }),
    /credential assignment/u,
    'a credential-shaped TypeScript variable is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const field = 'api_key'; const capture = { [field]: 'synthetic' }",
        file: 'typescript-computed-credential-negative.ts',
        declaredHashes: hashes,
      }),
    /computed property|credential assignment/u,
    'a computed credential-shaped TypeScript property is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const response = { 'x-request-id': 'capture' }",
        file: 'typescript-provider-capture-negative.ts',
        declaredHashes: hashes,
      }),
    /captured provider-response shape/u,
    'a provider-capture TypeScript property is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const field = 'x-request-id'; const capture = { [field]: 'capture' }",
        file: 'typescript-computed-provider-capture-negative.ts',
        declaredHashes: hashes,
      }),
    /computed property|captured provider-response shape/u,
    'a computed provider-capture TypeScript property is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"api\\u005fkey":"synthetic"}',
        file: 'escaped-credential-negative.json',
        declaredHashes: hashes,
      }),
    /credential assignment/u,
    'an escaped credential-shaped JSON property is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"x-request\\u002did":"capture"}',
        file: 'escaped-provider-capture-negative.json',
        declaredHashes: hashes,
      }),
    /captured provider-response shape/u,
    'an escaped provider-capture JSON property is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"host":"127.0.0.1"}',
        file: 'loopback-data-negative.json',
        declaredHashes: hashes,
      }),
    /documentation space|must end in/u,
    'loopback is refused in arbitrary data',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"host":"localhost"}',
        file: 'bare-host-data-negative.json',
        declaredHashes: hashes,
      }),
    /must end in/u,
    'a bare non-allowlisted host is refused in data',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"host":["localhost"]}',
        file: 'nested-bare-host-data-negative.json',
        declaredHashes: hashes,
      }),
    /must end in/u,
    'a bare non-allowlisted host cannot hide in a data array',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"host":{"value":"localhost"}}',
        file: 'nested-object-host-data-negative.json',
        declaredHashes: hashes,
      }),
    /must end in/u,
    'a bare non-allowlisted host cannot hide in a data object',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"address":"localhost"}',
        file: 'address-data-negative.json',
        declaredHashes: hashes,
      }),
    /must end in/u,
    'a bare non-allowlisted address is refused in data',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"destination":"localhost"}',
        file: 'destination-data-negative.json',
        declaredHashes: hashes,
      }),
    /must end in/u,
    'a bare non-allowlisted destination is refused in data',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '{"url":"ftp://localhost/path"}',
        file: 'non-http-url-data-negative.json',
        declaredHashes: hashes,
      }),
    /must end in/u,
    'a non-HTTP URL still has to use an allowlisted host',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: JSON.stringify({
          goldens: {
            default: 'POST /v1/systemone HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n::1',
          },
        }),
        file: 'packages/events-daemon/test/fixtures/judges/adversarial-v1.journal.json',
        declaredHashes: hashes,
      }),
    /RFC 3849 documentation space/u,
    'the pinned journal loopback exception does not admit a second loopback address',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: `// ${SK_FAKE}`,
        file: 'typescript-comment-secret-negative.ts',
        declaredHashes: hashes,
      }),
    /recognised secret-looking material/u,
    'secret material in a TypeScript comment is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'declare function makeUrl(): Promise<string>; async function f() { const value = await makeUrl(); }',
        file: 'awaited-url-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an indirectly awaited string is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'declare function makeConfig(): { endpoint: string }; const config = { ...makeConfig() }',
        file: 'spread-url-negative.ts',
        declaredHashes: hashes,
      }),
    /closed computed-string allowlist/u,
    'an endpoint hidden behind an object spread is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: "const endpoint = new URL('/v1', 'https://local.example')",
        file: 'constructed-url-negative.ts',
        declaredHashes: hashes,
      }),
    /URL must be a complete string literal/u,
    'even all-literal URL construction is refused in favour of one complete literal',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: [
          "import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../../src/domain/judges.ts';",
          'function shadow() {',
          "  const TYPESAFE_SYSTEM_ONE_ENDPOINT = 'https://synthetic.example';",
          '  const endpoint = TYPESAFE_SYSTEM_ONE_ENDPOINT;',
          '  return endpoint;',
          '}',
        ].join('\n'),
        file: 'shadowed-typesafe-endpoint-negative.ts',
        declaredHashes: hashes,
      }),
    /complete string literal|production TypeSafe endpoint/u,
    'a locally shadowed TypeSafe endpoint identifier is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'mF9_kP4zR8vQ2xL7cN5wT1yB6sD3hJ0a',
        file: 'entropy-negative',
        declaredHashes: hashes,
      }),
    /undeclared high-entropy token/u,
    'an unrecognised high-entropy token is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        file: 'hex-token-negative',
        declaredHashes: hashes,
      }),
    /undeclared high-entropy token/u,
    'an undeclared digest-shaped token is refused',
  );
  assert.throws(
    () =>
      assertSyntheticFixtureText({
        text: 'HTTP/1.1 200 OK\r\nx-request-id: capture\r\n',
        file: 'capture-negative',
        declaredHashes: hashes,
      }),
    /captured provider-response shape/u,
    'a captured provider response shape is refused',
  );
});

async function withInventoryFixture(
  files: readonly string[],
  work: (repositoryRoot: string) => Promise<void>,
): Promise<void> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'events-e11-integrity-'));
  try {
    const fixtures = join(repositoryRoot, 'packages/events-daemon/test/fixtures/judges');
    const support = join(repositoryRoot, 'packages/events-daemon/test/support');
    await Promise.all([mkdir(fixtures, { recursive: true }), mkdir(support, { recursive: true })]);
    await writeFile(
      join(fixtures, 'adversarial-v1.manifest.json'),
      `${JSON.stringify({ schema: 'agentcomms.events.judge-adversarial-manifest-v1', files })}\n`,
    );
    await work(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}

test('E11 adversarial corpus integrity: an unregistered adversarial file fails discovery', async () => {
  await withInventoryFixture(
    ['packages/events-daemon/test/fixtures/judges/adversarial-v1.manifest.json'],
    async (repositoryRoot) => {
      await writeFile(
        join(repositoryRoot, 'packages/events-daemon/test/fixtures/judges/adversarial-unregistered.jsonl'),
        '{}\n',
      );
      await assert.rejects(
        () => assertAdversarialCorpusFileInventory({ repositoryRoot }),
        /adversarial-unregistered\.jsonl.*missing from the corpus manifest/u,
      );
    },
  );
});

test('E11 adversarial corpus integrity: a matching symlink fails closed during discovery', async () => {
  await withInventoryFixture(
    ['packages/events-daemon/test/fixtures/judges/adversarial-v1.manifest.json'],
    async (repositoryRoot) => {
      const fixtures = join(repositoryRoot, 'packages/events-daemon/test/fixtures/judges');
      await writeFile(join(fixtures, 'neutral.json'), '{}\n');
      await symlink('neutral.json', join(fixtures, 'adversarial-linked.json'));
      await assert.rejects(
        () => assertAdversarialCorpusFileInventory({ repositoryRoot }),
        /adversarial-linked\.json.*symlink/u,
      );
    },
  );
});

test('E11 adversarial corpus integrity: a manifest entry without a file fails discovery', async () => {
  await withInventoryFixture(
    [
      'packages/events-daemon/test/fixtures/judges/adversarial-v1.manifest.json',
      'packages/events-daemon/test/support/judge-adversarial-missing.ts',
    ],
    async (repositoryRoot) => {
      await assert.rejects(
        () => assertAdversarialCorpusFileInventory({ repositoryRoot }),
        /judge-adversarial-missing\.ts.*does not exist/u,
      );
    },
  );
});

test('E11 adversarial corpus integrity: a missing scripted response fails the exact response inventory', () => {
  assert.throws(
    () =>
      assertScriptedResponseInventory({
        responses: {},
        expectedKinds: new Set(['noul-low']),
        file: 'response-inventory-negative',
      }),
    /scripted response inventory is exact/u,
    'a missing scripted response is refused',
  );
});
