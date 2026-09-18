// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  CommsError,
  emptyConfig,
  messageDigest,
  openCore,
  sanitizeHtmlToText,
  VERSION,
  wrapUntrusted,
} from '@cloudpixel/comms-core';

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(emptyConfig().defaults.sendPolicy, 'chat');
assert.equal(new CommsError('APPROVAL_REQUIRED', 'x').exitCode, 10);
const { text, report } = sanitizeHtmlToText('<p>Hi</p><div style="display:none">hidden</div>');
assert.equal(text, 'Hi');
assert.equal(report.hiddenElements, 1);
assert.match(wrapUntrusted('x', { field: 'body' }, 'b1'), /^<untrusted-email-content boundary="b1"/);
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
console.log('comms-core consumer check: imports, sanitiser, digest, core wiring and the agentcomms bin OK');
