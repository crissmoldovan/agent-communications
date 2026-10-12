import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { SecretFormState } from '../src/secret-form-state.ts';
import { tauriIpcFallback } from './helpers/tauri-ipc-fallback.mjs';

assertLoopbackSeal();

// desktop-mutation: desktop-secret-ipc-fallback
test('secret-window: pinned Tauri fallback preserves only the live hidden IPC payload', async () => {
  for (const command of ['desktop_target_url_set', 'desktop_judge_key_set', 'desktop_judge_key_rotate']) {
    for (const boundary of ['success', 'failure', 'close', 'blur', 'navigation-failure', 'submit']) {
      const bridge = await tauriIpcFallback();
      const state = new SecretFormState();
      const sentinel = `synthetic-hidden-${command}-${boundary}`;
      state.hidden = sentinel;
      let emitted;
      const submitted = state.submit(command, { id: 'synthetic', version: 1 }, (name, args) => {
        emitted = args.input;
        return bridge.invoke(name, args);
      });
      assert.equal(
        bridge.customPayload().input.hidden === sentinel,
        true,
        'initial production serialization needs the entry',
      );
      assert.equal(JSON.stringify(state.snapshot()).includes(sentinel), false, 'submit must clear visible state');
      const cancelled = boundary !== 'success' && boundary !== 'failure';
      if (cancelled) state.clear(boundary);
      bridge.failCustomProtocol();
      const fallback = await bridge.fallback;
      assert.equal(
        fallback.payload.input.hidden === sentinel,
        !cancelled,
        'production postMessage retry must preserve only a live entry',
      );
      assert.equal(fallback.options.customProtocolIpcBlocked, true);
      assert.equal(
        bridge.trace.some((entry) => entry.includes(sentinel)),
        false,
        'IPC warnings must not expose the entry',
      );
      const result =
        command === 'desktop_target_url_set'
          ? { kind: 'UrlFingerprint', scheme: 'https', host: 'synthetic.invalid', port: 443, sha256: '0'.repeat(64) }
          : { kind: 'Acknowledgement' };
      bridge.complete(fallback, boundary === 'failure' ? 'synthetic-refusal' : result, boundary === 'failure');
      await submitted;
      assert.equal(
        Object.hasOwn(emitted, 'hidden'),
        false,
        'completion, failure and lifecycle boundaries clear bridge input',
      );
      assert.equal(JSON.stringify(state.snapshot()).includes(sentinel), false);
      assert.equal(state.result?.kind === result.kind, boundary === 'success');
    }
  }
});
