import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const configUrl = new URL('../src-tauri/tauri.conf.json', import.meta.url);
const secretsHtmlUrl = new URL('../secrets.html', import.meta.url);
const libUrl = new URL('../src-tauri/src/lib.rs', import.meta.url);
const trayUrl = new URL('../src-tauri/src/tray.rs', import.meta.url);
const settingsCapabilityUrl = new URL('../src-tauri/capabilities/settings.json', import.meta.url);
const secretsCapabilityUrl = new URL('../src-tauri/capabilities/secrets.json', import.meta.url);
const cargoUrl = new URL('../src-tauri/Cargo.toml', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const configuredPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const secretsPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const directives = [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'connect-src',
  'frame-src',
  'object-src',
  'form-action',
  'base-uri',
];

function parsePolicy(value) {
  const pairs = value.split('; ');
  assert.equal(pairs.length, directives.length, 'CSP has an unexpected directive count');
  const result = new Map(
    pairs.map((pair) => {
      const [name, ...sources] = pair.split(' ');
      assert.ok(sources.length, `${name} has no value`);
      return [name, sources.join(' ')];
    }),
  );
  assert.deepEqual([...result.keys()].sort(), [...directives].sort());
  return result;
}

async function policyData() {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const html = await readFile(secretsHtmlUrl, 'utf8');
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i);
  assert.ok(meta, 'secrets must emit the tightening meta policy');
  return { config, configured: parsePolicy(config.app.security.csp), secrets: parsePolicy(meta[1]), meta: meta[1] };
}

function assertCompleteCsp({ config, configured, secrets, meta }) {
  assert.equal(config.app.security.csp, configuredPolicy);
  assert.equal(config.app.security.dangerousDisableAssetCspModification, false);
  assert.equal(meta, secretsPolicy);
  const intersection = new Map(directives.map((name) => [name, [configured.get(name), secrets.get(name)]]));
  assert.deepEqual(intersection.get('connect-src'), ['ipc: http://ipc.localhost', 'ipc: http://ipc.localhost']);
  for (const name of directives) {
    assert.ok(intersection.get(name).every(Boolean), `${name} is absent from the effective intersection`);
  }
  assert.deepEqual(intersection.get('img-src'), ["'self' data:", "'none'"]);
  assert.deepEqual(intersection.get('default-src'), ["'self'", "'none'"]);
}

// desktop-mutation: desktop-csp-configured-default-src
test('desktop-csp-exact configured default-src', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('default-src'), "'self'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-script-src
test('desktop-csp-exact configured script-src', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('script-src'), "'self'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-style-src
test('desktop-csp-exact configured style-src', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('style-src'), "'self'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-img-src
test('desktop-csp-exact configured img-src', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('img-src'), "'self' data:");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-connect-src
test('desktop-csp-exact configured connect-src', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('connect-src'), 'ipc: http://ipc.localhost');
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-frame-src
test('desktop-csp-exact configured frame-src', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('frame-src'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-object-src
test('desktop-csp-exact configured object-src', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('object-src'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-form-action
test('desktop-csp-exact configured form-action', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('form-action'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-configured-base-uri
test('desktop-csp-exact configured base-uri', async () => {
  const data = await policyData();
  assert.equal(data.configured.get('base-uri'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-default-src
test('desktop-csp-exact secrets default-src', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('default-src'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-script-src
test('desktop-csp-exact secrets script-src', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('script-src'), "'self'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-style-src
test('desktop-csp-exact secrets style-src', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('style-src'), "'self'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-img-src
test('desktop-csp-exact secrets img-src', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('img-src'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-connect-src
test('desktop-csp-exact secrets connect-src', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('connect-src'), 'ipc: http://ipc.localhost');
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-frame-src
test('desktop-csp-exact secrets frame-src', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('frame-src'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-object-src
test('desktop-csp-exact secrets object-src', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('object-src'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-form-action
test('desktop-csp-exact secrets form-action', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('form-action'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-secrets-base-uri
test('desktop-csp-exact secrets base-uri', async () => {
  const data = await policyData();
  assert.equal(data.secrets.get('base-uri'), "'none'");
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-asset-modification
test('desktop-csp-exact asset modification', async () => {
  const data = await policyData();
  assert.equal(data.config.app.security.dangerousDisableAssetCspModification, false);
  assertCompleteCsp(data);
});

// desktop-mutation: desktop-csp-null
test('desktop-csp-exact null policy', async () => {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  assert.equal(config.app.security.csp, configuredPolicy);
  assertCompleteCsp(await policyData());
});

// desktop-mutation: desktop-handler-order
test('desktop-handler-order', async () => {
  const lib = await readFile(libUrl, 'utf8');
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  assert.deepEqual(config.app.windows, [], 'config must not auto-create windows before handlers');
  assert.match(lib, /install_security_before_windows\(app\)/);
  assert.ok(
    lib.indexOf('install_security_before_windows(app)') < lib.indexOf('WebviewWindowBuilder::'),
    'security installation must precede the first webview build',
  );
  assert.match(lib, /\.on_navigation\(\|url\| security::allow_window_navigation\("settings", url\)\)/);
  assert.match(lib, /\.on_navigation\(\|url\| security::allow_window_navigation\("secrets", url\)\)/);
});

// desktop-mutation: desktop-http-opener-capability
test('desktop-http-opener-capability', async () => {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  assert.deepEqual(config.plugins ?? {}, {});
  for (const label of ['settings', 'secrets']) {
    const capability = JSON.parse(
      await readFile(label === 'settings' ? settingsCapabilityUrl : secretsCapabilityUrl, 'utf8'),
    );
    assert.deepEqual(capability.windows, [label]);
    assert.deepEqual(
      capability.permissions,
      label === 'settings'
        ? [
            'allow-desktop-control',
            'allow-desktop-approve',
            'allow-desktop-preferences',
            'allow-desktop-supervision-status',
            'allow-desktop-start-daemon',
            'allow-desktop-quit-daemon',
            'allow-desktop-open-secrets',
          ]
        : [],
    );
  }
  const cargo = await readFile(cargoUrl, 'utf8');
  const npm = JSON.parse(await readFile(packageUrl, 'utf8'));
  const lib = await readFile(libUrl, 'utf8');
  assert.match(lib, /install_security_before_windows\(app\)/);
  assert.doesNotMatch(lib, /\.plugin\(.*(?:http|opener|shell|fs|clipboard|dialog)/);
  assert.doesNotMatch(cargo, /tauri-plugin-(?:http|opener|shell|fs|clipboard|dialog)/);
  assert.deepEqual(
    Object.keys({ ...npm.dependencies, ...npm.devDependencies }).filter((name) =>
      /@tauri-apps\/plugin-(?:http|opener|shell|fs|clipboard|dialog)/.test(name),
    ),
    [],
  );
});

// desktop-mutation: desktop-window-labels
test('desktop-window-labels', async () => {
  const lib = await readFile(libUrl, 'utf8');
  assert.match(lib, /"settings"/);
  assert.match(lib, /"secrets"/);
  assert.match(lib, /"settings\.html"/);
  assert.match(lib, /"secrets\.html"/);
});

// desktop-mutation: desktop-tray-lifecycle
test('desktop-tray-lifecycle', async () => {
  const lib = await readFile(libUrl, 'utf8');
  const tray = await readFile(trayUrl, 'utf8');
  assert.match(lib, /install_tray\(app\)/);
  assert.match(lib, /WindowEvent::CloseRequested/);
  assert.match(lib, /api\.prevent_close\(\)/);
  assert.match(lib, /window\.hide\(\)/);
  assert.match(tray, /TrayIconBuilder/);
  assert.match(tray, /"show"/);
  assert.match(tray, /"show" =>/);
  assert.match(tray, /"quit"/);
});
