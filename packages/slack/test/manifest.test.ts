import assert from 'node:assert/strict';
import { test } from 'node:test';
import { methodRule, scopesFor, writeMethods } from '../src/api/methods.ts';
import { buildManifest, NEVER_REQUESTED, READ_SCOPES, renderManifest, scopesForMode } from '../src/manifest.ts';

/**
 * The manifests are the install. Whatever they ask for is what the token can do for as long as the workspace is
 * connected, and changing them later forces everybody to re-authorise — so the tests here are about what is in
 * them and, more importantly, what is not.
 */

test('read mode asks for reading, and nothing that can post', () => {
  const manifest = buildManifest('read', 'http://localhost:3000/slack');
  const scopes = manifest.oauth_config.scopes.user;

  assert.deepEqual(scopes, [...READ_SCOPES].sort(), 'read mode is exactly the read scopes');
  // D1 claims Slack itself enforces "cannot post" in read mode. That is only true if no write scope is here.
  for (const scope of scopesFor(['write', 'prepare'])) {
    assert.equal(scopes.includes(scope), false, `read mode asked for ${scope}, so Slack would allow posting`);
  }
});

test('send mode is read plus exactly what the write methods need', () => {
  const send = scopesForMode('send');
  const extra = send.filter((scope) => !READ_SCOPES.includes(scope));

  // Taken from the registry rather than written out here, so a posting method added without its scope fails
  // this rather than failing at runtime against a token that cannot do it.
  assert.deepEqual(extra, ['chat:write', 'files:write', 'reactions:write']);
  for (const scope of READ_SCOPES) assert.ok(send.includes(scope), `send mode dropped ${scope}`);

  // Every method the transport may call to post is enabled by something in this manifest.
  for (const method of writeMethods()) {
    const needed = methodRule(method)?.requiredScopes ?? [];
    assert.ok(
      needed.some((scope) => send.includes(scope)),
      `${method} is a write the send manifest does not enable: needs one of ${needed.join(', ')}`,
    );
  }
});

test('neither manifest asks for the scopes the design refused', () => {
  /*
   * D2 enumerated four ways to put a message in front of people. Two are behind the gate. `incoming-webhook`
   * posts with no `chat:write` anywhere and `im:write` mutates the person's read state — both are simply never
   * requested, because a scope that is never granted is a door no bug in this package can open.
   *
   * `team:read` is here for a different reason: it was dropped when `team.info` was, since `auth.test` returns
   * the workspace id and name without any scope at all.
   */
  for (const mode of ['read', 'send'] as const) {
    const scopes = scopesForMode(mode);
    for (const refused of NEVER_REQUESTED) {
      assert.equal(scopes.includes(refused), false, `${mode} mode asked for ${refused}`);
    }
    // Nothing admin-shaped, whatever it is called.
    assert.deepEqual(
      scopes.filter((scope) => scope.startsWith('admin')),
      [],
      `${mode} mode asked for an admin scope`,
    );
  }
});

test('the manifest carries only settings keys the research verified', () => {
  /*
   * A key Slack does not recognise is silently ignored, which would produce an app that looks configured and is
   * not. The manifest reference the research read documents `org_deploy_enabled`, `socket_mode_enabled` and
   * `token_rotation_enabled`; it documents no PKCE flag, so none is invented here.
   */
  const { settings } = buildManifest('send', 'http://localhost:3000/slack');
  assert.deepEqual(Object.keys(settings).sort(), [
    'org_deploy_enabled',
    'socket_mode_enabled',
    'token_rotation_enabled',
  ]);
  assert.equal(settings.token_rotation_enabled, true, 'rotation off would make the 30-day handling dead code');
  assert.equal(settings.socket_mode_enabled, false, 'D13: nothing in v1 subscribes to events');
  /*
   * Org-wide deployment is a different install with a different blast radius: the app lands across every
   * workspace in an Enterprise Grid org rather than the one person's. Nothing here is designed for that — the
   * account model is one workspace and one user — and the key was asserted to exist without anyone checking
   * which way it pointed.
   */
  assert.equal(settings.org_deploy_enabled, false, 'this would install the app across an entire Grid org');
});

test('only user scopes are requested, never bot scopes', () => {
  // Two reasons, and either alone would be enough: only a user token reaches the person's DMs and unjoined
  // public channels, and Slack says "desktop redirects are not allowed to request bot scopes" — which is the
  // redirect this package uses.
  const manifest = buildManifest('send', 'http://localhost:3000/slack');
  assert.deepEqual(Object.keys(manifest.oauth_config.scopes), ['user']);
});

test('the redirect url is whatever the caller says, and it is the only one', () => {
  // Slack matches redirect URLs exactly, so a second one left in the manifest is a second door.
  const manifest = buildManifest('read', 'http://localhost:51234/slack/callback');
  assert.deepEqual(manifest.oauth_config.redirect_urls, ['http://localhost:51234/slack/callback']);
});

test('what a person pastes is valid JSON, and round-trips', () => {
  const text = renderManifest('read', 'http://localhost:3000/slack');
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(text), buildManifest('read', 'http://localhost:3000/slack'));
});
