import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { archiveChunks, runtimeFile, type UstarFixtureEntry, writeUstarFixture } from './support/laya-ustar.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

type TarCode =
  | 'TAR_CHECKSUM'
  | 'TAR_DUPLICATE'
  | 'TAR_ENTRY_TYPE'
  | 'TAR_EXECUTABLE'
  | 'TAR_HASH'
  | 'TAR_HEADER'
  | 'TAR_PATH'
  | 'TAR_SIZE';

async function tarModule() {
  return import('../src/runtime/laya/tar.ts');
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'events-laya-tar-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectTarFailure(
  directory: string,
  entries: readonly UstarFixtureEntry[],
  code: TarCode,
  options: {
    readonly corruptChecksum?: boolean;
    readonly corruptHeader?: boolean;
    readonly corruptSize?: boolean;
  } = {},
): Promise<void> {
  const archive = await writeUstarFixture(directory, 'fixture.tgz', entries, options);
  const { inspectPackageArchive, LayaTarError } = await tarModule();
  await assert.rejects(
    () => inspectPackageArchive(archiveChunks(archive)),
    (error: unknown) => error instanceof LayaTarError && error.code === code,
  );
}

type ChecksumLayout = 'gnu-tar' | 'npm-pack' | 'bsdtar';

interface NumericHeaderField {
  readonly name: string;
  readonly offset: number;
  readonly width: number;
  readonly testName: string;
}

const NUMERIC_HEADER_FIELDS: readonly NumericHeaderField[] = [
  { name: 'mode', offset: 100, width: 8, testName: 'E2 tar: rejects malformed mode numeric headers before writing' },
  { name: 'uid', offset: 108, width: 8, testName: 'E2 tar: rejects malformed uid numeric headers before writing' },
  { name: 'gid', offset: 116, width: 8, testName: 'E2 tar: rejects malformed gid numeric headers before writing' },
  { name: 'size', offset: 124, width: 12, testName: 'E2 tar: rejects malformed size numeric headers before writing' },
  { name: 'mtime', offset: 136, width: 12, testName: 'E2 tar: rejects malformed mtime numeric headers before writing' },
  {
    name: 'devmajor',
    offset: 329,
    width: 8,
    testName: 'E2 tar: rejects malformed devmajor numeric headers before writing',
  },
  {
    name: 'devminor',
    offset: 337,
    width: 8,
    testName: 'E2 tar: rejects malformed devminor numeric headers before writing',
  },
];

function unsignedHeaderChecksum(header: Buffer): number {
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  return copy.reduce((total, byte) => total + byte, 0);
}

/** These are the three layouts written by GNU tar, npm pack, and bsdtar respectively. */
function setArchiverChecksum(header: Buffer, layout: ChecksumLayout): void {
  const checksum = unsignedHeaderChecksum(header).toString(8);
  header.fill(0, 148, 156);
  if (layout === 'gnu-tar') {
    Buffer.from(checksum.padStart(6, '0'), 'ascii').copy(header, 148);
    header[154] = 0;
    header[155] = 0x20;
    return;
  }
  if (layout === 'npm-pack') {
    Buffer.from(checksum.padStart(7, '0'), 'ascii').copy(header, 148);
    header[155] = 0;
    return;
  }
  Buffer.from(checksum.padStart(7, ' '), 'ascii').copy(header, 148);
  header[155] = 0x20;
}

async function writeModifiedUstarFixture(
  directory: string,
  name: string,
  entries: readonly UstarFixtureEntry[],
  modify: (header: Buffer) => void,
  headerIndex = 0,
): Promise<string> {
  const archive = await writeUstarFixture(directory, name, entries);
  const contents = gunzipSync(await readFile(archive));
  let headerOffset = 0;
  for (let index = 0; index < headerIndex; index += 1) {
    const payloadSize = Buffer.byteLength(entries[index]?.data ?? '');
    headerOffset += 512 + payloadSize + ((512 - (payloadSize % 512)) % 512);
  }
  modify(contents.subarray(headerOffset, headerOffset + 512));
  await writeFile(archive, gzipSync(contents));
  return archive;
}

async function expectExtractionFailureWithoutWriting(
  directory: string,
  archive: string,
  expected: readonly ReturnType<typeof runtimeFile>[],
  code: TarCode,
): Promise<void> {
  const destination = join(directory, 'output');
  const { extractPackageArchive, LayaTarError } = await tarModule();
  await assert.rejects(
    () => extractPackageArchive({ source: archiveChunks(archive), destination, files: expected }),
    (error: unknown) => error instanceof LayaTarError && error.code === code,
  );
  await assert.rejects(() => lstat(destination), { code: 'ENOENT' });
}

async function expectInspectionFailure(archive: string, code: TarCode): Promise<void> {
  const { inspectPackageArchive, LayaTarError } = await tarModule();
  await assert.rejects(
    () => inspectPackageArchive(archiveChunks(archive)),
    (error: unknown) => error instanceof LayaTarError && error.code === code,
  );
}

async function expectWholeArchiveRefusalBeforeStaging(
  directory: string,
  archive: string,
  expected: readonly ReturnType<typeof runtimeFile>[],
  code: TarCode,
): Promise<void> {
  const stagingParent = join(directory, 'staging-parent');
  await mkdir(stagingParent);
  await chmod(stagingParent, 0o500);
  let wroteBeforeArchiveWasRead = false;
  async function* source(): AsyncGenerator<Uint8Array> {
    const contents = await readFile(archive);
    for (let offset = 0; offset < contents.length; offset += 64) {
      if ((await readdir(stagingParent)).length > 0) wroteBeforeArchiveWasRead = true;
      yield contents.subarray(offset, offset + 64);
    }
  }

  const { extractPackageArchive, LayaTarError } = await tarModule();
  await assert.rejects(
    () => extractPackageArchive({ source: source(), destination: join(stagingParent, 'output'), files: expected }),
    (error: unknown) => error instanceof LayaTarError && error.code === code,
  );
  assert.equal(wroteBeforeArchiveWasRead, false, 'the invalid archive created staging before it was fully validated');
  assert.equal((await stat(stagingParent)).mode & 0o777, 0o500, 'the invalid archive changed its staging parent');
  assert.deepEqual(await readdir(stagingParent), [], 'the invalid archive left a staging directory or file');
}

function malformedNumericField(kind: 'base-256' | 'negative' | 'non-octal' | 'overflow', width: number): Buffer {
  if (kind === 'base-256') {
    const result = Buffer.alloc(width);
    result[0] = 0x80;
    return result;
  }
  if (kind === 'overflow') return Buffer.alloc(width, '7'.charCodeAt(0));
  if (kind === 'negative') return Buffer.from(`-${'0'.repeat(width - 2)}\0`, 'ascii');
  return Buffer.from(`${'0'.repeat(width - 2)}x\0`, 'ascii');
}

test('E2 tar: extracts only listed package regular files', { skip: WINDOWS_SKIP }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const listed = runtimeFile('index.mjs', 'tiny runtime');
    const archive = await writeUstarFixture(directory, 'valid.tgz', [
      { path: 'package/index.mjs', data: 'tiny runtime' },
      { path: 'package/unlisted.txt', data: 'must not be written' },
    ]);
    const { extractPackageArchive, inspectPackageArchive } = await tarModule();
    const inspected = await inspectPackageArchive(archiveChunks(archive));
    assert.deepEqual(inspected, [
      { ...listed, path: 'index.mjs' },
      { ...runtimeFile('unlisted.txt', 'must not be written'), path: 'unlisted.txt' },
    ]);

    const destination = join(directory, 'output');
    await assert.doesNotReject(() =>
      extractPackageArchive({ source: archiveChunks(archive), destination, files: [listed] }),
    );

    assert.equal(await readFile(join(destination, 'index.mjs'), 'utf8'), 'tiny runtime');
    await assert.rejects(() => stat(join(destination, 'unlisted.txt')), { code: 'ENOENT' });
    assert.equal((await stat(join(destination, 'index.mjs'))).mode & 0o077, 0);
  });
});

test('E2 tar: rejects a symbolic-link archive entry', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/link', type: '2' }], 'TAR_ENTRY_TYPE'),
  );
});

test('E2 tar: rejects a hard-link archive entry', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/link', type: '1' }], 'TAR_ENTRY_TYPE'),
  );
});

test('E2 tar: rejects a device archive entry', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/device', type: '3' }], 'TAR_ENTRY_TYPE'),
  );
});

test('E2 tar: rejects a FIFO archive entry', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/fifo', type: '6' }], 'TAR_ENTRY_TYPE'),
  );
});

test('E2 tar: rejects a PAX archive entry', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/pax', type: 'x' }], 'TAR_ENTRY_TYPE'),
  );
});

test('E2 tar: rejects an absolute package path', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: '/package/escape.mjs', data: 'x' }], 'TAR_PATH'),
  );
});

test('E2 tar: rejects a dot-dot package path', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/../escape.mjs', data: 'x' }], 'TAR_PATH'),
  );
});

test('E2 tar: rejects a backslash package path', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package\\escape.mjs', data: 'x' }], 'TAR_PATH'),
  );
});

test('E2 tar: rejects an embedded-NUL package path', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(
      directory,
      [{ path: 'package/ignored', data: 'x', rawName: Buffer.from('package/a\0b', 'binary') }],
      'TAR_PATH',
    ),
  );
});

test('E2 tar: rejects duplicate listed package entries', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(
      directory,
      [
        { path: 'package/index.mjs', data: 'one' },
        { path: 'package/index.mjs', data: 'two' },
      ],
      'TAR_DUPLICATE',
    ),
  );
});

test('E2 tar: rejects duplicate unlisted package entries', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(
      directory,
      [
        { path: 'package/unused.mjs', data: 'one' },
        { path: 'package/unused.mjs', data: 'two' },
      ],
      'TAR_DUPLICATE',
    ),
  );
});

test('E2 tar: rejects a malformed ustar checksum', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/index.mjs', data: 'x' }], 'TAR_CHECKSUM', {
      corruptChecksum: true,
    }),
  );
});

test('E2 tar: accepts npm-pack, GNU tar, and bsdtar checksum layouts', async () => {
  await withTemporaryDirectory(async (directory) => {
    const { inspectPackageArchive } = await tarModule();
    for (const layout of ['npm-pack', 'gnu-tar', 'bsdtar'] as const) {
      const archive = await writeModifiedUstarFixture(
        directory,
        `${layout}.tgz`,
        [{ path: 'package/index.mjs', data: layout }],
        (header) => setArchiverChecksum(header, layout),
      );
      assert.deepEqual(await inspectPackageArchive(archiveChunks(archive)), [
        { ...runtimeFile('index.mjs', layout), path: 'index.mjs' },
      ]);
    }
  });
});

test('E2 tar: rejects a wrong accepted-layout checksum before writing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const archive = await writeModifiedUstarFixture(
      directory,
      'wrong-checksum.tgz',
      [{ path: 'package/index.mjs', data: 'x' }],
      (header) => {
        setArchiverChecksum(header, 'npm-pack');
        const lastDigit = header[154];
        header[154] = lastDigit === '7'.charCodeAt(0) ? '6'.charCodeAt(0) : '7'.charCodeAt(0);
      },
    );
    await expectExtractionFailureWithoutWriting(directory, archive, [runtimeFile('index.mjs', 'x')], 'TAR_CHECKSUM');
  });
});

for (const field of NUMERIC_HEADER_FIELDS) {
  test(field.testName, async () => {
    for (const kind of ['non-octal', 'base-256', 'overflow', 'negative'] as const) {
      await withTemporaryDirectory(async (directory) => {
        const archive = await writeModifiedUstarFixture(
          directory,
          `${field.name}-${kind}.tgz`,
          [{ path: 'package/index.mjs', data: 'x' }],
          (header) => {
            malformedNumericField(kind, field.width).copy(header, field.offset);
            setArchiverChecksum(header, 'npm-pack');
          },
        );
        await expectExtractionFailureWithoutWriting(directory, archive, [runtimeFile('index.mjs', 'x')], 'TAR_HEADER');
      });
    }
  });
}

test('E2 tar: rejects case-folded package path collision before writing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const upper = runtimeFile('Foo.mjs', 'upper');
    const archive = await writeUstarFixture(directory, 'case-collision.tgz', [
      { path: 'package/Foo.mjs', data: 'upper' },
      { path: 'package/foo.mjs', data: 'lower' },
    ]);
    await expectInspectionFailure(archive, 'TAR_DUPLICATE');
    await expectExtractionFailureWithoutWriting(directory, archive, [upper], 'TAR_DUPLICATE');
  });
});

test('E2 tar: rejects Unicode case-folded package path collision before writing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = runtimeFile('Stra\u00dfe.mjs', 'first');
    const archive = await writeUstarFixture(directory, 'unicode-case-collision.tgz', [
      { path: 'package/Stra\u00dfe.mjs', data: 'first' },
      { path: 'package/STRASSE.mjs', data: 'second' },
    ]);
    await expectInspectionFailure(archive, 'TAR_DUPLICATE');
    await expectExtractionFailureWithoutWriting(directory, archive, [first], 'TAR_DUPLICATE');
  });
});

test('E2 tar: rejects NFC and NFD package path collision before writing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const nfc = runtimeFile('caf\u00e9.mjs', 'nfc');
    const archive = await writeUstarFixture(directory, 'normalisation-collision.tgz', [
      { path: 'package/caf\u00e9.mjs', data: 'nfc' },
      { path: 'package/cafe\u0301.mjs', data: 'nfd' },
    ]);
    await expectInspectionFailure(archive, 'TAR_PATH');
    await expectExtractionFailureWithoutWriting(directory, archive, [nfc], 'TAR_PATH');
  });
});

test('E2 tar: rejects a non-NFC package path before writing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const archive = await writeUstarFixture(directory, 'non-nfc.tgz', [
      { path: 'package/cafe\u0301.mjs', data: 'nfd' },
    ]);
    await expectInspectionFailure(archive, 'TAR_PATH');
    await expectExtractionFailureWithoutWriting(directory, archive, [], 'TAR_PATH');
  });
});

test('E2 tar: rejects a malformed ustar header', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/index.mjs', data: 'x' }], 'TAR_HEADER', { corruptHeader: true }),
  );
});

test('E2 tar: refuses whole archive before staging a later malformed header', { skip: WINDOWS_SKIP }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const listed = runtimeFile('first.mjs', 'first');
    const archive = await writeModifiedUstarFixture(
      directory,
      'late-bad-header.tgz',
      [
        { path: 'package/first.mjs', data: 'first' },
        { path: 'package/later.mjs', data: 'later' },
      ],
      (header) => {
        header[257] = 'x'.charCodeAt(0);
        setArchiverChecksum(header, 'npm-pack');
      },
      1,
    );
    await expectWholeArchiveRefusalBeforeStaging(directory, archive, [listed], 'TAR_HEADER');
  });
});

test('E2 tar: refuses whole archive before staging a later implied-directory collision', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    const listed = runtimeFile('Foo/first.mjs', 'first');
    const archive = await writeUstarFixture(directory, 'late-directory-collision.tgz', [
      { path: 'package/Foo/first.mjs', data: 'first' },
      { path: 'package/foo/later.mjs', data: 'later' },
    ]);
    await expectWholeArchiveRefusalBeforeStaging(directory, archive, [listed], 'TAR_DUPLICATE');
  });
});

test('E2 tar: rejects a malformed ustar size', async () => {
  await withTemporaryDirectory((directory) =>
    expectTarFailure(directory, [{ path: 'package/index.mjs', data: 'x' }], 'TAR_HEADER', { corruptSize: true }),
  );
});

test('E2 tar: refuses a listed file with the wrong SHA-256', async () => {
  await withTemporaryDirectory(async (directory) => {
    const archive = await writeUstarFixture(directory, 'wrong-hash.tgz', [{ path: 'package/index.mjs', data: 'x' }]);
    const expected = { ...runtimeFile('index.mjs', 'y'), executable: false };
    const { extractPackageArchive, LayaTarError } = await tarModule();
    await assert.rejects(
      () =>
        extractPackageArchive({
          source: archiveChunks(archive),
          destination: join(directory, 'output'),
          files: [expected],
        }),
      (error: unknown) => error instanceof LayaTarError && error.code === 'TAR_HASH',
    );
  });
});

test('E2 tar: refuses a listed file with the wrong size', async () => {
  await withTemporaryDirectory(async (directory) => {
    const archive = await writeUstarFixture(directory, 'wrong-size.tgz', [{ path: 'package/index.mjs', data: 'x' }]);
    const expected = { ...runtimeFile('index.mjs', 'x'), size: 2, executable: false };
    const { extractPackageArchive, LayaTarError } = await tarModule();
    await assert.rejects(
      () =>
        extractPackageArchive({
          source: archiveChunks(archive),
          destination: join(directory, 'output'),
          files: [expected],
        }),
      (error: unknown) => error instanceof LayaTarError && error.code === 'TAR_SIZE',
    );
  });
});

test('E2 tar: refuses a listed file with the wrong executable bit', async () => {
  await withTemporaryDirectory(async (directory) => {
    const archive = await writeUstarFixture(directory, 'wrong-mode.tgz', [
      { path: 'package/index.mjs', data: 'x', mode: 0o644 },
    ]);
    const expected = { ...runtimeFile('index.mjs', 'x'), executable: true };
    const { extractPackageArchive, LayaTarError } = await tarModule();
    await assert.rejects(
      () =>
        extractPackageArchive({
          source: archiveChunks(archive),
          destination: join(directory, 'output'),
          files: [expected],
        }),
      (error: unknown) => error instanceof LayaTarError && error.code === 'TAR_EXECUTABLE',
    );
  });
});

test('E2 tar: never invokes a system archive, package-manager, or install-script path', async () => {
  const source = await readFile(new URL('../src/runtime/laya/tar.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:child_process|\bspawn\b|\bexec\b|\bnpm\b|install-script/);
});
