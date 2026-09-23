// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as installed from '@agentcomms/core';
import {
  CommsError,
  ConfigStore,
  emptyConfig,
  messageDigest,
  migrateNames,
  NEW_CONFIG_VERSION,
  openCore,
  planNamesMigration,
  sanitizeHtmlToText,
  VERSION,
  wrapUntrusted,
} from '@agentcomms/core';

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(emptyConfig().defaults.sendPolicy, 'chat');
assert.equal(new CommsError('APPROVAL_REQUIRED', 'x').exitCode, 10);
const { text, report } = sanitizeHtmlToText('<p>Hi</p><div style="display:none">hidden</div>');
assert.equal(text, 'Hi');
assert.equal(report.hiddenElements, 1);
assert.match(wrapUntrusted('x', { field: 'body' }, 'b1'), /^<untrusted-content boundary="b1"/);
assert.equal(
  messageDigest({
    from: 'a@b.test',
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: 's',
    visibleText: 't',
    attachments: [],
  }).length,
  64,
);
assert.equal(openCore().paths.configDir, process.env.AGENT_COMMS_CONFIG_DIR);

const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'agentcomms.cmd' : 'agentcomms');
const run = (...args) => execFileSync(bin, args, { encoding: 'utf8', shell: process.platform === 'win32' });
assert.equal(run('--version').trim(), VERSION);
const paths = JSON.parse(run('paths', '--json'));
assert.equal(paths.ok, true);
assert.equal(paths.data.configDir, process.env.AGENT_COMMS_CONFIG_DIR);
// This release writes version 2 — accounts named organisation/platform — checked against the installed package
// rather than the source. The switch core's own tests use is still not reachable from here: it exists so a release
// that only *reads* the format cannot be talked into writing it, and it must never become part of the API.
assert.equal('enableNamesMigrationForTests' in installed, false);
assert.equal('namesMigrationEnabled' in installed, false);
assert.equal(NEW_CONFIG_VERSION, 2);
assert.equal(emptyConfig().version, 2);
// And it can actually migrate a version-1 config — the thing this release exists to do, run from the package as
// installed rather than from the source tree.
const older = mkdtempSync(join(tmpdir(), 'agentcomms-consumer-'));
writeFileSync(
  join(older, 'config.json'),
  `${JSON.stringify({
    version: 1,
    inboxes: {
      work: {
        id: 'ibx_AAAAAAAAAAAAAAAA',
        provider: 'gmail',
        email: 'jo@example.test',
        identity: 'oidc',
        client: 'desktop',
        tier: 'read',
        secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
        createdAt: '2026-09-22T00:00:00.000Z',
      },
    },
  })}\n`,
);
const store = new ConfigStore(older);
const plan = planNamesMigration(await store.load());
assert.equal(plan.status, 'ready');
assert.equal((await migrateNames(store, plan)).status, 'migrated');
const migrated = JSON.parse(readFileSync(join(older, 'config.json'), 'utf8'));
assert.equal(migrated.version, 2);
assert.deepEqual(Object.keys(migrated.inboxes), ['work/gmail']);
assert.deepEqual(migrated.formerNames.inboxes.work, { name: 'work/gmail', id: 'ibx_AAAAAAAAAAAAAAAA' });

console.log('core consumer check: imports, sanitiser, digest, core wiring, the agentcomms bin and a real migration OK');
