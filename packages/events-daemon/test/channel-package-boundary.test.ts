import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as WhatsApp from '@agentcomms/whatsapp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHANNELS = ['slack', 'resend', 'whatsapp'] as const;

test('D7: Phase-D channel packages remain one-way dependencies of the event daemon', async () => {
  for (const channel of CHANNELS) {
    const [manifestText, events] = await Promise.all([
      readFile(join(ROOT, 'packages', channel, 'package.json'), 'utf8'),
      readFile(join(ROOT, 'packages', channel, 'src', 'operations', 'events.ts'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    assert.equal(declared['@agentcomms/events-daemon'], undefined, `${channel} cannot declare the daemon`);
    assert.doesNotMatch(events, /@agentcomms\/events-daemon/u, `${channel} event operations cannot import the daemon`);
  }

  const daemon = JSON.parse(await readFile(join(ROOT, 'packages/events-daemon/package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  for (const channel of CHANNELS)
    assert.equal(
      daemon.dependencies[`@agentcomms/${channel}`],
      'workspace:*',
      `the daemon owns its ${channel} dependency`,
    );
});

test('D1: the WhatsApp package root exposes no list-writing handle to the event owner', () => {
  const writer = Object.entries(WhatsApp).find(([, value]) => {
    if (typeof value !== 'function') return false;
    const prototype = (value as { prototype?: { update?: unknown; forget?: unknown } }).prototype;
    return typeof prototype?.update === 'function' || typeof prototype?.forget === 'function';
  });
  assert.equal(writer, undefined, 'event ownership receives only the read-only event operation capability');
});
