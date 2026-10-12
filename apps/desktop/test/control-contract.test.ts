import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// desktop-mutation: desktop-b3-wire-contract
test('control-contract: desktop-b3-wire-contract rejects schema and vector drift', async () => {
  const { generateContract } = await import('../scripts/b3-contract.mjs');
  const baseline = await generateContract();
  assert.match(baseline, /pub enum NonSecretOperation/);
  await assert.rejects(
    generateContract({
      mutateSchema(schema) {
        schema.$defs.request.oneOf.shift();
      },
    }),
  );
  await assert.rejects(
    generateContract({
      mutateSchema(schema) {
        schema.$defs.resultsByOperation.$defs.status.properties.enabled.type = 'string';
      },
    }),
  );
  await assert.rejects(
    generateContract({
      mutateVectors(vectors) {
        const vector = vectors.find((v) => v.result?.owner);
        vector.result.enabled = 'wrong';
      },
    }),
  );
});

// Build input exercised by this artifact test: ../src-tauri/build.rs
// desktop-mutation: desktop-control-command-manifest
test('control-contract: built app manifest registers exactly the settings commands and isolates secrets', async (t) => {
  const desktop = new URL('../src-tauri/', import.meta.url);
  const target = await mkdtemp(join(tmpdir(), 'desktop-acl-artifact-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const build = spawnSync('cargo', ['build', '--offline', '--bin', 'agentcomms-desktop'], {
    cwd: desktop,
    encoding: 'utf8',
    env: { ...process.env, CARGO_TARGET_DIR: target },
  });
  assert.equal(build.status, 0, `desktop artifact build failed:\n${build.stderr}\n${build.stdout}`);

  const buildRoot = join(target, 'debug', 'build');
  const artifacts = await Promise.all(
    (await readdir(buildRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('agentcomms-desktop-'))
      .map(async (entry) => {
        const out = join(buildRoot, entry.name, 'out');
        const manifest = join(out, 'acl-manifests.json');
        const capabilities = join(out, 'capabilities.json');
        try {
          return { manifest, capabilities, mtime: (await stat(manifest)).mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const artifact = artifacts
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.mtime - a.mtime)[0];
  assert.ok(artifact, 'cargo build did not emit Tauri ACL and capability artifacts');
  const acl = JSON.parse(await readFile(artifact.manifest, 'utf8'));
  const capabilities = JSON.parse(await readFile(artifact.capabilities, 'utf8'));
  const commands = [
    'desktop_control',
    'desktop_approve',
    'desktop_preferences',
    'desktop_supervision_status',
    'desktop_start_daemon',
    'desktop_quit_daemon',
    'desktop_open_secrets',
  ];
  for (const command of commands) {
    const permission = `allow-${command.replaceAll('_', '-')}`;
    assert.deepEqual(acl['__app-acl__'].permissions[permission]?.commands.allow, [command]);
    assert.ok(capabilities.settings.permissions.includes(permission));
  }
  assert.deepEqual(capabilities.secrets.permissions, [
    'allow-desktop-target-secret-create',
    'allow-desktop-target-secret-rotate',
    'allow-desktop-target-url-set',
    'allow-desktop-subscriber-token-create',
    'allow-desktop-subscriber-token-rotate',
    'allow-desktop-judge-key-set',
    'allow-desktop-judge-key-rotate',
    'allow-desktop-secrets-migrate',
  ]);
  assert.deepEqual(capabilities.settings.windows, ['settings']);

  // This is the compiled desktop artifact, not build.rs text: a handler omission must not be hidden by a matching
  // source declaration. Tauri retains the registered commands as native invoke names in the executable.
  const binary = join(target, 'debug', 'agentcomms-desktop');
  const nativeNames = spawnSync('strings', [binary], { encoding: 'utf8' });
  assert.equal(nativeNames.status, 0, `cannot inspect built desktop command registration: ${nativeNames.stderr}`);
  for (const command of commands) assert.ok(nativeNames.stdout.includes(command));
});
