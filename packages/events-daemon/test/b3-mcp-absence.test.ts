import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
// @ts-expect-error Repository registry tooling is executable ESM without declaration files.
import { deriveRegistries, scratchEnv } from '../../../scripts/registries.mjs';
import { run } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { B3_CAPABILITIES, B3_EXCEPTION_REASON_SECRET } from '../src/operations/b3-contract.ts';
import { decideHeld } from '../src/operations/deliveries.ts';
import { ruleTestRetained } from '../src/operations/rule-test.ts';
import * as secretOperations from '../src/operations/secrets.ts';
import { targetResume } from '../src/operations/target-resume.ts';

test('B3 provided CLI/MCP surfaces keep secrets, retained reads, resume, held-decide, and pending selectors out of MCP', async () => {
  assert.equal(
    B3_EXCEPTION_REASON_SECRET,
    'secret material must never enter model input or output; the person completes this operation at the terminal or app.',
    'the secret exception reason is a stable reviewed sentence, not a mutable shared test value',
  );
  const stdout = new PassThrough();
  stdout.setEncoding('utf8');
  let help = '';
  stdout.on('data', (chunk) => {
    help += String(chunk);
  });
  assert.equal(await run(['--help'], { streams: { stdin: new PassThrough(), stdout, stderr: new PassThrough() } }), 0);

  const exceptions = B3_CAPABILITIES.filter((capability) => capability.mcp === null);
  assert.ok(exceptions.length > 0, 'the closed B3 contract declares terminal-only exceptions');
  for (const capability of exceptions) {
    assert.match(help, new RegExp(capability.cli.split(' ')[0] as string), `${capability.id} starts at a CLI group`);
    if (capability.secret === true)
      assert.equal(capability.reason, B3_EXCEPTION_REASON_SECRET, `${capability.id} keeps the exact secret reason`);
  }
  const registries = await deriveRegistries({ env: scratchEnv(), packages: ['events-daemon'] });
  const commands = new Set(registries['events-daemon'].commands);
  for (const required of [
    'rule test-retained',
    'target resume',
    'held decide',
    'target secret create',
    'target secret rotate',
    'target url set',
    'subscriber token create',
    'subscriber token rotate',
    'judge key set',
    'judge key rotate',
    'secrets migrate',
  ])
    assert.ok(commands.has(required), `${required} is a human-only CLI leaf`);
  assert.ok(
    !commands.has('target test-pending'),
    'the ordinary CLI has no pending-target selector leaf; that selector exists only in the approval flow',
  );
  const ordinaryCliErrors = new PassThrough();
  ordinaryCliErrors.setEncoding('utf8');
  let ordinaryCliError = '';
  ordinaryCliErrors.on('data', (chunk) => {
    ordinaryCliError += String(chunk);
  });
  let ordinaryCliIpc = 0;
  assert.notEqual(
    await run(['target', 'test', 'target-1', '--version', '1', '--pending-activation', 'activation-1'], {
      streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: ordinaryCliErrors },
      b3Registrar: {
        owner: {
          async handle() {
            ordinaryCliIpc += 1;
            return {};
          },
        },
      },
    }),
    0,
    'the ordinary target-test CLI leaf refuses a pending-target selector argument',
  );
  assert.match(ordinaryCliError, /unknown option '--pending-activation'/u);
  assert.equal(ordinaryCliIpc, 0, 'the parser refuses the selector before ordinary CLI IPC');
  for (const operation of [
    ruleTestRetained,
    targetResume,
    decideHeld,
    secretOperations.targetSecretCreate,
    secretOperations.targetSecretRotate,
    secretOperations.targetUrlSet,
    secretOperations.subscriberTokenCreate,
    secretOperations.subscriberTokenRotate,
    secretOperations.judgeKeySet,
    secretOperations.judgeKeyRotate,
    secretOperations.migrateSecrets,
  ])
    assert.equal(typeof operation, 'function', 'each exception owns a real operations-module export for strict parity');
  const mcpSource = await readFile(join(import.meta.dirname, '../src/mcp/server.ts'), 'utf8');
  assert.doesNotMatch(mcpSource, /operations\/secrets/u, 'the MCP server cannot directly import secret operations');

  const { server } = await createEventsMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'b3-human-only-absence', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    const listed = JSON.stringify(tools);
    for (const forbidden of [
      'secret',
      'migrate',
      'test-retained',
      'target_resume',
      'held_decide',
      'dryrun',
      'pending-activation',
    ])
      assert.doesNotMatch(
        listed,
        new RegExp(forbidden, 'i'),
        `${forbidden} never appears in MCP tools, schemas, or text`,
      );
  } finally {
    await client.close();
    await server.close();
  }
});
