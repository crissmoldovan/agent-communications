import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { drawRobotBadge } from '../scripts/robot-badge.ts';
import { AVATAR_MAX_BYTES } from '../src/api/avatar.ts';
import {
  avatarWith,
  closedPermit,
  configureWith,
  downloadWith,
  type FetchLike,
  guardSlackRequests,
  spendOn,
} from '../src/api/guard.ts';
import { SLACK_AVATARS_ORIGIN } from '../src/api/methods.ts';
import { run } from '../src/cli/program.ts';
import { ROBOT_BADGE_PNG } from '../src/icon/robot-badge.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import {
  AGENT_ICON_MAX_BYTES,
  AGENT_ICON_SIZE,
  type AgentIconResult,
  BADGE_AT,
  makeAgentIcon,
  suggestedEmojiName,
} from '../src/operations/icon.ts';
import { openWorkspace } from '../src/operations/session.ts';
import { type FakeSlack, startFakeSlack } from './support/fake-slack.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * The agent emoji maker (agent-label design §4 S4; plan Task B4).
 *
 * `icon make` reads the signed-in person's Slack photo, puts the package's own robot badge on its lower right, and
 * writes a square PNG small enough to be a Slack emoji. It changes nothing in Slack and nothing in the configuration,
 * so it asks nobody. These drive it against the loopback fake for the Web API and a loopback host of their own for
 * the photo — the guard approves Slack's real photo host, and the inner fetch rewrites it here after that approval,
 * as the fake does for the Web API. Nothing here reaches Slack.
 */

const PHOTO_PATH = '/2026-10-15/1000000000001_0123456789abcdef0123_512.jpg';
const PHOTO_URL = `${SLACK_AVATARS_ORIGIN}${PHOTO_PATH}`;
const RED = [220, 40, 40, 255] as const;
const GREEN = [30, 170, 90, 255] as const;

type Rgba = readonly [number, number, number, number];

interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A photo whose top-left quarter is red and the rest green: the opposite corners differ, so each can be told apart. */
function quarters(size = 512): Bitmap {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = x < size / 2 && y < size / 2 ? RED : GREEN;
      data.set(colour, (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/** Bytes nothing compresses: the worst case for the size of the PNG that comes out. */
function noise(size = 512): Bitmap {
  const data = new Uint8Array(size * size * 4);
  let seed = 7;
  for (let i = 0; i < data.length; i += 1) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    data[i] = i % 4 === 3 ? 255 : seed >> 16;
  }
  return { width: size, height: size, data };
}

function pngOf(bitmap: Bitmap): Buffer {
  const png = new PNG({ width: bitmap.width, height: bitmap.height });
  png.data = Buffer.from(bitmap.data);
  return PNG.sync.write(png);
}

function jpegOf(bitmap: Bitmap): Buffer {
  return encodeJpeg({ data: Buffer.from(bitmap.data), width: bitmap.width, height: bitmap.height }, 92).data;
}

function decodedPng(bytes: Uint8Array): Bitmap {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

function pixel(bitmap: Bitmap, x: number, y: number): Rgba {
  const at = (y * bitmap.width + x) * 4;
  const d = bitmap.data;
  return [d[at] ?? -1, d[at + 1] ?? -1, d[at + 2] ?? -1, d[at + 3] ?? -1];
}

function near(actual: Rgba, expected: Rgba, tolerance: number, what: string): void {
  const off = actual.map((value, i) => Math.abs(value - (expected[i] ?? 0)));
  assert.ok(
    off.every((d) => d <= tolerance),
    `${what}: ${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`,
  );
}

// ── A host for the photo, on loopback ──────────────────────────────────────────────────────────────────────────

interface PhotoReply {
  status?: number;
  headers?: Record<string, string>;
  body: Uint8Array | string;
  /** Sent in pieces with no length declared, so only a running count can tell how much is coming. */
  chunked?: boolean;
}

interface PhotoHost {
  readonly origin: string;
  readonly requests: { path: string; method: string; headers: IncomingMessage['headers'] }[];
  answer: (path: string) => PhotoReply;
  close(): Promise<void>;
}

async function startPhotoHost(answer: (path: string) => PhotoReply): Promise<PhotoHost> {
  const host: PhotoHost = {
    origin: '',
    requests: [],
    answer,
    close: async () => undefined,
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    host.requests.push({ path: request.url ?? '', method: request.method ?? '', headers: request.headers });
    const reply = host.answer(request.url ?? '');
    const body = typeof reply.body === 'string' ? Buffer.from(reply.body) : Buffer.from(reply.body);
    if (reply.chunked) {
      response.writeHead(reply.status ?? 200, { 'content-type': 'image/jpeg', ...reply.headers });
      // Every piece, whatever the socket's backpressure says: Node holds what it cannot send yet.
      for (let at = 0; at < body.byteLength; at += 64 * 1024) response.write(body.subarray(at, at + 64 * 1024));
      response.end();
      return;
    }
    response.writeHead(reply.status ?? 200, {
      'content-type': 'image/jpeg',
      'content-length': String(body.byteLength),
      ...reply.headers,
    });
    response.end(body);
  });
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()));
  const { port } = server.address() as AddressInfo;
  return Object.assign(host, {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((settle) => {
        server.closeAllConnections();
        server.close(() => settle());
      }),
  });
}

/** The inner fetch: Slack's photo host to the loopback one, everything else to the fake — both after the guard. */
function routed(fake: FakeSlack, photos: PhotoHost): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${SLACK_AVATARS_ORIGIN}/`))
      return fetch(url.replace(SLACK_AVATARS_ORIGIN, photos.origin), init);
    return fake.fetch(input, init);
  };
}

interface Setup {
  harness: Harness;
  fake: FakeSlack;
  photos: PhotoHost;
  fetch: FetchLike;
  accountId: string;
  close(): Promise<void>;
}

async function setup(
  options: {
    photo?: PhotoReply;
    user?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    authTest?: Record<string, unknown>;
  } = {},
): Promise<Setup> {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme' });
  const fake = await startFakeSlack({
    'auth.test': () => ({
      ok: true,
      url: 'https://acme.slack.com/',
      team: 'Acme',
      user: 'sam',
      team_id: 'T0001',
      user_id: 'U0001',
      ...options.authTest,
    }),
    'users.info': () => ({
      ok: true,
      user: {
        id: 'U0001',
        name: 'sam',
        ...options.user,
        profile: {
          display_name: 'Sam',
          real_name: 'Sam Example',
          image_192: PHOTO_URL.replace('_512', '_192'),
          image_512: PHOTO_URL,
          ...options.profile,
        },
      },
    }),
  });
  const photos = await startPhotoHost(
    () => options.photo ?? { headers: { 'content-type': 'image/jpeg' }, body: jpegOf(quarters()) },
  );
  return {
    harness,
    fake,
    photos,
    fetch: routed(fake, photos),
    accountId: account.id,
    close: async () => {
      await fake.close();
      await photos.close();
    },
  };
}

async function make(env: Setup): Promise<AgentIconResult> {
  const context = env.harness.context();
  return makeAgentIcon(context, await openWorkspace(context, 'acme', { fetch: env.fetch }));
}

function iconsFolder(harness: Harness): string {
  return join(harness.core.paths.dataDir, 'slack', 'agent-icons');
}

/** Every file under `root`, by path, with a digest of its bytes: what changed, and what did not. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(root, path)] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  return out;
}

/** The badge as it ships: decoded from the package's own PNG. */
const BADGE = decodedPng(ROBOT_BADGE_PNG);

/** Checks the lower-right corner holds every opaque pixel of the badge, exactly; returns how many it compared. */
function assertBadgeAt(icon: Bitmap): number {
  let compared = 0;
  for (let y = 0; y < BADGE.height; y += 1) {
    for (let x = 0; x < BADGE.width; x += 1) {
      const badge = pixel(BADGE, x, y);
      if (badge[3] !== 255) continue;
      assert.deepEqual(pixel(icon, BADGE_AT.left + x, BADGE_AT.top + y), badge, `badge pixel ${x},${y}`);
      compared += 1;
    }
  }
  return compared;
}

// ── What it makes ──────────────────────────────────────────────────────────────────────────────────────────────

test('a JPEG photo becomes a square PNG under 128 KB, the badge on its lower right and the photo opposite', async () => {
  const env = await setup();
  try {
    const result = await make(env);
    const expectedPath = join(iconsFolder(env.harness), `${env.accountId}.png`);
    assert.equal(result.path, expectedPath, 'written under the data directory, named for the account');
    const bytes = await readFile(result.path);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG');
    assert.ok(bytes.byteLength < AGENT_ICON_MAX_BYTES, `${bytes.byteLength} bytes is not under 128 KB`);
    assert.equal(AGENT_ICON_MAX_BYTES, 131_072);
    assert.equal(result.bytes, bytes.byteLength);

    const icon = decodedPng(bytes);
    assert.equal(icon.width, icon.height, 'square');
    assert.equal(icon.width, AGENT_ICON_SIZE);
    assert.deepEqual([result.width, result.height], [AGENT_ICON_SIZE, AGENT_ICON_SIZE]);

    // The lower-right corner is the badge's, pixel for pixel; it is not vacuous, the badge is mostly opaque.
    assert.ok(assertBadgeAt(icon) > 1500, 'too few opaque badge pixels were compared');
    assert.ok(
      BADGE_AT.left + BADGE.width <= AGENT_ICON_SIZE && BADGE_AT.left > AGENT_ICON_SIZE / 2,
      'the badge sits in the lower-right corner',
    );
    // Around the badge's disc, the photo shows through: the badge is drawn over it, not a box cut out of it.
    near(pixel(icon, BADGE_AT.left, BADGE_AT.top), GREEN, 12, 'the photo behind the badge’s transparent corner');
    // The opposite corner is the photo's own.
    near(pixel(icon, 2, 2), RED, 12, 'the top-left corner');
    near(pixel(icon, 2, AGENT_ICON_SIZE - 3), GREEN, 12, 'the bottom-left corner');
  } finally {
    await env.close();
  }
});

test('a PNG photo works the same, its colours exact', async () => {
  const env = await setup({ photo: { headers: { 'content-type': 'image/png' }, body: pngOf(quarters()) } });
  try {
    const result = await make(env);
    const icon = decodedPng(await readFile(result.path));
    assert.equal(icon.width, AGENT_ICON_SIZE);
    assert.equal(icon.height, AGENT_ICON_SIZE);
    assert.ok(result.bytes < AGENT_ICON_MAX_BYTES);
    assert.ok(assertBadgeAt(icon) > 1500);
    assert.deepEqual(pixel(icon, 2, 2), RED);
    assert.deepEqual(pixel(icon, AGENT_ICON_SIZE - 3, 2), GREEN);
  } finally {
    await env.close();
  }
});

test('even a photo nothing compresses comes out under 128 KB', async () => {
  const env = await setup({ photo: { headers: { 'content-type': 'image/png' }, body: pngOf(noise()) } });
  try {
    const result = await make(env);
    assert.ok(result.bytes < AGENT_ICON_MAX_BYTES, `${result.bytes} bytes`);
    assert.equal((await stat(result.path)).size, result.bytes);
  } finally {
    await env.close();
  }
});

test('a photo that is not square is cut to its middle square, not stretched', async () => {
  // 600 wide, 300 high: red on the left third, green in the middle, red on the right. Only the middle survives.
  const width = 600;
  const height = 300;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(x < 150 || x >= 450 ? RED : GREEN, (y * width + x) * 4);
  }
  const env = await setup({
    photo: { headers: { 'content-type': 'image/png' }, body: pngOf({ width, height, data }) },
  });
  try {
    const icon = decodedPng(await readFile((await make(env)).path));
    assert.deepEqual([icon.width, icon.height], [AGENT_ICON_SIZE, AGENT_ICON_SIZE]);
    assert.deepEqual(pixel(icon, 1, 1), GREEN);
    assert.deepEqual(pixel(icon, 1, AGENT_ICON_SIZE - 2), GREEN);
  } finally {
    await env.close();
  }
});

// ── What it says ───────────────────────────────────────────────────────────────────────────────────────────────

test('the result names the workspace’s emoji page and a suggested name from the handle', async () => {
  const env = await setup();
  try {
    const result = await make(env);
    assert.equal(result.emojiPage, 'https://acme.slack.com/customize/emoji');
    assert.equal(result.suggestedName, ':sam-agent:');
    assert.equal(result.workspace, 'acme');
    const said = result.steps.join('\n');
    assert.match(said, /https:\/\/acme\.slack\.com\/customize\/emoji/);
    assert.match(said, /sam-agent/);
    assert.ok(said.includes(result.path), 'the steps name the file to upload');
  } finally {
    await env.close();
  }
});

test('the suggested name is the handle, lower-cased, in the characters an emoji name may have', () => {
  assert.equal(suggestedEmojiName('sam', 'U0001'), ':sam-agent:');
  assert.equal(suggestedEmojiName('Sam.Example', 'U0001'), ':sam-example-agent:');
  assert.equal(suggestedEmojiName('André Ünal', 'U0001'), ':andre-unal-agent:');
  assert.equal(suggestedEmojiName('sam_x', 'U0001'), ':sam_x-agent:');
  assert.equal(suggestedEmojiName('--sam..x__', 'U0001'), ':sam-x-agent:');
  // Nothing usable left: the user id instead, never an empty name or a bare `:agent:` somebody else may own.
  assert.equal(suggestedEmojiName('日本', 'U0001'), ':u0001-agent:');
  assert.equal(suggestedEmojiName(undefined, 'U0001'), ':u0001-agent:');
  const long = suggestedEmojiName('a'.repeat(200), 'U0001');
  assert.match(long, /^:[a-z0-9_-]+-agent:$/);
  assert.ok(long.length <= 64, `${long.length} characters`);
});

test('an address off slack.com is never offered as the emoji page, and the icon is still made', async () => {
  const env = await setup({ authTest: { url: 'https://evil.example/' } });
  try {
    const result = await make(env);
    assert.equal(result.emojiPage, null, 'an address off slack.com is never offered as the emoji page');
    assert.match(result.steps.join('\n'), /Customize/);
    assert.ok(existsSync(result.path));
  } finally {
    await env.close();
  }
});

// ── What it refuses ────────────────────────────────────────────────────────────────────────────────────────────

for (const [name, photo] of [
  ['a web page', { headers: { 'content-type': 'text/html' }, body: '<html>Sign in to Slack</html>' }],
  ['bytes that claim to be a PNG and are not', { headers: { 'content-type': 'image/png' }, body: 'not a png at all' }],
  ['a GIF', { headers: { 'content-type': 'image/gif' }, body: 'GIF89a\u0001\u0000\u0001\u0000' }],
  [
    'a PNG that says it is larger than any photo',
    {
      headers: { 'content-type': 'image/png' },
      // The signature and a header claiming 100000 × 100000: refused before anything is decoded.
      body: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
        Buffer.from('IHDR'),
        Buffer.from([0x00, 0x01, 0x86, 0xa0, 0x00, 0x01, 0x86, 0xa0, 8, 6, 0, 0, 0]),
        Buffer.alloc(4),
      ]),
    },
  ],
  ['a refusal from the host', { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }],
] as const) {
  test(`${name} is refused, and nothing is written`, async () => {
    const env = await setup({ photo: photo as PhotoReply });
    try {
      await assert.rejects(make(env), (error: unknown) => {
        assert.ok(error instanceof CommsError, String(error));
        assert.notEqual(error.code, 'UNEXPECTED');
        return true;
      });
      assert.equal(existsSync(iconsFolder(env.harness)), false, 'a folder or a file was written');
    } finally {
      await env.close();
    }
  });
}

for (const chunked of [false, true]) {
  test(`a photo over the size cap is refused, ${chunked ? 'counted while it arrives' : 'by the length it declares'}, and nothing is written`, async () => {
    assert.ok(AVATAR_MAX_BYTES >= 1024 * 1024 && AVATAR_MAX_BYTES <= 16 * 1024 * 1024, 'a sane cap');
    const body = Buffer.alloc(AVATAR_MAX_BYTES + 1, 0xff);
    // A JPEG's first bytes, so it is the size that refuses it.
    body.set([0xff, 0xd8, 0xff], 0);
    const env = await setup({ photo: { headers: { 'content-type': 'image/jpeg' }, body, chunked } });
    try {
      await assert.rejects(make(env), (error: CommsError) => {
        assert.equal(error.code, 'BAD_DATA');
        assert.match(error.message, /larger than/);
        return true;
      });
      assert.equal(existsSync(iconsFolder(env.harness)), false);
    } finally {
      await env.close();
    }
  });
}

test('a photo kept anywhere but Slack’s photo host is never fetched', async () => {
  for (const image of [
    'https://secure.gravatar.com/avatar/0123456789abcdef.jpg?s=512',
    `http://avatars.slack-edge.com${PHOTO_PATH}`,
    `https://avatars.slack-edge.com.example.net${PHOTO_PATH}`,
    `https://someone@avatars.slack-edge.com${PHOTO_PATH}`,
    'not a url',
  ]) {
    const env = await setup({ profile: { image_512: image } });
    try {
      await assert.rejects(make(env), (error: CommsError) => {
        assert.equal(error.code, 'BAD_DATA', image);
        return true;
      });
      assert.deepEqual(env.photos.requests, [], `${image} was fetched`);
      assert.equal(existsSync(iconsFolder(env.harness)), false);
    } finally {
      await env.close();
    }
  }
});

test('a token that is not this workspace’s account makes nothing', async () => {
  const env = await setup({ authTest: { user_id: 'U0OTHER' } });
  try {
    await assert.rejects(make(env), (error: CommsError) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      return true;
    });
    assert.deepEqual(env.photos.requests, []);
    assert.equal(existsSync(iconsFolder(env.harness)), false);
  } finally {
    await env.close();
  }
});

// ── What it does not touch ─────────────────────────────────────────────────────────────────────────────────────

test('nothing changes in Slack or in the configuration, nobody is asked, and the photo goes out with no token', async () => {
  const env = await setup();
  try {
    const context = env.harness.context();
    const session = await openWorkspace(context, 'acme', { fetch: env.fetch });
    const before = await snapshot(env.harness.configDir);
    const requestsBefore = env.fake.requests.length;
    const result = await makeAgentIcon(context, session);
    assert.deepEqual(await snapshot(env.harness.configDir), before, 'the configuration or the state changed');
    // Two reads of the Web API, and nothing else: no post, no upload, no emoji added for the person.
    assert.deepEqual(
      env.fake.requests.slice(requestsBefore).map((request) => `${request.host} ${request.method}`),
      ['api auth.test', 'api users.info'],
    );
    assert.deepEqual(
      env.photos.requests.map((request) => `${request.method} ${request.path}`),
      [`GET ${PHOTO_PATH}`],
    );
    const [photo] = env.photos.requests;
    assert.equal(photo?.headers.authorization, undefined, 'the token went to the photo host');
    assert.equal(photo?.headers.cookie, undefined);
    assert.equal('approvalId' in result || 'approvalRequired' in result, false, 'it asked for an approval');
  } finally {
    await env.close();
  }
});

// ── The badge ──────────────────────────────────────────────────────────────────────────────────────────────────

test('the badge ships as a PNG in the package, and is exactly what its pixel map draws', () => {
  // The PNG is embedded in source, so the bundle carries it with the code that reads it; the drawing is the script's.
  const drawn = drawRobotBadge();
  assert.deepEqual([BADGE.width, BADGE.height], [drawn.width, drawn.height]);
  assert.ok(Buffer.from(BADGE.data).equals(Buffer.from(drawn.data)), 'run scripts/robot-badge.ts to draw it again');
  assert.ok(BADGE.width < AGENT_ICON_SIZE / 2, 'small: the photo stays the picture');
  // Transparent at its corners, so it is a round badge over the photo rather than a square pasted on it.
  assert.equal(pixel(BADGE, 0, 0)[3], 0);
  assert.equal(pixel(BADGE, BADGE.width - 1, BADGE.height - 1)[3], 0);
  assert.equal(pixel(BADGE, BADGE.width >> 1, BADGE.height >> 1)[3], 255);
});

// ── The photo host's door ──────────────────────────────────────────────────────────────────────────────────────

function recorder() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const inner: FetchLike = async (input, init) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init });
    return new Response('ok');
  };
  return { calls, inner };
}

test('Slack’s photo host is shut outside a photo grant, and opens for one GET of one photo, with no credential', async () => {
  const { calls, inner } = recorder();
  const permit = closedPermit();
  const fetch = guardSlackRequests(inner, permit);

  await assert.rejects(fetch(PHOTO_URL), /no photo is open/);
  await avatarWith(permit, PHOTO_URL, async () => {
    // Every near miss is refused without spending the grant.
    await assert.rejects(fetch(PHOTO_URL, { headers: { authorization: 'Bearer fake-user-token-0' } }), /credential/);
    await assert.rejects(fetch(PHOTO_URL, { headers: { cookie: 'd=fake' } }), /credential/);
    await assert.rejects(fetch(PHOTO_URL, { method: 'POST' }), /GET/);
    await assert.rejects(fetch(`${PHOTO_URL}?s=1`), /not the photo/);
    await assert.rejects(fetch(`${SLACK_AVATARS_ORIGIN}/2026-10-15/other_512.jpg`), /not the photo/);
    assert.equal(permit.avatar, PHOTO_URL, 'a refused request spent the grant');
    await fetch(PHOTO_URL);
    // Spent: a second fetch inside the same grant finds the door shut.
    await assert.rejects(fetch(PHOTO_URL), /no photo is open/);
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [PHOTO_URL],
  );
  assert.equal(calls[0]?.init?.redirect, 'error', 'a redirect would be a request nothing checked');
  assert.deepEqual(permit, closedPermit());
  // And the files host and the Web API stay what they were: the photo grant opens neither.
  await avatarWith(permit, PHOTO_URL, async () => {
    await assert.rejects(fetch('https://slack.com/api/chat.postMessage'), /no approval is open/);
    await assert.rejects(fetch('https://files.slack.com/files-pri/T0AAA1-F0BBB2/a.pdf'), /no download is open/);
  });
});

test('a photo grant names one photo on Slack’s photo host, or it does not open, and it does not nest', async () => {
  const permit = closedPermit();
  for (const url of [
    'https://secure.gravatar.com/avatar/0123.jpg',
    `http://avatars.slack-edge.com${PHOTO_PATH}`,
    `https://avatars.slack-edge.com:8443${PHOTO_PATH}`,
    `https://user@avatars.slack-edge.com${PHOTO_PATH}`,
    `${PHOTO_URL}?s=512`,
    `${PHOTO_URL}#x`,
    `${SLACK_AVATARS_ORIGIN}/`,
    'not a url',
  ]) {
    await assert.rejects(
      avatarWith(permit, url, async () => undefined),
      /one photo/,
      url,
    );
  }
  const nested = () => avatarWith(permit, PHOTO_URL, async () => undefined);
  await spendOn(permit, 'ap_1', 'chat.postMessage', () => assert.rejects(nested(), /do not nest/));
  await configureWith(permit, 'apps.manifest.update', () => assert.rejects(nested(), /do not nest/));
  await downloadWith(permit, { teamId: 'T0AAA1', fileId: 'F0BBB2' }, () => assert.rejects(nested(), /do not nest/));
  await avatarWith(permit, PHOTO_URL, async () => {
    await assert.rejects(nested(), /do not nest/);
    await assert.rejects(
      spendOn(permit, 'ap_2', 'chat.postMessage', async () => undefined),
      /do not nest/,
    );
    await assert.rejects(
      configureWith(permit, 'apps.manifest.update', async () => undefined),
      /do not nest/,
    );
    await assert.rejects(
      downloadWith(permit, { teamId: 'T0AAA1', fileId: 'F0BBB2' }, async () => undefined),
      /do not nest/,
    );
  });
  await assert.rejects(
    avatarWith(permit, PHOTO_URL, async () => {
      throw new Error('inside');
    }),
    /inside/,
  );
  assert.deepEqual(permit, closedPermit(), 'a grant was left open');
});

// ── Both surfaces ──────────────────────────────────────────────────────────────────────────────────────────────

async function viaCommand(env: Setup): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(['--json', 'icon', 'make', 'acme'], {
    core: env.harness.core,
    env: { ...env.harness.env, CLAUDECODE: '1' },
    platform: 'darwin',
    exchange: (params) => env.harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: false }),
      stderr: Object.assign(new PassThrough(), { isTTY: false }),
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
    },
    openBrowser: () => undefined,
    read: env.fetch,
  });
  return { code, stdout };
}

async function viaTool(env: Setup): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
  const { server } = await createSlackMcpServer({
    core: env.harness.core,
    env: env.harness.env,
    fetch: env.fetch,
    platform: 'darwin',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name: 'slack_icon_make', arguments: { workspace: 'acme' } })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

test('`icon make` and `slack_icon_make` make the same icon and say the same, each in its own words', async () => {
  const env = await setup();
  try {
    const config = await readFile(join(env.harness.configDir, 'config.json'));
    const command = await viaCommand(env);
    assert.equal(command.code, EXIT_CODES.OK, command.stdout);
    const fromCommand = (JSON.parse(command.stdout) as { data: AgentIconResult }).data;
    const madeByCommand = await readFile(fromCommand.path);

    const tool = await viaTool(env);
    assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
    const fromTool = tool.structuredContent as unknown as AgentIconResult;

    const { steps: commandSteps, ...commandRest } = fromCommand;
    const { steps: toolSteps, ...toolRest } = fromTool;
    assert.deepEqual(commandRest, toolRest);
    assert.ok((await readFile(fromTool.path)).equals(madeByCommand), 'the same bytes');
    // The step that records the emoji is the surface's own: the tool from a chat, the command at a terminal.
    assert.match(toolSteps.join('\n'), /comms_label/);
    assert.doesNotMatch(commandSteps.join('\n'), /comms_label/);
    assert.match(commandSteps.join('\n'), /label icon acme :sam-agent:/);
    assert.ok((await readFile(join(env.harness.configDir, 'config.json'))).equals(config), 'the config changed');
  } finally {
    await env.close();
  }
});
