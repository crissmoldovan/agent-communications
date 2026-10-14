import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import { verifyPhaseEPrerequisites } from '../../../scripts/verify-events-phase-e-prerequisites.mjs';
import { assertPhaseEPrerequisites } from '../src/runtime/phase-e-prerequisites.ts';

const ROOT = join(import.meta.dirname, '../../..');
const exec = promisify(execFile);

async function prerequisiteFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-e3-prerequisites-'));
  await Promise.all([
    cp(join(ROOT, 'packages/events-daemon/src'), join(root, 'packages/events-daemon/src'), { recursive: true }),
    cp(join(ROOT, 'packages/events-daemon/test/fixtures'), join(root, 'packages/events-daemon/test/fixtures'), {
      recursive: true,
    }),
    cp(join(ROOT, 'capabilities.json'), join(root, 'capabilities.json')),
    cp(join(ROOT, 'package.json'), join(root, 'package.json')),
    cp(
      join(ROOT, 'packages/events-daemon/test/b3-consumer-contract.test.ts'),
      join(root, 'packages/events-daemon/test/b3-consumer-contract.test.ts'),
    ),
  ]);
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(
    join(ROOT, 'packages/events-daemon/node_modules'),
    join(root, 'packages/events-daemon/node_modules'),
    'dir',
  );
  return root;
}

async function replace(root: string, file: string, from: string, to: string): Promise<void> {
  const path = join(root, file);
  const text = await readFile(path, 'utf8');
  assert.equal(text.split(from).length - 1, 1, `${file} contains the exact prerequisite guard once`);
  await writeFile(path, text.replace(from, to));
}

async function stubCanonicalJudge(root: string): Promise<void> {
  const file = join(root, 'packages/events-daemon/src/domain/judges.ts');
  const source = await readFile(file, 'utf8');
  const start = source.indexOf('export function canonicalJudge(value: unknown): CanonicalJudgeDocument {');
  const end = source.indexOf('\nfunction limits(', start);
  assert.notEqual(start, -1, 'fixture contains the canonical judge parser');
  assert.notEqual(end, -1, 'fixture contains the parser boundary');
  await writeFile(
    file,
    `${source.slice(0, start)}export function canonicalJudge(value: unknown): CanonicalJudgeDocument {\n` +
      '  return value as CanonicalJudgeDocument;\n' +
      `}\n${source.slice(end)}`,
  );
}

async function releaseFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentcomms-e3-release-'));
  await cp(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  const entries = await readdir(join(ROOT, 'packages'), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const destination = join(root, 'packages', entry.name);
    await mkdir(destination, { recursive: true });
    await cp(join(ROOT, 'packages', entry.name, 'package.json'), join(destination, 'package.json'));
  }
  await writeFile(join(root, 'scripts/packages.mjs'), "export const PACKAGES = []; export const SCOPE = '@fixture';\n");
  // release.mjs imports both gates in-process, so each stand-in exports the function it calls: the first refuses, and
  // the second throws only if it is ever reached.
  await writeFile(
    join(root, 'scripts/verify-events-phase-e-prerequisites.mjs'),
    "export async function verifyPhaseEPrerequisites() { return ['fixture Phase-E gate refused']; }\n",
  );
  await writeFile(
    join(root, 'scripts/verify-events-phase-e-tests.mjs'),
    "export async function verifyPhaseETestManifest() { throw new Error('second gate must not run'); }\n",
  );
  return root;
}

test('E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs', async () => {
  assert.doesNotThrow(() => assertPhaseEPrerequisites());
  assert.deepEqual(await verifyPhaseEPrerequisites({ root: ROOT }), []);
});

test('E3: root verify and package verification invoke both Phase-E gates once built, before typecheck, tests or ship', async () => {
  const rootPackage = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  for (const script of ['verify', 'preverify:packages']) {
    assert.match(rootPackage.scripts[script] ?? '', /verify:events-phase-e-prerequisites/u, script);
    assert.match(rootPackage.scripts[script] ?? '', /verify:events-phase-e-tests/u, script);
  }
  // The prerequisite gate loads the daemon's real source, which imports the built workspace packages: on a clean
  // checkout it can run only after `pnpm build`, and it must still refuse before typecheck, the tests and packaging.
  const verify = rootPackage.scripts.verify ?? '';
  const at = (step: string): number => verify.indexOf(step);
  assert.ok(at('pnpm build') >= 0 && at('pnpm build') < at('pnpm verify:events-phase-e-prerequisites'), verify);
  for (const later of ['pnpm typecheck', 'pnpm test', 'pnpm verify:packages'])
    assert.ok(at('pnpm verify:events-phase-e-tests') < at(later), `${later} runs after both gates`);
});

test('E3: release --publish --skip-verify stops at a failing Phase-E gate before registry or publish work', async () => {
  const root = await releaseFixture();
  try {
    const result = await exec(process.execPath, ['scripts/release.mjs', '--publish', '--skip-verify'], {
      cwd: root,
      encoding: 'utf8',
    }).then(
      () => assert.fail('release must refuse a failing prerequisite gate'),
      (error: { readonly code?: number; readonly stdout?: string; readonly stderr?: string }) => error,
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.notEqual(result.code, 0);
    assert.match(output, /fixture Phase-E gate refused/u);
    assert.doesNotMatch(output, /second gate must not run/u, 'the strict-test gate never runs after the first refuses');
    assert.doesNotMatch(output, /npm whoami|Publishing /u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E3: every B3 prerequisite drift refuses the E build/package/release gate before E registration', async () => {
  const root = await prerequisiteFixture();
  try {
    const cases = [
      {
        label: 'B3 control schema',
        file: 'packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json',
        from: 'https://agentcomms.local/b3-control-v1.schema.json',
        to: 'https://agentcomms.local/stubbed-b3-control-v1.schema.json',
        expected: 'B3 control schema has the stable v1 id',
      },
      {
        label: 'B3 doctor schema',
        file: 'packages/events-daemon/src/operations/contracts/doctor-v1.schema.json',
        from: 'https://agentcomms.local/events-doctor-v1.schema.json',
        to: 'https://agentcomms.local/stubbed-events-doctor-v1.schema.json',
        expected: 'B3 doctor schema has the stable v1 id',
      },
      {
        label: 'B3 secret capability row',
        file: 'capabilities.json',
        from: 'events-daemon.judge-key.rotate',
        to: 'events-daemon.judge-key.rotated-away',
        expected: 'B3 human-only exception row exists: events-daemon.judge-key.rotate',
      },
      {
        label: 'B3 schema result branch',
        file: 'packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json',
        from: '"doctor": { "$ref": "https://agentcomms.local/events-doctor-v1.schema.json" }',
        to: '"doctor": false',
        expected: 'B3 schema rejects checked-in doctor result branch',
      },
      {
        label: 'B3 vector schema drift',
        file: 'packages/events-daemon/test/fixtures/b3-control-contract-v1/unavailable.json',
        from: '"operation": "judgesList"',
        to: '"operation": null',
        expected: 'B3 schema rejects checked-in vector judge-e-unavailable',
      },
      {
        label: 'B3 consumer preview fixture',
        file: 'packages/events-daemon/test/fixtures/b3-approval-preview-v1/stale.json',
        from: 'Approval view: STALE_APPROVAL',
        to: 'Approval view: WRONG',
        expected: 'B3 consumer preview fixture stale.json does not match the real preview renderer',
      },
    ] as const;

    for (const mutation of cases) {
      const fixture = await prerequisiteFixture();
      try {
        await replace(fixture, mutation.file, mutation.from, mutation.to);
        const problems = await verifyPhaseEPrerequisites({ root: fixture });
        assert.ok(problems.includes(mutation.expected), `${mutation.label}: ${problems.join('; ')}`);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    }
    const parserFixture = await prerequisiteFixture();
    try {
      await stubCanonicalJudge(parserFixture);
      assert.ok(
        (await verifyPhaseEPrerequisites({ root: parserFixture })).some((problem: string) =>
          problem.includes('canonical judge parser accepts an invalid document'),
        ),
        'the real gate executes invalid canonical judge documents from its copied production closure',
      );
    } finally {
      await rm(parserFixture, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E3: the exact B3 capability inventory rejects a removed row and a stubbed operation', async () => {
  for (const mutation of [
    {
      label: 'removed row',
      change: (capabilities: { capabilities: Array<{ id: string }> }) => {
        capabilities.capabilities = capabilities.capabilities.filter(
          (row) => row.id !== 'events-daemon.judge-kind.disable',
        );
      },
    },
    {
      label: 'stubbed operation',
      change: (capabilities: { capabilities: Array<{ id: string; operation?: string }> }) => {
        const row = capabilities.capabilities.find((entry) => entry.id === 'events-daemon.judge-kind.disable');
        assert.ok(row, 'fixture contains the B3 capability row');
        row.operation = 'stubbedDisableJudgeKind';
      },
    },
  ] as const) {
    const root = await prerequisiteFixture();
    try {
      const path = join(root, 'capabilities.json');
      const capabilities = JSON.parse(await readFile(path, 'utf8')) as {
        capabilities: Array<{ id: string; operation?: string }>;
      };
      mutation.change(capabilities);
      await writeFile(path, `${JSON.stringify(capabilities, null, 2)}\n`);
      const problems = await verifyPhaseEPrerequisites({ root });
      assert.equal(
        problems.includes('capabilities.json B3 projection matches the exact E-owned B3 capability inventory'),
        true,
        `${mutation.label} must fail the exact B3 inventory gate: ${problems.join('; ')}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('E3: the B3 v1 inventory is closed and digest-pinned even when vectors, previews, or its consumer are made inert', async () => {
  const emptyVectors = await prerequisiteFixture();
  try {
    for (const directory of ['b3-control-contract-v1', 'b3-approval-preview-v1']) {
      const path = join(emptyVectors, 'packages/events-daemon/test/fixtures', directory);
      for (const entry of await readdir(path)) await rm(join(path, entry));
    }
    const problems = await verifyPhaseEPrerequisites({ root: emptyVectors });
    assert.ok(
      problems.some((problem: string) => problem.includes('B3 v1 inventory missing file:')),
      `empty B3 v1 fixture directories must refuse: ${problems.join('; ')}`,
    );
  } finally {
    await rm(emptyVectors, { recursive: true, force: true });
  }

  const extraVector = await prerequisiteFixture();
  try {
    await writeFile(
      join(extraVector, 'packages/events-daemon/test/fixtures/b3-control-contract-v1/unreviewed.json'),
      '{"name":"unreviewed"}\n',
    );
    const problems = await verifyPhaseEPrerequisites({ root: extraVector });
    assert.ok(
      problems.includes(
        'B3 v1 inventory extra file: packages/events-daemon/test/fixtures/b3-control-contract-v1/unreviewed.json',
      ),
      `an extra B3 v1 fixture must refuse: ${problems.join('; ')}`,
    );
  } finally {
    await rm(extraVector, { recursive: true, force: true });
  }

  const localNoul = await prerequisiteFixture();
  try {
    await replace(
      localNoul,
      'packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json',
      '"endpoint": { "type": "string", "pattern": "^http://127\\\\.0\\\\.0\\\\.1(?::[0-9]+)?(?:/[^?#]*)?$" },\n            "approvedAddressSet": { "type": "array", "minItems": 1, "maxItems": 1, "items": { "const": "127.0.0.1" } },\n            "promptTemplate": { "$ref": "#/$defs/id" },\n            "protocol": { "const": "noul" }',
      '"endpoint": { "type": "string", "pattern": "^http://127\\\\.0\\\\.0\\\\.1(?::[0-9]+)?(?:/[^?#]*)?$" },\n            "approvedAddressSet": { "type": "array", "minItems": 1, "maxItems": 1, "items": { "type": "string" } },\n            "promptTemplate": { "$ref": "#/$defs/id" },\n            "protocol": { "const": "noul" }',
    );
    const problems = await verifyPhaseEPrerequisites({ root: localNoul });
    assert.ok(
      problems.includes(
        'B3 v1 inventory digest mismatch: packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json',
      ),
      `a removed local-Noul IPv4 restriction must refuse: ${problems.join('; ')}`,
    );
  } finally {
    await rm(localNoul, { recursive: true, force: true });
  }

  const inertConsumer = await prerequisiteFixture();
  try {
    await writeFile(
      join(inertConsumer, 'packages/events-daemon/test/b3-consumer-contract.test.ts'),
      "test('inert', () => {});\n",
    );
    const problems = await verifyPhaseEPrerequisites({ root: inertConsumer });
    assert.ok(
      problems.includes('B3 v1 inventory digest mismatch: packages/events-daemon/test/b3-consumer-contract.test.ts'),
      `an inert B3 consumer contract test must refuse: ${problems.join('; ')}`,
    );
  } finally {
    await rm(inertConsumer, { recursive: true, force: true });
  }
});
