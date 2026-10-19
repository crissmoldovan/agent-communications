// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TAURI = fileURLToPath(new URL('../../src-tauri/', import.meta.url));
const read = (path: string): string => readFileSync(`${TAURI}${path}`, 'utf8');

/** What Terminal's automation prompt says, on the first Approve in Terminal of a signed build. */
const USAGE = 'Agent Comms opens Terminal so you can approve a change there.';

/** One key's value in a plist, as text: the element after `<key>name</key>`, whatever it is. */
function plistValue(plist: string, key: string): string | null {
  const match = new RegExp(
    `<key>${key.replaceAll('.', '\\.')}</key>\\s*(<string>[^<]*</string>|<true\\s*/>|<false\\s*/>)`,
  ).exec(plist);
  return match?.[1] ?? null;
}

describe('the macOS bundle', () => {
  const config = JSON.parse(read('tauri.conf.json')) as {
    bundle: { macOS: { infoPlist?: string; entitlements?: string; hardenedRuntime?: boolean } };
  };
  const macOS = config.bundle.macOS;

  it('says in Info.plist why it drives Terminal, which a signed build needs before osascript may', () => {
    expect(macOS.infoPlist).toBe('Info.plist');
    const plist = read(macOS.infoPlist ?? 'Info.plist');
    expect(plist).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\r?\n<!DOCTYPE plist /);
    expect(plistValue(plist, 'NSAppleEventsUsageDescription')).toBe(`<string>${USAGE}</string>`);
  });

  it('is signed under the hardened runtime with the Apple Events entitlement, and no other', () => {
    expect(macOS.hardenedRuntime).toBe(true);
    expect(macOS.entitlements).toBe('Entitlements.plist');
    const plist = read(macOS.entitlements ?? 'Entitlements.plist');
    expect(plistValue(plist, 'com.apple.security.automation.apple-events')).toBe('<true/>');
    // The only entitlement: the app asks for nothing else the hardened runtime would refuse it.
    expect(Array.from(plist.matchAll(/<key>([^<]+)<\/key>/g), (match) => match[1])).toEqual([
      'com.apple.security.automation.apple-events',
    ]);
  });
});
