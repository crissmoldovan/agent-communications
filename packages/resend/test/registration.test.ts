import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES, managedRuntimeDir } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tarballOf } from '../../core/test/helpers/provenance-fixture.ts';
import { VERSION } from '../src/version.ts';
import { assertNoBareCommand, resendInline } from './support/handoffs.ts';
import { type Captured, type Harness, newHarness, tempDir } from './support/harness.ts';

/*
 * Registering the Resend server, end to end, with the generic `account` pin (design 2026-09-26 §6) — the pin every
 * channel after Gmail and Slack is narrowed by, which nothing had registered for real before this package.
 *
 * `agent-resend mcp install` and the core server's `comms_server_install` are one change (`serverInstallChange`), so
 * an approval prepared on one surface is claimed on the other. The pin is written as `--account`, `--force` keeps it,
 * and `comms_update` registers the entry again at a newer release with exactly that pin.
 *
 * Nothing here reaches npm, Resend, a real client config or the keychain: every client config is under a temporary
 * home, `npx` is only named in entries nothing starts (`--no-verify`), the registry `comms_update` reads is a loopback
 * stand-in, and npm's global prefix is a temporary directory.
 */

const LATEST = '99.0.0';

interface Machine {
  harness: Harness;
  home: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A harness with one account, and a home of its own for the client configs — Windows' too, which are found through
 * `APPDATA` — with a `PATH` that holds nothing a registration could start.
 */
async function machine(): Promise<Machine> {
  const harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend' });
  const home = tempDir();
  const bin = join(home, 'bin');
  await mkdir(bin);
  return {
    harness,
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      PATH: bin,
      npm_config_offline: 'true',
    },
  };
}

/** The approval id a command that stopped for approval handed back, its preview and its hint. */
function pending(ran: Captured): { approvalId: string; preview: string; hint: string } {
  assert.equal(ran.code, EXIT_CODES.APPROVAL, `${ran.stdout}${ran.stderr}`);
  const error = ran.json().error;
  assert.equal(error?.code, 'APPROVAL_PENDING', ran.stdout);
  return {
    approvalId: String(error?.details?.approvalId),
    preview: String(error?.details?.preview),
    hint: String(error?.hint),
  };
}

/** The CLI as an agent runs it: no terminal, so a change waiting for a person comes back with its id. */
const cli = (m: Machine, argv: string[]) => m.harness.cli(['--json', ...argv], { env: m.env });

/** A registry on the loopback address that names `LATEST` as every package's latest release. */
async function registry(): Promise<{ url: string; asked: string[]; close(): Promise<void> }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url ?? '').slice(1);
    asked.push(`/${name}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    // The release's tarball integrity, the one the provenance fixture's attestations sign: what an update verifies.
    response.end(
      JSON.stringify({
        'dist-tags': { latest: LATEST },
        versions: { [LATEST]: { dist: { integrity: tarballOf(name, LATEST) } } },
      }),
    );
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    asked,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

/**
 * The core MCP server, started as a client starts it — `agentcomms mcp`, from the core this package is built against
 * — over stdio, with this harness's configuration and home. Its environment is pinned whole, so nothing of the
 * machine running the tests reaches it: `PATH` holds only `ps`, which `prune` needs.
 */
async function coreServer(m: Machine, extra: Record<string, string> = {}, verified = false) {
  // An update verifies every release it registers, and a built server reads npm's attestations and Sigstore's root,
  // which no test may reach: one that updates is core's own server, started with the test's verifier.
  const coreCli = verified
    ? fileURLToPath(new URL('../../core/test/fixtures/verified-core-server.ts', import.meta.url))
    : join(dirname(fileURLToPath(import.meta.resolve('@agentcomms/core'))), 'cli.mjs');
  const bin = tempDir();
  const ps = ['/bin/ps', '/usr/bin/ps'].find((path) => existsSync(path));
  if (ps) symlinkSync(ps, join(bin, 'ps'));
  const serverEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...m.harness.env,
    ...m.env,
    PATH: bin,
    AGENT_COMMS_DATA_DIR: m.harness.core.paths.dataDir,
    ...extra,
  })) {
    if (value !== undefined) serverEnv[key] = value;
  }
  const client = new Client({ name: 'registration-test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: verified
        ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', coreCli]
        : [coreCli, 'mcp'],
      env: serverEnv,
      stderr: 'ignore',
    }),
  );
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      },
    close: () => client.close(),
  };
}

const body = (preview: string) => preview.split('\n').slice(1).join('\n');

async function cursorEntry(m: Machine, name = 'resend'): Promise<{ command: string; args: string[] } | undefined> {
  const file = join(m.home, '.cursor', 'mcp.json');
  if (!existsSync(file)) return undefined;
  return (
    JSON.parse(await readFile(file, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }
  ).mcpServers[name];
}

/** The four folder pins a registration is written with (CUE-403), in the order the installer writes them. */
function pinWords(paths: { configDir: string; stateDir: string; dataDir: string; secretsDir: string }): string[] {
  const { configDir, stateDir, dataDir, secretsDir } = paths;
  return ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir];
}

test('pinned with `account`: prepared by comms_server_install, written with --account, kept by --force and by update', async () => {
  const m = await machine();
  const npm = await registry();
  // npm's global packages are read from here, not from the machine running the tests.
  const prefix = tempDir();
  const server = await coreServer(m, { npm_config_registry: npm.url, npm_config_prefix: prefix });
  try {
    // ── Prepared in chat with the generic pin, claimed at the command line ──
    const fromChat = await server.call('comms_server_install', {
      channel: 'resend',
      client: 'cursor',
      account: 'acme/resend',
      launcher: 'npx',
      noVerify: true,
    });
    assert.equal(fromChat.isError, undefined, JSON.stringify(fromChat.structuredContent));
    const asked = fromChat.structuredContent as { approvalId: string; preview: string };
    assert.match(
      asked.preview,
      /registers the Resend MCP server with cursor as "resend", pinned to the account acme\/resend/,
    );
    const install = ['mcp', 'install', '--client', 'cursor', '--account', 'acme/resend', '--launcher', 'npx'];
    const fromCommand = pending(await cli(m, [...install, '--no-verify']));
    assert.equal(body(fromCommand.preview), body(asked.preview), 'the same words from either surface');
    // The command an agent is told to run again carries the pin: without it, it would ask for a wider server. It is
    // this installation's own, located, its folders pinned (CUE-403).
    assert.ok(
      fromCommand.hint.includes(
        resendInline(m.harness.core, [...install, '--no-verify', '--approval', fromCommand.approvalId]),
      ),
      fromCommand.hint,
    );
    assertNoBareCommand(fromCommand.hint);
    assert.equal(await cursorEntry(m), undefined, 'nothing is written while it is only asked');

    const claimed = await cli(m, [...install, '--no-verify', '--approval', asked.approvalId]);
    assert.equal(claimed.code, 0, claimed.stdout);
    assert.equal(claimed.json<{ applied: boolean }>().data?.applied, true);
    assert.deepEqual((await cursorEntry(m))?.args, [
      '-y',
      `@agentcomms/resend@${VERSION}`,
      ...pinWords(m.harness.core.paths),
      'mcp',
      '--account',
      'acme/resend',
    ]);

    // ── Registered again with --force and no pin named: the pin is kept, never widened ──
    const force = ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify', '--force'];
    const again = pending(await cli(m, force));
    assert.match(
      again.preview,
      /replacing its own earlier entry of that name, which served the account acme\/resend, and keeping --account acme\/resend/,
    );
    assert.doesNotMatch(again.preview, /not pinned/);
    const forced = await cli(m, [...force, '--approval', again.approvalId]);
    assert.equal(forced.code, 0, forced.stdout);
    assert.deepEqual((await cursorEntry(m))?.args.slice(-2), ['--account', 'acme/resend']);

    // ── A newer release: comms_update registers it again, pinned exactly as it was ──
    const check = await server.call('comms_update', { check: true });
    assert.equal(check.isError, undefined, JSON.stringify(check.structuredContent));
    const behind = (
      (check.structuredContent?.behind ?? []) as { kind: string; channel?: string; narrowing?: string[] }[]
    )
      .filter((item) => item.kind === 'registration')
      .map((item) => [item.channel, item.narrowing]);
    assert.deepEqual(behind, [['resend', ['--account', 'acme/resend']]]);
    assert.ok(npm.asked.includes('/@agentcomms/resend'), `the registry was asked about Resend: ${npm.asked}`);
    const updating = await coreServer(m, { npm_config_registry: npm.url, npm_config_prefix: prefix }, true);
    try {
      const update = await updating.call('comms_update', { noVerify: true });
      assert.equal(update.isError, undefined, JSON.stringify(update.structuredContent));
      const prepared = update.structuredContent as { approvalId: string; preview: string };
      assert.match(prepared.preview, /pinned to the account acme\/resend, as now/);
      assert.match(prepared.preview, new RegExp(`@agentcomms/resend@${LATEST.replaceAll('.', '\\.')} was verified`));
      const updated = await updating.call('comms_update', { noVerify: true, approvalId: prepared.approvalId });
      assert.equal(updated.isError, undefined, JSON.stringify(updated.structuredContent));
    } finally {
      await updating.close();
    }
    assert.deepEqual((await cursorEntry(m))?.args, [
      '-y',
      `@agentcomms/resend@${LATEST}`,
      ...pinWords(m.harness.core.paths),
      'mcp',
      '--account',
      'acme/resend',
    ]);
  } finally {
    await server.close();
    await npm.close();
    await m.harness.close();
  }
});

test('the pin is refused where it cannot mean one thing: an account not here, another channel’s option', async () => {
  const m = await machine();
  const server = await coreServer(m);
  try {
    const nobody = await server.call('comms_server_install', {
      channel: 'resend',
      client: 'cursor',
      account: 'nobody/resend',
      launcher: 'npx',
      noVerify: true,
    });
    assert.equal(nobody.isError, true);
    assert.match(JSON.stringify(nobody.structuredContent), /no account called \\"nobody\/resend\\"/);
    const slackOption = await server.call('comms_server_install', {
      channel: 'resend',
      client: 'cursor',
      workspace: 'acme/resend',
      launcher: 'npx',
      noVerify: true,
    });
    assert.equal(slackOption.isError, true);
    assert.match(JSON.stringify(slackOption.structuredContent), /`workspace` is an option of the Slack server/);

    const ran = await cli(m, ['mcp', 'install', '--client', 'cursor', '--account', 'nobody/resend', '--no-verify']);
    assert.equal(ran.code, EXIT_CODES.NOT_FOUND, ran.stdout);
    assert.deepEqual(await m.harness.core.approvals.list(), [], 'nobody was asked');
    assert.equal(await cursorEntry(m), undefined);
  } finally {
    await server.close();
    await m.harness.close();
  }
});

test('unpinned, the preview says it reaches every account; --print and --client json ask nobody', async () => {
  const m = await machine();
  try {
    const asked = pending(await cli(m, ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify']));
    assert.match(asked.preview, /not pinned: it reaches every account on this machine/);
    for (const argv of [
      ['mcp', 'install', '--client', 'cursor', '--launcher', 'npx', '--no-verify', '--print'],
      ['mcp', 'install', '--client', 'json', '--launcher', 'npx', '--account', 'acme/resend', '--no-verify'],
    ]) {
      const ran = await cli(m, argv);
      assert.equal(ran.code, 0, `${argv.join(' ')}: ${ran.stdout}`);
    }
    assert.equal((await m.harness.core.approvals.list()).length, 1, 'only the registration that writes asked');
    assert.equal(await cursorEntry(m), undefined);
  } finally {
    await m.harness.close();
  }
});

const NO_PS =
  process.platform === 'win32'
    ? { skip: 'no `ps` on Windows: prune keeps everything when it cannot list processes' }
    : {};

test(
  'an approval to prune from comms_server_prune is claimed by `agent-resend mcp prune --approval`',
  NO_PS,
  async () => {
    const m = await machine();
    const { dataDir } = m.harness.core.paths;
    const old = managedRuntimeDir(dataDir, '@agentcomms/resend', '0.0.1');
    await mkdir(join(old, 'node_modules', '@agentcomms', 'resend'), { recursive: true });
    await writeFile(join(old, 'package.json'), '{}');
    const server = await coreServer(m);
    try {
      const dry = await cli(m, ['mcp', 'prune', '--dry-run']);
      assert.equal(dry.code, 0, dry.stdout);
      assert.deepEqual(await m.harness.core.approvals.list(), [], 'a dry run asks nobody');
      const asked = await server.call('comms_server_prune', { channel: 'resend' });
      assert.equal(asked.isError, undefined, JSON.stringify(asked.structuredContent));
      const fromChat = asked.structuredContent as { approvalId: string; preview: string };
      assert.match(fromChat.preview, /deletes the unused Resend runtime 0\.0\.1/);
      assert.ok(existsSync(old), 'asking removed nothing');
      const claimed = await cli(m, ['mcp', 'prune', '--approval', fromChat.approvalId]);
      assert.equal(claimed.code, 0, claimed.stdout);
      assert.ok(!existsSync(old));
    } finally {
      await server.close();
      await m.harness.close();
    }
  },
);
