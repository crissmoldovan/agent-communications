import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentMarkerHint, writeError } from '../src/cli-runtime.ts';
import { CommsError, ERROR_REGISTRY, EXIT_CODES, toCommsError } from '../src/errors.ts';
import { errorEnvelope, okEnvelope, SCHEMA_VERSION } from '../src/output.ts';

test('every error code maps to its documented exit code', () => {
  assert.equal(new CommsError('APPROVAL_REQUIRED', 'x').exitCode, 10);
  // 11 was the daily update check's stop, retired with it (design 2026-10-16, U1): nothing exits 11 any more.
  assert.ok(!Object.values(ERROR_REGISTRY).some((spec) => spec.exit === 11));
  assert.equal(new CommsError('USAGE', 'x').exitCode, 64);
  assert.equal(new CommsError('BAD_DATA', 'x').exitCode, 65);
  assert.equal(new CommsError('NOT_FOUND', 'x').exitCode, 66);
  assert.equal(new CommsError('PROVIDER_UNAVAILABLE', 'x').exitCode, 69);
  assert.equal(new CommsError('TRANSIENT', 'x').exitCode, 75);
  assert.equal(new CommsError('AUTH_REQUIRED', 'x').exitCode, 77);
  assert.equal(new CommsError('CONFIG', 'x').exitCode, 78);
  assert.equal(new CommsError('UNEXPECTED', 'x').exitCode, 1);
  assert.equal(EXIT_CODES.OK, 0);
});

test('SEND_OUTCOME_UNKNOWN is an approval refusal (exit 10) that is never retryable, as JSON and CLI consumers branch on it', () => {
  const unknown = new CommsError('SEND_OUTCOME_UNKNOWN', 'the outcome of its send is unknown: it may have gone out');
  assert.equal(unknown.exitCode, 10);
  assert.equal(unknown.retryable, false);
  assert.equal(ERROR_REGISTRY.SEND_OUTCOME_UNKNOWN.summary, 'the send outcome is unknown; check before sending again');
  // Not APPROVAL_VOID's "prepare again": a consumer that branches on the code never prepares after it.
  assert.doesNotMatch(ERROR_REGISTRY.SEND_OUTCOME_UNKNOWN.summary, /prepare/);
  assert.equal(errorEnvelope(unknown).error.code, 'SEND_OUTCOME_UNKNOWN', 'the code a JSON consumer branches on');
});

test('toCommsError keeps a CommsError and wraps anything else as UNEXPECTED', () => {
  const original = new CommsError('NOT_FOUND', 'gone');
  assert.equal(toCommsError(original), original);
  const wrapped = toCommsError(new TypeError('boom'));
  assert.equal(wrapped.code, 'UNEXPECTED');
  assert.equal(wrapped.message, 'boom');
  assert.equal(toCommsError('text').message, 'text');
});

test('envelopes carry the schema version and omit absent optional fields', () => {
  assert.deepEqual(okEnvelope({ a: 1 }), { ok: true, schemaVersion: SCHEMA_VERSION, data: { a: 1 } });
  assert.deepEqual(errorEnvelope(new CommsError('CONFIG', 'bad')), {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    error: { code: 'CONFIG', message: 'bad' },
  });
  assert.deepEqual(errorEnvelope(new CommsError('AUTH_REQUIRED', 'reauth', { hint: 'run x' })).error, {
    code: 'AUTH_REQUIRED',
    message: 'reauth',
    hint: 'run x',
  });
});

/*
 * The re-review of 0.35.0, LOW 3: `CODEX_HOME` is a setting people export, and it marks a shell as Codex's. The marker
 * stays — dropping it would let a Codex session pass as the person — so every refusal a marker causes says which
 * variable it was and how a person at their own terminal clears it.
 */

function written(error: CommsError, options: { json: boolean; platform?: NodeJS.Platform }) {
  let out = '';
  let err = '';
  const sink = (add: (text: string) => void) => ({
    write: (chunk: string) => {
      add(chunk);
      return true;
    },
  });
  const code = writeError(
    error,
    { json: options.json, color: false, platform: options.platform },
    {
      stdout: sink((text) => {
        out += text;
      }) as never,
      stderr: sink((text) => {
        err += text;
      }) as never,
    },
  );
  return { code, out, err };
}

test('LOW 3: a refusal an agent’s marker caused names the variable, and how a person at their terminal clears it', () => {
  assert.equal(
    agentMarkerHint('CODEX_HOME', 'darwin'),
    '`CODEX_HOME` is set in this shell; if you’re not inside Codex, `unset CODEX_HOME` and run it again.',
  );
  assert.equal(
    agentMarkerHint('CLAUDECODE', 'linux'),
    '`CLAUDECODE` is set in this shell; if you’re not inside Claude Code, `unset CLAUDECODE` and run it again.',
  );
  assert.equal(
    agentMarkerHint('CODEX_HOME', 'win32'),
    '`CODEX_HOME` is set in this shell; if you’re not inside Codex, `Remove-Item Env:CODEX_HOME` and run it again.',
  );
  // What is no variable a person sets — over MCP, an MCP server's process — has nothing to clear.
  for (const marker of ['MCP', 'MCP_SERVER_PROCESS', 'AGENTCOMMS_MCP_SERVER', 'PATH', undefined, 42])
    assert.equal(agentMarkerHint(marker, 'darwin'), null, String(marker));

  const refusal = new CommsError('APPROVAL_REQUIRED', 'only a person can approve a send or a change, not an agent', {
    hint: 'Ask the person to approve it at their own terminal.',
    details: { marker: 'CODEX_HOME' },
  });
  const said =
    'Ask the person to approve it at their own terminal. `CODEX_HOME` is set in this shell; if you’re not inside Codex, `unset CODEX_HOME` and run it again.';
  const json = written(refusal, { json: true, platform: 'darwin' });
  assert.equal(json.code, 10);
  assert.equal(JSON.parse(json.out).error.hint, said);
  assert.deepEqual(JSON.parse(json.out).error.details, { marker: 'CODEX_HOME' });
  const text = written(refusal, { json: false, platform: 'darwin' });
  assert.equal(text.err, `error: ${refusal.message}\nhint: ${said}\n`);
  // A refusal with no hint of its own gets this one alone; one with no agent's marker is as it was.
  const bare = new CommsError('APPROVAL_REQUIRED', 'x', { details: { reason: 'NO_SESSION', marker: 'CURSOR_AGENT' } });
  assert.equal(
    JSON.parse(written(bare, { json: true, platform: 'darwin' }).out).error.hint,
    '`CURSOR_AGENT` is set in this shell; if you’re not inside Cursor, `unset CURSOR_AGENT` and run it again.',
  );
  const server = new CommsError('APPROVAL_REQUIRED', 'x', {
    hint: 'h',
    details: { reason: 'MCP_SERVER_PROCESS', marker: 'AGENTCOMMS_MCP_SERVER' },
  });
  assert.equal(JSON.parse(written(server, { json: true }).out).error.hint, 'h');
});
