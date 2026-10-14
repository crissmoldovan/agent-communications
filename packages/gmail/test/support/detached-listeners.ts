import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

export const LISTENER_REGISTRY_ENV = 'AGENT_COMMS_TEST_LISTENER_REGISTRY';
export const LISTENER_TEST_FILE_ENV = 'AGENT_COMMS_TEST_FILE';
export const LISTENER_TEST_NAME_ENV = 'AGENT_COMMS_TEST_NAME';

export interface RegisteredListener {
  readonly pid: number;
  readonly flowId: string;
  readonly testFile: string;
  readonly testName: string;
}

function registryPath(): string {
  const path = process.env[LISTENER_REGISTRY_ENV];
  if (!path) throw new Error(`${LISTENER_REGISTRY_ENV} does not name the Gmail test listener registry`);
  return path;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

/** The command line a running process was started with, or null when there is none to read. */
async function commandLineOf(pid: number): Promise<string | null> {
  try {
    const { stdout } =
      process.platform === 'win32'
        ? await execFileAsync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { windowsHide: true },
          )
        : await execFileAsync('ps', ['-o', 'args=', '-p', String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether a registered listener is still running: its PID is, and that PID is still `oauth-listen` for its flow. A PID
 * is only a number, and Windows hands a finished process's to the next one quickly, so a PID that answers may be
 * another process's by the end of the suite: neither counted as a leak nor ever stopped in the listener's name.
 */
async function stillListening(entry: RegisteredListener): Promise<boolean> {
  if (!running(entry.pid)) return false;
  const line = (await commandLineOf(entry.pid)) ?? '';
  return line.includes('oauth-listen') && line.includes(entry.flowId);
}

export async function registeredListeners(): Promise<RegisteredListener[]> {
  let text: string;
  try {
    text = await readFile(registryPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const listeners = new Map<number, RegisteredListener>();
  for (const line of text.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as RegisteredListener;
    if (
      Number.isInteger(entry.pid) &&
      entry.pid > 0 &&
      typeof entry.flowId === 'string' &&
      typeof entry.testFile === 'string' &&
      typeof entry.testName === 'string'
    ) {
      listeners.set(entry.pid, entry);
    }
  }
  return [...listeners.values()];
}

export async function liveRegisteredListeners(): Promise<RegisteredListener[]> {
  const listeners = await registeredListeners();
  const live = await Promise.all(listeners.map(stillListening));
  return listeners.filter((_, index) => live[index]);
}

export async function stopRegisteredListeners(listeners: readonly RegisteredListener[]): Promise<void> {
  // Only a process that is still the listener is signalled: its PID may be another process's by now.
  const listening = (await Promise.all(listeners.map(stillListening))).flatMap((live, index) =>
    live ? [listeners[index] as RegisteredListener] : [],
  );
  for (const { pid } of listening) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The listener finished between the liveness check and cleanup.
    }
  }
  const deadline = Date.now() + 5_000;
  while (listening.some(({ pid }) => running(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const left = (await Promise.all(listening.map(stillListening))).flatMap((live, index) =>
    live ? [listening[index] as RegisteredListener] : [],
  );
  for (const { pid } of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The listener finished between the second liveness check and cleanup.
    }
  }
  const killedDeadline = Date.now() + 1_000;
  while (left.some(({ pid }) => running(pid)) && Date.now() < killedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
