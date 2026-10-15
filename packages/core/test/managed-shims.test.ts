import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inspectManagedShim,
  managedShimDirectory,
  managedShimPath,
  managedShimsSupported,
  removeManagedShimsForRuntimes,
  writeManagedShim,
} from '../src/managed-shims.ts';
import { tempDir } from './helpers/temp.ts';

const WINDOWS_SKIP =
  process.platform === 'win32' ? { skip: 'WINDOWS_SKIP: this test executes a POSIX shell shim' } : {};

function fixture(platform: NodeJS.Platform = 'linux') {
  const home = tempDir('shim-home-');
  const dataDir = join(home, 'data');
  const env = { HOME: home, USERPROFILE: home, PATH: '' };
  return { context: { env, dataDir, platform }, home, dataDir };
}

function entryAt(root: string, name: string): string {
  const entry = join(root, name, 'node_modules', '@agentcomms', 'core', 'dist', 'cli.mjs');
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(
    entry,
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.SHIM_OUT, JSON.stringify(process.argv.slice(2)));\n",
  );
  return entry;
}

test('managed CLI shims are offered only on macOS and Linux', () => {
  assert.equal(managedShimsSupported({ platform: 'darwin' }), true, 'macOS supports the POSIX managed shim');
  assert.equal(managedShimsSupported({ platform: 'linux' }), true, 'Linux supports the POSIX managed shim');
  assert.equal(managedShimsSupported({ platform: 'win32' }), false, 'Windows does not offer a managed shim');
  assert.equal(managedShimsSupported({ platform: 'freebsd' }), false, 'other platforms are not offered a shim');
});

test(
  'a POSIX managed shim runs the managed Node and entry, repoints on update and explains PATH',
  WINDOWS_SKIP,
  async () => {
    const { context, home } = fixture();
    const first = entryAt(home, 'runtime/0.17.0-core');
    const written = await writeManagedShim(context, {
      binary: 'agentcomms',
      command: [process.execPath, first],
      entry: first,
    });
    assert.equal(written.status, 'created', 'the first managed install creates its shim');
    assert.equal(written.path, join(home, '.local', 'bin', 'agentcomms'), 'POSIX uses the user-local bin directory');
    assert.equal(written.onPath, false, 'the empty temporary PATH does not contain the shim directory');
    assert.match(written.pathNotice ?? '', /export PATH=/, 'the result explains how to prepend the directory now');
    assert.match(written.pathNotice ?? '', /No shell profile was edited/, 'the result says no profile was edited');
    assert.equal(statSync(written.path).mode & 0o111, 0o111, 'the POSIX shim is executable');

    const out = join(home, 'first.json');
    const ran = spawnSync(written.path, ['alpha', 'two words'], {
      env: { ...process.env, SHIM_OUT: out },
      encoding: 'utf8',
    });
    assert.equal(ran.status, 0, `the first shim runs successfully: ${ran.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['alpha', 'two words'], 'the shim forwards every argument');

    const second = entryAt(home, 'runtime/0.18.0-core');
    const updated = await writeManagedShim(context, {
      binary: 'agentcomms',
      command: [process.execPath, second],
      entry: second,
    });
    assert.equal(updated.status, 'updated', 'an update repoints an owned shim');
    assert.match(
      readFileSync(updated.path, 'utf8'),
      new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the shim names the new entry',
    );
    assert.doesNotMatch(
      readFileSync(updated.path, 'utf8'),
      new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the shim no longer names the old entry',
    );
  },
);

test('shim ownership protects foreign files and inspection distinguishes missing, stale and foreign', async () => {
  const { context, home, dataDir } = fixture();
  const first = entryAt(home, 'runtime/0.17.0-core');
  const second = entryAt(home, 'runtime/0.18.0-core');
  const bin = managedShimDirectory(context);
  mkdirSync(bin, { recursive: true });
  const foreignPath = managedShimPath(context, 'agent-gmail');
  writeFileSync(foreignPath, 'belongs to somebody else\n');

  const refused = await writeManagedShim(context, {
    binary: 'agent-gmail',
    command: [process.execPath, first],
    entry: first,
  });
  assert.equal(refused.status, 'foreign', 'a pre-existing unreceipted shim is foreign');
  assert.equal(readFileSync(foreignPath, 'utf8'), 'belongs to somebody else\n', 'a foreign shim is not overwritten');

  const owned = await writeManagedShim(context, {
    binary: 'agentcomms',
    command: [process.execPath, first],
    entry: first,
  });
  assert.equal(owned.status, 'created', 'a free target becomes owned');
  assert.equal(
    (await inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: first })).status,
    'current',
    'the matching receipt and expected entry are current',
  );
  assert.equal(
    (await inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: second })).status,
    'stale',
    'an owned shim aimed at an older runtime is stale',
  );

  writeFileSync(owned.path, 'changed after install\n');
  const changed = await inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: first });
  assert.equal(changed.status, 'foreign', 'changed bytes are no longer owned');
  const notUpdated = await writeManagedShim(context, {
    binary: 'agentcomms',
    command: [process.execPath, second],
    entry: second,
  });
  assert.equal(notUpdated.status, 'foreign', 'an update does not overwrite changed bytes');
  assert.equal(readFileSync(owned.path, 'utf8'), 'changed after install\n', 'the changed file remains byte-for-byte');

  const slack = await writeManagedShim(context, {
    binary: 'agent-slack',
    command: [process.execPath, first],
    entry: first,
  });
  assert.equal(slack.status, 'created', 'another free target is owned independently');
  rmSync(slack.path);
  assert.equal(
    (await inspectManagedShim(context, { binary: 'agent-slack', expectedEntry: first })).status,
    'missing',
    'a receipted shim whose file is gone is missing',
  );

  const resend = await writeManagedShim(context, {
    binary: 'agent-resend',
    command: [process.execPath, first],
    entry: first,
  });
  assert.equal(resend.status, 'created', 'the prune fixture owns its shim');
  const whatsapp = await writeManagedShim(context, {
    binary: 'agent-whatsapp',
    command: [process.execPath, first],
    entry: first,
  });
  assert.equal(whatsapp.status, 'created', 'the changed-receipt fixture begins with an owned shim');
  const otherPath = join(home, 'somebody-elses-agent-whatsapp');
  writeFileSync(otherPath, readFileSync(whatsapp.path, 'utf8'));
  const receiptPath = join(dataDir, 'managed-shims.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    shims: Record<string, { path: string }>;
  };
  const whatsappReceipt = receipt.shims['agent-whatsapp'];
  assert.ok(whatsappReceipt, 'the fixture can alter the recorded path without changing its digest');
  whatsappReceipt.path = otherPath;
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const removed = await removeManagedShimsForRuntimes(context, [join(home, 'runtime/0.17.0-core')]);
  assert.deepEqual(removed.removed, [resend.path], 'prune removes an unchanged owned shim into the removed runtime');
  assert.ok(removed.kept.includes(owned.path), 'prune keeps the changed foreign shim');
  assert.ok(removed.kept.includes(otherPath), 'prune treats a receipt for another path as foreign');
  assert.equal(
    readFileSync(otherPath, 'utf8'),
    readFileSync(whatsapp.path, 'utf8'),
    'prune never deletes the other path',
  );
  assert.equal(readFileSync(owned.path, 'utf8'), 'changed after install\n', 'prune does not delete foreign bytes');
});

test('a receipt that names a shim by a path rather than a command name is trusted in nothing it says', async () => {
  const { context, home, dataDir } = fixture();
  const first = entryAt(home, 'runtime/0.17.0-core');
  const owned = await writeManagedShim(context, {
    binary: 'agentcomms',
    command: [process.execPath, first],
    entry: first,
  });
  assert.equal(owned.status, 'created', 'the fixture begins with an owned shim into the runtime prune removes');
  mkdirSync(join(home, 'Documents'));
  const outside = join(home, 'Documents', 'taxes.txt');
  writeFileSync(outside, 'not a shim\n');
  // Every other field holds: the path is the key joined onto the directory, the digest is the file's, the entry is
  // inside the runtime being removed. Only the key, a path out of the directory, gives it away.
  const key = '../../Documents/taxes.txt';
  const receiptPath = join(dataDir, 'managed-shims.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { shims: Record<string, unknown> };
  receipt.shims[key] = {
    path: join(realpathSync(managedShimDirectory(context)), key),
    digest: createHash('sha256').update('not a shim\n').digest('hex'),
    node: process.execPath,
    entry: first,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const pruned = await removeManagedShimsForRuntimes(context, [join(home, 'runtime/0.17.0-core')]);
  assert.deepEqual(pruned, { removed: [], kept: [] }, 'prune acts on no entry of a receipt with a path for a name');
  assert.equal(readFileSync(outside, 'utf8'), 'not a shim\n', 'the file outside the shim directory survives');
  assert.match(readFileSync(owned.path, 'utf8'), /^#!\/bin\/sh\n/, 'and the owned shim is left with the rest');
  await assert.rejects(
    writeManagedShim(context, { binary: '../escape', command: [process.execPath, first], entry: first }),
    (error: Error & { code?: string }) =>
      error.code === 'CONFIG' && /not a safe managed CLI binary name/.test(error.message),
    'a write names its shim by a command name too',
  );
});

test('a file replaced after ownership inspection is neither overwritten nor deleted', async () => {
  const replacing = fixture();
  const first = entryAt(replacing.home, 'runtime/0.17.0-core');
  const second = entryAt(replacing.home, 'runtime/0.18.0-core');
  const owned = await writeManagedShim(replacing.context, {
    binary: 'agentcomms',
    command: [process.execPath, first],
    entry: first,
  });
  assert.equal(owned.status, 'created', 'the replacement race begins with an owned shim');
  const racedWrite = await writeManagedShim(
    {
      ...replacing.context,
      hooks: { beforeReplace: () => writeFileSync(owned.path, 'foreign during replace\n') },
    },
    { binary: 'agentcomms', command: [process.execPath, second], entry: second },
  );
  assert.equal(racedWrite.status, 'foreign', 'the changed filesystem object aborts the owned replacement');
  assert.equal(
    readFileSync(owned.path, 'utf8'),
    'foreign during replace\n',
    'replacement restores the foreign bytes instead of overwriting them',
  );

  const pruning = fixture();
  const pruneEntry = entryAt(pruning.home, 'runtime/0.17.0-core');
  const pruneOwned = await writeManagedShim(pruning.context, {
    binary: 'agentcomms',
    command: [process.execPath, pruneEntry],
    entry: pruneEntry,
  });
  assert.equal(pruneOwned.status, 'created', 'the prune race begins with an owned shim');
  const racedPrune = await removeManagedShimsForRuntimes(
    {
      ...pruning.context,
      hooks: { beforeRemove: () => writeFileSync(pruneOwned.path, 'foreign during prune\n') },
    },
    [join(pruning.home, 'runtime/0.17.0-core')],
  );
  assert.deepEqual(racedPrune.removed, [], 'prune no longer claims the raced foreign path was removed');
  assert.deepEqual(racedPrune.kept, [pruneOwned.path], 'prune reports the raced foreign path as kept');
  assert.equal(
    readFileSync(pruneOwned.path, 'utf8'),
    'foreign during prune\n',
    'prune restores the foreign bytes instead of deleting them',
  );
});

test(
  'a symlinked bin stays usable, but changing its resolved directory refuses update and prune without touching files',
  WINDOWS_SKIP,
  async () => {
    const replacing = fixture();
    const publicBin = managedShimDirectory(replacing.context);
    const firstBin = join(replacing.home, 'first-bin');
    const secondBin = join(replacing.home, 'second-bin');
    mkdirSync(join(publicBin, '..'), { recursive: true });
    mkdirSync(firstBin);
    mkdirSync(secondBin);
    symlinkSync(firstBin, publicBin, 'dir');
    const first = entryAt(replacing.home, 'runtime/0.17.0-core');
    const second = entryAt(replacing.home, 'runtime/0.18.0-core');
    const owned = await writeManagedShim(replacing.context, {
      binary: 'agentcomms',
      command: [process.execPath, first],
      entry: first,
    });
    assert.equal(owned.status, 'created', 'a bin directory that is itself a symlink accepts a managed shim');
    assert.equal(
      readFileSync(join(firstBin, 'agentcomms'), 'utf8'),
      readFileSync(owned.path, 'utf8'),
      'the shim is written inside the symlink target and remains reachable through the public path',
    );
    const original = readFileSync(owned.path, 'utf8');
    writeFileSync(join(secondBin, 'agentcomms'), original);
    const swapBin = () => {
      // The link itself: Node 24's rmSync refuses a symlink to a directory without `recursive`.
      unlinkSync(publicBin);
      symlinkSync(secondBin, publicBin, 'dir');
    };

    await assert.rejects(
      writeManagedShim(
        { ...replacing.context, hooks: { beforeReplace: swapBin } },
        { binary: 'agentcomms', command: [process.execPath, second], entry: second },
      ),
      /resolved directory changed/i,
      'an update refuses when the public bin path resolves somewhere else immediately before replacement',
    );
    assert.equal(
      readFileSync(join(firstBin, 'agentcomms'), 'utf8'),
      original,
      'the originally resolved shim is unchanged after the refused update',
    );
    assert.equal(
      readFileSync(join(secondBin, 'agentcomms'), 'utf8'),
      original,
      'the same-byte file under the replacement directory is not mistaken for the owned shim',
    );

    const pruning = fixture();
    const prunePublicBin = managedShimDirectory(pruning.context);
    const pruneFirstBin = join(pruning.home, 'first-bin');
    const pruneSecondBin = join(pruning.home, 'second-bin');
    mkdirSync(join(prunePublicBin, '..'), { recursive: true });
    mkdirSync(pruneFirstBin);
    mkdirSync(pruneSecondBin);
    symlinkSync(pruneFirstBin, prunePublicBin, 'dir');
    const pruneEntry = entryAt(pruning.home, 'runtime/0.17.0-core');
    const pruneOwned = await writeManagedShim(pruning.context, {
      binary: 'agentcomms',
      command: [process.execPath, pruneEntry],
      entry: pruneEntry,
    });
    const pruneOriginal = readFileSync(pruneOwned.path, 'utf8');
    writeFileSync(join(pruneSecondBin, 'agentcomms'), pruneOriginal);
    await assert.rejects(
      removeManagedShimsForRuntimes(
        {
          ...pruning.context,
          hooks: {
            beforeRemove: () => {
              unlinkSync(prunePublicBin);
              symlinkSync(pruneSecondBin, prunePublicBin, 'dir');
            },
          },
        },
        [join(pruning.home, 'runtime/0.17.0-core')],
      ),
      /resolved directory changed/i,
      'prune refuses when the public bin path resolves somewhere else immediately before removal',
    );
    assert.equal(
      readFileSync(join(pruneFirstBin, 'agentcomms'), 'utf8'),
      pruneOriginal,
      'the originally resolved shim is unchanged after the refused prune',
    );
    assert.equal(
      readFileSync(join(pruneSecondBin, 'agentcomms'), 'utf8'),
      pruneOriginal,
      'prune never removes the same-byte file under the replacement directory',
    );
  },
);

test('concurrent shim writes preserve both receipt entries', async () => {
  const { context, home } = fixture();
  const entry = entryAt(home, 'runtime/0.17.0-core');
  const [core, gmail] = await Promise.all([
    writeManagedShim(context, { binary: 'agentcomms', command: [process.execPath, entry], entry }),
    writeManagedShim(context, { binary: 'agent-gmail', command: [process.execPath, entry], entry }),
  ]);
  assert.equal(core.status, 'created', 'the concurrent core shim is created');
  assert.equal(gmail.status, 'created', 'the concurrent Gmail shim is created');
  assert.equal(
    (await inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: entry })).status,
    'current',
    'the core receipt survives the concurrent Gmail write',
  );
  assert.equal(
    (await inspectManagedShim(context, { binary: 'agent-gmail', expectedEntry: entry })).status,
    'current',
    'the Gmail receipt survives the concurrent core write',
  );
});

test('a stale corrupt mutation lock left by a crashed install is recovered', async () => {
  const { context, home, dataDir } = fixture();
  const entry = entryAt(home, 'runtime/0.17.0-core');
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'managed-shims.lock');
  writeFileSync(lock, 'a crashed writer left an incomplete lock body');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);

  const result = await writeManagedShim(
    { ...context, lockOptions: { staleMs: 10, timeoutMs: 100 } },
    { binary: 'agentcomms', command: [process.execPath, entry], entry },
  );

  assert.equal(result.status, 'created', 'an abandoned corrupt lock does not wedge future managed installs');
  assert.equal(
    (await inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: entry })).status,
    'current',
    'the recovered mutation still leaves a current owned shim and receipt',
  );
});

test(
  'a shim naming the file a link to the expected Node resolves to is stale; one naming the link is never (CUE-492)',
  WINDOWS_SKIP,
  async () => {
    const { context, home } = fixture();
    const entry = entryAt(home, 'runtime/0.19.0-core');
    const link = join(home, 'bin', 'node');
    mkdirSync(join(home, 'bin'));
    symlinkSync(process.execPath, link);
    const real = realpathSync(process.execPath);
    const inspect = (expectedNode: string) =>
      inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: entry, expectedNode });

    // What an earlier release wrote: the file the system reports, where PATH finds this Node by a link.
    await writeManagedShim(context, { binary: 'agentcomms', command: [real, entry], entry });
    const stale = await inspect(link);
    assert.equal(stale.status, 'stale', stale.detail);
    assert.ok(stale.detail.includes(real) && stale.detail.includes(link), stale.detail);
    assert.equal((await inspect(real)).status, 'current', 'with no link on PATH, the real file is what is expected');

    // Written now: the link. A process that finds this Node only by its real file never calls the link stale, and a
    // Node that is another file altogether is not this one to judge by.
    await writeManagedShim(context, { binary: 'agentcomms', command: [link, entry], entry });
    assert.equal((await inspect(link)).status, 'current');
    assert.equal((await inspect(real)).status, 'current', 'a link is never repointed to the file it resolves to');
    assert.equal((await inspect('/opt/another/bin/node')).status, 'current', 'another Node is not judged by this one');
  },
);

test(
  'a shim naming its entry by the real path is current where the runtime is found through a linked folder',
  WINDOWS_SKIP,
  async () => {
    // The locator names the entry it checked by its real path; the doctor finds the runtime by the data folder's path.
    const { context, home } = fixture();
    const entry = realpathSync(entryAt(home, 'runtime/0.19.0-core'));
    const linked = join(home, 'linked-runtime');
    symlinkSync(join(home, 'runtime'), linked);
    const throughLink = join(linked, '0.19.0-core', 'node_modules', '@agentcomms', 'core', 'dist', 'cli.mjs');
    await writeManagedShim(context, { binary: 'agentcomms', command: [process.execPath, entry], entry });
    const current = await inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: throughLink });
    assert.equal(current.status, 'current', current.detail);
    const other = entryAt(home, 'runtime/0.20.0-core');
    const stale = await inspectManagedShim(context, { binary: 'agentcomms', expectedEntry: other });
    assert.equal(stale.status, 'stale', 'another runtime is still another entry');
  },
);
