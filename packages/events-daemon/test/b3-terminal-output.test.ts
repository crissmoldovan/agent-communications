import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { isDangerous } from '@agentcomms/core';
import {
  renderApprovalViewForTerminal,
  renderDryRunListForTerminal,
  renderDryRunRecordForTerminal,
  run,
  terminalSafeJson,
} from '../src/cli/program.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/b3-control-contract-v1');
// A right-to-left override, a zero-width space, a C1 control, DEL and a Unicode tag character: each one changes what a
// terminal shows without being visible itself.
const HOSTILE = 'safe‮evil​\u0085\u007F\u{E0041}';

function dangerousCharacters(text: string): readonly string[] {
  return [...text].filter((char) => isDangerous(char.codePointAt(0) ?? 0));
}

function capturedStream(): { readonly stream: Writable; readonly text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}

async function cli(stateDir: string, args: readonly string[]) {
  const stdout = capturedStream();
  const stderr = capturedStream();
  const code = await run(['--state-dir', stateDir, ...args], {
    streams: { stdin: new PassThrough(), stdout: stdout.stream, stderr: stderr.stream },
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function requestDocument(name: string): Promise<Record<string, unknown>> {
  const vectors = JSON.parse(await readFile(join(FIXTURES, 'ordinary-results.json'), 'utf8')) as readonly {
    readonly name: string;
    readonly request: { readonly args: { readonly document: Record<string, unknown> } };
  }[];
  const vector = vectors.find((entry) => entry.name === name);
  assert.ok(vector, `${name} is a checked-in ordinary request`);
  return structuredClone(vector.request.args.document);
}

test('D13: terminal-safe JSON escapes every control, bidi and invisible character and keeps the exact data', () => {
  const value = { constant: HOSTILE, nested: [HOSTILE], plain: 'line\nbreak' };
  const json = terminalSafeJson(value);
  assert.deepEqual(dangerousCharacters(json), [], 'no dangerous character reaches the terminal');
  assert.match(json, /\\u202e/u);
  assert.match(json, /\\udb40\\udc41/u, 'an astral tag character is written as its surrogate pair');
  assert.deepEqual(JSON.parse(json), value, 'a JSON reader decodes the same value');
});

test('D13: the CLI writes a stored rule document to the terminal without its bidi and invisible characters', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-terminal-output-');
  const owner = await startEventOwner({ stateDir, now: () => 1_000, tickMs: 60_000 });
  try {
    const target = await requestDocument('target-add-result');
    assert.equal((await cli(stateDir, ['target', 'add', JSON.stringify(target)])).code, 0);
    const rule = await requestDocument('rule-create-result');
    rule.mapping = { constant: HOSTILE };
    const created = await cli(stateDir, ['rule', 'create', JSON.stringify(rule)]);
    assert.equal(created.code, 0, created.stderr);
    for (const args of [
      ['rule', 'show', 'rule-1'],
      ['--json', 'rule', 'show', 'rule-1'],
    ]) {
      const shown = await cli(stateDir, args);
      assert.equal(shown.code, 0, shown.stderr);
      assert.deepEqual(dangerousCharacters(shown.stdout), [], `${args.join(' ')} prints no dangerous character`);
      assert.match(shown.stdout, /\\u202e/u, 'the override is written as its escape');
      const [row] = JSON.parse(shown.stdout) as readonly { readonly document: { readonly mapping: unknown } }[];
      assert.deepEqual(row?.document.mapping, { constant: HOSTILE }, 'the stored constant is unchanged');
    }
  } finally {
    await owner.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D13: the approval preview a person reads at the terminal neutralises a bidi override instead of obeying it', async () => {
  const rule = await requestDocument('rule-create-result');
  rule.mapping = { constant: HOSTILE };
  const rendered = renderApprovalViewForTerminal({
    kind: 'READY',
    approvalId: 'ap_00000000000000000000000001',
    digest: 'digest-1',
    preview: { documentVersion: 1, kind: 'rule', rule },
    challenge: {
      approvalId: 'ap_00000000000000000000000001',
      digest: 'digest-1',
      challenge: 'challenge-1',
      expiresAt: 301_000,
    },
  });
  assert.deepEqual(dangerousCharacters(rendered), [], 'no dangerous character reaches the terminal');
  // D13's text-only contract neutralises these characters; the shared fixtures fix the exact bytes both renderers
  // produce, so the letters around the override stay and the override itself does not reach the terminal.
  assert.match(rendered, /safeevil/u, 'the preview still shows the mapping text');
});

test('D13: a daemon error that quotes a document reaches the terminal with its bidi character shown, not obeyed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-terminal-error-');
  const owner = await startEventOwner({ stateDir, now: () => 1_000, tickMs: 60_000 });
  try {
    assert.equal(
      (await cli(stateDir, ['target', 'add', JSON.stringify(await requestDocument('target-add-result'))])).code,
      0,
    );
    const rule = await requestDocument('rule-create-result');
    // The owner's pointer diagnostic quotes the mapping path it refuses.
    rule.mapping = { $path: '\u202E' };
    const refused = await cli(stateDir, ['rule', 'create', JSON.stringify(rule)]);
    assert.notEqual(refused.code, 0, 'the invalid mapping is refused');
    assert.deepEqual(dangerousCharacters(refused.stderr), [], 'no dangerous character reaches the terminal');
    assert.match(refused.stderr, /<U\+202E>/u, 'the quoted override is shown as text');
  } finally {
    await owner.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

const DRY_RUN_ENTRY = {
  deliveryId: 'delivery-1',
  ruleId: `rule-${HOSTILE}`,
  ruleVersion: 1,
  targetId: `target-${HOSTILE}`,
  targetVersion: 1,
  eventId: 'event-1',
  accountId: 'account-1',
  deliveredAt: 1_000,
  expiresAt: 61_000,
};

test('D13: a retained dry-run listing shows stored rule ids with their bidi and invisible characters made visible', () => {
  const listed = renderDryRunListForTerminal([DRY_RUN_ENTRY]);
  assert.deepEqual(dangerousCharacters(listed), [], 'the listing prints no dangerous character');
  assert.match(listed, /rule-safe<U\+202E>evil/u, 'the stored rule id is shown as text');
});

test('D13: a retained dry-run record shows stored target ids with their bidi and invisible characters made visible', () => {
  const shown = renderDryRunRecordForTerminal({
    ...DRY_RUN_ENTRY,
    record: { cloudEventBytes: JSON.stringify({ data: { text: HOSTILE } }) } as never,
  });
  assert.deepEqual(dangerousCharacters(shown), [], 'the record prints no dangerous character');
  assert.match(shown, /target-safe<U\+202E>evil/u, 'the stored target id is shown as text');
});
