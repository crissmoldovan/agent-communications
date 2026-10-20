/**
 * The gate evidence's provenance (E2 review round 1, A3): a release accepts the committed gate results only once GitHub
 * says the protected run the owner recorded wrote them. Every request here goes to a loopback fake of the two REST API
 * endpoints the check uses, never to GitHub.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { BOUNDARY_EVIDENCE } from '../scripts/verify-laya-boundary-gate.mjs';
import {
  GATE_RUNS,
  GATE_WORKFLOW,
  gateRunsApi,
  parseRunRecordBytes,
  RUN_COPIES,
  repositoryOf,
  verifyGateRuns,
} from '../scripts/verify-laya-gate-runs.mjs';
import { GATE_REPORT_DIRECTORY } from '../scripts/verify-laya-quality-gate.mjs';
import {
  boundaryEvidence,
  codeOf,
  offeredRoot,
  removeRoot,
  writeBoundaryEvidence,
  writeQualityReport,
} from './helpers/laya-release-fixture.mjs';
import { assertLoopbackSeal } from './helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

const REPOSITORY = 'crissmoldovan/agent-communications';
const RUN_ID = '18234567890';
const COMMIT = 'c'.repeat(40);
const TOKEN = 'fake-job-token';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What a run of one architecture wrote as its own copy: that entry, and every field the result shares. */
function ownCopy(text, architecture) {
  const document = JSON.parse(text);
  const restricted = {
    ...document,
    architectures: document.architectures.filter((entry) => entry.architecture === architecture),
  };
  return Buffer.from(`${JSON.stringify(restricted, null, 2)}\n`, 'utf8');
}

function recordBytes(runs) {
  return `${JSON.stringify({ schemaVersion: 1, runs }, null, 2)}\n`;
}

/** An offered candidate with both results committed for `architectures`, and the run record naming one run each. */
async function withCommittedResults(run, architectures = ['arm64']) {
  const { root, metrics } = await offeredRoot();
  try {
    await writeQualityReport(root, metrics, architectures);
    await writeBoundaryEvidence(root, boundaryEvidence(root, architectures));
    await writeFile(
      join(root, GATE_RUNS),
      recordBytes(architectures.map((architecture) => ({ architecture, runId: RUN_ID, commit: COMMIT }))),
    );
    const quality = await readFile(join(root, GATE_REPORT_DIRECTORY, `${metrics.report.manifestId}.json`), 'utf8');
    const boundary = await readFile(join(root, BOUNDARY_EVIDENCE), 'utf8');
    return await run({ root, quality, boundary });
  } finally {
    await removeRoot(root);
  }
}

function protectedRun(overrides = {}) {
  return {
    id: Number(RUN_ID),
    path: GATE_WORKFLOW,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_sha: COMMIT,
    head_branch: 'laya-candidate-1',
    repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function artifactsFor(committed, architecture, overrides = {}) {
  const artifacts = [
    { name: 'laya-gate-results', digest: `sha256:${'0'.repeat(64)}`, workflow_run: { id: Number(RUN_ID) } },
    ...Object.entries(RUN_COPIES).map(([kind, name]) => ({
      name,
      digest: `sha256:${sha256(ownCopy(committed[kind], architecture))}`,
      workflow_run: { id: Number(RUN_ID), head_sha: COMMIT },
    })),
  ].map((artifact) => ({ ...artifact, ...(overrides[artifact.name] ?? {}) }));
  return { total_count: artifacts.length, artifacts: artifacts.filter((artifact) => artifact.name !== 'omit') };
}

/** A loopback stand-in for the REST API: it answers the two paths the check uses and records every request. */
async function fakeGitHub(answer) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    const reply = answer(request.url ?? '');
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
    response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    api: { url: `http://127.0.0.1:${port}`, repository: REPOSITORY, token: TOKEN },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function routes(committed, { run = protectedRun(), artifacts, architecture = 'arm64' } = {}) {
  return (url) => {
    if (url === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`) return { body: run };
    if (url === `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100`)
      return { body: artifacts ?? artifactsFor(committed, architecture) };
    return { status: 404, body: { message: 'Not Found' } };
  };
}

async function checkWith(root, answer, architectures = ['arm64']) {
  const github = await fakeGitHub(answer);
  try {
    const checked = await verifyGateRuns({ root, architectures, api: github.api });
    return { checked, requests: github.requests };
  } finally {
    await github.close();
  }
}

test('E2 review round 1: a release accepts the gate results only as the protected run the owner recorded wrote them', async () => {
  await withCommittedResults(async ({ root, quality, boundary }) => {
    const committed = { quality, boundary };
    const { checked, requests } = await checkWith(root, routes(committed));
    assert.deepEqual(checked, [{ architecture: 'arm64', runId: RUN_ID }]);
    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      [
        `GET /repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
        `GET /repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?per_page=100`,
      ],
      'two reads, and nothing else',
    );
    assert.ok(
      requests.every((request) => request.authorization === `Bearer ${TOKEN}` && !request.url.includes(TOKEN)),
      'the job token goes only in a header',
    );
    // The path may name the ref the run came from.
    assert.ok(
      (
        await checkWith(
          root,
          routes(committed, { run: protectedRun({ path: `${GATE_WORKFLOW}@refs/tags/laya-candidate-1` }) }),
        )
      ).checked,
    );
    for (const [name, run] of [
      ['another workflow', protectedRun({ path: '.github/workflows/release.yml' })],
      ['a look-alike path', protectedRun({ path: `${GATE_WORKFLOW}.bak` })],
      ['started by a push', protectedRun({ event: 'push' })],
      ['not on a candidate tag', protectedRun({ head_branch: 'main' })],
      ['still running', protectedRun({ status: 'in_progress', conclusion: null })],
      ['failed', protectedRun({ conclusion: 'failure' })],
      ['skipped', protectedRun({ conclusion: 'skipped' })],
      ['on another commit', protectedRun({ head_sha: 'd'.repeat(40) })],
      ['in another repository', protectedRun({ repository: { full_name: 'someone/fork' } })],
      ['another run', protectedRun({ id: 1 })],
    ]) {
      assert.equal(await codeOf(() => checkWith(root, routes(committed, { run }))), 'LAYA_GATE_RUN', name);
    }
    for (const [name, overrides, code] of [
      ['no quality copy', { [RUN_COPIES.quality]: { name: 'omit' } }, 'LAYA_GATE_RUN_ARTIFACT'],
      ['no boundary copy', { [RUN_COPIES.boundary]: { name: 'omit' } }, 'LAYA_GATE_RUN_ARTIFACT'],
      ['another run’s copy', { [RUN_COPIES.quality]: { workflow_run: { id: 2 } } }, 'LAYA_GATE_RUN_ARTIFACT'],
      ['a zipped copy', { [RUN_COPIES.boundary]: { digest: `sha256:${'1'.repeat(64)}` } }, 'LAYA_GATE_RUN_DIGEST'],
      ['no digest', { [RUN_COPIES.quality]: { digest: null } }, 'LAYA_GATE_RUN_DIGEST'],
    ]) {
      const artifacts = artifactsFor(committed, 'arm64', overrides);
      if (name.startsWith('no ') && name.endsWith('copy')) artifacts.total_count = artifacts.artifacts.length;
      assert.equal(await codeOf(() => checkWith(root, routes(committed, { artifacts }))), code, name);
    }
    const paged = { ...artifactsFor(committed, 'arm64'), total_count: 101 };
    assert.equal(
      await codeOf(() => checkWith(root, routes(committed, { artifacts: paged }))),
      'LAYA_GATE_RUN_ARTIFACT',
      'more artifacts than one page holds',
    );
    // A result changed after the run is not the run's: the copy GitHub holds no longer matches it.
    const edited = JSON.parse(boundary);
    edited.architectures[0].macos = '14.6';
    await writeFile(join(root, BOUNDARY_EVIDENCE), `${JSON.stringify(edited, null, 2)}\n`);
    assert.equal(await codeOf(() => checkWith(root, routes(committed))), 'LAYA_GATE_RUN_DIGEST');
    await writeFile(join(root, BOUNDARY_EVIDENCE), boundary);
    for (const [name, answer] of [
      ['an unknown run', () => ({ status: 404, body: { message: 'Not Found' } })],
      // A redirect is refused, even to an answer that would pass: the check reads only what GitHub answered itself.
      [
        'a redirect',
        (url) =>
          url.startsWith('/moved/')
            ? routes(committed)(url.slice('/moved'.length))
            : { status: 302, headers: { location: `/moved${url}` }, body: {} },
      ],
      ['not JSON', () => ({ body: 'not json' })],
    ]) {
      assert.equal(await codeOf(() => checkWith(root, answer)), 'LAYA_GATE_RUN_API', name);
    }
  });
});

test('E2 review round 1: each offered architecture is checked against its own run’s copies', async () => {
  await withCommittedResults(
    async ({ root, quality, boundary }) => {
      const committed = { quality, boundary };
      const both = (architecture) => (url) =>
        url.endsWith('/artifacts?per_page=100')
          ? { body: artifactsFor(committed, architecture) }
          : routes(committed)(url);
      // Copies of the arm64 entry do not stand for x64.
      assert.equal(await codeOf(() => checkWith(root, both('arm64'), ['arm64', 'x64'])), 'LAYA_GATE_RUN_DIGEST');
      await writeFile(join(root, GATE_RUNS), recordBytes([{ architecture: 'arm64', runId: RUN_ID, commit: COMMIT }]));
      assert.equal(
        await codeOf(() => checkWith(root, both('arm64'), ['arm64', 'x64'])),
        'LAYA_GATE_RUNS_ABSENT',
        'an offered architecture with no recorded run',
      );
    },
    ['arm64', 'x64'],
  );
});

test('E2 review round 1: the run record names one protected run per architecture, in its exact shape', async () => {
  const good = recordBytes([{ architecture: 'arm64', runId: RUN_ID, commit: COMMIT }]);
  assert.deepEqual(parseRunRecordBytes(Buffer.from(good)).runs, [
    { architecture: 'arm64', runId: RUN_ID, commit: COMMIT },
  ]);
  for (const [name, text] of [
    [
      'not canonical',
      JSON.stringify({ schemaVersion: 1, runs: [{ architecture: 'arm64', runId: RUN_ID, commit: COMMIT }] }),
    ],
    ['another version', recordBytes([]).replace('"schemaVersion": 1', '"schemaVersion": 2')],
    ['no runs', recordBytes([])],
    ['an extra field', recordBytes([{ architecture: 'arm64', runId: RUN_ID, commit: COMMIT, url: 'x' }])],
    ['a numeric run id', recordBytes([{ architecture: 'arm64', runId: Number(RUN_ID), commit: COMMIT }])],
    ['a short commit', recordBytes([{ architecture: 'arm64', runId: RUN_ID, commit: 'c'.repeat(7) }])],
    ['another architecture', recordBytes([{ architecture: 'arm', runId: RUN_ID, commit: COMMIT }])],
    [
      'an architecture twice',
      recordBytes([
        { architecture: 'arm64', runId: RUN_ID, commit: COMMIT },
        { architecture: 'arm64', runId: '7', commit: COMMIT },
      ]),
    ],
  ]) {
    assert.equal(await codeOf(() => parseRunRecordBytes(Buffer.from(text))), 'LAYA_GATE_RUNS_SHAPE', name);
  }
  await withCommittedResults(async ({ root }) => {
    await rm(join(root, GATE_RUNS));
    assert.equal(await codeOf(() => checkWith(root, () => ({ body: {} }))), 'LAYA_GATE_RUNS_ABSENT');
  });
});

test('E2 review round 1: the gate-run check reaches GitHub only over https, as this repository, with the job’s token', async () => {
  const github = ['https:/', '/api.github.com'].join('');
  assert.equal(repositoryOf(), REPOSITORY);
  assert.deepEqual(gateRunsApi({}), { url: github, repository: REPOSITORY, token: undefined });
  assert.deepEqual(
    gateRunsApi({ GITHUB_API_URL: `${github}/`, GITHUB_REPOSITORY: 'owner/name', GITHUB_TOKEN: TOKEN }),
    { url: github, repository: 'owner/name', token: TOKEN },
  );
  for (const url of ['http://127.0.0.1:9', 'file:///etc', 'ftp://example.test']) {
    assert.equal(await codeOf(() => gateRunsApi({ GITHUB_API_URL: url })), 'LAYA_GATE_RUN_API', url);
  }
  await withCommittedResults(async ({ root }) => {
    assert.equal(
      await codeOf(() =>
        verifyGateRuns({
          root,
          architectures: ['arm64'],
          api: { url: 'http://127.0.0.1:9', repository: 'not a repository' },
        }),
      ),
      'LAYA_GATE_RUN_API',
    );
  });
});
