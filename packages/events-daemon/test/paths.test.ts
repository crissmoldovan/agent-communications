import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  EventPathError,
  type EventPathIo,
  ensureEventPaths,
  ensureOwnerOnlyFile,
  eventPaths,
} from '../src/runtime/paths.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('CTRL-B1: event paths create an owner-only directory and file below the supplied state root', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'events-daemon-paths-'));
  try {
    await chmod(root, 0o700);
    const paths = eventPaths(root);
    await ensureEventPaths(paths);
    await ensureOwnerOnlyFile(paths.controlToken);

    assert.equal((await stat(paths.root)).mode & 0o077, 0);
    assert.equal((await stat(paths.controlToken)).mode & 0o077, 0);
    assert.equal((await stat(paths.controlToken)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CTRL-B1: event paths refuse a state root that is a symbolic link or group-readable', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'events-daemon-paths-'));
  try {
    const actual = join(root, 'actual');
    const linked = join(root, 'linked');
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linked);
    await assert.rejects(
      () => ensureEventPaths(eventPaths(linked)),
      (error: unknown) => {
        assert.ok(error instanceof EventPathError);
        assert.equal(error.code, 'EVENT_PATH_LINK');
        return true;
      },
    );
    assert.ok((await lstat(linked)).isSymbolicLink());

    const weak = join(root, 'weak');
    await mkdir(weak, { mode: 0o700 });
    await chmod(weak, 0o755);
    await assert.rejects(
      () => ensureEventPaths(eventPaths(weak)),
      (error: unknown) => {
        assert.ok(error instanceof EventPathError);
        assert.equal(error.code, 'EVENT_PATH_PERMISSIONS');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CTRL-B1: an event state file must be a private regular file, never a directory', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'events-daemon-paths-'));
  try {
    await chmod(root, 0o700);
    const paths = eventPaths(root);
    await ensureEventPaths(paths);
    await mkdir(paths.controlToken, { mode: 0o700 });
    await assert.rejects(
      () => ensureOwnerOnlyFile(paths.controlToken),
      (error: unknown) => {
        assert.ok(error instanceof EventPathError);
        assert.equal(error.code, 'EVENT_PATH_TYPE');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CTRL-B1: Windows path checks refuse a reparse point and an ACL that admits another user', async () => {
  const directories = new Map<string, { mode: number; reparse?: boolean }>([
    ['C:/state', { mode: 0o700 }],
    ['C:/state/events', { mode: 0o700 }],
  ]);
  const io: EventPathIo = {
    async mkdir(path) {
      directories.set(path, directories.get(path) ?? { mode: 0o700 });
    },
    async lstat(path) {
      const entry = directories.get(path);
      if (entry === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        mode: entry.mode,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    },
    async chmod() {},
    async open() {
      throw new Error('not used by this test');
    },
    async isReparsePoint(path) {
      return directories.get(path)?.reparse === true;
    },
    async isCurrentUserOnly(path) {
      return path !== 'C:/state/events';
    },
  };

  await assert.rejects(
    () => ensureEventPaths(eventPaths('C:/state'), { io, platform: 'win32' }),
    (error: unknown) => {
      assert.ok(error instanceof EventPathError);
      assert.equal(error.code, 'EVENT_PATH_PERMISSIONS');
      return true;
    },
  );

  directories.set('C:/state/events', { mode: 0o700, reparse: true });
  await assert.rejects(
    () => ensureEventPaths(eventPaths('C:/state'), { io, platform: 'win32' }),
    (error: unknown) => {
      assert.ok(error instanceof EventPathError);
      assert.equal(error.code, 'EVENT_PATH_REPARSE_POINT');
      return true;
    },
  );
});
