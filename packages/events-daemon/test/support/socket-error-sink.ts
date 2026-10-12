import assert from 'node:assert/strict';

const SOCKET_TEST_TIMEOUT_MS = 5_000;

/** Fails a socket-lifecycle proof instead of leaving the test worker open indefinitely. */
export async function withSocketTestTimeout<T>(
  work: Promise<T>,
  description: string,
  timeoutMs: number = SOCKET_TEST_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * An unhandled socket `error` is delivered on a later turn. Keep the capture installed through that turn so a
 * sink-removal mutant becomes this test's deterministic assertion failure instead of an orphaned worker failure.
 */
export async function withoutUncaughtSocketException<T>(message: string, work: () => T | Promise<T>): Promise<T> {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.prependListener('uncaughtException', onUncaught);
  try {
    const result = await withSocketTestTimeout(Promise.resolve().then(work), `${message} to settle`);
    await withSocketTestTimeout(
      new Promise<void>((resolve) => setImmediate(resolve)),
      `${message} to deliver a pending socket error`,
    );
    assert.deepEqual(uncaught, [], message);
    return result;
  } finally {
    process.off('uncaughtException', onUncaught);
  }
}

export function waitForSocketClose(socket: {
  readonly destroyed?: boolean | undefined;
  once(event: 'close', listener: () => void): unknown;
}): Promise<void> {
  if (socket.destroyed === true) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', resolve));
}
