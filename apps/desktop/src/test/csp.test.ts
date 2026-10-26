// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepaintSource } from '../theme.ts';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(`${APP}${path}`, 'utf8');

/**
 * The twenty-two commands the app's Rust side answers, each granted as `allow-<name>`: Phase C's fourteen, the event
 * service's seven (desktop 0.27.0), and which build this is (0.32.0).
 */
const COMMANDS = [
  'installation',
  'cli',
  'open_in_terminal',
  'revoke_preview',
  'copy_text',
  'open_link',
  'open_profile',
  'get_settings',
  'set_folders',
  'set_login_item',
  'updater_state',
  'check_for_updates',
  'install_update',
  'take_deep_link',
  'event_service_state',
  'set_event_service',
  'event_service_retry',
  'restart_event_service',
  'answer_first_start',
  'open_full_disk_access',
  'answer_quit',
  'app_build',
];

/** Phase C's no-egress policy, with the one inline script — the pre-paint script — pinned by its hash (DA7, DA14). */
function expectedPolicy(hash: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    'connect-src ipc: http://ipc.localhost',
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

describe('the content policy', () => {
  it("the content policy is phase C's with the pre-paint script pinned by its hash", () => {
    const hash = createHash('sha256').update(prepaintSource(), 'utf8').digest('base64');
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    const security = config.app.security;
    expect(security.csp).toBe(expectedPolicy(hash));
    expect(security.devCsp).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'sha256-${hash}' 'unsafe-inline'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        'connect-src ipc: http://ipc.localhost ws://localhost:1420',
        "frame-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
      ].join('; '),
    );
    expect(security.dangerousDisableAssetCspModification).toBe(false);
    // Nothing is loaded from anywhere but the app itself: the policy names no host but Tauri's IPC.
    expect(security.csp).not.toMatch(/https?:\/\/(?!ipc\.localhost)/);
  });

  it('the hash pinned is the pre-paint script that opens on soft (0.28.0), not the one before it', () => {
    const source = prepaintSource();
    expect(source).toContain('var T=["soft","cue","terminal"]');
    const hash = createHash('sha256').update(source, 'utf8').digest('base64');
    const security = JSON.parse(read('src-tauri/tauri.conf.json')).app.security;
    for (const policy of [security.csp, security.devCsp]) {
      const pinned = [...String(policy).matchAll(/'sha256-([^']+)'/g)].map((match) => match[1]);
      expect(pinned).toEqual([hash]);
    }
    // The script 0.27 pinned registered cue and terminal and opened on cue.
    expect(hash).not.toBe('wLkmBKemGb0dgFM5hke0n98F0sY24defqs04ByLzfv8=');
  });

  it('index.html carries no inline script of its own', () => {
    const html = read('index.html');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const [, attributes = '', body = ''] = scripts[0] ?? [];
    expect(attributes).toMatch(/\btype="module"/);
    expect(attributes).toMatch(/\bsrc="\/src\/main\.tsx"/);
    expect(body.trim()).toBe('');
    expect(html).toMatch(/<title>Agent Comms<\/title>/);
    expect(html).toMatch(/<div id="root"><\/div>/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('capabilities grant only events, dragging and the twenty-two commands', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
    expect(capability.windows).toEqual(['main']);
    expect([...capability.permissions].sort()).toEqual(
      [
        'core:event:allow-listen',
        'core:event:allow-unlisten',
        'core:window:allow-start-dragging',
        'core:window:allow-internal-toggle-maximize',
        ...COMMANDS.map((name) => `allow-${name.replaceAll('_', '-')}`),
      ].sort(),
    );
    expect(Object.keys(capability).sort()).toEqual(['$schema', 'description', 'identifier', 'permissions', 'windows']);
  });
});
