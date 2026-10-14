import { readFile } from 'node:fs/promises';

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
  return (await registeredListeners()).filter((entry) => running(entry.pid));
}

export async function stopRegisteredListeners(listeners: readonly RegisteredListener[]): Promise<void> {
  for (const { pid } of listeners) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The listener finished between the liveness check and cleanup.
    }
  }
  const deadline = Date.now() + 5_000;
  while (listeners.some(({ pid }) => running(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const { pid } of listeners.filter(({ pid }) => running(pid))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The listener finished between the second liveness check and cleanup.
    }
  }
  const killedDeadline = Date.now() + 1_000;
  while (listeners.some(({ pid }) => running(pid)) && Date.now() < killedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
