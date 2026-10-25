import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { run } from '../src/cli/program.ts';
import { MCP_SERVER_MARKER } from '../src/targets/queue.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/** `agent-events lane …` before the owner is asked: the gates and the argument grammar (routing design §6). */

async function cli(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk;
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await run(argv, {
    env,
    streams: {
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
      stdout: Object.assign(stdout, { isTTY: false }),
      stderr: Object.assign(stderr, { isTTY: false }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

const SESSION = '25f971a3-0c69-44e3-971c-3a4656afa986';

// The not-running exit (66) needs the owner to answer, and the owner refuses Windows (78) by design (B1-G).
test('LANE-D: lane bind refuses inside the event service’s MCP server before it asks the owner (B1)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-lane-gate-');
  try {
    const base = ['--state-dir', stateDir];
    const refused = await cli([...base, 'lane', 'bind', 'david', '--window', SESSION, '--json'], {
      [MCP_SERVER_MARKER]: 'events',
    });
    assert.equal(refused.code, 10, refused.err);
    assert.match(refused.err, /binding a lane is for a person.*cannot bind one/u);
    assert.equal(refused.out, '');
    // A program the server starts inherits the mark, so it is refused too.
    const served: NodeJS.ProcessEnv = {};
    await run(['mcp'], {
      env: served,
      startMcp: async () => undefined,
      streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
    });
    assert.equal((await cli([...base, 'lane', 'bind', 'david', '--window', SESSION], served)).code, 10);
    // The person's terminal gets as far as the owner, which is not running here.
    const person = await cli([...base, 'lane', 'bind', 'david', '--window', SESSION, '--json'], {});
    assert.equal(person.code, 66, person.err);
    assert.match(person.err, /not running/u);
    // Listing and unbinding are not refused by the mark: list names no content, and unbinding only tightens.
    for (const argv of [
      ['lane', 'list', '--json'],
      ['lane', 'unbind', 'david', '--json'],
    ])
      assert.equal((await cli([...base, ...argv], { [MCP_SERVER_MARKER]: 'events' })).code, 66, argv.join(' '));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('LANE-D: a bad lane name or window id exits 64 before the owner is asked', async () => {
  const stateDir = await shortTempDir('events-lane-usage-');
  try {
    const base = ['--state-dir', stateDir];
    for (const argv of [
      ['lane', 'bind', 'David', '--window', SESSION],
      ['lane', 'bind', 'a'.repeat(41), '--window', SESSION],
      ['lane', 'bind', 'david', '--window', 'window-1'],
      ['lane', 'bind', 'david', '--window', SESSION.toUpperCase()],
      ['lane', 'bind', 'david', '--window', '0123456789abcde'],
      ['lane', 'unbind', 'david lane'],
      ['lane', 'unbind', 'david_lane'],
    ]) {
      const result = await cli([...base, ...argv, '--json'], {});
      assert.equal(result.code, 64, `${argv.join(' ')}: ${result.err}`);
    }
    const missing = await cli([...base, 'lane', 'bind', 'david', '--json'], {});
    assert.notEqual(missing.code, 0, 'a binding names its window');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
