import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
  canonicalTarballUrl,
  downloadVerifiedTarball,
  fetchTarball,
  MANIFEST_MAX_BYTES,
  TARBALL_MAX_BYTES,
  TARBALL_MAX_REDIRECTS,
  TARBALL_TIMEOUT_MS,
  type TarballFetch,
  type TarballRelease,
  tarballEntries,
  tarballLocation,
  tarballManifest,
  UNPACKED_MAX_BYTES,
} from '../src/release-tarball.ts';
import type { Packument } from '../src/update-release.ts';
import {
  type FixtureEntry,
  gzip,
  paxRecords,
  releaseTarball,
  rewriteHeader,
  ustar,
} from './helpers/tarball-fixture.ts';

/*
 * A release's tarball, read for what it declares (design 2026-10-22 P1, §7.1): fetched from wherever the packument
 * says — any http(s) address, through at most five redirects, then once from npm's canonical address — and kept only
 * when its sha512 is the verified provenance digest; then gunzipped, bounded, and its ustar archive walked for
 * `package/package.json` alone.
 *
 * The network here is a loopback server on 127.0.0.1, reached through the real `fetch`. npm's canonical address never
 * is: a recording fetch answers it with a stand-in.
 */

const CORE = '@agentcomms/core';
const VERSION = '0.26.0';
const TARBALL = releaseTarball(CORE, VERSION);
const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('hex');
const RELEASE: TarballRelease = { packageName: CORE, version: VERSION, sha512: sha512(TARBALL) };
const CANONICAL = canonicalTarballUrl(CORE, VERSION);
const MiB = 1024 * 1024;

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A loopback server answering with `handler`, every request's path and headers recorded. */
async function loopback(handler: Handler) {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? '', headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    seen,
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}

/**
 * The fetch a download is handed: loopback addresses go to the real `fetch`; anything else — npm's canonical address
 * among them — to `elsewhere`, a 503 unless a test says. Every address asked is recorded, in order.
 */
function recording(
  elsewhere: (url: string) => Response | Promise<Response> = () => new Response(null, { status: 503 }),
) {
  const asked: string[] = [];
  const fetchOne: TarballFetch = async (url, init) => {
    asked.push(url);
    if (url.startsWith('http://127.0.0.1:')) return fetch(url, init);
    return elsewhere(url);
  };
  return { fetch: fetchOne, asked };
}

const bytesOf = (bytes: Buffer) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });

test('the limits are the design’s', () => {
  assert.equal(TARBALL_MAX_BYTES, 32 * MiB);
  assert.equal(TARBALL_TIMEOUT_MS, 60_000);
  assert.equal(TARBALL_MAX_REDIRECTS, 5);
  assert.equal(UNPACKED_MAX_BYTES, 128 * MiB);
  assert.equal(MANIFEST_MAX_BYTES, MiB);
});

test("npm's canonical address names the package and its file, a scope kept as npm writes it", () => {
  assert.equal(CANONICAL, 'https://registry.npmjs.org/@agentcomms/core/-/core-0.26.0.tgz');
  assert.equal(canonicalTarballUrl('left-pad', '1.3.0'), 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz');
});

test('a location is the packument’s dist.tarball when it is an absolute http or https address, never with a user', () => {
  const of = (tarball: unknown): Packument => ({ versions: { [VERSION]: { dist: { tarball } } } });
  assert.equal(
    tarballLocation(of('https://mirror.comms.test/core-0.26.0.tgz'), VERSION),
    'https://mirror.comms.test/core-0.26.0.tgz',
  );
  assert.equal(
    tarballLocation(of('http://127.0.0.1:4873/core-0.26.0.tgz'), VERSION),
    'http://127.0.0.1:4873/core-0.26.0.tgz',
  );
  assert.equal(
    tarballLocation(of('https://someone:secret@mirror.comms.test/core-0.26.0.tgz'), VERSION),
    'https://mirror.comms.test/core-0.26.0.tgz',
  );
  for (const tarball of [
    '/core-0.26.0.tgz',
    'core-0.26.0.tgz',
    'file:///etc/hosts',
    'ftp://mirror.comms.test/x.tgz',
    42,
    null,
    '',
  ]) {
    assert.equal(tarballLocation(of(tarball), VERSION), null, String(tarball));
  }
  assert.equal(tarballLocation({ versions: {} }, VERSION), null);
  assert.equal(tarballLocation({}, VERSION), null);
});

test('a verified tarball downloads over HTTP, and its bytes are the verified digest’s', async () => {
  const served = await loopback((_request, response) => response.writeHead(200).end(TARBALL));
  try {
    const net = recording();
    const location = `${served.base}/core-0.26.0.tgz`;
    const got = await downloadVerifiedTarball(RELEASE, location, { fetch: net.fetch });
    assert.equal(got.ok, true);
    assert.ok(got.ok && got.bytes.equals(TARBALL));
    assert.deepEqual(net.asked, [location]);
  } finally {
    await served.close();
  }
});

test('the default fetch asks for the bytes as they are stored, and sends no credential', async () => {
  const served = await loopback((_request, response) => response.writeHead(200).end(TARBALL));
  try {
    const response = await fetchTarball(`${served.base}/core-0.26.0.tgz`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(TARBALL));
    const [request] = served.seen;
    assert.equal(request?.headers['accept-encoding'], 'identity');
    assert.equal(request?.headers.authorization, undefined);
    assert.equal(request?.headers.cookie, undefined);
  } finally {
    await served.close();
  }
});

test('a location with a user and password is asked without them', async () => {
  const served = await loopback((_request, response) => response.writeHead(200).end(TARBALL));
  try {
    const net = recording();
    const location = `${served.base.replace('http://', 'http://someone:secret@')}/core-0.26.0.tgz`;
    const got = await downloadVerifiedTarball(RELEASE, location, { fetch: net.fetch });
    assert.equal(got.ok, true);
    assert.deepEqual(net.asked, [`${served.base}/core-0.26.0.tgz`]);
    assert.equal(served.seen[0]?.headers.authorization, undefined);
  } finally {
    await served.close();
  }
});

test('any http or https location is used, through at most five redirects', async () => {
  // `/hop/<n>` sends the asker on to `/hop/<n-1>`, alternately by an absolute and a relative address; `/hop/0` serves.
  const served = await loopback((request, response) => {
    const n = Number(/^\/hop\/(\d+)$/.exec(request.url ?? '')?.[1] ?? -1);
    if (n === 0) return response.writeHead(200).end(TARBALL);
    if (n > 0) {
      const next = n % 2 === 0 ? `${served.base}/hop/${n - 1}` : `/hop/${n - 1}`;
      return response.writeHead([301, 302, 303, 307, 308][n % 5] as number, { location: next }).end();
    }
    response.writeHead(404).end();
  });
  try {
    const five = recording();
    const ok = await downloadVerifiedTarball(RELEASE, `${served.base}/hop/5`, { fetch: five.fetch });
    assert.equal(ok.ok, true, 'five redirects are followed');
    assert.equal(five.asked.length, 6);
    assert.ok(!five.asked.includes(CANONICAL));

    const six = recording();
    const refused = await downloadVerifiedTarball(RELEASE, `${served.base}/hop/6`, { fetch: six.fetch });
    assert.deepEqual(refused, { ok: false, problem: 'download' });
    assert.equal(six.asked.filter((url) => url === CANONICAL).length, 1, 'the canonical address is asked once');
    assert.equal(six.asked.at(-1), CANONICAL);
    assert.ok(!six.asked.includes(`${served.base}/hop/0`), 'the sixth redirect is not followed');

    // An https mirror that sends the asker on to another origin, over http, is followed like any other.
    const mirror = recording((url) =>
      url === 'https://mirror.comms.test/core-0.26.0.tgz'
        ? new Response(null, { status: 302, headers: { location: `${served.base}/hop/0` } })
        : new Response(null, { status: 503 }),
    );
    const across = await downloadVerifiedTarball(RELEASE, 'https://mirror.comms.test/core-0.26.0.tgz', {
      fetch: mirror.fetch,
    });
    assert.equal(across.ok, true);
    assert.deepEqual(mirror.asked, ['https://mirror.comms.test/core-0.26.0.tgz', `${served.base}/hop/0`]);
  } finally {
    await served.close();
  }
});

test('a redirect to another scheme, or with no address, is not followed', async () => {
  const served = await loopback((request, response) => {
    if (request.url === '/file') return response.writeHead(302, { location: 'file:///etc/hosts' }).end();
    if (request.url === '/nowhere') return response.writeHead(302).end();
    response.writeHead(302, { location: 'ftp://mirror.comms.test/core-0.26.0.tgz' }).end();
  });
  try {
    for (const path of ['/file', '/nowhere', '/ftp']) {
      const net = recording();
      const got = await downloadVerifiedTarball(RELEASE, `${served.base}${path}`, { fetch: net.fetch });
      assert.deepEqual(got, { ok: false, problem: 'download' }, path);
      assert.deepEqual(net.asked, [`${served.base}${path}`, CANONICAL], path);
    }
  } finally {
    await served.close();
  }
});

test("a location that fails is tried once more at npm's canonical address", async () => {
  const served = await loopback((_request, response) => response.writeHead(500).end('broken'));
  try {
    const net = recording((url) => (url === CANONICAL ? bytesOf(TARBALL) : new Response(null, { status: 503 })));
    const location = `${served.base}/core-0.26.0.tgz`;
    const got = await downloadVerifiedTarball(RELEASE, location, { fetch: net.fetch });
    assert.equal(got.ok, true);
    assert.ok(got.ok && got.bytes.equals(TARBALL));
    assert.deepEqual(net.asked, [location, CANONICAL]);
  } finally {
    await served.close();
  }
  // A location that cannot be connected to at all is the same.
  const net = recording((url) => (url === CANONICAL ? bytesOf(TARBALL) : new Response(null, { status: 503 })));
  const closed = await loopback(() => undefined);
  await closed.close();
  const got = await downloadVerifiedTarball(RELEASE, `${closed.base}/core-0.26.0.tgz`, { fetch: net.fetch });
  assert.equal(got.ok, true);
  assert.deepEqual(net.asked, [`${closed.base}/core-0.26.0.tgz`, CANONICAL]);
  // So is a fetch that throws.
  const throwing = await downloadVerifiedTarball(RELEASE, 'https://mirror.comms.test/x.tgz', {
    fetch: async (url) => {
      if (url === CANONICAL) return bytesOf(TARBALL);
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(throwing.ok, true);
});

test('a canonical location is not tried twice, and no location means the canonical one alone', async () => {
  const twice = recording();
  assert.deepEqual(await downloadVerifiedTarball(RELEASE, CANONICAL, { fetch: twice.fetch }), {
    ok: false,
    problem: 'download',
  });
  assert.deepEqual(twice.asked, [CANONICAL]);

  const none = recording((url) => (url === CANONICAL ? bytesOf(TARBALL) : new Response(null, { status: 503 })));
  const got = await downloadVerifiedTarball(RELEASE, null, { fetch: none.fetch });
  assert.equal(got.ok, true);
  assert.deepEqual(none.asked, [CANONICAL]);
});

test('a download over 32 MiB is refused, by its length or by what arrives', async () => {
  let bodyWritten = 0;
  const served = await loopback((request, response) => {
    if (request.url === '/declared') {
      // Says it is one byte too long, then sends nothing: a reader that waited for the body would time out instead.
      response.writeHead(200, { 'content-length': String(TARBALL_MAX_BYTES + 1) });
      response.flushHeaders();
      return;
    }
    // No length at all: chunk after chunk, one MiB each, past the limit — unless the reader stops taking them.
    response.writeHead(200);
    const chunk = Buffer.alloc(MiB, 1);
    const more = () => {
      while (bodyWritten <= TARBALL_MAX_BYTES + 2 * MiB) {
        bodyWritten += chunk.length;
        if (!response.write(chunk)) return void response.once('drain', more);
      }
      response.end();
    };
    response.on('error', () => undefined);
    more();
  });
  try {
    const declared = recording();
    const started = Date.now();
    assert.deepEqual(
      await downloadVerifiedTarball(RELEASE, `${served.base}/declared`, { fetch: declared.fetch, timeoutMs: 10_000 }),
      { ok: false, problem: 'size' },
    );
    assert.ok(Date.now() - started < 9_000, 'the body was waited for');
    assert.deepEqual(declared.asked, [`${served.base}/declared`, CANONICAL]);

    const chunked = recording();
    assert.deepEqual(
      await downloadVerifiedTarball(RELEASE, `${served.base}/chunked`, { fetch: chunked.fetch, timeoutMs: 20_000 }),
      { ok: false, problem: 'size' },
    );
  } finally {
    await served.close();
  }
});

test('a download that does not finish in its time is refused', async () => {
  const served = await loopback((request, response) => {
    if (request.url === '/body') {
      // Headers at once, then half the tarball, then nothing.
      response.writeHead(200, { 'content-length': String(TARBALL.length) });
      response.write(TARBALL.subarray(0, Math.floor(TARBALL.length / 2)));
    }
    // `/headers`: nothing at all.
  });
  try {
    for (const path of ['/headers', '/body']) {
      const net = recording();
      const started = Date.now();
      const got = await downloadVerifiedTarball(RELEASE, `${served.base}${path}`, { fetch: net.fetch, timeoutMs: 200 });
      assert.deepEqual(got, { ok: false, problem: 'download' }, path);
      assert.ok(Date.now() - started < 5_000, `${path} was waited for past its time`);
      assert.deepEqual(net.asked, [`${served.base}${path}`, CANONICAL]);
    }
  } finally {
    await served.close();
  }
});

test('bytes that are not the verified digest’s are refused, from the location and the canonical address alike', async () => {
  const other = releaseTarball(CORE, VERSION, { files: { 'OTHER.md': 'another tarball\n' } });
  const served = await loopback((_request, response) => response.writeHead(200).end(other));
  try {
    const net = recording((url) => (url === CANONICAL ? bytesOf(other) : new Response(null, { status: 503 })));
    const location = `${served.base}/core-0.26.0.tgz`;
    assert.deepEqual(await downloadVerifiedTarball(RELEASE, location, { fetch: net.fetch }), {
      ok: false,
      problem: 'digest',
    });
    assert.deepEqual(net.asked, [location, CANONICAL]);
    // Other bytes at the location and nothing at the canonical address: still the digest, the more telling of the two.
    const missing = recording();
    assert.deepEqual(await downloadVerifiedTarball(RELEASE, location, { fetch: missing.fetch }), {
      ok: false,
      problem: 'digest',
    });
  } finally {
    await served.close();
  }
  // The verified digest decides, however it is written.
  const upper = await downloadVerifiedTarball({ ...RELEASE, sha512: RELEASE.sha512.toUpperCase() }, null, {
    fetch: async () => bytesOf(TARBALL),
  });
  assert.equal(upper.ok, true);
});

// ── The archive ─────────────────────────────────────────────────────────────────────────────────────────────────

const manifestJson = (manifest: unknown = { name: CORE, version: VERSION }) => `${JSON.stringify(manifest)}\n`;
const archive = (entries: readonly FixtureEntry[], options?: { badChecksumAt?: number }) =>
  gzip(ustar(entries, options));

test('a gzip bomb stops past 128 MiB, and what is not gzip is refused', () => {
  const bomb = gzip(Buffer.alloc(129 * MiB));
  assert.ok(bomb.length < MiB, 'the bomb is small');
  assert.deepEqual(tarballManifest(bomb), { ok: false, problem: 'gzip' });
  assert.deepEqual(tarballEntries(bomb), { ok: false, problem: 'gzip' });
  assert.deepEqual(tarballManifest(Buffer.from('not a gzip stream')), { ok: false, problem: 'gzip' });
  assert.deepEqual(tarballManifest(TARBALL.subarray(0, TARBALL.length - 12)), { ok: false, problem: 'gzip' });
});

test('package/package.json is read when it is exactly one regular file of at most 1 MiB', () => {
  assert.deepEqual(tarballManifest(TARBALL), { ok: true, manifest: { name: CORE, version: VERSION } });
  const declared = releaseTarball(CORE, VERSION, { declares: { security: true } });
  assert.deepEqual(tarballManifest(declared), {
    ok: true,
    manifest: { name: CORE, version: VERSION, agentcommsRelease: { security: true } },
  });
  // Exactly 1 MiB is read.
  const head = manifestJson({ name: CORE, version: VERSION, pad: '' });
  const padded = head.replace('"pad":""', `"pad":"${'x'.repeat(MiB - Buffer.byteLength(head))}"`);
  assert.equal(Buffer.byteLength(padded), MiB);
  const full = tarballManifest(archive([{ path: 'package/package.json', data: padded }]));
  assert.equal(full.ok, true);
  // A leading ./ is no different.
  assert.deepEqual(tarballManifest(archive([{ path: './package/package.json', data: manifestJson() }])), {
    ok: true,
    manifest: { name: CORE, version: VERSION },
  });
});

test('what is not exactly one regular package/package.json of at most 1 MiB, holding an object, is no manifest', () => {
  const cases: [string, Buffer][] = [
    ['none', archive([{ path: 'package/README.md', data: 'hello\n' }])],
    [
      'two',
      archive([
        { path: 'package/package.json', data: manifestJson() },
        { path: 'package/package.json', data: manifestJson({ name: CORE, version: VERSION, agentcommsRelease: {} }) },
      ]),
    ],
    [
      'a pax header renaming a later entry',
      archive([
        { path: 'package/package.json', data: manifestJson() },
        { path: 'package/PaxHeader/README.md', type: 'x', data: paxRecords({ path: 'package/package.json' }) },
        { path: 'package/README.md', data: manifestJson({ name: CORE, version: VERSION, agentcommsRelease: {} }) },
      ]),
    ],
    [
      'a GNU long name renaming a later entry',
      archive([
        { path: 'package/package.json', data: manifestJson() },
        { path: '././@LongLink', type: 'L', data: 'package/package.json\0' },
        { path: 'package/README.md', data: manifestJson() },
      ]),
    ],
    ['a symlink', archive([{ path: 'package/package.json', type: '2', linkname: '../../etc/passwd' }])],
    ['a folder', archive([{ path: 'package/package.json', type: '5' }])],
    ['1 MiB and a byte', archive([{ path: 'package/package.json', data: Buffer.alloc(MiB + 1, 0x20) }])],
    ['a JSON array', archive([{ path: 'package/package.json', data: '[]\n' }])],
    ['JSON null', archive([{ path: 'package/package.json', data: 'null\n' }])],
    ['not JSON', archive([{ path: 'package/package.json', data: '{"name": ' }])],
  ];
  for (const [what, gz] of cases) assert.deepEqual(tarballManifest(gz), { ok: false, problem: 'manifest' }, what);
});

test('a pax size, and a pax path to a renamed entry, are applied to the next entry only', () => {
  // The pax path renames README.md to package.json; the header after it keeps its own name.
  const renamed = archive([
    { path: 'package/PaxHeader/README.md', type: 'x', data: paxRecords({ path: 'package/package.json' }) },
    { path: 'package/README.md', data: manifestJson() },
    { path: 'package/dist/cli.mjs', data: '// cli\n' },
  ]);
  assert.deepEqual(tarballManifest(renamed), { ok: true, manifest: { name: CORE, version: VERSION } });
  const entries = tarballEntries(renamed);
  assert.ok(entries.ok);
  assert.deepEqual(
    entries.entries.map((entry) => entry.path),
    ['package.json', 'dist/cli.mjs'],
  );
  // A pax size is the next entry's length, whatever its own header says: here 0, with 700 bytes behind it.
  const data = 'x'.repeat(700);
  const tar = ustar([
    { path: 'package/PaxHeader/big.txt', type: 'x', data: paxRecords({ size: String(data.length) }) },
    { path: 'package/big.txt', data },
    { path: 'package/package.json', data: manifestJson() },
  ]);
  const sized = gzip(rewriteHeader(tar, 1024, (header) => header.write('00000000000\0', 124, 'latin1')));
  const read = tarballEntries(sized);
  assert.ok(read.ok);
  assert.deepEqual(
    read.entries.map((entry) => [entry.path, entry.data.length]),
    [
      ['big.txt', 700],
      ['package.json', manifestJson().length],
    ],
  );
  assert.deepEqual(tarballManifest(sized), { ok: true, manifest: { name: CORE, version: VERSION } });
});

test('a broken header or a path outside package/ is a broken archive', () => {
  const good: FixtureEntry[] = [
    { path: 'package/package.json', data: manifestJson() },
    { path: 'package/dist/cli.mjs', data: '// cli\n' },
  ];
  const tar = ustar(good);
  const cases: [string, Buffer][] = [
    ['a bad checksum on the manifest', archive(good, { badChecksumAt: 0 })],
    ['a bad checksum on a later header', archive(good, { badChecksumAt: 1 })],
    ['a .. segment', archive([...good, { path: 'package/../../escape.txt', data: 'x' }])],
    ['a .. segment at the end', archive([{ path: 'package/dist/..', type: '5' }, ...good])],
    ['an entry outside package/', archive([...good, { path: 'other/file.txt', data: 'x' }])],
    ['an absolute path', archive([{ path: '/package/package.json', data: manifestJson() }])],
    ['package itself as a file', archive([...good, { path: 'package', data: 'x' }])],
    [
      'a pax path outside package/',
      archive([{ path: 'x', type: 'x', data: paxRecords({ path: 'etc/passwd' }) }, ...good]),
    ],
    [
      'a global pax header',
      archive([{ path: 'pax_global_header', type: 'g', data: paxRecords({ comment: 'x' }) }, ...good]),
    ],
    ['a pax record that is not one', archive([{ path: 'package/x', type: 'x', data: 'garbage\n' }, ...good])],
    [
      'a pax size that is not a number',
      archive([{ path: 'package/x', type: 'x', data: paxRecords({ size: '1e3' }) }, ...good]),
    ],
    // A base-256 size: the high bit of the size field's first byte.
    ['a base-256 size', gzip(rewriteHeader(tar, 0, (header) => header.fill(0, 124, 136).writeUInt8(0x80, 124)))],
    ['a size that is not octal', gzip(rewriteHeader(tar, 0, (header) => header.write('00000000009\0', 124, 'latin1')))],
    // An entry whose data runs past the end of the archive.
    ['a truncated entry', gzip(tar.subarray(0, 512 + 10))],
  ];
  for (const [what, gz] of cases) {
    assert.deepEqual(tarballManifest(gz), { ok: false, problem: 'archive' }, what);
    assert.deepEqual(tarballEntries(gz), { ok: false, problem: 'archive' }, what);
  }
});

test('tarballEntries lists every regular file below package/, with its bytes', () => {
  const binary = Buffer.from([0, 1, 2, 255, 254]);
  const gz = archive([
    { path: 'package/package.json', data: manifestJson() },
    { path: 'package/dist', type: '5' },
    { path: 'package/dist/cli.mjs', data: '// cli\n' },
    { path: 'package/dist/data.bin', data: binary },
    { path: 'package/bin', type: '2', linkname: 'dist/cli.mjs' },
    { path: `package/${'deep/'.repeat(30)}file.txt`, data: 'deep\n' },
  ]);
  const listed = tarballEntries(gz);
  assert.ok(listed.ok);
  const byPath = new Map(listed.entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('package.json')?.type, 'file');
  assert.equal(byPath.get('package.json')?.data.toString('utf8'), manifestJson());
  assert.equal(byPath.get('dist')?.type, 'directory');
  assert.equal(byPath.get('dist/cli.mjs')?.data.toString('utf8'), '// cli\n');
  assert.ok(byPath.get('dist/data.bin')?.data.equals(binary));
  assert.equal(byPath.get('bin')?.type, 'link');
  assert.equal(byPath.get(`${'deep/'.repeat(30)}file.txt`)?.data.toString('utf8'), 'deep\n');
  assert.deepEqual(
    listed.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path),
    ['package.json', 'dist/cli.mjs', 'dist/data.bin', `${'deep/'.repeat(30)}file.txt`],
  );
  // A release tarball, as the fixture packs one, is its manifest and its files.
  const release = tarballEntries(releaseTarball(CORE, VERSION, { files: { 'README.md': '# core\n' } }));
  assert.ok(release.ok);
  assert.deepEqual(
    release.entries.map((entry) => entry.path),
    ['package.json', 'README.md', 'dist/cli.mjs'],
  );
});
