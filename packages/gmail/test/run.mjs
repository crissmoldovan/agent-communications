import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'agent-gmail-listeners-'));
const registry = join(directory, 'listeners.jsonl');
const preload = new URL('./support/detached-listener-preload.ts', import.meta.url).href;
const nodeOptions = [process.env.NODE_OPTIONS, `--import=${JSON.stringify(preload)}`].filter(Boolean).join(' ');
const env = {
  ...process.env,
  AGENT_COMMS_TEST_LISTENER_REGISTRY: registry,
  NODE_OPTIONS: nodeOptions,
};

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

let ordinary = 1;
let liveness = 1;
try {
  ordinary = await run(['--experimental-strip-types', '--test', 'test/**/*.test.ts']);
  liveness = await run(['--experimental-strip-types', '--test', 'test/listener-liveness.end.ts']);
} finally {
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = ordinary || liveness;
