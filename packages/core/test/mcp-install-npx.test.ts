import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { type McpProduct, mcpInstall } from '../src/mcp-install.ts';
import { tempDir } from './helpers/temp.ts';

/**
 * The `npx` entry keeps `mcp` exactly when the package `npx` runs is the whole CLI.
 *
 * Gmail's `@agentcomms/gmail-mcp` starts the server as its bin, so `mcp` there would be read as an argument. Slack's
 * `@agentcomms/slack` is the CLI, and the entry without `mcp` ran it: `unknown option '--workspace'`, exit 64, in a
 * client config already written. One rule served both, and it was right for one of them.
 *
 * `--client json` with `apply: false` and `noVerify` writes nothing and starts nothing. HOME is a scratch directory
 * because the installer reads every client's config there to list what else is registered.
 */
function product(runsCli: boolean | undefined): McpProduct {
  return {
    packageName: '@agentcomms/example',
    binary: 'agent-example',
    defaultServerName: 'example',
    npxPackage: runsCli ? '@agentcomms/example' : '@agentcomms/example-mcp',
    ...(runsCli === undefined ? {} : { npxArgs: runsCli ? ['mcp'] : [] }),
    version: '9.9.9',
    moduleUrl: import.meta.url,
    serverArgs: () => ['--pin', 'acme'],
  };
}

async function npxArgs(runsCli: boolean | undefined): Promise<string[]> {
  const home = tempDir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
  };
  // The scanner follows these to where codex and Claude Code keep their real configs; this test reads neither.
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const context = { env, core: { paths: { dataDir: join(home, 'data'), configDir: join(home, 'config') } } };
  const result = await mcpInstall(context, product(runsCli), {
    client: 'json',
    launcher: 'npx',
    apply: false,
    noVerify: true,
  });
  assert.equal(result.applied, false);
  return result.entry.args;
}

test('a CLI package run through npx is told to start the server', async () => {
  assert.deepEqual(await npxArgs(true), ['-y', '@agentcomms/example@9.9.9', 'mcp', '--pin', 'acme']);
});

test('a server-only package run through npx is not handed `mcp` as an argument', async () => {
  assert.deepEqual(await npxArgs(false), ['-y', '@agentcomms/example-mcp@9.9.9', '--pin', 'acme']);
  assert.deepEqual(await npxArgs(undefined), ['-y', '@agentcomms/example-mcp@9.9.9', '--pin', 'acme']);
});
