import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

interface B3StructuralScripts {
  verifyB3GuardCoverage(input: {
    readonly root: string;
    readonly manifests: readonly unknown[];
  }): Promise<readonly string[]>;
  verifyB3SqlScope(input: { readonly root: string; readonly files: readonly string[] }): Promise<readonly string[]>;
  verifyB3WriterInventory(input: {
    readonly root: string;
    readonly inventory: readonly unknown[];
    readonly files: readonly string[];
  }): Promise<readonly string[]>;
}

async function scripts(): Promise<B3StructuralScripts> {
  const load = (path: string): Promise<unknown> => import(path);
  const [coverage, scope, inventory] = await Promise.all([
    load('../../../scripts/verify-b3-guard-coverage.mjs'),
    load('../../../scripts/verify-b3-sql-scope.mjs'),
    load('../../../scripts/verify-b3-writer-inventory.mjs'),
  ]);
  return {
    ...(coverage as Record<string, unknown>),
    ...(scope as Record<string, unknown>),
    ...(inventory as Record<string, unknown>),
  } as unknown as B3StructuralScripts;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-b3-guard-'));
  await mkdir(join(root, 'test'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'real-operation.ts'), 'export const realOperation = () => true;\n');
  await writeFile(
    join(root, 'test', 'real-operation.test.ts'),
    "import { test } from 'node:test';\ntest('real operation', () => {});\n",
  );
  return root;
}

test('B3 guard coverage refuses a case without its required mutation evidence', async () => {
  const root = await fixtureRoot();
  const problems = await (await scripts()).verifyB3GuardCoverage({
    root,
    manifests: [
      {
        area: 'fixture',
        cases: [
          {
            case: 'missing-mutation',
            operation: 'realOperation',
            productionEntry: 'src/real-operation.ts',
            test: 'test/real-operation.test.ts',
            mutationTest: 'real operation',
            loadedMarker: 'fixture-loaded',
          },
        ],
      },
    ],
  });
  assert.deepEqual(problems, ['fixture/missing-mutation: missing non-empty "mutation"']);
});

test('B3 guard coverage refuses a case without its production entry', async () => {
  const root = await fixtureRoot();
  const problems = await (await scripts()).verifyB3GuardCoverage({
    root,
    manifests: [
      {
        area: 'fixture',
        cases: [
          {
            case: 'missing-production-entry',
            operation: 'realOperation',
            productionEntry: 'src/missing-operation.ts',
            test: 'test/real-operation.test.ts',
            mutation: { from: 'return true;', to: 'return false;' },
            mutationTest: 'real operation',
            loadedMarker: 'fixture-loaded',
          },
        ],
      },
    ],
  });
  assert.deepEqual(problems, [
    'fixture/missing-production-entry: production entry does not exist: src/missing-operation.ts',
  ]);
});

test('B3 guard coverage refuses a test-support model as a production entry', async () => {
  const root = await fixtureRoot();
  const problems = await (await scripts()).verifyB3GuardCoverage({
    root,
    manifests: [
      {
        area: 'fixture',
        cases: [
          {
            case: 'test-model',
            operation: 'realOperation',
            productionEntry: 'test/support/model.ts',
            test: 'test/real-operation.test.ts',
            mutation: { from: 'return true;', to: 'return false;' },
            mutationTest: 'real operation',
            loadedMarker: 'fixture-loaded',
          },
        ],
      },
    ],
  });
  assert.deepEqual(problems, [
    'fixture/test-model: production entry must be runtime source, not test support: test/support/model.ts',
  ]);
});

test('B3 SQL scope verifier refuses an unannotated raw identity write and copied channel vocabulary', async () => {
  const root = await fixtureRoot();
  const source = join(root, 'src', 'operator.ts');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    source,
    "const WHATSAPP_MESSAGE_TYPES = ['message'];\ndb.prepare('DELETE FROM deliveries WHERE raw_message_id = ?');\n",
  );
  const problems = await (await scripts()).verifyB3SqlScope({ root, files: ['src/operator.ts'] });
  assert.deepEqual(problems, [
    'src/operator.ts: raw/external identity SQL needs a B3_SQL_SCOPE annotation naming account and source',
    'src/operator.ts: B3 code must import channel vocabulary instead of copying it',
  ]);
});

test('B3 writer inventory verifier refuses an unlisted cipher writer', async () => {
  const root = await fixtureRoot();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'writer.ts'), 'await cipher.encrypt(location, bytes);\n');
  const problems = await (await scripts()).verifyB3WriterInventory({ root, inventory: [], files: ['src/writer.ts'] });
  assert.deepEqual(problems, ['src/writer.ts: cipher/secret writer is absent from the explicit B3 lease inventory']);
});
