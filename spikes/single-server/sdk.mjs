/**
 * The MCP SDK exactly as `packages/core` installs it (2.3.1), loaded as ESM from core's own dependency folder, so the
 * spike needs no `package.json` of its own and cannot drift to another SDK version.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));

function packageRoot(name) {
  let dir = dirname(fromCore.resolve(name));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === name) return { dir, manifest };
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find the package root of ${name}`);
    dir = parent;
  }
}

async function importExport(name, subpath = '.') {
  const { dir, manifest } = packageRoot(name);
  const entry = manifest.exports[subpath];
  const target = typeof entry.import === 'string' ? entry.import : entry.import.default;
  return import(pathToFileURL(join(dir, target)).href);
}

export const SDK_VERSION = packageRoot('@modelcontextprotocol/server').manifest.version;
export const CLIENT_VERSION = packageRoot('@modelcontextprotocol/client').manifest.version;

export const server = await importExport('@modelcontextprotocol/server');
export const serverStdio = await importExport('@modelcontextprotocol/server', './stdio');
export const client = await importExport('@modelcontextprotocol/client');
export const clientStdio = await importExport('@modelcontextprotocol/client', './stdio');
export const { z } = await importExport('zod');

/** A Standard Schema that accepts anything unchanged: what a relay validates a forwarded result against. */
export const PASSTHROUGH = {
  '~standard': { version: 1, vendor: 'agentcomms-spike', validate: (value) => ({ value }) },
};
