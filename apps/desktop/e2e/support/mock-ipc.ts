import type { Page } from '@playwright/test';

/**
 * Stands in for Tauri in the page: `window.__TAURI_INTERNALS__` answers `invoke` from `scenario`, keeps the callbacks
 * `transformCallback` registers, and takes `plugin:event|listen`, so `window.__emit(event, payload)` reaches the app's
 * listeners. Every invoke is recorded in `window.__calls`. Requests to anywhere but the preview server are refused.
 *
 * `scenario` names each command's answer by its Rust name (`installation`, `take_deep_link`, …). `cli` maps a call's
 * kind to the data of an `ok` result — or, for `doctor` and `accounts`, a map by product, and for `queueList` a map by
 * the state it asks for — and `cliResults` maps a kind to a whole `CliResult`, for a failure or a pending approval.
 */
export async function installMockIpc(page: Page, scenario: Record<string, unknown>): Promise<void> {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === 'localhost' && url.port === '4173' ? route.continue() : route.abort();
  });
  await page.addInitScript((given: Record<string, unknown>) => {
    type Handler = (message: { event: string; id: number; payload: unknown }) => void;
    const calls: { cmd: string; args: unknown }[] = [];
    const callbacks = new Map<number, Handler>();
    const listeners = new Map<string, number[]>();
    let next = 1;
    const cli = (given.cli ?? {}) as Record<string, unknown>;
    const cliResults = (given.cliResults ?? {}) as Record<string, unknown>;
    const scoped = (value: unknown, product: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof product === 'string' &&
      product in value
        ? (value as Record<string, unknown>)[product]
        : value;
    const target = window as unknown as Record<string, unknown>;
    target.__calls = calls;
    target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    target.__TAURI_INTERNALS__ = {
      transformCallback(callback: Handler) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') {
          const event = String(args.event);
          listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
          return Number(args.handler);
        }
        if (cmd === 'plugin:event|unlisten') return null;
        if (cmd === 'cli') {
          const call = args.call as { kind: string; product?: string; state?: string };
          if (call.kind in cliResults) return cliResults[call.kind];
          if (call.kind === 'version') return { status: 'version', version: '0.24.0' };
          if (call.kind in cli) {
            return { status: 'ok', exit: 0, data: scoped(cli[call.kind], call.product ?? call.state) };
          }
          return {
            status: 'failed',
            exit: -1,
            code: 'APP_NOT_BUILT',
            message: `${call.kind} is not in this scenario`,
            hint: null,
          };
        }
        if (cmd in given) return given[cmd];
        throw { code: 'APP_NOT_BUILT', message: `${cmd} is not in this scenario` };
      },
    };
    target.__emit = (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    };
  }, scenario);
}
