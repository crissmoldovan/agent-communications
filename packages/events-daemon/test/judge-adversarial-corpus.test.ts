import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type AdversarialCorpusCase,
  assertAdversarialRun,
  runAdversarialCase,
} from './support/judge-adversarial-fixture.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const corpusUrl = new URL('./fixtures/judges/adversarial-v1.jsonl', import.meta.url);
const journalUrl = new URL('./fixtures/judges/adversarial-v1.journal.json', import.meta.url);

type ResponseChunk = Readonly<{ utf8: string }> | Readonly<{ fillByte: number; count: number }>;

function scriptedResponse(chunks: readonly ResponseChunk[], rowId: string): Buffer {
  return Buffer.concat(
    chunks.map((chunk) => {
      if ('utf8' in chunk) return Buffer.from(chunk.utf8, 'utf8');
      assert.equal(Number.isSafeInteger(chunk.fillByte), true, `${rowId}: response fill byte is an integer`);
      assert.equal(chunk.fillByte >= 0 && chunk.fillByte <= 255, true, `${rowId}: response fill byte is bounded`);
      assert.equal(Number.isSafeInteger(chunk.count), true, `${rowId}: response fill count is an integer`);
      assert.equal(chunk.count >= 0, true, `${rowId}: response fill count is non-negative`);
      return Buffer.alloc(chunk.count, chunk.fillByte);
    }),
  );
}

test('E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const [corpus, journalText] = await Promise.all([
    readFile(fileURLToPath(corpusUrl), 'utf8'),
    readFile(fileURLToPath(journalUrl), 'utf8'),
  ]);
  const rows = corpus
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as AdversarialCorpusCase);
  const journal = JSON.parse(journalText) as {
    goldens?: Record<string, string>;
    responses?: Record<string, ResponseChunk[]>;
    requests?: Record<string, string[]>;
  };
  assert.ok(rows.length >= 20, 'the corpus contains the complete E-6 adversarial category set');
  const before = process.getActiveResourcesInfo();
  for (const row of rows) {
    const requestKeys = journal.requests?.[row.id];
    assert.equal(Array.isArray(requestKeys), true, `${row.id}: journal fixture supplies its pinned request inventory`);
    const goldenRequests = (requestKeys ?? []).map((key) => {
      const golden = journal.goldens?.[key];
      assert.equal(typeof golden, 'string', `${row.id}: journal fixture resolves golden request ${key}`);
      return Buffer.from(golden ?? '', 'utf8');
    });
    const responseChunks = journal.responses?.[row.response];
    assert.equal(
      Array.isArray(responseChunks),
      true,
      `${row.id}: journal fixture resolves its scripted response bytes`,
    );
    assertAdversarialRun(
      row,
      await runAdversarialCase(row, scriptedResponse(responseChunks ?? [], row.id)),
      goldenRequests,
    );
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const after = process.getActiveResourcesInfo();
  for (const resource of ['TCPSERVERWRAP', 'TCPWRAP', 'TCPCONNECTWRAP'])
    assert.equal(
      after.filter((value) => value === resource).length,
      before.filter((value) => value === resource).length,
      `the corpus closes every ${resource} on success and refusal`,
    );
});
