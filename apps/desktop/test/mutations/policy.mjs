import assert from 'node:assert/strict';
import { join } from 'node:path';

export function applicable(item, platform) {
  assert.ok(Array.isArray(item.platforms) && item.platforms.length > 0, 'missing mutation platform applicability');
  assert.ok(
    item.platforms.every((value) => ['darwin', 'linux', 'win32'].includes(value)),
    'invalid mutation platform',
  );
  if (item.platforms.length !== 3) assert.ok(item.platformReason, 'missing mutation platform reason');
  return item.platforms.includes(platform);
}

export function isolatedPaths(temp) {
  return {
    target: join(temp, '.mutation/target'),
    dist: join(temp, 'apps/desktop/dist'),
    home: join(temp, '.mutation/home'),
    evidence: join(temp, '.mutation/evidence'),
  };
}
