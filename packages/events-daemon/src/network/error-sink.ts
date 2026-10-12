import type { EventEmitter } from 'node:events';

/**
 * Keeps an owned network resource from turning a later transport error into an uncaught exception.
 * Operation-specific listeners still translate errors into their own result while they are active.
 */
export function installErrorSink<T extends EventEmitter>(resource: T): T {
  resource.on('error', () => undefined);
  return resource;
}
