import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const forbidden =
  /node:|node::Start|node_module_register|OrtGetApiBase|onnxruntime|onnx\.ModelProto|model-container|@agentcomms\/events-daemon|events-laya-runtime|new\s+(?:Shared)?Worker\s*\(/i;
// In source bytes, an ordinary {node: value} property is not a runtime import. Quoted Node
// module specifiers and native runtime signatures remain forbidden; graph edges use the stricter rule above.
const forbiddenBytes = new RegExp(`["']node:[a-z0-9_/-]+["']|${forbidden.source.replace(/^node:\|/, '')}`, 'gi');

// ONNX has no magic header. Recognize protobuf ModelProto metadata (IR, GraphProto and opsets),
// including varint and length-delimited fields, without trusting the extension or producer name.
function onnxMetadata(bytes) {
  let offset = 0;
  const fields = new Map();
  function varint() {
    let value = 0;
    let factor = 1;
    for (let index = 0; index < 10 && offset < bytes.length; index++) {
      const byte = bytes[offset++];
      value += (byte & 127) * factor;
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    throw new Error('invalid protobuf');
  }
  try {
    while (offset < bytes.length) {
      const tag = varint();
      const wire = tag % 8;
      const field = Math.floor(tag / 8);
      if (!field) return false;
      fields.set(field, wire);
      if (wire === 0) varint();
      else if (wire === 1) offset += 8;
      else if (wire === 2) {
        const length = varint();
        offset += length;
      } else if (wire === 5) offset += 4;
      else return false;
      if (offset > bytes.length) return false;
    }
    return fields.get(1) === 0 && fields.get(7) === 2 && fields.get(8) === 2;
  } catch {
    return false;
  }
}

export function inspectContent(bytes) {
  const contentMarkers = [...bytes.toString('latin1').matchAll(forbiddenBytes)].map((match) => match[0]);
  const magic = bytes.subarray(0, 4).toString('latin1');
  if (onnxMetadata(bytes) || ['GGUF', 'GGML', 'TFL3'].includes(magic) || bytes.subarray(4, 8).toString() === 'TFL3')
    contentMarkers.push('model-container');
  // safetensors: little-endian header length followed by tensor dtype/shape/data_offsets metadata.
  if (bytes.length >= 10) {
    const length = bytes.readBigUInt64LE(0);
    if (length > 1n && length <= BigInt(bytes.length - 8)) {
      try {
        const header = JSON.parse(bytes.subarray(8, 8 + Number(length)).toString());
        if (
          Object.values(header).some(
            (entry) => entry?.dtype && Array.isArray(entry.shape) && Array.isArray(entry.data_offsets),
          )
        )
          contentMarkers.push('model-container');
      } catch {
        /* Not a safetensors header. */
      }
    }
  }
  return { sha256: digest(bytes), size: bytes.length, type: 'data', contentMarkers };
}

export function cargoPlatforms(target) {
  return target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target];
}

export function validateBinding(binding, artifacts) {
  assert.equal(binding.version, 1, 'unsupported artifact binding');
  assert.ok(binding.buildId && binding.buildId === binding.vite.buildId, 'frontend build identity mismatch');
  assert.deepEqual(binding.artifacts, artifacts, 'packaged artifact digest mismatch');
  auditViteAssets(binding.vite.assets);
}

function auditViteAssets(assets) {
  assert.ok(Array.isArray(assets) && assets.length > 0, 'missing embedded Vite asset evidence');
  for (const asset of assets) {
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size >= 0, 'missing Vite content size');
    assert.equal(asset.type, 'data', 'missing Vite content classification');
    assert.ok(Array.isArray(asset.contentMarkers), 'missing Vite content classification');
    assert.ok(!forbidden.test(asset.contentMarkers.join(' ')), `forbidden embedded Vite content: ${asset.path}`);
  }
}

// Reinspect the complete output after all Vite hooks. A late change, missing/public asset or forged
// classification cannot be bound to a package merely because generateBundle saw an earlier payload.
export async function validateFrontendAssets(vite, folder) {
  auditViteAssets(vite.assets);
  const actual = (await artifactInventory(folder)).filter((entry) => entry.path !== 'desktop-build-graph.json');
  const expected = vite.assets
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    actual.sort((a, b) => a.path.localeCompare(b.path)),
    expected,
    'final Vite asset inventory mismatch',
  );
  for (const asset of vite.assets) {
    const { path, ...metadata } = asset;
    assert.deepEqual(
      inspectContent(await readFile(join(folder, path))),
      metadata,
      'final Vite content classification mismatch',
    );
  }
}

export async function artifactInventory(folder) {
  const result = [];
  async function walk(path, relative = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(!entry.isSymbolicLink(), 'artifact symlink must be reviewed');
      const name = `${relative}${entry.name}`;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
      else result.push({ path: name, sha256: digest(await readFile(join(path, entry.name))) });
    }
  }
  await walk(folder);
  assert.ok(result.length, 'empty packaged artifact inventory');
  return result;
}

export function bundleGraphPlugin() {
  return {
    name: 'desktop-content-provenance',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const modules = [...this.getModuleIds()].map((id) => {
        const info = this.getModuleInfo(id);
        const portable = (value) =>
          value.replaceAll('\\', '/').replaceAll(resolve(desktop, '../..').replaceAll('\\', '/'), '<workspace>');
        return { id: portable(id), imports: [...info.importedIds, ...info.dynamicallyImportedIds].map(portable) };
      });
      const assets = Object.values(bundle).map((entry) => ({
        path: entry.fileName,
        ...inspectContent(Buffer.from(entry.type === 'chunk' ? entry.code : entry.source)),
      }));
      this.emitFile({
        type: 'asset',
        fileName: 'desktop-build-graph.json',
        source: JSON.stringify({ buildId: process.env.DESKTOP_BUILD_ID, modules, assets }),
      });
    },
  };
}

export function auditBundle(evidence) {
  assert.equal(evidence.version, 1);
  assert.ok(evidence.files.length, 'empty bundle evidence');
  assert.ok(
    evidence.graph.cargo.length && evidence.graph.pnpm.length && evidence.graph.vite.length,
    'missing resolved dependency graph',
  );
  auditViteAssets(evidence.graph.viteAssets);
  for (const file of evidence.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(file.size > 0);
    assert.ok(
      ['tauri-executable', 'tauri-metadata', 'tauri-icon', 'declared-license', 'vite-asset'].includes(file.provenance),
      `undeclared bundle file: ${file.path}`,
    );
    assert.ok(
      !forbidden.test(`${file.type} ${(file.contentMarkers ?? []).join(' ')}`),
      `forbidden bundle content: ${file.path}`,
    );
    assert.ok(
      !file.executable || ['tauri-executable', 'tauri-metadata'].includes(file.provenance),
      `undeclared executable: ${file.path}`,
    );
  }
  for (const node of evidence.graph.vite)
    assert.ok(!forbidden.test(JSON.stringify(node)), 'forbidden Vite dependency edge');
  for (const node of [...evidence.graph.cargo, ...evidence.graph.pnpm])
    assert.ok(
      !forbidden.test(JSON.stringify(node)) &&
        ![node.name, ...(node.dependencies ?? [])].some((edge) =>
          /^(?:node)(?:@|$)/i.test(typeof edge === 'string' ? edge : edge.name),
        ),
      'forbidden resolved runtime dependency',
    );
  assert.deepEqual(evidence.graph.tauri.resources, ['../THIRD_PARTY_LICENSES']);
  assert.equal(evidence.graph.tauri.externalBin, undefined);
}

function command(binary, args, cwd = desktop) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  assert.equal(
    result.status,
    0,
    `bundle evidence command unavailable: ${binary} (${result.error?.code ?? result.status})`,
  );
  return result.stdout;
}

export async function buildEvidence() {
  const host = command('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1];
  assert.ok(host, 'missing Rust target provenance');
  const config = JSON.parse(await readFile(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
  const target = resolve(process.env.CARGO_TARGET_DIR ?? join(desktop, 'src-tauri/target'));
  const bundle = join(target, 'release/bundle');
  const binding = JSON.parse(await readFile(join(target, 'release/desktop-artifact-evidence.json'), 'utf8'));
  validateBinding(binding, await artifactInventory(bundle));
  const vite = binding.vite;
  const platforms = cargoPlatforms(process.env.DESKTOP_BUNDLE_PLATFORM ?? host);
  assert.deepEqual(binding.platforms, platforms, 'artifact target metadata mismatch');
  const cargo = platforms.flatMap((platform) => {
    const metadata = JSON.parse(
      command('cargo', [
        'metadata',
        '--offline',
        '--locked',
        '--filter-platform',
        platform,
        '--format-version',
        '1',
        '--manifest-path',
        'src-tauri/Cargo.toml',
      ]),
    );
    const resolvedIds = new Set(metadata.resolve.nodes.map((node) => node.id));
    return metadata.packages
      .filter((node) => resolvedIds.has(node.id))
      .map(({ id, name, version, source, checksum }) => ({
        name,
        platform,
        version,
        source,
        checksum,
        dependencies: metadata.resolve.nodes
          .find((node) => node.id === id)
          .dependencies.map((dependency) => {
            const resolved = metadata.packages.find((node) => node.id === dependency);
            assert.ok(resolved, 'unresolved Cargo edge');
            return `${resolved.name}@${resolved.version}`;
          }),
      }));
  });
  const pnpm = [];
  const visited = new Set();
  const collect = async (directory, includePeers = true) => {
    if (visited.has(directory)) return;
    visited.add(directory);
    const entry = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const names = Object.keys({ ...entry.dependencies, ...(includePeers ? entry.peerDependencies : {}) }).sort();
    pnpm.push({ name: entry.name, version: entry.version, dependencies: names });
    for (const name of names) {
      let current = directory;
      let found;
      for (;;) {
        try {
          found = await realpath(join(current, 'node_modules', name));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (dirname(current) === current) break;
        current = dirname(current);
      }
      if (!found && entry.peerDependenciesMeta?.[name]?.optional) continue;
      assert.ok(found, `unresolved installed pnpm edge: ${name}`);
      await collect(found);
    }
  };
  await collect(desktop, false);
  let folder;
  let extracted;
  try {
    if (process.platform === 'darwin') folder = join(bundle, 'macos/Agent Communications.app');
    else {
      const kind = process.platform === 'win32' ? 'nsis' : 'deb';
      const candidates = (await readdir(join(bundle, kind))).filter((name) =>
        name.endsWith(kind === 'nsis' ? '.exe' : '.deb'),
      );
      assert.equal(candidates.length, 1, 'ambiguous release payload');
      extracted = await mkdtemp(join(tmpdir(), 'desktop-content-'));
      const artifact = join(bundle, kind, candidates[0]);
      if (kind === 'deb') command('dpkg-deb', ['--extract', artifact, extracted]);
      else command('7z', ['x', '-y', `-o${extracted}`, artifact]);
      folder = extracted;
    }
    const files = [];
    const licenseHash = digest(await readFile(join(desktop, 'THIRD_PARTY_LICENSES')));
    const iconHashes = new Set(
      await Promise.all(
        (await readdir(join(desktop, 'src-tauri/icons')))
          .filter((name) => /\.(?:png|ico|icns)$/.test(name))
          .map(async (name) => digest(await readFile(join(desktop, 'src-tauri/icons', name)))),
      ),
    );
    async function walk(path, relative = '') {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        const name = `${relative}${entry.name}`;
        const stat = await lstat(full);
        assert.ok(!stat.isSymbolicLink(), 'bundle symlink must be reviewed');
        if (stat.isDirectory()) {
          await walk(full, `${name}/`);
          continue;
        }
        const bytes = await readFile(full);
        const executable =
          (stat.mode & 0o111) !== 0 ||
          bytes.subarray(0, 2).toString() === 'MZ' ||
          bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
        const base = basename(name);
        const provenance = /^agentcomms-desktop(?:\.exe)?$/.test(base)
          ? 'tauri-executable'
          : base === 'THIRD_PARTY_LICENSES' && digest(bytes) === licenseHash
            ? 'declared-license'
            : /^(?:Info\.plist|PkgInfo|CodeResources|.*\.desktop)$/.test(base)
              ? 'tauri-metadata'
              : iconHashes.has(digest(bytes))
                ? 'tauri-icon'
                : vite.assets.some((asset) => asset.sha256 === digest(bytes))
                  ? 'vite-asset'
                  : 'undeclared';
        const contentMarkers = provenance === 'declared-license' ? [] : inspectContent(bytes).contentMarkers;
        files.push({
          path: name,
          sha256: digest(bytes),
          size: bytes.length,
          executable,
          type: executable ? 'executable' : 'data',
          provenance,
          contentMarkers,
        });
      }
    }
    await walk(folder);
    return {
      version: 1,
      files,
      graph: { cargo, pnpm, vite: vite.modules, viteAssets: vite.assets, tauri: config.bundle },
      lockDigests: {
        cargo: digest(await readFile(join(desktop, 'src-tauri/Cargo.lock'))),
        pnpm: digest(await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url))),
      },
    };
  } finally {
    if (extracted) await rm(extracted, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditBundle(await buildEvidence());
  process.stdout.write('desktop bundle content and dependency graph: OK\n');
}
