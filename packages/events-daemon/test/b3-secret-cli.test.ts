import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { type EventsCliStreams, run } from '../src/cli/program.ts';

function tty(): EventsCliStreams {
  return {
    stdin: Object.assign(new PassThrough(), { isTTY: true }),
    stdout: Object.assign(new PassThrough(), { isTTY: true }),
    stderr: Object.assign(new PassThrough(), { isTTY: true }),
  };
}

async function collected(
  stream: PassThrough,
  work: () => Promise<number>,
): Promise<{ readonly code: number; readonly text: string }> {
  stream.setEncoding('utf8');
  let text = '';
  stream.on('data', (chunk) => {
    text += String(chunk);
  });
  const code = await work();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { code, text };
}

test('B3 secret CLI accepts material only through its injected hidden TTY reader and reveals generated material once', async () => {
  const streams = tty();
  const seen: unknown[] = [];
  let prompted = 0;
  const result = await collected(streams.stdout as PassThrough, () =>
    run(['judge', 'key', 'set', 'judge-1', '--version', '1'], {
      streams,
      env: {},
      b3Registrar: {
        owner: {
          async handle(request) {
            seen.push(request);
            return { kind: 'judge-key', judgeId: 'judge-1', version: 1, generation: 1 };
          },
        },
      },
      readSecret: async () => {
        prompted += 1;
        return 'synthetic-hidden-value';
      },
    }),
  );
  assert.equal(result.code, 0);
  assert.equal(prompted, 1, 'the only test seam supplies hidden material once');
  assert.deepEqual(seen, [
    {
      operation: 'judgeKeySet',
      args: { judgeId: 'judge-1', version: 1, hidden: 'synthetic-hidden-value' },
      origin: 'interactive-terminal',
    },
  ]);
  assert.doesNotMatch(
    result.text,
    /synthetic-hidden-value/,
    'a user-provided value is never echoed in terminal output',
  );

  const generatedSeen: unknown[] = [];
  const generated = await collected(streams.stdout as PassThrough, () =>
    run(['target', 'secret', 'create', 'target-1', '--version', '1'], {
      streams,
      env: {},
      b3Registrar: {
        owner: {
          async handle(request) {
            generatedSeen.push(request);
            return {
              receipt: { kind: 'target-secret', targetId: 'target-1', version: 1, generation: 1 },
              terminalReveal: 'synthetic-generated-terminal-value',
            };
          },
        },
      },
    }),
  );
  assert.equal(generated.code, 0);
  assert.equal(
    (generated.text.match(/synthetic-generated-terminal-value/g) ?? []).length,
    1,
    'the controlling TTY is the one renderer and consumes the generated reveal once',
  );
  assert.match(generated.text, /"kind":"target-secret"/u, 'the remainder of terminal output is a receipt');
  assert.deepEqual(generatedSeen, [
    { operation: 'targetSecretCreate', args: { targetId: 'target-1', version: 1 }, origin: 'interactive-terminal' },
  ]);
});

test('B3 secret CLI refuses agent-marked, non-TTY, redirected-input, and JSON invocations before prompt or IPC', async () => {
  for (const scenario of [
    {
      name: 'agent marker',
      env: { CLAUDECODE: '1' },
      streams: tty(),
      argv: ['target', 'secret', 'create', 'target-1', '--version', '1'],
    },
    {
      name: 'non-TTY',
      env: {},
      streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() } as EventsCliStreams,
      argv: ['target', 'secret', 'create', 'target-1', '--version', '1'],
    },
    {
      name: 'redirected input',
      env: {},
      streams: {
        stdin: new PassThrough(),
        stdout: Object.assign(new PassThrough(), { isTTY: true }),
        stderr: Object.assign(new PassThrough(), { isTTY: true }),
      },
      argv: ['target', 'secret', 'create', 'target-1', '--version', '1'],
    },
    {
      name: 'JSON',
      env: {},
      streams: tty(),
      argv: ['--json', 'target', 'secret', 'create', 'target-1', '--version', '1'],
    },
  ] as const) {
    let prompted = 0;
    let handled = 0;
    const completed = await collected(scenario.streams.stderr as PassThrough, () =>
      run(scenario.argv, {
        streams: scenario.streams,
        env: scenario.env,
        b3Registrar: {
          owner: {
            async handle() {
              handled += 1;
              return {};
            },
          },
        },
        readSecret: async () => {
          prompted += 1;
          return 'synthetic-hidden-value';
        },
      }),
    );
    assert.notEqual(completed.code, 0, `${scenario.name} is refused`);
    assert.match(
      completed.text,
      /only a person|interactive terminal/u,
      `${scenario.name} reaches the human-terminal guard rather than failing only because the command is absent`,
    );
    assert.equal(prompted, 0, `${scenario.name} refuses before a prompt`);
    assert.equal(handled, 0, `${scenario.name} refuses before the CLI can make an IPC owner request`);
  }
});

test('B3 secret CLI has no argv, environment, JSON, or stdin-pipe material channel', async () => {
  const streams = tty();
  (streams.stdin as PassThrough).end('synthetic-piped-value\n');
  const seen: unknown[] = [];
  const result = await collected(streams.stdout as PassThrough, () =>
    run(['target', 'url', 'set', 'target-1', '--draft', '{"kind":"webhook"}', '--new-version', '1'], {
      streams,
      env: { AGENT_EVENTS_SECRET: 'test-environment-value' },
      b3Registrar: {
        owner: {
          async handle(request) {
            seen.push(request);
            return { scheme: 'https' };
          },
        },
      },
      readSecret: async () => 'https://receiver.invalid/synthetic-hidden-reader-value',
    }),
  );
  assert.equal(result.code, 0);
  assert.deepEqual(seen, [
    {
      operation: 'targetUrlSet',
      args: {
        targetId: 'target-1',
        inertDraft: { kind: 'webhook' },
        newVersion: 1,
        hidden: 'https://receiver.invalid/synthetic-hidden-reader-value',
      },
      origin: 'interactive-terminal',
    },
  ]);
  assert.doesNotMatch(result.text, /synthetic-(?:piped|environment|hidden-reader)-value/u);

  const argvStreams = tty();
  let prompted = 0;
  let handled = 0;
  const argvResult = await collected(argvStreams.stderr as PassThrough, () =>
    run(['target', 'secret', 'create', 'target-1', '--version', '1', '--secret', 'synthetic-argv-value'], {
      streams: argvStreams,
      env: {},
      b3Registrar: {
        owner: {
          async handle() {
            handled += 1;
            return {};
          },
        },
      },
      readSecret: async () => {
        prompted += 1;
        return 'unreachable';
      },
    }),
  );
  assert.notEqual(argvResult.code, 0);
  assert.match(argvResult.text, /unknown option '--secret'/u);
  assert.equal(prompted, 0);
  assert.equal(handled, 0);
});

test('B3 terminal migration names every failed post-selector cleanup reference so it can be retried before rotation', async () => {
  const streams = tty();
  const leftovers = ['event-secret:aaaaaaaaaaaaaaaaaaaaaaaa', 'event-secret:bbbbbbbbbbbbbbbbbbbbbbbb'];
  const output = await collected(streams.stdout as PassThrough, () =>
    run(['secrets', 'migrate', '--to', 'file'], {
      streams,
      env: {},
      b3Registrar: {
        owner: {
          async handle(request) {
            assert.deepEqual(request, {
              operation: 'migrateSecrets',
              args: { to: 'file' },
              origin: 'interactive-terminal',
            });
            return { moved: 2, leftovers };
          },
        },
      },
    }),
  );
  assert.equal(output.code, 0);
  assert.match(output.text, /retry this migration before rotating/u);
  for (const reference of leftovers) assert.match(output.text, new RegExp(reference, 'u'));
});
