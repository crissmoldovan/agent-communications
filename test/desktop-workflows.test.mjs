import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const normalUrl = new URL('../.github/workflows/desktop.yml', import.meta.url);
const releaseUrl = new URL('../.github/workflows/desktop-release.yml', import.meta.url);
// JSON is a YAML 1.2 subset. Keeping these workflows in that subset lets the mutation
// runner validate their complete structure using Node alone, including on fork PRs.
const readWorkflow = async (url) => JSON.parse(await readFile(url, 'utf8'));
const runs = (job) =>
  job.steps
    .filter((step) => step.run)
    .map((step) => step.run)
    .join('\n');
const platforms = ['macos-latest', 'windows-latest', 'ubuntu-latest'];

async function forkSafe() {
  for (const url of [normalUrl, releaseUrl]) {
    const workflow = await readWorkflow(url);
    const source = JSON.stringify(workflow);
    assert.doesNotMatch(source, /secrets\s*(?:\.|\[)|NODE_AUTH_TOKEN|NPM_TOKEN|YARN_NPM_AUTH_TOKEN/i);
    assert.doesNotMatch(source, /(?:_auth(?:token)?|always-auth|password)\s*[:=]/i);
    for (const registry of source.matchAll(/https?:\/\/[^\s"'\\;]+/gi)) {
      assert.equal(registry[0], 'https://registry.npmjs.org/');
    }
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with?.['registry-url'], undefined);
      }
    }
  }
}

// desktop-mutation: desktop-tag-isolation
test('desktop-tag-isolation', async () => {
  const workflow = await readWorkflow(releaseUrl);
  assert.deepEqual(workflow.on, { push: { tags: ['desktop-v*'] } });
  const npm = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(npm, /tags: \['v\*'\]/);
  assert.doesNotMatch(npm, /desktop-v/);
  const validation = runs(workflow.jobs.validate);
  assert.match(validation, /desktop-v\$version/);
  assert.match(validation, /apps\/desktop\/package\.json/);
  for (const id of ['validate', 'release']) {
    const source = runs(workflow.jobs[id]);
    assert.match(source, /git ls-remote/);
    assert.match(source, /\^\{\}/);
    assert.match(source, /GITHUB_SHA/);
    assert.match(source, /git rev-parse HEAD/);
  }
});

// desktop-mutation: desktop-matrix-completeness
test('desktop-workflow-matrix', async () => {
  const normal = await readWorkflow(normalUrl);
  const release = await readWorkflow(releaseUrl);
  assert.deepEqual(normal.on.workflow_call, {});
  for (const event of ['push', 'pull_request']) {
    for (const path of [
      'apps/desktop/**',
      '.github/workflows/desktop*.yml',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      'test/**',
    ]) {
      assert.ok(normal.on[event].paths.includes(path), `${event} misses ${path}`);
    }
  }
  const job = normal.jobs.verify;
  assert.deepEqual(job.strategy.matrix.os, platforms);
  assert.equal(job['runs-on'], `$\{{ matrix.os }}`);
  assert.equal(job.if, undefined);
  assert.deepEqual(release.jobs.verify.needs, ['validate']);
  assert.equal(release.jobs.verify.uses, './.github/workflows/desktop.yml');
  assert.equal(release.jobs.verify.with, undefined);
  assert.equal(release.jobs.verify.secrets, undefined);
  const source = runs(job);
  for (const command of [
    'pnpm install --frozen-lockfile',
    'pnpm --filter @agentcomms/desktop build',
    'pnpm --filter @agentcomms/desktop typecheck',
    'pnpm --filter @agentcomms/desktop test',
    'cargo fmt --all -- --check',
    'cargo clippy --all-targets --all-features -- -D warnings',
    'cargo test --all-targets --all-features',
    'pnpm --filter @agentcomms/desktop test:e2e -- --case no-egress',
    'pnpm --filter @agentcomms/desktop test:e2e -- --case capabilities',
    'pnpm --filter @agentcomms/desktop tauri:build --no-sign',
  ])
    assert.ok(source.includes(command), `missing ${command}`);
  const unixControl = job.steps.find(
    (step) => step.name === 'Unix Task-4 production mutation and Node/Rust control gates',
  );
  assert.equal(unixControl?.if, "runner.os != 'Windows'");
  assert.match(unixControl.run, /DESKTOP_REQUIRE_CONTROL_PROBE=1/);
  assert.match(unixControl.run, /control-server-compat\.test\.mjs/);
  assert.match(unixControl.run, /mutations\/run\.mjs --group task-4/);
  assert.doesNotMatch(unixControl.run, /DESKTOP_ALLOW_SOCKET_SKIP/);
  const windowsControl = job.steps.find(
    (step) => step.name === 'Windows public pre-read filesystem trap mutation gate',
  );
  assert.equal(windowsControl?.if, "runner.os == 'Windows'");
  assert.match(windowsControl.run, /mutations\/run\.mjs --case desktop-windows-pre-read-refusal/);
  const unixSecrets = job.steps.find((step) => step.name === 'Unix Task-6 production mutations');
  assert.equal(unixSecrets?.if, "runner.os != 'Windows'");
  assert.match(unixSecrets.run, /mutations\/run\.mjs --group task-6/);
  for (const step of job.steps.filter((step) => step.run)) {
    if (step !== unixControl && step !== windowsControl && step !== unixSecrets && !/apt-get/.test(step.run))
      assert.equal(step.if, undefined, `${step.name} must run on every OS`);
    assert.equal(step['continue-on-error'], undefined);
  }
  assert.match(source, /xvfb-run/);
  assert.match(source, /libwebkit2gtk-4\.1-dev/);
  assert.match(source, /libayatana-appindicator3-dev/);
  await forkSafe();
  // Execute the actual workflow's registry guard with a fork-like empty environment.
  // No package manager or network is invoked: the Node heredoc checks local inputs.
  const guard = job.steps.find((step) => step.name === 'Assert public registry without credentials').run;
  const node = guard.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE$/)?.[1];
  assert.ok(node, 'production registry guard missing');
  const directory = await mkdtemp(join(tmpdir(), 'desktop-registry-'));
  try {
    const env = { HOME: directory, USERPROFILE: directory, npm_config_registry: 'https://registry.npmjs.org/' };
    const run = (extra = {}) =>
      spawnSync(process.execPath, ['--input-type=module'], {
        cwd: directory,
        env: { ...env, ...extra },
        input: node,
        encoding: 'utf8',
      });
    assert.equal(run().status, 0, 'public install must need no secret');
    for (const key of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'YARN_NPM_AUTH_TOKEN']) {
      assert.notEqual(run({ [key]: 'synthetic' }).status, 0, `${key} must be refused`);
    }
    assert.notEqual(run({ npm_config_registry: 'https://packages.example.test/' }).status, 0);
    for (const text of [
      '//registry.npmjs.org/:_authToken=synthetic',
      '@cueplusplus:registry=https://packages.example.test/',
      'registry=https://user:pass@registry.npmjs.org/',
    ]) {
      await writeFile(join(directory, '.npmrc'), text);
      assert.notEqual(run().status, 0, 'unsafe npmrc must be refused');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// desktop-mutation: desktop-windows-probe-launcher
test('desktop-windows-probe-launcher', async () => {
  const workflow = await readWorkflow(normalUrl);
  const steps = workflow.jobs.verify.steps;
  const index = steps.findIndex((step) => step.name === 'Bundled actual webview no-egress probe');
  const source = steps[index].run;
  assert.equal(steps[index].if, undefined, 'the outer build and absolute launcher apply on every OS');
  const build =
    'pnpm --filter @agentcomms/desktop tauri:build --features no-egress-probe --no-sign --bundles "$bundle"';
  assert.ok(source.includes(build), 'build the actual bundled probe in the outer workflow shell');
  assert.match(source, /VITE_NO_EGRESS_PROBE=1 CARGO_NET_OFFLINE=true/);
  for (const branch of [
    'macOS) bundle=app; probe="apps/desktop/src-tauri/target/release/bundle/macos/Agent Communications.app/Contents/MacOS/agentcomms-desktop" ;;',
    'Windows) bundle=nsis; probe="apps/desktop/src-tauri/target/release/agentcomms-desktop.exe" ;;',
    'Linux) bundle=deb; probe="apps/desktop/src-tauri/target/release/agentcomms-desktop" ;;',
  ])
    assert.ok(source.includes(branch), 'select the packaged executable for every platform');
  assert.ok(source.includes(`probe_binary=$(node -p 'require("node:path").resolve(process.argv[1])' "$probe")`));
  const passThrough = 'export DESKTOP_PROBE_BINARY="$probe_binary"';
  assert.ok(source.includes(passThrough), 'the harness must receive the native absolute path and skip nested pnpm');
  assert.ok(source.indexOf(build) < source.indexOf(passThrough));
  assert.ok(source.indexOf(passThrough) < source.indexOf('test:e2e'));
  assert.match(source, /xvfb-run -a pnpm --filter @agentcomms\/desktop test:e2e -- --case no-egress/);
  assert.ok(
    steps.slice(index + 1).some((step) => step.run?.includes('tauri:build --no-sign --bundles "$bundle"')),
    'a distinct later command must rebuild the ordinary production bundle',
  );
});

// desktop-mutation: desktop-workflow-public-registry
test('desktop-workflow-public-registry', async () => {
  for (const [url, id] of [
    [normalUrl, 'verify'],
    [releaseUrl, 'bundle'],
  ]) {
    const job = (await readWorkflow(url)).jobs[id];
    assert.equal(job.env.npm_config_registry, 'https://registry.npmjs.org/');
    const steps = job.steps;
    const assertion = steps.findIndex((step) => step.run?.includes('pnpm config get registry'));
    const install = steps.findIndex((step) => step.run?.includes('pnpm install --frozen-lockfile'));
    assert.ok(assertion >= 0 && install > assertion, 'public registry assertion must precede frozen install');
    assert.match(steps[assertion].run, /test "\$\(pnpm config get registry\)" = "https:\/\/registry\.npmjs\.org\/"/);
    assert.match(steps[assertion].run, /config get userconfig/);
    assert.match(steps[assertion].run, /config get globalconfig/);
    assert.match(steps[assertion].run, /\.npmrc/);
    assert.match(steps[assertion].run, /process\.env/);
    assert.match(steps[assertion].run, /throw new Error/);
  }
});

// desktop-mutation: desktop-workflow-no-registry-token
test('desktop-workflow-no-registry-token', forkSafe);

// desktop-mutation: desktop-workflow-no-private-registry
test('desktop-workflow-no-private-registry', forkSafe);

// desktop-mutation: desktop-workflow-no-registry-auth
test('desktop-workflow-no-registry-auth', forkSafe);

// desktop-mutation: desktop-prerelease-only
test('desktop-prerelease-only', async () => {
  const workflow = await readWorkflow(releaseUrl);
  assert.deepEqual(Object.keys(workflow.on), ['push']);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write' });
  assert.deepEqual(workflow.jobs.release.needs, ['validate', 'verify', 'bundle']);
  assert.deepEqual(workflow.jobs.bundle.needs, ['validate', 'verify']);
  const source = runs(workflow.jobs.release);
  const publishing = source.split('\n').filter((line) => /gh release (?:create|edit)/.test(line));
  assert.equal(publishing.length, 2);
  for (const line of publishing) {
    assert.match(line, /--prerelease(?:\s|$)/);
    assert.match(line, /--latest=false/);
    assert.match(line, /--notes-file apps\/desktop\/RELEASE_NOTES\.md/);
  }
  assert.doesNotMatch(source, /--prerelease=false|--latest=true|inputs\./);
  assert.match(source, /--verify-tag/);
  assert.match(source, /isPrerelease/);
  assert.match(source, /gh release upload/);
  assert.equal(workflow.jobs.release.env.GH_TOKEN, `$\{{ github.token }}`);
});

// desktop-mutation: desktop-no-signing-secret
test('desktop-no-signing-secret', async () => {
  const normal = await readWorkflow(normalUrl);
  const release = await readWorkflow(releaseUrl);
  assert.doesNotMatch(
    JSON.stringify([normal, release]),
    /secrets\s*(?:\.|\[)|APPLE_|CSC_|TAURI_SIGNING_|WINDOWS_CERTIFICATE|certificateThumbprint|signCommand/,
  );
  const config = JSON.parse(await readFile(new URL('../apps/desktop/src-tauri/tauri.conf.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url)));
  assert.equal(config.version, manifest.version);
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.bundle.windows.certificateThumbprint, null);
  assert.deepEqual(config.bundle.resources, ['../THIRD_PARTY_LICENSES']);
  assert.deepEqual(config.bundle.targets, ['app', 'nsis', 'deb']);
  assert.match(manifest.scripts.test, /release-notes\.test\.mjs|"test\/\*\.test\.mjs"/);
  const source = runs(release.jobs.bundle);
  assert.doesNotMatch(source, /tauri:build -- /, 'pnpm would forward the separator to Cargo');
  assert.match(source, /universal-apple-darwin --bundles app/);
  assert.match(source, /x86_64-pc-windows-msvc --bundles nsis --no-sign/);
  assert.match(source, /aarch64-apple-darwin x86_64-apple-darwin/);
});

// desktop-mutation: desktop-actions-pinned
test('desktop-actions-pinned', async () => {
  // A version tag can be moved by the action's publisher after review; the release job holds a write token, so every
  // action either workflow runs is named by the exact commit that was reviewed.
  for (const name of ['desktop.yml', 'desktop-release.yml']) {
    const text = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
    const uses = [...text.matchAll(/"uses":\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${name} runs actions`);
    for (const reference of uses) {
      // A local reusable workflow runs from the same commit as its caller.
      if (reference.startsWith('./.github/workflows/')) continue;
      assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${reference} is pinned to a commit`);
    }
  }
});

// desktop-mutation: desktop-hash-asset
test('desktop-hash-asset', async () => {
  const release = await readWorkflow(releaseUrl);
  const bundle = release.jobs.bundle;
  const source = runs(bundle);
  assert.match(source, /ditto -c -k --sequesterRsrc --keepParent/);
  assert.match(source, /desktop-macos-universal\.app\.zip/);
  assert.match(source, /desktop-windows-x64-setup\.exe/);
  const steps = release.jobs.release.steps;
  const download = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.path, 'release-assets');
  assert.equal(download.with['merge-multiple'], true);
  assert.equal(download.with.pattern, 'desktop-*');
  const publish = runs(release.jobs.release);
  assert.match(publish, /\['desktop-macos-universal\.app\.zip', 'desktop-windows-x64-setup\.exe'\]\.sort\(\)/);
  assert.match(publish, /deepEqual\(readdirSync\('release-assets'\)\.sort\(\), files\)/);
  assert.match(publish, /createHash\('sha256'\)/);
  assert.match(publish, /files\.map/);
  assert.match(publish, /SHA256SUMS/);
  assert.match(publish, /release-assets\/\*/);
  assert.match(publish, /Open Anyway/);
  assert.match(publish, /More info/);
  assert.match(publish, /Run anyway/);
  assert.match(publish, /Smart App Control/);
});

// desktop-mutation: desktop-no-linux-upload
test('desktop-no-linux-upload', async () => {
  const normal = await readWorkflow(normalUrl);
  assert.doesNotMatch(JSON.stringify(normal), /upload-artifact|gh release/);
  const release = await readWorkflow(releaseUrl);
  assert.deepEqual(release.jobs.bundle.strategy.matrix.os, ['macos-latest', 'windows-latest']);
  for (const [id, job] of Object.entries(release.jobs)) {
    if (id !== 'bundle') assert.doesNotMatch(JSON.stringify(job), /upload-artifact/);
  }
  const upload = release.jobs.bundle.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.path, 'release-assets/*');
  assert.equal(upload.with['if-no-files-found'], 'error');
});
