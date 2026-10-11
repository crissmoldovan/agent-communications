import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataItem, Item, OperationForm, OperationFormView, Read } from '../src/screens/shared.tsx';

const matrix = JSON.parse(
  await readFile(new URL('../../../test/fixtures/desktop-screen-contract/v1.json', import.meta.url), 'utf8'),
);
const semantics = JSON.parse(
  await readFile(new URL('../../../test/fixtures/desktop-screen-contract/semantics-v1.json', import.meta.url), 'utf8'),
);
const doctorSchema = JSON.parse(
  await readFile(
    new URL('../../../packages/events-daemon/src/operations/contracts/doctor-v1.schema.json', import.meta.url),
    'utf8',
  ),
);
function resolveDoctor(shape) {
  while (shape.$ref)
    shape = shape.$ref
      .slice(2)
      .split('/')
      .reduce((value, key) => value[key], doctorSchema);
  return shape;
}
// These are safe display fragments, not complete raw responses. Every included doctor field must still be declared.
function assertDoctorFragment(shape, value) {
  shape = resolveDoctor(shape);
  if (shape.type === 'array') {
    assert.ok(Array.isArray(value));
    for (const item of value) assertDoctorFragment(shape.items, item);
  } else if (shape.type === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(shape.properties[key], `doctor fixture invents field ${key}`);
      assertDoctorFragment(shape.properties[key], child);
    }
  }
}

function section(html, item) {
  const start = html.indexOf(`<section data-item="${item}">`);
  assert.notEqual(start, -1, item);
  const tags = /<section\b[^>]*>|<\/section>/gu;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  throw new Error(`unclosed section ${item}`);
}
function nodes(element) {
  if (!React.isValidElement(element)) return [];
  const children = [DataItem, Item, Read].includes(element.type) ? element.type(element.props) : element.props.children;
  return [element, ...React.Children.toArray(children).flatMap(nodes)];
}
const safe = (operation, segments = [], code = null) => ({
  operation,
  segments,
  code,
  truncated: false,
  approval: null,
});
async function verifyCase(screen, item, label) {
  const { screens } = await import('../src/screens/index');
  const contract = semantics[screen][item];
  assert.ok(contract && Object.keys(contract).length, `${screen}:${item} semantic expectation`);
  const calls = [];
  const preferences = [];
  const results = {
    doctor: safe('doctor', [
      { path: '/recovery/leases', text: 'unrelated-recovery-count', trust: 'untrusted' },
      { path: '/superseded/0', text: 'unrelated-superseded-record', trust: 'untrusted' },
    ]),
  };
  if (contract.data) {
    const { operation, path, text } = contract.data;
    if (operation === 'doctor') {
      let shape = doctorSchema;
      for (const part of path.slice(1).split('/')) {
        shape = resolveDoctor(shape);
        shape = shape.type === 'array' ? shape.items : shape.properties[part];
        assert.ok(shape, `unknown doctor path ${path}`);
      }
      assertDoctorFragment(shape, JSON.parse(text));
    }
    results[operation] = safe(operation, [{ path, text, trust: 'untrusted' }]);
  }
  if (screen === 'approvals')
    results.approvalView = {
      ...(results.approvalView ?? safe('approvalView')),
      approval: {
        approvalId: 'approval-native',
        digest: 'digest-native',
        challenge: 'challenge-from-native',
        expiresAt: 9000,
      },
    };
  const props = {
    results,
    onOperation: (operation, args, scope) => calls.push([operation, args, scope]),
    onSecrets: () => calls.push(['secrets']),
    onApproval() {},
    preferences: { openAtLogin: false, keepCollectingAfterQuit: false },
    onPreferences: (value) => preferences.push(value),
  };
  const html = section(renderToStaticMarkup(React.createElement(screens[screen], props)), item);
  assert.ok(html.includes(label), label);
  if (contract.data) {
    const encoded = renderToStaticMarkup(React.createElement('span', {}, contract.data.text)).slice(6, -7);
    assert.ok(html.includes(encoded), `${screen}:${item} must display the actual selected daemon field`);
  }
  for (const text of contract.needles ?? []) assert.ok(html.includes(text), `${screen}:${item}: ${text}`);
  if (contract.seam) {
    assert.ok(html.includes(`data-contract-seam="${contract.seam}"`), `${screen}:${item}: explicit ${contract.seam}`);
    assert.ok(
      !html.includes('unrelated-recovery-count') && !html.includes('unrelated-superseded-record'),
      `${screen}:${item} must not substitute unrelated counts`,
    );
  }
  if (contract.unavailable) {
    const { operation, code } = contract.unavailable;
    const unavailable = section(
      renderToStaticMarkup(
        React.createElement(screens[screen], {
          ...props,
          results: { ...results, [operation]: safe(operation, [], code) },
        }),
      ),
      item,
    );
    assert.ok(unavailable.includes(code), `${screen}:${item}: render typed ${code}`);
  }
  if (contract.disabled) assert.match(html, /<button[^>]*disabled=""[^>]*>Approve<\/button>/);
  if (contract.actions || contract.preferences) {
    const all = nodes(screens[screen](props));
    for (const operation of contract.actions ?? []) {
      if (operation === 'secrets') {
        const button = all.find((node) => node.type === 'button' && node.props.onClick === props.onSecrets);
        assert.ok(button);
        button.props.onClick();
      } else {
        const control = all.find(
          (node) => (node.type === Read || node.type === OperationForm) && node.props.operation === operation,
        );
        assert.ok(control, `${screen}:${item}: actionable ${operation}`);
        if (control.type === Read) Read(control.props).props.onClick();
        else
          OperationFormView({
            ...control.props,
            document: '{"stableId":"fixture-id"}',
            expectedScope: '{}',
            error: '',
            onDocument() {},
            onScope() {},
            onError() {},
          }).props.onSubmit({ preventDefault() {} });
      }
      assert.equal(calls.at(-1)[0], operation);
    }
    if (contract.preferences) {
      const inputs = all.filter((node) => node.type === 'input' && node.props.type === 'checkbox');
      const index = contract.preferences === 'openAtLogin' ? 0 : 1;
      assert.equal(inputs[index].props.checked, false);
      inputs[index].props.onChange({ target: { checked: true } });
      assert.equal(preferences.at(-1)[contract.preferences], true);
    }
  }
}
for (const [screen, items] of Object.entries(matrix)) {
  for (const [item, label] of Object.entries(items)) {
    test(`screen:${screen}:${item}`, async () => {
      let network = 0;
      const previous = globalThis.fetch;
      globalThis.fetch = async () => {
        network++;
        throw new Error('network forbidden');
      };
      try {
        await verifyCase(screen, item, label);
        assert.equal(network, 0);
      } finally {
        globalThis.fetch = previous;
      }
    });
  }
}

// desktop-mutation: desktop-screen-contract-completeness
test('screen-contract: desktop-screen-contract-completeness renders every required screen item', async () => {
  const { screens } = await import('../src/screens/index');
  const { Overview } = await import('../src/screens/overview.tsx');
  assert.equal(screens.overview, Overview);
  for (const [screen, items] of Object.entries(matrix)) {
    const html = renderToStaticMarkup(
      React.createElement(screens[screen], {
        results: {},
        onOperation() {},
        onApproval() {},
        onSecrets() {},
        preferences: { openAtLogin: false, keepCollectingAfterQuit: false },
        onPreferences() {},
      }),
    );
    for (const item of Object.keys(items)) assert.ok(html.includes(`data-item="${item}"`), `${screen}:${item}`);
  }
});

// desktop-mutation: desktop-screen-contract-seams
test('screen-contract: unavailable fields never substitute unrelated daemon records', async () => {
  for (const [screen, item] of [
    ['sources', 'slack-drains'],
    ['settings', 'retention'],
    ['settings', 'secret-backend'],
    ['settings', 'data-disk-use'],
    ['overview', 'activation-completion'],
  ])
    await verifyCase(screen, item, matrix[screen][item]);
});
