import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { run } from '../src/cli/program.ts';
import { VERSION } from '../src/version.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

async function invoke(args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const stdout = new PassThrough();
  let text = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => {
    text += String(chunk);
  });
  const code = await run(args, {
    streams: { stdin: new PassThrough(), stdout, stderr: new PassThrough() },
  });
  return { code, stdout: text };
}

test('agent-events prints its package version through both program-wide version flags', async () => {
  for (const flag of ['--version', '-V']) {
    const result = await invoke([flag]);
    assert.equal(result.code, 0, `${flag} exits successfully`);
    assert.equal(result.stdout, `${VERSION}\n`, `${flag} prints only the package version`);
  }
});

test('agent-events keeps the trailing --json every command documents, beside the program version flag', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('aev-cli-json-');
  const env = {
    ...process.env,
    HOME: root,
    AGENT_COMMS_CONFIG_DIR: join(root, 'config'),
    AGENT_COMMS_STATE_DIR: join(root, 'state'),
  };
  const call = async (args: readonly string[]) => {
    const stdout = new PassThrough();
    let text = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk) => {
      text += String(chunk);
    });
    const code = await run(args, { env, streams: { stdin: new PassThrough(), stdout, stderr: new PassThrough() } });
    return { code, stdout: text };
  };
  try {
    const trailing = await call(['status', '--json']);
    assert.equal(trailing.code, 0, 'a trailing --json is still a program option after a subcommand');
    assert.deepEqual(
      JSON.parse(trailing.stdout),
      { owner: 'not-running' },
      'status --json writes machine-readable output',
    );
    const leading = await call(['--json', 'status']);
    assert.equal(leading.code, 0, 'a leading --json still works');
    assert.deepEqual(
      JSON.parse(leading.stdout),
      { owner: 'not-running' },
      '--json status writes machine-readable output',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
