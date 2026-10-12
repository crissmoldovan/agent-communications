import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Production pipe intake: ../../../packages/events-daemon/src/runtime/desktop-capability-pipe.ts

async function rejectKeyChannel(channel) {
  const moduleUrl = new URL('../../../packages/events-daemon/src/runtime/desktop-capability-pipe.ts', import.meta.url);
  const module = await import(moduleUrl);
  assert.equal(typeof module.readDesktopCapabilityPipe, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pipe-refusal-'));
  const file = join(directory, 'synthetic-key');
  try {
    await writeFile(file, 'synthetic-key-intake-only-padding', { mode: 0o600 });
    const env = { ...process.env, SECRET_PIPE_MODULE: moduleUrl.href };
    delete env.AGENTCOMMS_DESKTOP_CAPABILITY_FD;
    delete env.AGENTCOMMS_DESKTOP_CAPABILITY_KEY;
    delete env.AGENTCOMMS_DESKTOP_CAPABILITY_FILE;
    if (channel === 'env') env.AGENTCOMMS_DESKTOP_CAPABILITY_KEY = 'synthetic-key-intake-only-padding';
    if (channel === 'file') env.AGENTCOMMS_DESKTOP_CAPABILITY_FILE = file;
    const script =
      "const {readDesktopCapabilityPipe}=await import(process.env.SECRET_PIPE_MODULE); const value=readDesktopCapabilityPipe(); process.stdout.write(value===undefined?'refused':'accepted'); value?.fill(0);";
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        script,
        '--',
        ...(channel === 'argv' ? ['--desktop-capability-key', 'synthetic-key-intake-only-padding'] : []),
      ],
      { env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, 'pipe intake child failed');
    assert.equal(result.stdout, 'refused');
    assert.throws(() => module.readDesktopCapabilityPipe({ AGENTCOMMS_DESKTOP_CAPABILITY_FD: '0' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// desktop-mutation: desktop-secret-key-argv
test('secret-capability: key intake refuses argv material', () => rejectKeyChannel('argv'));
// desktop-mutation: desktop-secret-key-env
test('secret-capability: key intake refuses env material', () => rejectKeyChannel('env'));
// desktop-mutation: desktop-secret-key-file
test('secret-capability: key intake refuses file material', () => rejectKeyChannel('file'));
