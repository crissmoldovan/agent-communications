import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ApprovalStore, CommsError, ConfigStore, emptyConfig } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import {
  type LayaPlatformProbe,
  layaJudgeKindDefinitionFor,
  registerLayaEnablementInputs,
} from '../src/domain/judges.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { renderB3ApprovalPreviewV1 } from '../src/operations/b3-contract.ts';
import { assertB3ControlV3LayaJudgeResult } from '../src/operations/b3-control-v3.ts';
import b3ControlV1Schema from '../src/operations/contracts/b3-control-v1.schema.json' with { type: 'json' };
import b3ControlV3Schema from '../src/operations/contracts/b3-control-v3.schema.json' with { type: 'json' };
import doctorV1Schema from '../src/operations/contracts/doctor-v1.schema.json' with { type: 'json' };
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { JudgeTestControl } from '../src/runtime/judge-test.ts';
import { createOwnerB3ControlService, startEventOwner } from '../src/runtime/owner.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import {
  LAYA,
  layaArtifactOrigin,
  layaRig,
  macPlatform,
  syntheticLaya,
  treeListing,
} from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

assertLoopbackSeal();

/**
 * E2 CI round 1: every test here that starts or awaits a child, a listener, an owner or a worker has a bound of its own.
 * `node --test` has none, and Node 24 keeps a test whose awaited promise never settles pending for ever (Node 22
 * cancels it once the event loop drains): a hang must fail in minutes, not at the job limit hours later.
 */
const CHILD_TEST_TIMEOUT_MS = 120_000;

/*
 * E2 Task 10a: the Laya judge-creation surface (B3 control v3). A Laya judge is configuration: `judge add` and
 * `rule create` keep one whatever Laya's state, and it evaluates only once Laya is enabled and ready. With the shipped
 * placeholder lock no rule naming one can be enabled, and the refusal names Laya's closed reason.
 */

/** The reviewed manifest this release ships (`laya-manifest.json`); the placeholder lock leaves it unoffered. */
const SHIPPED_MANIFEST = 'laya-en-onnx-68f27dfe';
const ACCOUNT = 'ibx_LAYATENAAAAAAAAA';
const QUESTION = 'Does this synthetic message ask for a reply today?';

function layaJudge(overrides: Record<string, unknown> = {}) {
  return {
    judgeId: 'judge-laya-10a',
    version: 1,
    kind: LAYA,
    provider: LAYA,
    model: SHIPPED_MANIFEST,
    promptTemplate: 'laya-noul-v1',
    ...overrides,
  };
}

const target = { targetId: 'target-laya-10a', version: 1, kind: 'dry-run' as const, retentionMs: 60_000 };

function ruleNaming(judge: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'rule-laya-10a',
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    agentic: {
      judge,
      question: QUESTION,
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match' as const,
      callsPerRollingHour: 10,
      inputTokensPerRolling30Days: 100_000,
      concurrency: 1,
      maxInputTokens: 400,
      maxOutputTokens: 64,
    },
    mapping: { subject: { $path: '/subject' } },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
    ...overrides,
  };
}

/**
 * A control or domain refusal with one stable reason: the code over the control protocol, or the domain's own. A
 * Laya refusal also names its reason in the message, which is all the CLI and MCP show a person or an agent.
 */
function refusedWith(reason: string) {
  const named = reason.startsWith('LAYA_') || reason.startsWith('E2_');
  return (error: unknown) =>
    (error instanceof CommsError &&
      error.code === 'BAD_DATA' &&
      (error.details as { reason?: unknown } | undefined)?.reason === reason &&
      (!named || error.message.includes(reason))) ||
    (error instanceof EventDomainError && error.code === reason);
}

interface Production {
  readonly root: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly control: EventControlClient;
  stop(): Promise<void>;
  counts(): Promise<Record<string, number>>;
}

/** The production owner over the daemon's own shipped assets: the placeholder lock, so Laya is not offered. */
async function production(prefix: string): Promise<Production> {
  const root = await shortTempDir(prefix);
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'data');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined = await startEventOwner({
    ...noRealHome(stateDir),
    stateDir,
    configDir: await emptyConfigDir(root),
    dataDir,
    tickMs: 60_000,
  });
  return {
    root,
    stateDir,
    dataDir,
    control: new EventControlClient({ stateDir, clientName: 'events-e2-t10a' }),
    async stop() {
      await owner?.stop();
      owner = undefined;
      await rm(root, { recursive: true, force: true });
    },
    async counts() {
      const live = owner;
      owner = undefined;
      await live?.stop();
      const store = await openEventDatabase({ stateDir });
      try {
        return {
          ...(store.database
            .prepare(
              `SELECT (SELECT count(*) FROM judge_versions) AS judges,
                      (SELECT count(*) FROM rule_versions) AS rules,
                      (SELECT count(*) FROM judge_kind_versions WHERE kind = 'laya') AS layaKinds,
                      (SELECT count(*) FROM activation_intents) AS intents,
                      (SELECT count(*) FROM active_versions) AS pointers,
                      (SELECT count(*) FROM laya_models) AS models`,
            )
            .get() as Record<string, number>),
        };
      } finally {
        store.close();
      }
    },
  };
}

test('E2 Laya judge creation: with the shipped placeholder lock, a Laya judge and its rule are kept as configuration', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const running = await production('events-e2-t10a-create-');
  try {
    const { control } = running;
    const added = (await control.request('addJudge', { document: layaJudge() })) as Record<string, unknown>;
    assert.deepEqual(
      { ...added, digest: typeof added.digest },
      {
        id: 'judge-laya-10a@1',
        kind: 'judge',
        objectId: 'judge-laya-10a',
        version: 1,
        document: layaJudge(),
        digest: 'string',
        state: null,
      },
      'judge add keeps the Laya judge as an inert immutable version',
    );
    const updated = (await control.request('updateJudge', { document: layaJudge({ version: 2 }) })) as {
      readonly id: string;
    };
    assert.equal(updated.id, 'judge-laya-10a@2', 'judge update keeps its next immutable version');
    assert.deepEqual(
      await control.request('judgesList'),
      [1, 2].map((version) => ({
        judgeId: 'judge-laya-10a',
        version,
        kind: LAYA,
        provider: LAYA,
        model: SHIPPED_MANIFEST,
        revokedAt: null,
      })),
      'the B3 v3 inventory lists the Laya judge like any other',
    );
    await control.request('target-add', { document: target });
    const created = (await control.request('rule-create', { document: ruleNaming(layaJudge()) })) as {
      readonly id: string;
      readonly state: unknown;
    };
    assert.equal(created.id, 'rule-laya-10a@1', 'rule create keeps a rule that names the Laya judge');
    assert.equal(created.state, null, 'and the rule is inert');
    await assert.rejects(
      control.request('rule-enable', { ruleId: 'rule-laya-10a', version: 1 }),
      refusedWith('E2_EXTERNAL_REFERENCE_BLOCKED'),
      'enabling the rule reports its Laya judge unavailable, with the release’s closed reason',
    );
    const tested = (await control.request('judgeTest', { judgeId: 'judge-laya-10a', version: 1 })) as {
      readonly kind: string;
    };
    assert.equal(tested.kind, 'refused', 'the Laya judge is not tested while no active rule may call it');
    assert.equal(
      await treeListing(join(running.dataDir, 'events', LAYA)),
      null,
      'no Laya runtime, model or directory exists',
    );
    assert.deepEqual(
      await running.counts(),
      { judges: 2, rules: 1, layaKinds: 0, intents: 0, pointers: 0, models: 0 },
      'configuration only: no Laya enablement, intent, pointer or model row',
    );
  } finally {
    await running.stop();
  }
});

test('E2 Laya judge test: where Laya is not offered, a Laya judge test names Laya’s own reason before any rule authority', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const running = await production('events-e2-t13-judge-test-');
  try {
    const { control } = running;
    await control.request('addJudge', { document: layaJudge() });
    assert.deepEqual(
      await control.request('judgeTest', { judgeId: 'judge-laya-10a', version: 1 }),
      { kind: 'refused', judgeId: 'judge-laya-10a', version: 1, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' },
      'the placeholder lock’s reason, not the rule authority no Laya judge can be granted on this release',
    );
    const viaCli = await cli(['judge', 'test', 'judge-laya-10a', '--version', '1'], running.stateDir);
    assert.equal(viaCli.code, 0, viaCli.stderr);
    assert.match(viaCli.stdout, /E2_EXTERNAL_REFERENCE_BLOCKED/u, 'the person’s terminal names it too');
    // Any other judge keeps E's own order: a version no active rule references is refused for that.
    await control.request('addJudge', {
      document: {
        judgeId: 'judge-local-13',
        version: 1,
        kind: 'local-endpoint',
        provider: 'ollama',
        model: 'synthetic-model',
        // A bare loopback host: E2's checker refuses any other host, a port included, in a Laya test file.
        endpoint: 'http://127.0.0.1/v1/systemone',
        approvedAddressSet: ['127.0.0.1'],
        promptTemplate: 'ollama-noul-v1',
        protocol: 'noul',
      },
    });
    assert.deepEqual(await control.request('judgeTest', { judgeId: 'judge-local-13', version: 1 }), {
      kind: 'refused',
      judgeId: 'judge-local-13',
      version: 1,
      code: 'JUDGE_AUTHORITY_CHANGED',
    });
    assert.deepEqual(
      await running.counts(),
      { judges: 2, rules: 0, layaKinds: 0, intents: 0, pointers: 0, models: 0 },
      'a refused test reserves, enables and installs nothing',
    );
  } finally {
    await running.stop();
  }
  // The database's own Laya inputs decide, as they do for a rule: a release that offers Laya, on a platform that
  // does not, names that platform's reason.
  const laya = await syntheticLaya();
  const stateDir = await shortTempDir('events-e2-t13-judge-test-linux-');
  const store = await openEventDatabase({ stateDir });
  const unregister = registerLayaEnablementInputs(store.database, {
    layaAssetSource: laya.assets,
    layaPlatformProbe: { platform: 'linux', architecture: 'x64' },
  });
  try {
    ImmutableVersions.forJudgeContract(store.database, 'b3-control-v3').createJudge(
      layaJudge({ model: laya.manifestId }),
    );
    const tested = await new JudgeTestControl({
      store,
      taint: {
        record: async () => {
          throw new Error('a refused Laya judge test records no taint');
        },
      },
    }).test({ judgeId: 'judge-laya-10a', version: 1 });
    assert.deepEqual(tested, {
      kind: 'refused',
      judgeId: 'judge-laya-10a',
      version: 1,
      code: 'LAYA_PLATFORM_UNAVAILABLE',
    });
  } finally {
    unregister();
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E2 Laya judge creation: only the binary template on this release’s reviewed manifest can be created', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const running = await production('events-e2-t10a-refuse-');
  try {
    const { control } = running;
    await assert.rejects(
      control.request('addJudge', { document: layaJudge({ promptTemplate: 'laya-choice2-v1' }) }),
      refusedWith('LAYA_TEMPLATE_BLOCKED'),
      'the choice template is refused until its answer has a reviewed source',
    );
    await assert.rejects(
      control.request('updateJudge', { document: layaJudge({ promptTemplate: 'laya-choice2-v1' }) }),
      refusedWith('LAYA_TEMPLATE_BLOCKED'),
    );
    await assert.rejects(
      control.request('addJudge', { document: layaJudge({ model: 'laya-en-onnx-tiny-v1' }) }),
      refusedWith('LAYA_MANIFEST_NOT_REVIEWED'),
      'a Laya judge names this release’s reviewed manifest entry',
    );
    await assert.rejects(
      control.request('addJudge', { document: layaJudge({ promptTemplate: 'laya-free-text-v1' }) }),
      refusedWith('VERSION_DOCUMENT_INVALID'),
      'a template no worker implements is not a Laya judge document at all',
    );
    await control.request('target-add', { document: target });
    await assert.rejects(
      control.request('rule-create', { document: ruleNaming(layaJudge({ promptTemplate: 'laya-choice2-v1' })) }),
      refusedWith('LAYA_TEMPLATE_BLOCKED'),
      'a rule cannot carry a choice-template Laya judge either',
    );
    assert.deepEqual(await control.request('judgesList'), []);
    assert.deepEqual(await running.counts(), {
      judges: 0,
      rules: 0,
      layaKinds: 0,
      intents: 0,
      pointers: 0,
      models: 0,
    });
  } finally {
    await running.stop();
  }
});

test('E2 Laya judge creation: a rule naming a Laya judge is enabled only where this platform offers Laya', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = await syntheticLaya();
  for (const [platform, reason] of [
    [{ platform: 'linux' as const, architecture: 'x64' }, 'LAYA_PLATFORM_UNAVAILABLE'],
    [macPlatform('fails'), 'LAYA_SANDBOX_UNAVAILABLE'],
  ] as const) {
    const stateDir = await shortTempDir('events-e2-t10a-platform-');
    const store = await openEventDatabase({ stateDir });
    const unregister = registerLayaEnablementInputs(store.database, {
      layaAssetSource: laya.assets,
      layaPlatformProbe: platform,
    });
    try {
      const versions = ImmutableVersions.forJudgeContract(store.database, 'b3-control-v3');
      const judge = layaJudge({ model: laya.manifestId });
      versions.createTarget(target);
      versions.createJudge(judge);
      versions.createRule(ruleNaming(judge));
      assert.throws(
        () => new ImmutableVersions(store.database).prepareRule('rule-laya-10a', 1),
        refusedWith(reason),
        `${reason}: the rule's Laya judge is reported unavailable before the kind's own state`,
      );
    } finally {
      unregister();
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('E2 Laya judge creation: an operator control without E2’s artifact manager still answers B3 v1', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e2-t10a-v1-');
  const store = await openEventDatabase({ stateDir });
  try {
    const v1 = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
    await assert.rejects(
      v1.handle({ operation: 'addJudge', args: { document: layaJudge() } }),
      refusedWith('E2_EXTERNAL_REFERENCE_BLOCKED'),
      'v1 has no Laya judge variant: where Laya is not offered, none is created',
    );
    // A Laya judge kept through v3 stays out of v1's inventory.
    ImmutableVersions.forJudgeContract(store.database, 'b3-control-v3').createJudge(layaJudge());
    assert.deepEqual(await v1.handle({ operation: 'judgesList', args: {} }), []);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

async function cli(argv: readonly string[], stateDir: string) {
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  let stdout = '';
  let stderr = '';
  streams.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += String(chunk)));
  streams.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += String(chunk)));
  const code = await run(['--state-dir', stateDir, '--json', ...argv], { streams, env: {} });
  return { code, stdout, stderr };
}

test('E2 Laya judge creation: the CLI and MCP add, list and refuse a Laya judge alike', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const running = await production('events-e2-t10a-parity-');
  const { server } = await createEventsMcpServer({ stateDir: running.stateDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-e2-t10a-parity', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const viaCli = await cli(
      ['judge', 'add', JSON.stringify(layaJudge({ judgeId: 'judge-laya-cli' }))],
      running.stateDir,
    );
    assert.equal(viaCli.code, 0, viaCli.stderr);
    const viaMcp = await client.callTool({
      name: 'events_judge_add',
      arguments: { document: layaJudge({ judgeId: 'judge-laya-mcp' }) },
    });
    assert.notEqual(viaMcp.isError, true, JSON.stringify(viaMcp.content));
    const shape = (value: unknown) => {
      const { id: _id, objectId: _objectId, digest: _digest, document, ...rest } = value as Record<string, unknown>;
      return { ...rest, document: { ...(document as Record<string, unknown>), judgeId: '<id>' } };
    };
    assert.deepEqual(shape(JSON.parse(viaCli.stdout)), shape(viaMcp.structuredContent), 'one operation, one answer');
    const listed = await cli(['judges', 'list'], running.stateDir);
    const mcpListed = await client.callTool({ name: 'events_judges_list', arguments: {} });
    assert.deepEqual(JSON.parse(listed.stdout), (mcpListed.structuredContent as { result: unknown }).result);
    assert.deepEqual(
      (JSON.parse(listed.stdout) as { judgeId: string }[]).map((entry) => entry.judgeId),
      ['judge-laya-cli', 'judge-laya-mcp'],
    );
    const choice = JSON.stringify(layaJudge({ judgeId: 'judge-laya-choice', promptTemplate: 'laya-choice2-v1' }));
    const refusedCli = await cli(['judge', 'add', choice], running.stateDir);
    const refusedMcp = await client.callTool({ name: 'events_judge_add', arguments: { document: JSON.parse(choice) } });
    assert.notEqual(refusedCli.code, 0);
    assert.equal(refusedMcp.isError, true);
    assert.match(refusedCli.stderr, /LAYA_TEMPLATE_BLOCKED/u, 'the CLI names the stable reason');
    assert.match(JSON.stringify(refusedMcp.content), /LAYA_TEMPLATE_BLOCKED/u, 'and so does MCP');
  } finally {
    await Promise.all([client.close(), server.close()]);
    await running.stop();
  }
});

test('E2 Laya judge preview: a rule activation naming a Laya judge shows its template, manifest and D11 limits, and no input text', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = await syntheticLaya();
  const platform = macPlatform();
  const rig = await layaRig({ laya, platform });
  const database = rig.store.database;
  const unregister = registerLayaEnablementInputs(database, {
    layaAssetSource: laya.assets,
    layaPlatformProbe: platform,
  });
  try {
    await rig.enable();
    const config = emptyConfig();
    config.inboxes['events/gmail'] = {
      id: ACCOUNT,
      provider: 'gmail',
      email: 'laya-preview@example.test',
      identity: 'oidc',
      client: 'laya-preview-client',
      tier: 'read',
      contacts: false,
      grantedScopes: [],
      secretRef: `gmail:none:${ACCOUNT}`,
      internalDomains: [],
      createdAt: '2026-10-19T00:00:00.000Z',
    };
    const configDir = join(rig.root, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
    const judge = layaJudge({ model: laya.manifestId });
    await rig.operator.handle({ operation: 'addJudge', args: { document: judge } });
    const versions = ImmutableVersions.forJudgeContract(database, 'b3-control-v3');
    versions.createTarget(target);
    versions.createRule(ruleNaming(judge));
    const prepared = (await rig.activations.prepareRule({ ruleId: 'rule-laya-10a', version: 1 })) as {
      readonly approvalId: string;
      readonly binding: { readonly digest: string };
    };
    const service = (laya3: boolean) =>
      createOwnerB3ControlService({
        store: rig.store,
        ports: {
          quiescer: new WriterQuiescer(),
          secrets: {} as never,
          assertObjectSecretReady: async () => ({ ready: true as const }),
        },
        config: new ConfigStore(configDir),
        activations: rig.activations,
        cipher: { encrypt: async () => Buffer.alloc(0) },
        now: () => 1_800_000_000_000,
        ...(laya3 ? { laya: rig.manager } : {}),
      });
    const view = (await service(true).handle({
      operation: 'approvalView',
      args: { approvalId: prepared.approvalId, digest: prepared.binding.digest },
    })) as Record<string, unknown>;
    assert.equal(view.kind, 'READY');
    const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
    const schemas = new Ajv2020({ allErrors: true, strict: false });
    for (const schema of [b3ControlV1Schema, doctorV1Schema, b3ControlV3Schema]) schemas.addSchema(schema);
    const validate = schemas.getSchema(`${b3ControlV3Schema.$id}#/$defs/resultsByOperation/approvalView`);
    assert.ok(validate !== undefined);
    assert.equal(validate(view), true, `the live view is B3 v3's: ${JSON.stringify(validate.errors)}`);
    assertB3ControlV3LayaJudgeResult('approvalView', view);
    const disclosures = JSON.parse(laya.assets.disclosuresBytes.toString()) as {
      facts: { englishCpu: string; macosBoundary: string; oneAtATime: string };
      limitations: { sandboxDeprecation: string; englishAccuracy: string };
    };
    assert.deepEqual(view.layaJudge, {
      judgeId: 'judge-laya-10a',
      version: 1,
      promptTemplate: 'laya-noul-v1',
      manifestId: laya.manifestId,
      limits: {
        englishCpu: disclosures.facts.englishCpu,
        macosBoundary: disclosures.facts.macosBoundary,
        oneAtATime: disclosures.facts.oneAtATime,
      },
      limitations: disclosures.limitations,
    });
    const block = JSON.stringify(view.layaJudge);
    for (const input of [QUESTION, '/subject', 'Synthetic', ACCOUNT])
      assert.equal(block.includes(input), false, `the Laya preview carries no input text: ${input}`);
    const rendered = renderB3ApprovalPreviewV1(view);
    assert.match(
      rendered.terminal,
      /^Laya judge judge-laya-10a@1: template laya-noul-v1, manifest laya-en-onnx-tiny-v1$/mu,
    );
    for (const fact of [
      disclosures.facts.englishCpu,
      disclosures.facts.macosBoundary,
      disclosures.facts.oneAtATime,
      disclosures.limitations.englishAccuracy,
    ])
      assert.ok(rendered.terminal.includes(fact), `the terminal preview says: ${fact}`);
    const v1 = (await service(false).handle({
      operation: 'approvalView',
      args: { approvalId: prepared.approvalId, digest: prepared.binding.digest },
    })) as Record<string, unknown>;
    assert.equal(v1.kind, 'READY');
    assert.equal(Object.hasOwn(v1, 'layaJudge'), false, 'a B3 v1 owner service keeps v1’s closed approval view');
  } finally {
    unregister();
    await rig.close();
  }
});

test('E2 Laya judge creation: a reviewed entry that lists the choice template still creates no choice judge', {
  skip: WINDOWS_SKIP,
}, async () => {
  // The fixture entry lists both templates; only the worker's noul rule decides which a judge may use.
  const laya = await syntheticLaya();
  const stateDir = await shortTempDir('events-e2-t12-choice-');
  const store = await openEventDatabase({ stateDir });
  const unregister = registerLayaEnablementInputs(store.database, {
    layaAssetSource: laya.assets,
    layaPlatformProbe: macPlatform(),
  });
  try {
    const versions = ImmutableVersions.forJudgeContract(store.database, 'b3-control-v3');
    assert.deepEqual(
      layaJudgeKindDefinitionFor({ layaAssetSource: laya.assets, layaPlatformProbe: macPlatform() }).judgeTerms()
        .promptTemplates,
      ['laya-choice2-v1', 'laya-noul-v1'],
      'the reviewed entry lists the choice template',
    );
    assert.throws(
      () => versions.createJudge(layaJudge({ model: laya.manifestId, promptTemplate: 'laya-choice2-v1' })),
      refusedWith('LAYA_TEMPLATE_BLOCKED'),
      'a listed template the worker refuses is not creatable',
    );
    versions.createJudge(layaJudge({ model: laya.manifestId }));
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM judge_versions').get() as { count: number }).count,
      1,
      'only the noul judge was kept',
    );
  } finally {
    unregister();
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

/** A macOS host whose content-free sandbox probe can stop passing between two phases of one activation. */
function switchableMac(): { readonly probe: LayaPlatformProbe; offered: boolean } {
  const state = { offered: true };
  return Object.assign(state, {
    probe: {
      platform: 'darwin' as const,
      architecture: 'arm64',
      spawnSync: (command: string) =>
        command === '/usr/sbin/sysctl'
          ? { status: 0, signal: null, error: undefined, stdout: '0\n' }
          : { status: state.offered ? 0 : 1, signal: null, error: undefined },
    },
  });
}

/**
 * E's own rule activation path over the synthetic reviewed bytes: the Laya kind enabled through its approval, a Laya
 * judge and its rule kept through B3 v3, and E's core approval store bridged so a test can act after the core claim
 * and immediately before the final pointer swap.
 */
async function ruleActivation(hooks: {
  readonly afterCoreClaim?: (() => void) | undefined;
  readonly beforeFinalise?: (() => void) | undefined;
}) {
  const root = await shortTempDir('events-e2-t12-rule-');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
    id: ACCOUNT,
    provider: 'gmail',
    email: 'laya-rule@example.test',
    identity: 'oidc',
    client: 'laya-rule-client',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${ACCOUNT}`,
    internalDomains: [],
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const laya = await syntheticLaya();
  const mac = switchableMac();
  const inputs = { layaAssetSource: laya.assets, layaPlatformProbe: mac.probe };
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  const unregister = registerLayaEnablementInputs(store.database, inputs);
  const configStore = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => configStore.load() });
  let reachedFinalise = false;
  const runtime = new ActivationRuntime({
    store,
    approvals: {
      createDisclosure: approvals.createDisclosure.bind(approvals),
      approveDisclosure: approvals.approveDisclosure.bind(approvals),
      claimForDisclosure: async (...args: Parameters<typeof approvals.claimForDisclosure>) => {
        const claimed = await approvals.claimForDisclosure(...args);
        hooks.afterCoreClaim?.();
        return claimed;
      },
      get: approvals.get.bind(approvals),
      issueDisclosureChallenge: approvals.issueDisclosureChallenge.bind(approvals),
      list: approvals.list.bind(approvals),
    },
    config: configStore,
    gmailSourceFor: async () => ({
      getProfile: async () => ({
        emailAddress: 'laya-rule@example.test',
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: '404',
      }),
    }),
    encryptBaseline: async (_intent, _account, position) => Buffer.from(JSON.stringify(position)),
    decryptBaseline: async (_intent, _account, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
    encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
    decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
    mailboxLock: new MailboxLock(),
    ...inputs,
    failpoint: (edge) => {
      if (edge !== 'before-finalise') return;
      reachedFinalise = true;
      hooks.beforeFinalise?.();
    },
  });
  const approve = async (prepared: PreparedActivation) => {
    const answer = await runtime.issueChallenge(prepared.approvalId);
    return runtime.approve({ approvalId: prepared.approvalId, answer });
  };
  new ImmutableVersions(store.database, inputs).createJudgeKind(
    layaJudgeKindDefinitionFor(inputs).prepareEnablement({ version: 1 }),
  );
  await approve(await runtime.prepareJudgeKind({ kind: LAYA, version: 1 }));
  const versions = ImmutableVersions.forJudgeContract(store.database, 'b3-control-v3');
  const judge = layaJudge({ model: laya.manifestId });
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createRule(ruleNaming(judge));
  reachedFinalise = false;
  const pointer = (kind: string, objectId: string) =>
    store.database
      .prepare('SELECT version FROM active_versions WHERE kind = ? AND object_id = ?')
      .get(kind, objectId) ?? null;
  return {
    mac,
    runtime,
    approve,
    pointer,
    reachedFinalise: () => reachedFinalise,
    /** Laya stops being offered here, and the kind is disabled too: only Laya's own reason may answer first. */
    withdraw: () => {
      mac.offered = false;
      store.database.prepare("DELETE FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?").run(LAYA);
    },
    async close() {
      unregister();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('E2 Laya judge creation: a rule whose Laya stops being offered after it was prepared is refused at its claim, with Laya’s reason first', {
  skip: WINDOWS_SKIP,
}, async () => {
  let afterCoreClaim: (() => void) | undefined;
  const setup = await ruleActivation({ afterCoreClaim: () => afterCoreClaim?.() });
  try {
    assert.ok(setup.pointer('judge-kind', LAYA) !== null, 'the Laya kind is enabled');
    const prepared = (await setup.runtime.prepareRule({ ruleId: 'rule-laya-10a', version: 1 })) as PreparedActivation;
    afterCoreClaim = setup.withdraw;
    await assert.rejects(
      setup.approve(prepared),
      (error: unknown) => error instanceof Error && error.message.includes('(LAYA_SANDBOX_UNAVAILABLE)'),
      'the local claim re-reads the rule and refuses with Laya’s reason before the kind’s own state',
    );
    assert.equal(setup.reachedFinalise(), false, 'the claim refused it: the final pointer swap was never reached');
    assert.equal(setup.pointer('rule', 'rule-laya-10a'), null, 'no rule pointer exists');
  } finally {
    await setup.close();
  }
});

test('E2 Laya judge creation: a rule whose Laya stops being offered after its claim is refused at finalise, with Laya’s reason first', {
  skip: WINDOWS_SKIP,
}, async () => {
  let beforeFinalise: (() => void) | undefined;
  const setup = await ruleActivation({ beforeFinalise: () => beforeFinalise?.() });
  try {
    const prepared = (await setup.runtime.prepareRule({ ruleId: 'rule-laya-10a', version: 1 })) as PreparedActivation;
    beforeFinalise = setup.withdraw;
    await assert.rejects(
      setup.approve(prepared),
      (error: unknown) => error instanceof Error && error.message.includes('(LAYA_SANDBOX_UNAVAILABLE)'),
      'the final pointer swap re-reads the rule and refuses with Laya’s reason before the kind’s own state',
    );
    assert.equal(setup.reachedFinalise(), true, 'the refusal came at the final swap');
    assert.equal(setup.pointer('rule', 'rule-laya-10a'), null, 'no rule pointer exists');
  } finally {
    await setup.close();
  }
});

test('E2 Laya judge creation: where Laya is offered, judge add and rule create still enable, intend, record and install nothing', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const laya = await syntheticLaya();
  const root = await shortTempDir('events-e2-t12-offered-');
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'data');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined = await startEventOwner({
    ...noRealHome(stateDir),
    stateDir,
    configDir: await emptyConfigDir(root),
    dataDir,
    tickMs: 60_000,
    laya: {
      assets: laya.assets,
      platform: macPlatform(),
      network: layaArtifactOrigin(laya).network,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
    },
  });
  try {
    const control = new EventControlClient({ stateDir, clientName: 'events-e2-t12-offered' });
    const judge = layaJudge({ model: laya.manifestId });
    await control.request('addJudge', { document: judge });
    await control.request('target-add', { document: target });
    await control.request('rule-create', { document: ruleNaming(judge) });
    assert.equal(await treeListing(join(dataDir, 'events', LAYA)), null, 'no Laya runtime, model or directory exists');
    await owner.stop();
    owner = undefined;
    const store = await openEventDatabase({ stateDir });
    try {
      assert.deepEqual(
        {
          ...(store.database
            .prepare(
              `SELECT (SELECT count(*) FROM judge_versions) AS judges,
                      (SELECT count(*) FROM rule_versions) AS rules,
                      (SELECT count(*) FROM judge_kind_versions WHERE kind = 'laya') AS layaKinds,
                      (SELECT count(*) FROM activation_intents) AS intents,
                      (SELECT count(*) FROM active_versions) AS pointers,
                      (SELECT count(*) FROM laya_models) AS models`,
            )
            .get() as Record<string, number>),
        },
        { judges: 1, rules: 1, layaKinds: 0, intents: 0, pointers: 0, models: 0 },
        'configuration only, even where Laya could be enabled',
      );
    } finally {
      store.close();
    }
  } finally {
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
