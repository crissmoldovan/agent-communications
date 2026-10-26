import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * 0.32.0 (design 2026-10-26-owner-feedback-0320 §4): the server-only package starts Gmail's server without Gmail's
 * CLI, so it marks its own process as Gmail's MCP server itself, before the server starts — and every program it
 * starts inherits the mark. The real bin is run, in a temporary home, and a preload reads the mark as it exits; its
 * stdin is closed at once, as a client ending a session closes it. Nothing reaches Gmail.
 */

const ENTRY = fileURLToPath(new URL('../src/server.ts', import.meta.url));

test('the gmail-mcp bin marks its process as Gmail’s MCP server', async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-gmail-mcp-marker-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const out = join(home, 'marker.txt');
  const preload = join(home, 'read-marker.mjs');
  writeFileSync(
    preload,
    [
      "import { writeFileSync } from 'node:fs';",
      `process.on('exit', () => writeFileSync(${JSON.stringify(out)}, process.env.AGENTCOMMS_MCP_SERVER ?? '(none)'));`,
    ].join('\n'),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--import',
        pathToFileURL(preload).href,
        ENTRY,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          USERPROFILE: home,
          AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
          NO_COLOR: '1',
          AGENT_COMMS_UPDATE_CHECK: 'off',
        },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (exit) => resolve(exit));
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the server did not exit; stderr: ${stderr.slice(0, 300)}`));
    }, 20_000);
    timer.unref();
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(out, 'utf8'), 'gmail');
});
