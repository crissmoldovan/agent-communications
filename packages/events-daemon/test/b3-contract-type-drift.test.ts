import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { EventControlClient } from '../src/control/client.ts';
import {
  canonicalFullRuleDocument,
  canonicalJudge,
  canonicalSubscriber,
  canonicalTarget,
  normaliseActivationDocument,
} from '../src/domain/activation-documents.ts';
import {
  assertB3ControlContractVectorV1,
  B3_ACTIVATION_FAILURE_CODES,
  B3_ACTIVATION_STATUSES,
  B3_APPROVAL_VIEW_VARIANTS,
  B3_CONTROL_ERROR_CODES,
  B3_CONTROL_V1_OPERATION_SPECS,
  B3_CONTROL_V1_RESULT_OPERATIONS,
  B3_CONTROL_V1_SCHEMA_VERSION,
  B3_DESKTOP_CONTROL_OPERATIONS,
  B3_DISCLOSURE_ACTIVATION_KINDS,
  B3_DISCLOSURE_VERSION_KINDS,
  B3_HELD_DECISIONS,
  B3_INTENT_KINDS,
  B3_JUDGE_UNAVAILABLE_VARIANTS,
  B3_OWNER_RESULT_KINDS,
  B3_OWNER_STATES,
  B3_PENDING_TARGET_APPROVAL_SURFACES,
  B3_SECRET_BACKENDS,
  type B3ActivationStatus,
  type B3ApprovalViewVariant,
  type B3CapabilityStatus,
  type B3ControlErrorCodeV1,
  type B3HeldDecision,
  type B3JudgeUnavailableV1,
  type B3OwnerResultKind,
  type B3OwnerState,
  type B3PendingTargetApprovalSurface,
  type B3SecretBackend,
  type B3UnavailableResultKind,
} from '../src/operations/b3-contract.ts';
import * as ownerControl from '../src/runtime/owner.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/b3-control-contract-v1');
const CONTRACTS = join(import.meta.dirname, '../src/operations/contracts');
const ROOT = join(import.meta.dirname, '../../..');

async function vectors(): Promise<readonly unknown[]> {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.json')).sort();
  const values = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as unknown),
  );
  return values.flatMap((value) => (Array.isArray(value) ? value : [value]));
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, 'object', `${name} is an object`);
  assert.notEqual(value, null, `${name} is non-null`);
  assert.ok(!Array.isArray(value), `${name} is not an array`);
  return value as Readonly<Record<string, unknown>>;
}

async function desktopCallableOperations(): Promise<readonly string[]> {
  const capabilities = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly {
      readonly package: string;
      readonly operation?: string | undefined;
    }[];
  };
  return [
    ...new Set(
      capabilities.capabilities.flatMap((capability) =>
        capability.package === 'events-daemon' && capability.operation !== undefined && capability.operation !== 'run'
          ? [capability.operation]
          : [],
      ),
    ),
  ].sort();
}

function ownerWireOperations(): readonly {
  readonly capabilityOperation: string;
  readonly wireOperation: string;
  readonly desktopCallable: boolean;
}[] {
  const registry = ownerControl as typeof ownerControl & {
    readonly OWNER_CONTROL_WIRE_OPERATIONS?: readonly {
      readonly capabilityOperation: string;
      readonly wireOperation: string;
      readonly desktopCallable: boolean;
    }[];
  };
  assert.ok(registry.OWNER_CONTROL_WIRE_OPERATIONS, 'the owner exports the wire-operation registry it dispatches');
  return registry.OWNER_CONTROL_WIRE_OPERATIONS;
}

function vectorValidator(schema: Readonly<Record<string, unknown>>, doctor: Readonly<Record<string, unknown>>) {
  // doctor-v1 predates Ajv's strictRequired lint, but remains the authoritative checked schema for this external ref.
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(doctor);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id as string}#/$defs/vector`);
  assert.ok(validate, 'the B3 control schema exposes a vector validator');
  return validate;
}

function operationValues(schema: unknown): readonly string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [];
  const node = schema as Readonly<Record<string, unknown>>;
  const properties =
    typeof node.properties === 'object' && node.properties !== null && !Array.isArray(node.properties)
      ? (node.properties as Readonly<Record<string, unknown>>)
      : {};
  const operation =
    typeof properties.operation === 'object' && properties.operation !== null && !Array.isArray(properties.operation)
      ? (properties.operation as Readonly<Record<string, unknown>>)
      : {};
  const direct = [
    ...(Array.isArray(operation.enum)
      ? operation.enum.filter((value): value is string => typeof value === 'string')
      : []),
    ...(typeof operation.const === 'string' ? [operation.const] : []),
  ];
  return [...direct, ...(Array.isArray(node.oneOf) ? node.oneOf.flatMap((branch) => operationValues(branch)) : [])];
}

function constValue(node: unknown, name: string): string {
  const value = record(node, name).const;
  if (typeof value !== 'string') assert.fail(`${name} is a string const`);
  return value;
}

function vectorJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(
    /\[\n\s+((?:true|false|null|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"))\n\s*\]/gu,
    '[$1]',
  )}\n`;
}

function requestArgumentsSchema(
  definitions: Readonly<Record<string, unknown>>,
  operation: string,
): Readonly<Record<string, unknown>> {
  const candidates = record(definitions.request, 'request definition').oneOf;
  assert.ok(Array.isArray(candidates), 'request definition has branches');
  const branch = candidates.find((candidate) => {
    const properties = record(record(candidate, 'request branch').properties, 'request branch properties');
    const operationSchema = record(properties.operation, 'request operation schema');
    return (
      operationSchema.const === operation ||
      (Array.isArray(operationSchema.enum) && operationSchema.enum.includes(operation))
    );
  });
  assert.ok(branch, `${operation} has a request branch`);
  return record(
    record(record(branch, `${operation} request branch`).properties, `${operation} request properties`).args,
    `${operation} request arguments`,
  );
}

test('B3 v1 schema, exported operation types, and checked-in request/result/error vectors stay in lockstep', async () => {
  const schema = record(
    JSON.parse(await readFile(join(CONTRACTS, 'b3-control-v1.schema.json'), 'utf8')) as unknown,
    'B3 control schema',
  );
  assert.equal(schema.$id, 'https://agentcomms.local/b3-control-v1.schema.json');
  assert.equal(B3_CONTROL_V1_SCHEMA_VERSION, 'b3-control-v1');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const definitions = record(schema.$defs, 'B3 control schema definitions');
  const doctor = record(
    JSON.parse(await readFile(join(CONTRACTS, 'doctor-v1.schema.json'), 'utf8')) as unknown,
    'doctor schema',
  );
  assert.deepEqual(
    record(definitions.doctor, 'doctor schema reference').$ref,
    doctor.$id,
    'doctor results use the existing doctor-v1 schema by its stable schema id',
  );
  assert.deepEqual(
    [...new Set(operationValues(definitions.request))].sort(),
    ownerWireOperations()
      .filter((entry) => entry.desktopCallable)
      .map((entry) => entry.wireOperation)
      .sort(),
    'the schema uses the owner protocol wire names for every desktop-callable daemon capability',
  );
  assert.deepEqual(
    ownerWireOperations()
      .filter((entry) => entry.desktopCallable)
      .map((entry) => entry.capabilityOperation)
      .sort(),
    await desktopCallableOperations(),
    'every desktop-callable capability maps to one owner control-protocol wire name',
  );
  assert.deepEqual(
    [...B3_DESKTOP_CONTROL_OPERATIONS].sort(),
    ownerWireOperations()
      .filter((entry) => entry.desktopCallable)
      .map((entry) => entry.wireOperation)
      .sort(),
    'the TypeScript desktop-operation vocabulary is the owner wire vocabulary too',
  );
  assert.deepEqual(
    B3_CONTROL_V1_OPERATION_SPECS.map((specification) => specification.operation),
    B3_DESKTOP_CONTROL_OPERATIONS,
    'the data-only operation export cannot silently omit a capability',
  );
  assert.deepEqual(
    B3_CONTROL_V1_RESULT_OPERATIONS,
    B3_DESKTOP_CONTROL_OPERATIONS,
    'the exported result grammar covers every desktop wire operation',
  );
  assert.deepEqual(
    (record(definitions.judgeUnavailable, 'judge unavailable definition').oneOf as readonly unknown[]).map((branch) => {
      const properties = record(record(branch, 'judge unavailable branch').properties, 'judge unavailable properties');
      return {
        code: constValue(properties.code, 'judge unavailable code'),
        phase: constValue(properties.phase, 'judge unavailable phase'),
      };
    }),
    B3_JUDGE_UNAVAILABLE_VARIANTS,
    'the schema and TypeScript share the exact pre-E/E2 result discriminants',
  );
  assert.deepEqual(
    (record(definitions.approvalResult, 'approval result definition').oneOf as readonly unknown[]).map((branch) => {
      const approvalBranch = record(branch, 'approval result branch');
      const properties =
        approvalBranch.$ref === '#/$defs/approvalReady'
          ? record(
              record(definitions.approvalReady, 'approval-ready definition').properties,
              'approval-ready properties',
            )
          : record(approvalBranch.properties, 'approval result properties');
      return constValue(properties.kind, 'approval kind');
    }),
    B3_APPROVAL_VIEW_VARIANTS,
    'the schema and TypeScript share the exact approval-result discriminants',
  );
  assert.deepEqual(
    record(record(definitions.error, 'error definition').properties, 'error properties').code,
    { enum: B3_CONTROL_ERROR_CODES },
    'the error schema enum is derived from the exported TypeScript vocabulary',
  );
  assert.deepEqual(
    record(
      record(requestArgumentsSchema(definitions, 'decideHeld'), 'held-decision args').properties,
      'held-decision properties',
    ).decision,
    { enum: B3_HELD_DECISIONS },
    'the schema and TypeScript share the closed held-decision vocabulary',
  );
  assert.deepEqual(
    record(
      record(requestArgumentsSchema(definitions, 'migrateSecrets'), 'secret-backend args').properties,
      'secret-backend properties',
    ).to,
    { enum: B3_SECRET_BACKENDS },
    'the schema and TypeScript share the closed secret-backend vocabulary',
  );
  assert.deepEqual(
    record(
      record(definitions.approvalFlowRequest, 'pending approval request').properties,
      'pending approval properties',
    ).surface,
    { enum: B3_PENDING_TARGET_APPROVAL_SURFACES },
    'the schema and TypeScript share the approval-surface vocabulary',
  );
  const resultSchemas = record(record(definitions.resultsByOperation, 'result schemas').$defs, 'result schema map');
  assert.deepEqual(
    record(record(resultSchemas.status, 'status result schema').properties, 'status result properties').owner,
    { enum: B3_OWNER_STATES },
    'the schema and TypeScript share the owner-state vocabulary',
  );
  const statusActivationIntents = record(
    record(resultSchemas.status, 'status result schema').properties,
    'status result properties',
  ).activationIntents;
  assert.deepEqual(statusActivationIntents, {
    type: 'array',
    items: { $ref: '#/$defs/activationIntentSummary' },
  });
  assert.deepEqual(
    record(definitions.activationIntentSummary, 'status activation-intent grammar'),
    {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'failureCode', 'count'],
      properties: {
        status: { enum: B3_ACTIVATION_STATUSES },
        failureCode: {
          anyOf: [
            {
              enum: B3_ACTIVATION_FAILURE_CODES,
            },
            { type: 'null' },
          ],
        },
        count: { type: 'integer', minimum: 0 },
      },
    },
    'the status summary uses the owner activation-intent grammar',
  );
  assert.deepEqual(
    resultSchemas['enable-all'],
    { $ref: '#/$defs/preparedActivation' },
    'enable-all uses the shared prepared-activation result grammar',
  );
  assert.deepEqual(
    record(
      record(definitions.preparedActivation, 'prepared activation schema').properties,
      'prepared activation properties',
    ).status,
    { const: 'pending' },
    'a prepared activation is always pending when the owner returns it',
  );
  assert.deepEqual(
    record(
      record(definitions.preparedActivation, 'prepared activation schema').properties,
      'prepared activation properties',
    ).kind,
    { enum: B3_INTENT_KINDS },
    'prepared activation kinds use the activation document vocabulary',
  );
  const disclosureBinding = record(definitions.disclosureBinding, 'core disclosure binding schema');
  assert.deepEqual(
    record(disclosureBinding.properties, 'core disclosure binding properties').activationKind,
    { enum: B3_DISCLOSURE_ACTIVATION_KINDS },
    'prepared bindings use core disclosure activation kinds',
  );
  assert.deepEqual(
    record(
      record(definitions.disclosureVersion, 'core disclosure version schema').properties,
      'core disclosure version properties',
    ).kind,
    { enum: B3_DISCLOSURE_VERSION_KINDS },
    'prepared bindings use core disclosure version kinds',
  );
  assert.deepEqual(
    record(record(resultSchemas.retryDelivery, 'retry result schema').properties, 'retry result properties').kind,
    { const: B3_OWNER_RESULT_KINDS[0] },
    'the schema and TypeScript share the delivery-result kind vocabulary',
  );

  const checked = await vectors();
  const validateVector = vectorValidator(schema, doctor);
  const operations = new Set<string>();
  const resultOperations = new Set<string>();
  const errorCodes = new Set<string>();
  for (const vector of checked) {
    assertB3ControlContractVectorV1(vector);
    assert.equal(
      validateVector(vector),
      true,
      `${record(vector, 'vector').name as string} satisfies its JSON Schema: ${JSON.stringify(validateVector.errors)}`,
    );
    const request = record(record(vector, 'vector').request, 'vector request');
    operations.add(request.operation as string);
    if (Object.hasOwn(vector as object, 'result')) resultOperations.add(request.operation as string);
    const error = record(vector, 'vector').error;
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const code = (error as Readonly<Record<string, unknown>>).code;
      if (typeof code === 'string') errorCodes.add(code);
    }
  }
  assert.throws(
    () =>
      assertB3ControlContractVectorV1({
        name: 'ordinary-target-cannot-be-pending',
        request: { operation: 'targetTest', args: { targetId: 'target-1', targetVersion: 1, selector: {} } },
      }),
    /ordinary target test vector/u,
    'only the separate approval-flow vector may name a pending target selector',
  );
  assert.deepEqual(
    [...operations].sort(),
    ownerWireOperations()
      .filter((entry) => entry.desktopCallable)
      .map((entry) => entry.wireOperation)
      .sort(),
    'each desktop-callable daemon operation has a language-neutral request vector',
  );
  assert.deepEqual(
    [...resultOperations].sort(),
    ownerWireOperations()
      .filter((entry) => entry.desktopCallable)
      .map((entry) => entry.wireOperation)
      .sort(),
    'each desktop-callable daemon operation has a closed result branch and a real result vector',
  );
  assert.deepEqual(
    [...errorCodes].sort(),
    [...B3_CONTROL_ERROR_CODES].sort(),
    'every stable desktop-visible error code has a checked-in error vector',
  );
});

test('B3 v1 keeps each E/E2 unavailable code paired with its owning phase', async () => {
  const schema = record(
    JSON.parse(await readFile(join(CONTRACTS, 'b3-control-v1.schema.json'), 'utf8')) as unknown,
    'B3 control schema',
  );
  const doctor = record(
    JSON.parse(await readFile(join(CONTRACTS, 'doctor-v1.schema.json'), 'utf8')) as unknown,
    'doctor schema',
  );
  const validateVector = vectorValidator(schema, doctor);
  for (const invalid of [
    { code: 'E_REQUIRED', phase: 'E2' },
    { code: 'E2_REQUIRED', phase: 'E' },
  ]) {
    const vector = {
      name: `invalid-${invalid.code}-${invalid.phase}`,
      request: { operation: 'judgeModelStatus', args: {} },
      result: { kind: 'unavailable', ...invalid },
    };
    assert.equal(validateVector(vector), false, `${invalid.code}/${invalid.phase} is rejected by the JSON Schema`);
    assert.throws(
      () => assertB3ControlContractVectorV1(vector),
      /unknown code or phase/u,
      `${invalid.code}/${invalid.phase} is rejected by the TypeScript runtime guard`,
    );
  }
});

test('B3 v1 keeps every closed success result attached to its owning operation', async () => {
  const schema = record(
    JSON.parse(await readFile(join(CONTRACTS, 'b3-control-v1.schema.json'), 'utf8')) as unknown,
    'B3 control schema',
  );
  const doctor = record(
    JSON.parse(await readFile(join(CONTRACTS, 'doctor-v1.schema.json'), 'utf8')) as unknown,
    'doctor schema',
  );
  const validateVector = vectorValidator(schema, doctor);
  const invalid = {
    name: 'status-cannot-return-a-judge-state',
    request: { operation: 'status', args: {} },
    result: { kind: 'unavailable', code: 'E_REQUIRED', phase: 'E' },
  };
  assert.equal(validateVector(invalid), false, 'a closed judge result does not validate for status');
  assert.throws(
    () => assertB3ControlContractVectorV1(invalid),
    /status result must be a closed object/u,
    'the TypeScript runtime vector guard keeps the same operation/result boundary',
  );
});

test('B3 v1 gives every desktop wire a closed result schema that rejects empty and unknown result objects', async () => {
  const schema = record(
    JSON.parse(await readFile(join(CONTRACTS, 'b3-control-v1.schema.json'), 'utf8')) as unknown,
    'B3 control schema',
  );
  const doctor = record(
    JSON.parse(await readFile(join(CONTRACTS, 'doctor-v1.schema.json'), 'utf8')) as unknown,
    'doctor schema',
  );
  const definitions = record(schema.$defs, 'B3 control schema definitions');
  const results = record(
    record(definitions.resultsByOperation, 'per-operation result schemas').$defs,
    'result schema map',
  );
  const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(doctor);
  ajv.addSchema(schema);
  const desktopWires = ownerWireOperations()
    .filter((entry) => entry.desktopCallable)
    .map((entry) => entry.wireOperation)
    .sort();
  assert.deepEqual(
    Object.keys(results).sort(),
    desktopWires,
    'the registry automatically makes a new desktop wire require its own result schema',
  );
  for (const operation of desktopWires) {
    const validate = ajv.getSchema(`${schema.$id as string}#/$defs/resultsByOperation/$defs/${operation}`);
    assert.ok(validate, `${operation} has an addressable result schema`);
    assert.equal(validate({}), false, `${operation} rejects an empty ordinary result object`);
    assert.equal(
      validate({ unexpected: true }),
      false,
      `${operation} rejects an ordinary result with an unknown property`,
    );
  }
  const checked = await vectors();
  for (const operation of desktopWires) {
    const vector = checked.find((candidate) => {
      const value = record(candidate, 'vector');
      return Object.hasOwn(value, 'result') && record(value.request, 'result vector request').operation === operation;
    });
    assert.ok(vector, `${operation} has a checked-in successful result vector`);
    const invalid = JSON.parse(JSON.stringify(vector)) as Record<string, unknown>;
    invalid.result = { unexpected: true };
    assert.throws(
      () => assertB3ControlContractVectorV1(invalid),
      `${operation} runtime result validation rejects an unknown ordinary result object`,
    );
  }
});

test('B3 exported closed string vocabularies are tuple-derived rather than handwritten unions', async () => {
  const source = await readFile(join(import.meta.dirname, '../src/operations/b3-contract.ts'), 'utf8');
  const exportedDeclarations = source
    .split(/(?=^export\b|^(?:const|function|type|interface)\b)/mu)
    .filter((declaration) => /^export (?:type|interface)\b/u.test(declaration));
  for (const declaration of exportedDeclarations) {
    assert.doesNotMatch(
      declaration,
      /(?:'[^']+'|"[^"]+")\s*\|\s*(?:'[^']+'|"[^"]+")/u,
      `closed string unions in exported declarations must derive from an exported runtime tuple:\n${declaration}`,
    );
  }
});

test('B3 v1 successful vectors use the daemon canonical document validators', async () => {
  const checked = await vectors();
  const validRuleResult = checked.find((vector) => {
    const request = record(record(vector, 'vector').request, 'result vector request');
    return request.operation === 'rule-create' && Object.hasOwn(vector as object, 'result');
  });
  assert.ok(validRuleResult, 'the fixture set carries a successful rule-create vector');
  const invalidRuleResult = JSON.parse(JSON.stringify(validRuleResult)) as {
    readonly request: { readonly args: { readonly document: Record<string, unknown> } };
  };
  invalidRuleResult.request.args.document.condition = {};
  assert.throws(
    () => assertB3ControlContractVectorV1(invalidRuleResult),
    /condition leaf/u,
    'a successful contract vector must use the daemon rule-document validator',
  );
  for (const vector of checked) {
    const value = record(vector, 'vector');
    if (!Object.hasOwn(value, 'result')) continue;
    const request = record(value.request, 'result vector request');
    const args = record(request.args, 'result vector arguments');
    switch (request.operation) {
      case 'rule-create':
      case 'rule-update':
      case 'ruleTest':
        canonicalFullRuleDocument(args.document);
        break;
      case 'target-add':
      case 'target-update':
        canonicalTarget(args.document);
        break;
      case 'addSubscriber':
      case 'updateSubscriber':
        canonicalSubscriber(args.document);
        break;
      case 'addJudge':
      case 'updateJudge':
        canonicalJudge(args.document);
        break;
      case 'approvalView': {
        const result = record(value.result, 'approval result');
        if (result.kind === 'READY') normaliseActivationDocument(result.preview as never);
        break;
      }
    }
  }
});

test('B3 v1 owner wire registry dispatches every desktop capability over the authenticated control protocol', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-b3-contract-wires-');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    try {
      owner = await startEventOwner({ stateDir, tickMs: 60_000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip(
          'EPERM: the sandbox blocks the owner Unix listener; the coordinator runs this control-protocol proof outside it',
        );
        return;
      }
      throw error;
    }
    const checked = await vectors();
    const requestFor = (wireOperation: string) => {
      const vector = checked.find(
        (candidate) => record(record(candidate, 'vector').request, 'request').operation === wireOperation,
      );
      assert.ok(vector, `${wireOperation} has a language-neutral request vector`);
      return record(record(vector, 'vector').request, 'request').args as Record<string, unknown>;
    };
    const client = new EventControlClient({ stateDir, clientName: 'b3-contract-wire-test' });
    const wires = ownerWireOperations().filter((entry) => entry.desktopCallable);
    for (const { wireOperation } of [
      ...wires.filter((entry) => entry.wireOperation !== 'stop'),
      ...wires.filter((entry) => entry.wireOperation === 'stop'),
    ]) {
      try {
        await client.request(wireOperation, requestFor(wireOperation));
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        assert.notEqual(code, 'USAGE', `${wireOperation} reaches a real owner handler, not its unknown-operation path`);
        assert.doesNotMatch(
          String(error),
          /not recognised|unknown operation/u,
          `${wireOperation} is dispatched by the owner`,
        );
      }
    }
  } finally {
    await owner?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 v1 regenerates every ordinary result vector byte-for-byte from its real owner wire', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-b3-ordinary-results-');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    try {
      let intentOrdinal = 0;
      owner = await startEventOwner({
        stateDir,
        now: () => 1_000,
        tickMs: 60_000,
        newIntentId: () => `act_contract_${++intentOrdinal}`,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip(
          'EPERM: the sandbox blocks the owner Unix listener; the coordinator runs this real-owner vector regeneration proof outside it',
        );
        return;
      }
      throw error;
    }
    const ordinary = JSON.parse(await readFile(join(FIXTURES, 'ordinary-results.json'), 'utf8')) as readonly {
      readonly name: string;
      readonly request: {
        readonly operation: string;
        readonly args: Record<string, unknown>;
        readonly origin?: string;
      };
      readonly result: unknown;
    }[];
    const client = new EventControlClient({ stateDir, clientName: 'b3-ordinary-result-regenerator' });
    const replies = new Map<string, unknown>();
    // Core mints approval ids from its cryptographic generator, which a published package does not let a test replace;
    // each distinct id becomes a stable ordinal in order of first appearance, so the bytes are reproducible.
    const approvalIds = new Map<string, string>();
    const stable = (value: unknown): unknown => {
      // An untrusted-content envelope draws a fresh random boundary for every response, by design.
      if (typeof value === 'string' && value.includes('<untrusted-content'))
        return value.replaceAll(/boundary="[A-Za-z0-9_-]+"/gu, 'boundary="BOUNDARY"');
      if (typeof value === 'string' && /^ap_[0-9A-Za-z]{20,}$/u.test(value)) {
        const known = approvalIds.get(value);
        if (known !== undefined) return known;
        const ordinal = `ap_${String(approvalIds.size + 1).padStart(26, '0')}`;
        approvalIds.set(value, ordinal);
        return ordinal;
      }
      if (Array.isArray(value)) return value.map(stable);
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stable(entry)]));
      return value;
    };
    const regenerate = process.env.B3_CONTRACT_REGENERATE === '1';
    for (const vector of [
      ...ordinary.filter((vector) => vector.request.operation !== 'stop'),
      ...ordinary.filter((vector) => vector.request.operation === 'stop'),
    ]) {
      const reply = stable(await client.request(vector.request.operation, vector.request.args));
      replies.set(vector.name, reply);
      if (regenerate) continue;
      assert.deepEqual(
        reply,
        vector.result,
        `${vector.name} is byte-stable and differs when its checked-in ordinary result vector drifts`,
      );
    }
    const generated = ordinary.map((vector) => ({ ...vector, result: replies.get(vector.name) }));
    if (regenerate) {
      // Coordinator-only: rewrites the fixture from the real owner's replies; the normal run then proves it unchanged.
      await writeFile(join(FIXTURES, 'ordinary-results.json'), vectorJson(generated));
      return;
    }
    assert.deepEqual(
      generated,
      ordinary,
      'every ordinary desktop result vector is the reply of its real authenticated owner operation',
    );
    assert.equal(
      await readFile(join(FIXTURES, 'ordinary-results.json'), 'utf8'),
      vectorJson(generated),
      'ordinary-results.json is regenerated byte-for-byte from real owner replies',
    );
  } finally {
    await owner?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

// @ts-expect-error E2_REQUIRED is paired only with phase E2.
const mismatchedE2Unavailable: B3JudgeUnavailableV1 = {
  kind: 'unavailable',
  code: 'E2_REQUIRED',
  phase: 'E',
};
void mismatchedE2Unavailable;

// @ts-expect-error closed error codes are derived from B3_CONTROL_ERROR_CODES, not independently widened.
const impossibleB3ErrorCode: B3ControlErrorCodeV1 = 'NEW_CODE';
void impossibleB3ErrorCode;

// @ts-expect-error capability publication status is tuple-derived.
const impossibleCapabilityStatus: B3CapabilityStatus = 'partial';
// @ts-expect-error approval variants are tuple-derived.
const impossibleApprovalVariant: B3ApprovalViewVariant = 'APPROVED';
// @ts-expect-error held-decision actions are tuple-derived.
const impossibleHeldDecision: B3HeldDecision = 'defer';
// @ts-expect-error secret backends are tuple-derived.
const impossibleSecretBackend: B3SecretBackend = 'memory';
// @ts-expect-error approval surfaces are tuple-derived.
const impossibleApprovalSurface: B3PendingTargetApprovalSurface = 'mcp';
// @ts-expect-error owner states are tuple-derived.
const impossibleOwnerState: B3OwnerState = 'stopped';
// @ts-expect-error activation statuses are tuple-derived.
const impossibleActivationStatus: B3ActivationStatus = 'waiting';
// @ts-expect-error delivery result kinds are tuple-derived.
const impossibleOwnerResultKind: B3OwnerResultKind = 'delivery-skipped';
// @ts-expect-error unavailable result kinds are tuple-derived.
const impossibleUnavailableResultKind: B3UnavailableResultKind = 'available';
void [
  impossibleCapabilityStatus,
  impossibleApprovalVariant,
  impossibleHeldDecision,
  impossibleSecretBackend,
  impossibleApprovalSurface,
  impossibleOwnerState,
  impossibleActivationStatus,
  impossibleOwnerResultKind,
  impossibleUnavailableResultKind,
];
