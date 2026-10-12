import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/** Execute the pinned production bridge; only its browser/native transport endpoints are simulated. */
export async function tauriIpcFallback() {
  const lock = await readFile(new URL('../../src-tauri/Cargo.lock', import.meta.url), 'utf8');
  const version = lock.match(/\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/u)?.[1];
  assert.equal(version, '2.12.2', 'review this regression when the pinned Tauri bridge changes');
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
  let scripts;
  for (const source of await readdir(registry)) {
    const candidate = join(registry, source, `tauri-${version}`, 'scripts');
    try {
      scripts = Object.fromEntries(
        await Promise.all(
          ['core.js', 'ipc.js', 'ipc-protocol.js', 'process-ipc-message-fn.js'].map(async (name) => [
            name,
            await readFile(join(candidate, name), 'utf8'),
          ]),
        ),
      );
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.ok(scripts, 'install the pinned Cargo dependencies before running the production bridge test');
  let rejectFetch;
  let received;
  const fallback = new Promise((resolve) => {
    received = resolve;
  });
  const trace = [];
  let customBody;
  const window = {
    crypto: webcrypto,
    __TAURI_INTERNALS__: { __TAURI_PATTERN__: { pattern: 'brownfield' } },
    ipc: { postMessage: (data) => received(JSON.parse(data)) },
  };
  const context = {
    window,
    Headers,
    setTimeout,
    console: { warn: (...args) => trace.push(args.map(String).join(' ')) },
    fetch: (_url, options) => {
      customBody = JSON.parse(options.body);
      return new Promise((_resolve, reject) => {
        rejectFetch = reject;
      });
    },
  };
  const replacements = {
    __TEMPLATE_os_name__: JSON.stringify(process.platform === 'win32' ? 'windows' : 'macos'),
    __TEMPLATE_protocol_scheme__: JSON.stringify('http'),
    __TEMPLATE_isolation_origin__: JSON.stringify('synthetic-isolation'),
    __TEMPLATE_invoke_key__: JSON.stringify('synthetic-invoke-key'),
    __TEMPLATE_fetch_channel_data_command__: JSON.stringify('synthetic-channel'),
    __RAW_process_ipc_message_fn__: scripts['process-ipc-message-fn.js'],
  };
  for (const name of ['core.js', 'ipc.js', 'ipc-protocol.js']) {
    let source = scripts[name];
    for (const [placeholder, value] of Object.entries(replacements)) source = source.replaceAll(placeholder, value);
    runInNewContext(source, context, { filename: `tauri-${version}/${name}` });
  }
  return {
    invoke: window.__TAURI_INTERNALS__.invoke,
    customPayload: () => customBody,
    failCustomProtocol: () => rejectFetch(new Error('synthetic custom-protocol refusal')),
    fallback,
    complete: (frame, value, failed = false) =>
      window.__TAURI_INTERNALS__.runCallback(failed ? frame.error : frame.callback, value),
    trace,
  };
}
