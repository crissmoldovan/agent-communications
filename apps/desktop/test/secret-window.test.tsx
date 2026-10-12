import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// desktop-mutation: desktop-secret-close-race
test('secret-window: submit clears entry and every lifecycle race discards a late reveal', async () => {
  const module = await import('../src/secret-form-state.ts').catch(() => ({}));
  assert.equal(typeof module.SecretFormState, 'function', 'secrets needs its own clearing state');
  for (const event of ['close', 'blur', 'navigation-failure', 'submit']) {
    const state = new module.SecretFormState();
    state.hidden = 'synthetic-hidden-entry';
    let complete: (value: { kind: 'RevealOnce'; material: string }) => void = () => {
      throw new Error('submission must start immediately');
    };
    let emitted: Record<string, unknown> = {};
    const submitted = state.submit('desktop_judge_key_set', { id: 'judge-synthetic', version: 1 }, (_command, args) => {
      emitted = args.input;
      assert.equal(args.input.hidden === 'synthetic-hidden-entry', true);
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    assert.equal(state.hidden, '');
    assert.equal(JSON.stringify(state.snapshot()).includes('synthetic-hidden-entry'), false);
    state.clear(event);
    assert.equal(
      Object.hasOwn(emitted, 'hidden'),
      false,
      'lifecycle clearing must also clear the pending bridge input',
    );
    complete({ kind: 'RevealOnce', material: 'synthetic-generated-response' });
    await submitted;
    assert.equal(JSON.stringify(state.snapshot()).includes('synthetic-'), false, event);
  }
});

// desktop-mutation: desktop-secret-hidden-form
test('secret-window: hidden forms are isolated and never rehydrate or echo failed entry', async () => {
  const module = await import('../src/secrets-app.tsx').catch(() => ({}));
  assert.equal(typeof module.SecretsApp, 'function', 'the secret entry must not render the general App');
  const html = renderToStaticMarkup(React.createElement(module.SecretsApp));
  assert.match(html, /type="password"/u);
  assert.match(html, /autoComplete="off"/u);
  assert.doesNotMatch(html, /href=|type="url"|clipboard|desktop_control/u);
  const { SecretFormState } = await import('../src/secret-form-state.ts');
  const state = new SecretFormState();
  state.hidden = 'synthetic-hidden-failed-entry';
  await state.submit('desktop_judge_key_set', { id: 'judge-synthetic', version: 1 }, async () => {
    throw new Error('synthetic-hidden-failed-entry');
  });
  assert.equal(JSON.stringify(state.snapshot()).includes('synthetic'), false);
});
