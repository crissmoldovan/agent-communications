#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv from '../packages/events-daemon/node_modules/ajv/dist/2020.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = 'packages/events-daemon/test/fixtures/b3-control-contract-v1';
const PREVIEW_FIXTURES = 'packages/events-daemon/test/fixtures/b3-approval-preview-v1';
/**
 * E owns this exact B3-v1 input inventory.  B3 is frozen here: a deliberate B3-v1 change updates its pin in the
 * same commit and records why in that commit, rather than silently weakening E's prerequisite gate.
 *
 * 0.30.0 (the action queue) is one such change, and only additive: the schema, the desktop request vectors and the
 * ordinary and seeded result vectors gain the eight `queue-*` owner wires, the `queue` target document, a rule's
 * optional `retention.queueMs` and a rule version's optional tightening preview. No existing branch changed.
 *
 * 0.31.0 (routing's lanes) is another, also only additive: the `queue` target document gains its optional
 * `lane: { name }`, and the schema and vectors gain the person's three `lane-*` owner wires (list, bind, unbind).
 *
 * 0.32.0 is another, also only additive: the schema and vectors gain the person's `judge-setup`, `provider-list`,
 * `provider-key-set` and `provider-key-remove` owner wires (judges set up in the app, owner decision 2026-10-26), and
 * the person's `messages-list` and `message-show` owner wires, their arguments and their entry grammar (a story per
 * message, 0.32.0 spec §3.6). No existing branch changed.
 *
 * 0.32.0's second security look (2026-10-26) widens one value of a branch 0.32.0 itself added: `judge-setup`'s result
 * `approvedBy`, which was always `desktop-app`, names where the person was — `desktop-app`, `desktop-app (test build)`,
 * `desktop-app (unattested)` or `terminal` — as the CLI established it. No branch an earlier release shipped changed.
 *
 * 0.33.0 (design §3.3) is another, also only additive: the AI providers gain `anthropic`, whose key Analyse's model
 * uses, while `judge-setup` keeps exactly Jev's two providers (`jevProvider`); and the schema and vectors gain the
 * person's `rule-analyse` owner wire, its arguments and its result; and the `judge-show` owner wire, one judge
 * version's exact canonical document, digest and state, for the rule editor. No existing branch changed.
 *
 * 0.33.0 (the Linear target, design §3.4) is another, also only additive. The provider key wires' provider, `aiProvider`,
 * gains `linear` beside the AI providers; `judge-setup` keeps `jevProvider`, since Linear serves no judge. The target
 * document gains its `linear` branch, and a delivery's target kind the value `linear`. The person's `integration-show`
 * owner wire (Settings → Integrations) is added, with its request and result vectors, and a delivery row its optional
 * `linear: { identifier, url }`.
 */
const B3_V1_INVENTORY = Object.freeze({
  'packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json':
    'c961efa9d8ad88794dfe40c315fa67624a3cbf018a9f59ec636f7db230164d9a',
  'packages/events-daemon/src/operations/contracts/doctor-v1.schema.json':
    'f1c9127451c729427b301c503214e59a7b698d07d5d130f350b23f0fcf827d6a',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/approval-view-ready.json':
    'df7d290b4229b6f88e84117ad8680abedc9442fd23272242e74a64ae04472da8',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/approval-view-rule-preview.json':
    '0a45270f6f3c366f1a1d1b3e3264b4318746c74cc82d1a99985600abc7fee89f',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/approval-view-variants.json':
    'b75e356047e2285960e76042996a646c50919be4737c11d926e070a381a4f128',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/b3-operation-results.json':
    'b917918b966c0c4935a417acf890da26adba9dc59e29b494106cbcb47f8e5a19',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/desktop-operation-requests.json':
    '80abd5987e9d179ab70242696db635388b8c5a05dd1c25a1c0e0aa56eac19dce',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/doctor-result.json':
    '2ac2678746992c9c36b9f917cecdc245298a0d8384be0a1b37b84762a1277279',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/error-vectors.json':
    '2d77017ee83bc6eb81de98bc32464196c9f7807bd446a57117ce22d7a6c059fb',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/held-decide.json':
    '6fc694fd79ad444659d3f36300ae14aa08482a6402871f204fa17d17fb3492f9',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/holds.json':
    '2e3eaa8886260d56019350e33aa16f3db4ebbc1b4d6292671a9ded44045ab490',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/operation-requests.json':
    'f722a05d3197e2090a9fd70ae0fe4702119452b6214a8312b8048a7369b6e9c9',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/ordinary-results.json':
    '0d21b030a2ac336e9c612f96ed568fb9dd8c5877ce82f5bc8b921116cd1d9360',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/pending-target.json':
    'b5ced3972a7ea890fe7239edf3f56147b1c2d352d10006405640b3e8bd333b06',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/secret-origin.json':
    'e0192f61837d2e8faaca1cfe5ad99db26ffb02ee1a325c31eb595243e6a4e6b4',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/seeded-results.json':
    '7a9503cb9d7a6f6195b58512504ef31ed1d1d318add5a7e3733959ade3e63481',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/target-test.json':
    'dda54666b9959991200f3a67c1ef6173142db7ca1bb1730de1efa480e3f34c3b',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/unavailable-e2.json':
    'b3108e4c29bec8fc9844dd3bb116e155e790d8951f7e77fe0b625425b1332a2c',
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/unavailable.json':
    'a1607b7dd787a5b70572b7d68e42ce59a9ecf8f3dcd3819d74bbd58d0a578ddd',
  'packages/events-daemon/test/fixtures/b3-approval-preview-v1/challenge-expired.json':
    '599d7efe00637c16b6409b2aec989760be7f49ca29b2b66d93d36ae2c890cfba',
  'packages/events-daemon/test/fixtures/b3-approval-preview-v1/digest-mismatch.json':
    'fa084bd7155b5ff3f88a1a2807ebb3ec81821c8edd47ec6c057a1e01d2dd7d7f',
  'packages/events-daemon/test/fixtures/b3-approval-preview-v1/ready.json':
    '21217c186a24006e7c87722eb141b4700c284c47d4955f391fb6dd6c78f7c2a7',
  'packages/events-daemon/test/fixtures/b3-approval-preview-v1/stale.json':
    '2fb75f3b2201c619baa8ab2fd77c2c9052b96c3030ad5ad000265b9c3db9fd37',
  'packages/events-daemon/test/b3-consumer-contract.test.ts':
    '8f7228c1ac04a9a649581d80063b75b7840c2310fa3f35a052d22c185fbfce59',
});
const REQUIRED_VECTOR_NAMES = Object.freeze([
  'doctor-result',
  'approval-view-ready',
  'approval-view-rule-preview',
  'approval-view-stale',
  'approval-view-digest-mismatch',
  'approval-view-challenge-expired',
  'held-decide-unavailable',
  'held-list-empty',
  'secret-app-unavailable',
  'pending-target-approval-flow',
  'target-test-active-request',
  'error-usage',
  'error-bad-data',
  'error-approval-void',
  'error-not-found',
  'error-config',
]);
const EXCEPTIONS = [
  'events-daemon.target-secret.create',
  'events-daemon.target-secret.rotate',
  'events-daemon.target-url.set',
  'events-daemon.subscriber-token.create',
  'events-daemon.subscriber-token.rotate',
  'events-daemon.judge-key.set',
  'events-daemon.judge-key.rotate',
  'events-daemon.secrets.migrate',
  'events-daemon.approve',
  'events-daemon.rule.test-retained',
  'events-daemon.target.resume',
  'events-daemon.held.decide',
  'events-daemon.dryrun.list',
  'events-daemon.dryrun.show',
];
const SECRET_REASON =
  'secret material must never enter model input or output; the person completes this operation at the terminal or app.';

function capabilityCliRoute(signature) {
  const words = signature.split(' ');
  const firstArgument = words.findIndex(
    (word) => word.startsWith('<') || word.startsWith('--') || word.startsWith('('),
  );
  return words.slice(0, firstArgument < 0 ? undefined : firstArgument).join(' ');
}

function compareCapabilityInventory(expected, actual, sourceName, problems) {
  if (!Array.isArray(expected)) {
    problems.push('E runtime exports its exact B3 capability inventory');
    return;
  }
  if (!Array.isArray(actual)) {
    problems.push(`${sourceName} has capability rows`);
    return;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    problems.push(`${sourceName} matches the exact E-owned B3 capability inventory`);
}

async function text(root, file, problems) {
  const value = await readFile(join(root, file), 'utf8').catch(() => undefined);
  if (value === undefined) problems.push(`missing prerequisite input: ${file}`);
  return value ?? '';
}
async function inventoryFiles(root, directory, problems) {
  try {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      // Inventory keys are repository paths with `/` on every platform; `join` would give `\\` on Windows.
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) files.push(...(await inventoryFiles(root, file, problems)));
      else if (entry.isFile()) files.push(file);
      else problems.push(`B3 v1 inventory has unsupported entry: ${file}`);
    }
    return files;
  } catch (error) {
    problems.push(`B3 v1 inventory cannot read directory: ${directory}: ${String(error)}`);
    return [];
  }
}
async function verifyB3Inventory(root, problems) {
  const found = new Set([
    ...(await inventoryFiles(root, VECTORS, problems)),
    ...(await inventoryFiles(root, PREVIEW_FIXTURES, problems)),
    'packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json',
    'packages/events-daemon/src/operations/contracts/doctor-v1.schema.json',
    'packages/events-daemon/test/b3-consumer-contract.test.ts',
  ]);
  for (const file of found) if (!(file in B3_V1_INVENTORY)) problems.push(`B3 v1 inventory extra file: ${file}`);
  for (const [file, expected] of Object.entries(B3_V1_INVENTORY)) {
    let bytes;
    try {
      bytes = await readFile(join(root, file));
    } catch {
      problems.push(`B3 v1 inventory missing file: ${file}`);
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expected)
      problems.push(`B3 v1 inventory digest mismatch: ${file}`);
  }
}
function json(value, message, problems) {
  try {
    return JSON.parse(value);
  } catch {
    problems.push(message);
    return undefined;
  }
}
async function load(root, file, problems) {
  try {
    return await import(pathToFileURL(join(root, file)).href);
  } catch (error) {
    problems.push(`cannot load prerequisite production module ${file}: ${String(error)}`);
    return undefined;
  }
}
async function vectors(root, problems) {
  const files = await readdir(join(root, VECTORS)).catch(() => undefined);
  if (files === undefined) {
    problems.push(`missing prerequisite input: ${VECTORS}`);
    return [];
  }
  const result = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const value = json(await text(root, join(VECTORS, file), problems), `B3 vector ${file} is valid JSON`, problems);
    if (value !== undefined) result.push(...(Array.isArray(value) ? value : [value]));
  }
  return result;
}
async function previewFixtures(root, problems) {
  const files = await readdir(join(root, PREVIEW_FIXTURES)).catch(() => undefined);
  if (files === undefined) {
    problems.push(`missing prerequisite input: ${PREVIEW_FIXTURES}`);
    return [];
  }
  const result = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const value = json(
      await text(root, join(PREVIEW_FIXTURES, file), problems),
      `B3 preview fixture ${file} is valid JSON`,
      problems,
    );
    if (value !== undefined) result.push({ file, value });
  }
  return result;
}
function requireVectors(values, specs, problems) {
  const byName = new Map(values.map((vector) => [vector?.name, vector]));
  for (const name of REQUIRED_VECTOR_NAMES)
    if (!byName.has(name)) problems.push(`B3 required vector is absent: ${name}`);
  const secret = byName.get('secret-app-unavailable');
  if (secret?.request?.origin !== 'app-window')
    problems.push('B3 required vector secret-app-unavailable keeps its forged app/window origin');
  const pending = byName.get('pending-target-approval-flow');
  if (pending?.request?.surface !== 'app-approval-screen')
    problems.push('B3 required vector pending-target-approval-flow is app approval only');
  const ordinary = byName.get('target-test-active-request');
  if (ordinary?.request?.operation !== 'targetTest' || Object.hasOwn(ordinary?.request ?? {}, 'selector'))
    problems.push(
      'B3 required vector target-test-active-request refuses a pending target selector on ordinary CLI/MCP',
    );
  for (const spec of specs ?? []) {
    if (!values.some((vector) => vector?.request?.operation === spec?.operation))
      problems.push(`B3 operation has no request vector: ${String(spec?.operation)}`);
  }
}

function validate(schema, doctor, values, specs, problems) {
  if (schema?.$id !== 'https://agentcomms.local/b3-control-v1.schema.json')
    problems.push('B3 control schema has the stable v1 id');
  if (doctor?.$id !== 'https://agentcomms.local/events-doctor-v1.schema.json')
    problems.push('B3 doctor schema has the stable v1 id');
  if (!schema || !doctor) return;
  let validator;
  let validateDoctor;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addSchema(doctor);
    ajv.addSchema(schema);
    validator = ajv.compile({ $ref: `${schema.$id}#/$defs/vector` });
    validateDoctor = ajv.compile({ $ref: `${schema.$id}#/$defs/doctor` });
  } catch (error) {
    problems.push(`B3 control schema and doctor-v1 $ref compile: ${String(error)}`);
    return;
  }
  for (const vector of values)
    if (!validator(vector))
      problems.push(
        `B3 schema rejects checked-in vector ${typeof vector?.name === 'string' ? vector.name : '<unnamed>'}`,
      );
  const doctorVector = values.find((vector) => vector?.name === 'doctor-result');
  if (!doctorVector) problems.push('B3 required doctor result vector is absent');
  else if (!validateDoctor(doctorVector.result)) problems.push('B3 schema rejects checked-in doctor result branch');
  requireVectors(values, specs, problems);
}
function consume(contract, values, previews, problems) {
  if (!contract) return;
  const {
    assertB3ControlContractVectorV1: guard,
    renderB3ApprovalPreviewV1: render,
    B3_CONTROL_CONTRACT: control,
    B3_CONTROL_V1_OPERATION_SPECS: specs,
  } = contract;
  if (typeof guard !== 'function') {
    problems.push('B3 exports the runtime vector guard');
    return;
  }
  if (typeof render !== 'function') problems.push('B3 exports the approval preview renderer');
  if (control?.version !== 'b3-control-v1' || !Array.isArray(specs) || specs.length === 0)
    problems.push('B3 exports its consumed contract constants');
  for (const vector of values) {
    try {
      guard(vector);
      if (vector?.request?.operation === 'approvalView' && Object.hasOwn(vector, 'result')) {
        const rendered = render(vector.result);
        if (rendered?.kind !== vector.result?.kind) throw new TypeError('renderer drifted the discriminant');
      }
    } catch (error) {
      problems.push(
        `B3 runtime contract rejects checked-in vector ${typeof vector?.name === 'string' ? vector.name : '<unnamed>'}: ${String(error)}`,
      );
    }
  }
  try {
    guard({ name: 'phase-e-invalid-operation', request: { operation: 'not-a-b3-operation', args: {} } });
    problems.push('B3 runtime vector guard accepts invalid vector phase-e-invalid-operation');
  } catch {}
  try {
    render({ kind: 'NOT_A_B3_PREVIEW' });
    problems.push('B3 preview renderer accepts an invalid preview variant');
  } catch {}
  for (const { file, value } of previews) {
    try {
      if (JSON.stringify(render(value?.result)) !== JSON.stringify(value?.expected)) {
        problems.push(`B3 consumer preview fixture ${file} does not match the real preview renderer`);
      }
    } catch (error) {
      problems.push(`B3 consumer preview fixture ${file} is rejected by the real preview renderer: ${String(error)}`);
    }
  }
}

export async function verifyPhaseEPrerequisites({ root = ROOT } = {}) {
  const problems = [];
  const [phase, contract, schemaText, doctorText, capabilitiesText, checked, previews] = await Promise.all([
    load(root, 'packages/events-daemon/src/runtime/phase-e-prerequisites.ts', problems),
    load(root, 'packages/events-daemon/src/operations/b3-contract.ts', problems),
    text(root, 'packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json', problems),
    text(root, 'packages/events-daemon/src/operations/contracts/doctor-v1.schema.json', problems),
    text(root, 'capabilities.json', problems),
    vectors(root, problems),
    previewFixtures(root, problems),
  ]);
  await verifyB3Inventory(root, problems);
  try {
    phase?.assertPhaseEPrerequisites();
  } catch (error) {
    problems.push(`E runtime prerequisite gate refuses its real parser/registry/B3 contract: ${String(error)}`);
  }
  validate(
    json(schemaText, 'B3 control schema is valid JSON', problems),
    json(doctorText, 'B3 doctor schema is valid JSON', problems),
    checked,
    contract?.B3_CONTROL_V1_OPERATION_SPECS,
    problems,
  );
  consume(contract, checked, previews, problems);
  const capabilities = json(capabilitiesText, 'capabilities.json is valid JSON', problems)?.capabilities;
  const expectedCapabilities = phase?.PHASE_E_B3_CAPABILITY_INVENTORY;
  compareCapabilityInventory(
    expectedCapabilities,
    contract?.B3_CAPABILITIES?.map((entry) => ({
      id: entry.id,
      cli: entry.cli,
      mcp: entry.mcp,
      operation: entry.operation,
      status: entry.status,
      reason: entry.reason ?? null,
      secret: entry.secret === true,
    })),
    'B3_CAPABILITIES',
    problems,
  );
  compareCapabilityInventory(
    expectedCapabilities,
    Array.isArray(capabilities) && Array.isArray(expectedCapabilities)
      ? expectedCapabilities.map((expected) => {
          const rows = capabilities.filter((candidate) => candidate?.id === expected.id);
          const row = rows.length === 1 ? rows[0] : undefined;
          return {
            id: row?.id,
            cli: row?.cli === capabilityCliRoute(expected.cli) ? expected.cli : row?.cli,
            mcp: row?.mcp,
            operation: row?.operation,
            status: row?.status,
            reason: row?.reason ?? null,
            secret: row?.reason === SECRET_REASON,
          };
        })
      : capabilities,
    'capabilities.json B3 projection',
    problems,
  );
  if (!Array.isArray(capabilities)) problems.push('capabilities.json has capability rows');
  else
    for (const id of EXCEPTIONS) {
      const row = capabilities.find((candidate) => candidate?.id === id);
      if (row?.status !== 'exception' || row?.mcp !== null || typeof row?.operation !== 'string' || !row.reason)
        problems.push(`B3 human-only exception row exists: ${id}`);
    }
  return problems;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await verifyPhaseEPrerequisites();
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  }
}
