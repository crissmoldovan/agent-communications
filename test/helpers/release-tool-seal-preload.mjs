import childProcess, { ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import workerThreads from 'node:worker_threads';

export const RELEASE_CHILD_PROCESS_ENTRY_POINTS = Object.freeze([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
]);

const ownPreload = process.execArgv.some((argument) => argument.includes('release-tool-seal-preload.mjs'));

function recordPath() {
  const record = new URL(import.meta.url).searchParams.get('record');
  if (record === null) throw new Error('release tool seal preload requires a record file URL');
  const url = new URL(record);
  if (url.protocol !== 'file:') throw new Error('release tool seal preload record must be a file URL');
  return fileURLToPath(url);
}

function attemptedCommand(entryPoint, args) {
  return {
    entryPoint,
    command: String(args[0]),
    arguments: Array.isArray(args[1]) ? args[1].map(String) : [],
  };
}

function install() {
  const record = recordPath();
  for (const entryPoint of RELEASE_CHILD_PROCESS_ENTRY_POINTS) {
    Object.defineProperty(childProcess, entryPoint, {
      configurable: true,
      writable: true,
      value: function refusedReleaseTool(...args) {
        appendFileSync(record, `${JSON.stringify(attemptedCommand(entryPoint, args))}\n`, 'utf8');
        throw new Error(`release tool seal refused child_process.${entryPoint}: ${String(args[0])}`);
      },
    });
  }
  // Below the convenience exports: every one of them ends in ChildProcess.prototype.spawn or the spawn_sync binding.
  const refuse = (entryPoint, command) => {
    appendFileSync(record, `${JSON.stringify({ entryPoint, command: String(command), arguments: [] })}\n`, 'utf8');
    throw new Error(`release tool seal refused ${entryPoint}: ${String(command)}`);
  };
  Object.defineProperty(ChildProcess.prototype, 'spawn', {
    configurable: true,
    writable: true,
    value: function refusedChildProcessSpawn(options) {
      return refuse('ChildProcess.prototype.spawn', options?.file);
    },
  });
  // A worker would start without this preload, so the release child may start none.
  Object.defineProperty(workerThreads, 'Worker', {
    configurable: true,
    writable: true,
    value: function refusedWorker(source) {
      return refuse('worker_threads.Worker', source);
    },
  });
  const binding = process.binding;
  Object.defineProperty(process, 'binding', {
    configurable: true,
    writable: true,
    value: function sealedBinding(name) {
      if (name === 'spawn_sync' || name === 'process_wrap') return refuse('process.binding', name);
      return binding.call(process, name);
    },
  });
  syncBuiltinESMExports();
}

if (ownPreload) install();
