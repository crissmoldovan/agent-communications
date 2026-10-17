import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILE_DOWNLOAD, methodRule, scopesFor, writeMethods } from '../src/api/methods.ts';
import {
  BOT_SCOPES,
  botScopesForMode,
  buildAgentManifest,
  buildManifest,
  NEVER_REQUESTED,
  READ_SCOPES,
  renderAgentManifest,
  renderManifest,
  scopesForMode,
} from '../src/manifest.ts';

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

test('a workspace connected to read can download a file, and downloading asks for nothing more', () => {
  /*
   * A download is a read: it goes out in read mode and in send mode, with no approval. That is true only if the
   * scope Slack asks of the files host is one the read manifest already requests — taken from the rule rather than
   * written out here, so a download that came to need another scope fails this instead of failing at Slack.
   */
  const read = scopesForMode('read');
  const needed = FILE_DOWNLOAD.requiredScopes ?? [];
  assert.ok(needed.length > 0, 'the download rule records no scope, so nothing here checks one');
  for (const scope of needed) assert.ok(read.includes(scope), `read mode cannot download: it lacks ${scope}`);
  assert.deepEqual(scopesFor(['download']), ['files:read']);
  // And it adds nothing to either manifest: read mode is still exactly the read scopes.
  assert.deepEqual(
    buildManifest('read', 'http://localhost:3000/slack').oauth_config.scopes.user,
    [...READ_SCOPES].sort(),
  );
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
    const scopes = [...scopesForMode(mode), ...botScopesForMode(mode)];
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

test('the manifest turns PKCE on, because without it none of the rest works', () => {
  /*
   * This file once omitted the field and argued for omitting it: the research had found no PKCE key documented,
   * and inventing one Slack would silently ignore is worse than leaving it out. The research was incomplete.
   * Both the PKCE guide and the app manifest reference document `pkce_enabled` under `oauth_config`, and the
   * guide says what its absence costs — "If the app has never enabled PKCE, they will be treated like a server
   * redirect", which refuses the loopback this whole sign-in is built on.
   *
   * So the app this printed could not have completed a single sign-in, and nothing in the test suite noticed
   * because the suite only ever checked that the keys present were ones we meant to write.
   */
  for (const mode of ['read', 'send'] as const) {
    assert.equal(buildManifest(mode, 'http://localhost:3000/slack').oauth_config.pkce_enabled, true, mode);
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

test('the read app has no bot user and no bot scope, so no token it issues can post', () => {
  // D1's guarantee, unchanged by the agent label (design 2026-10-15 S1): on this machine, no stored token for a read
  // workspace can post. A bot user in the read manifest would be one.
  const manifest = buildManifest('read', 'http://localhost:3000/slack');
  assert.deepEqual(Object.keys(manifest.oauth_config.scopes), ['user']);
  assert.equal('features' in manifest, false, 'the read manifest declares a bot user');
  assert.deepEqual(botScopesForMode('read'), []);
});

test('the send app has a bot user with exactly the four posting scopes, and none that reads or uploads', () => {
  /*
   * S1: the app posts as itself, named after the person, so the `send` manifest adds a bot user and exactly these
   * four bot scopes — post, name each post, post in a public channel it has not joined, react. Nothing that reads
   * (`*:history`, `*:read`) or uploads (`files:write`): a bot token here reads nothing, and files go out as the
   * person. The user scopes are what they were.
   */
  const manifest = buildManifest('send', 'http://localhost:3000/slack');
  assert.deepEqual(manifest.oauth_config.scopes.bot, [
    'chat:write',
    'chat:write.customize',
    'chat:write.public',
    'reactions:write',
  ]);
  assert.deepEqual(BOT_SCOPES, manifest.oauth_config.scopes.bot);
  assert.deepEqual(botScopesForMode('send'), manifest.oauth_config.scopes.bot);
  assert.deepEqual(manifest.oauth_config.scopes.user, scopesForMode('send'));
  assert.ok(manifest.features?.bot_user, 'the send manifest has no bot user');
  assert.equal(typeof manifest.features?.bot_user.display_name, 'string');
  for (const scope of manifest.oauth_config.scopes.bot ?? []) {
    assert.equal(/history|:read$|files:/.test(scope), false, `the bot asks for ${scope}, which reads or uploads`);
  }
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

test('scopes are only ever issued for a mode that exists', () => {
  // The type allows two values; the type is erased at runtime, and a cast upstream can deliver anything.
  assert.throws(() => scopesForMode('raed' as never), /neither "read" nor "send"/);
  assert.throws(() => scopesForMode(undefined as never), /neither "read" nor "send"/);
});

// ── The organisation's agent app (CUE-493) ─────────────────────────────────────────────────────────────────────────

test('the agent app is a bot and nothing else: the four posting scopes, no user scope, no redirect, no rotation', () => {
  /*
   * One app per organisation, installed once by its administrator, whose bot token each member pastes with
   * `workspace bot`. Nobody signs in through it — so no user scope and no redirect — and nothing here could renew a
   * pasted token, so its rotation is off: `workspace bot` refuses a token that rotates.
   */
  const manifest = buildAgentManifest();
  assert.deepEqual(manifest.oauth_config.scopes, { bot: [...BOT_SCOPES].sort() });
  assert.equal('user' in manifest.oauth_config.scopes, false, 'the agent app asks for a user scope');
  assert.equal('redirect_urls' in manifest.oauth_config, false, 'the agent app has a redirect');
  assert.equal('pkce_enabled' in manifest.oauth_config, false, 'the agent app has nothing to sign in with');
  assert.ok(manifest.features.bot_user, 'the agent app has no bot user');
  assert.equal(manifest.features.bot_user.always_online, false);
  assert.deepEqual(manifest.settings, {
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  });
  for (const scope of NEVER_REQUESTED) {
    assert.equal(JSON.stringify(manifest).includes(`"${scope}"`), false, `the agent app asks for ${scope}`);
  }
  // Its own name, which the administrator changes to the organisation's: never one of this suite's commands.
  assert.ok(manifest.display_information.name.length <= 35, 'Slack names an app in at most 35 characters');
  assert.doesNotMatch(manifest.display_information.name, /agent-slack|agentcomms/);
  assert.ok(manifest.display_information.description.length <= 140, 'Slack describes an app in at most 140');
});

test('the agent manifest a person pastes is valid JSON, and round-trips', () => {
  const text = renderAgentManifest();
  assert.equal(text.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(text), buildAgentManifest());
});
