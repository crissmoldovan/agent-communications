// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the packed Laya worker loads (E2 review round 1, B11): every module specifier of `entry` (the built worker,
 * below `dist`), and of every one of its own chunks it reaches, through `import … from`, `export … from`, a bare
 * `import "…"`, `import(…)` and `require(…)`. A Node built-in (`node:…`) is allowed and a relative chunk inside `dist/`
 * is read in turn; anything else — a package, or a path out of `dist/` — is refused. Returns the chunks read and the
 * refused specifiers, both sorted. The daemon's tests call it on planted builds; run as the consumer check, it reads
 * the installed build.
 */
export async function packedWorkerImports(dist, entry = 'laya-worker.mjs') {
  const chunks = new Set();
  const refused = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const chunk = pending.pop();
    if (chunks.has(chunk)) continue;
    chunks.add(chunk);
    const source = await readFile(join(dist, chunk), 'utf8');
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      const target = posix.normalize(posix.join(posix.dirname(chunk), specifier));
      if (/^\.\.?\//.test(specifier) && !target.startsWith('../') && !posix.isAbsolute(target)) pending.push(target);
      else refused.add(specifier);
    }
  }
  return { chunks: [...chunks].sort(), refused: [...refused].sort() };
}

// Run as the consumer check (scripts/verify-package.mjs), which requires its last line; imported by the daemon's tests,
// for the function above, it runs nothing.
const invoked = process.argv[1] === undefined ? '' : realpathSync(process.argv[1]);
if (invoked === realpathSync(fileURLToPath(import.meta.url))) await consumerCheck();

async function consumerCheck() {
  if (globalThis[Symbol.for('agentcomms.events.loopback-seal.preloaded.v1')] !== true) {
    throw new Error('the events-daemon consumer check requires the loopback seal preload');
  }

  const { status } = await import('@agentcomms/events-daemon');
  // B1-G: the event service refuses Windows. There the library and the CLI must say so; everything else runs below.
  const windows = process.platform === 'win32';
  const refusesWindows = /does not run on Windows/;
  if (windows) await assert.rejects(() => status(), refusesWindows);
  else assert.deepEqual(await status(), { owner: 'not-running' });
  const dist = dirname(fileURLToPath(import.meta.resolve('@agentcomms/events-daemon')));
  const packageRoot = join(dist, '..');
  const cli = join(dist, 'cli.mjs');
  const installed = JSON.parse(await readFile(join(dist, '..', 'package.json'), 'utf8'));

  // E2: the packed daemon carries Laya's three reviewed assets and its worker, and ships Laya held — the fail-closed
  // placeholder lock, byte for byte — with no Laya runtime, ONNX package or model anywhere in what the install brought.
  const PLACEHOLDER_LOCK = '{\n  "schemaVersion": 1,\n  "blocked": "E2_EXTERNAL_REFERENCE_BLOCKED"\n}\n';
  const LAYA_UNAVAILABLE = { kind: 'unavailable', code: 'E2_EXTERNAL_REFERENCE_BLOCKED', phase: 'E2' };
  for (const asset of ['laya-manifest.json', 'laya-runtime.json', 'laya-enablement-disclosures.json']) {
    await readFile(join(packageRoot, asset), 'utf8');
  }
  assert.equal(
    await readFile(join(packageRoot, 'laya-runtime.json'), 'utf8'),
    PLACEHOLDER_LOCK,
    'the packed daemon ships Laya held, behind the placeholder lock',
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(packageRoot, 'laya-manifest.json'), 'utf8')).promptTemplates,
    ['laya-noul-v1'],
    'the packed manifest offers exactly the binary template',
  );
  const worker = await packedWorkerImports(dist);
  assert.deepEqual(
    worker.refused,
    [],
    `the packed Laya worker loads only Node built-ins and its own chunks, through every chunk: ${worker.refused.join(', ')}`,
  );
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.equal(installed.scripts?.[hook], undefined, `the packed daemon has no ${hook} script`);
  for (const name of Object.keys({ ...installed.dependencies, ...installed.optionalDependencies }))
    assert.doesNotMatch(
      name,
      /laya|onnxruntime|@huggingface\/tokenizers/i,
      `the packed daemon does not depend on ${name}`,
    );

  /** Every package directory the install placed, nested ones included, by its package name. */
  async function installedPackages(modules) {
    const found = [];
    const entries = await readdir(modules, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const names = entry.name.startsWith('@')
        ? (await readdir(join(modules, entry.name), { withFileTypes: true }))
            .filter((child) => child.isDirectory())
            .map((child) => `${entry.name}/${child.name}`)
        : [entry.name];
      for (const name of names) {
        found.push(name);
        found.push(...(await installedPackages(join(modules, name, 'node_modules'))));
      }
    }
    return found;
  }

  /** Every file below a directory, as a path relative to it. */
  async function filesBelow(directory, prefix = '') {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) found.push(...(await filesBelow(join(directory, entry.name), path)));
      else found.push(path);
    }
    return found;
  }

  const consumerModules = join(process.cwd(), 'node_modules');
  const placed = await installedPackages(consumerModules);
  assert.ok(placed.includes('@agentcomms/events-daemon'), 'the consumer installed the packed daemon');
  const runtimeLike = placed.filter((name) =>
    /^@receptron\/|^onnxruntime|^@huggingface\/tokenizers$|^@agentcomms\/events-laya-runtime$/.test(name),
  );
  assert.deepEqual(runtimeLike, [], 'no Laya runtime or ONNX package is anywhere in the installed tree');
  const lockfile = JSON.parse(await readFile(join(process.cwd(), 'package-lock.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(lockfile.packages ?? {}).filter((path) =>
      /@receptron|onnxruntime|@huggingface\/tokenizers|laya-runtime/.test(path),
    ),
    [],
    'and none in what npm recorded installing',
  );
  assert.deepEqual(
    (await filesBelow(packageRoot)).filter((path) =>
      /\.onnx(?:\.data)?$|laya_config\.json$|^node_modules\//.test(path),
    ),
    [],
    'the packed daemon carries no model file and no bundled dependency tree',
  );

  // `--import` takes a module specifier: on Windows an absolute path reads as a URL scheme, so pass a file URL.
  const sealUrl = new URL('./loopback-seal-preload.mjs', import.meta.url).href;
  const help = execFileSync(process.execPath, ['--import', sealUrl, cli, '--help'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(help, /Usage: agent-events/);
  const cliVersion = execFileSync(process.execPath, ['--import', sealUrl, cli, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(cliVersion, `${installed.version}\n`, 'the packed daemon CLI reports the installed package version');
  const statusArgs = ['--import', sealUrl, cli, '--json', 'status'];
  if (windows)
    assert.throws(
      () => execFileSync(process.execPath, statusArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (error) => refusesWindows.test(`${error.stderr ?? ''}${error.stdout ?? ''}${error.message}`),
    );
  else {
    const result = execFileSync(process.execPath, statusArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result, '{"owner":"not-running"}\n');
  }

  function startMcp(command, args, env) {
    const child = spawn(process.execPath, ['--import', sealUrl, command, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter !== undefined) {
          pending.delete(message.id);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      }
    });
    return {
      request(method, params) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP request ${method} did not finish: ${stderr}`));
          }, 5_000);
          pending.set(id, { resolve, timeout });
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
      },
      notify(method, params) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      },
      async close() {
        child.stdin.end();
        const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5_000))]);
        if (code === null) {
          child.kill('SIGTERM');
          await exited.catch(() => undefined);
          throw new Error(`MCP process did not exit: ${stderr}`);
        }
        assert.equal(code, 0, stderr);
      },
    };
  }

  if (process.platform !== 'win32') {
    // `/tmp` stays short after macOS resolves its per-user temporary-directory symlink; the control socket has 103 bytes.
    const root = await mkdtemp(join('/tmp', 'events-daemon-consumer-'));
    const stateDir = join(root, 'state');
    const configDir = join(root, 'config');
    const dataDir = join(root, 'data');
    const env = {
      ...process.env,
      AGENT_COMMS_STATE_DIR: stateDir,
      AGENT_COMMS_CONFIG_DIR: configDir,
      // Pinned, so this check can see that Laya's artifact directory is never created.
      AGENT_COMMS_DATA_DIR: dataDir,
      AGENT_COMMS_UPDATE_CHECK: 'off',
      NO_COLOR: '1',
    };
    let stderr = '';
    const owner = spawn(process.execPath, ['--import', sealUrl, cli, '--state-dir', stateDir, 'run'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    owner.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise((resolve, reject) => {
      owner.once('error', reject);
      owner.once('exit', (code) => resolve(code));
    });
    const running = async () => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          const output = execFileSync(
            process.execPath,
            ['--import', sealUrl, cli, '--state-dir', stateDir, '--json', 'status'],
            {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              env,
            },
          );
          if (JSON.parse(output).owner === 'running') return;
        } catch {
          // The control socket appears only after the foreground owner has created its private state.
        }
        if (Date.now() >= deadline) throw new Error(`the foreground owner did not start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      await running();
      const mcp = startMcp(cli, ['--state-dir', stateDir, 'mcp'], env);
      try {
        const initialized = await mcp.request('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'packed-consumer', version: '0' },
        });
        assert.equal(initialized.result.protocolVersion, '2025-03-26');
        // The server names the version that is actually installed, read from that installed package's own manifest.
        assert.deepEqual(
          initialized.result.serverInfo,
          { name: 'agent-events', version: installed.version },
          'the packed daemon MCP server reports the installed package version',
        );
        mcp.notify('notifications/initialized', {});
        const status = await mcp.request('tools/call', { name: 'events_status', arguments: {} });
        assert.equal(status.result.structuredContent.owner, 'running');
        const tools = await mcp.request('tools/list', {});
        const names = tools.result.tools.map((tool) => tool.name);
        for (const expected of ['events_approval_view', 'events_rule_test', 'events_target_test', 'events_held_list'])
          assert.ok(names.includes(expected), `the packed daemon consumer exposes B3 paired tool ${expected}`);
        for (const forbidden of ['events_target_secret_create', 'events_target_resume', 'events_held_decide'])
          assert.ok(
            !names.includes(forbidden),
            `the packed daemon consumer keeps terminal-only B3 tool ${forbidden} absent`,
          );
      } finally {
        await mcp.close();
      }
      // Laya held, through the installed CLI against the installed owner: every way to turn it on names the reason.
      const daemonCli = (...args) =>
        JSON.parse(
          execFileSync(process.execPath, ['--import', sealUrl, cli, '--state-dir', stateDir, '--json', ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
          }),
        );
      assert.deepEqual(
        daemonCli('judge', 'kind', 'enable', 'laya'),
        LAYA_UNAVAILABLE,
        'judge kind enable laya is refused',
      );
      assert.deepEqual(
        daemonCli('judge', 'kinds', 'list').find((entry) => entry.kind === 'laya'),
        { kind: 'laya', state: 'unavailable', code: 'E2_EXTERNAL_REFERENCE_BLOCKED' },
        'judge kinds list shows Laya unavailable',
      );
      const model = daemonCli('judge', 'model', 'status');
      assert.deepEqual(
        { state: model.state, reason: model.reason, lock: model.runtimeLockDigest },
        { state: 'unavailable', reason: 'E2_EXTERNAL_REFERENCE_BLOCKED', lock: null },
        'judge model status says why',
      );
      const stopped = execFileSync(
        process.execPath,
        ['--import', sealUrl, cli, '--state-dir', stateDir, '--json', 'stop'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        },
      );
      assert.equal(stopped, '{"stopping":true}\n');
      assert.equal(await exited, 0, stderr);
      await assert.rejects(
        stat(join(dataDir, 'events', 'laya')),
        { code: 'ENOENT' },
        'no Laya runtime, model or directory was installed or created',
      );
    } finally {
      if (owner.exitCode === null) owner.kill('SIGTERM');
      await exited.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }

  console.log(
    'events-daemon consumer check: package import, Laya held with no runtime or model installed, foreground owner, local CLI and MCP control OK',
  );
}
