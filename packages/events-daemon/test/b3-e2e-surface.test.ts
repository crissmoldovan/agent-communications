import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ApprovalStore, CommsError, ConfigStore, EXIT_CODES, emptyConfig } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type EventsCliStreams, run, runTerminalApprovalFlow } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { B3_CAPABILITIES } from '../src/operations/b3-contract.ts';
import { ActivationRuntime } from '../src/runtime/activations.ts';
import {
  createOwnerB3ControlService,
  disclosureApprovalChannel,
  issueTerminalApprovalChallenge,
  startEventOwner,
} from '../src/runtime/owner.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ROOT = join(import.meta.dirname, '../../..');

interface Capability {
  readonly id: string;
  readonly package: string;
  readonly cli: string | null;
  readonly mcp: string | null;
  readonly status: 'both' | 'exception';
  readonly argv?: readonly string[];
  readonly args?: Readonly<Record<string, unknown>>;
  readonly unchecked?: string;
}

function tty(): EventsCliStreams {
  return {
    stdin: Object.assign(new PassThrough(), { isTTY: true }),
    stdout: Object.assign(new PassThrough(), { isTTY: true }),
    stderr: Object.assign(new PassThrough(), { isTTY: true }),
  };
}

async function cli(
  argv: readonly string[],
  stateDir: string,
  options: { readonly human?: boolean; readonly readSecret?: () => Promise<string> } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const streams =
    options.human === true
      ? tty()
      : {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        };
  const collect = (stream: PassThrough) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (text += String(chunk)));
    return () => text;
  };
  const stdout = collect(streams.stdout as PassThrough);
  const stderr = collect(streams.stderr as PassThrough);
  const code = await run(['--state-dir', stateDir, ...argv], {
    streams,
    env: {},
    ...(options.readSecret === undefined ? {} : { readSecret: options.readSecret }),
  });
  return { code, stdout: stdout(), stderr: stderr() };
}

function commandWords(row: Capability): readonly string[] {
  if (row.cli === null) throw new Error(`${row.id} must name its CLI route`);
  return row.cli.split(' ');
}

function forbiddenToolName(row: { readonly cli: string }): string {
  return `events_${row.cli
    .replaceAll(/ <[^>]+>/gu, '')
    .replaceAll(/ --[^ ]+(?: <[^>]+>)?/gu, '')
    .replaceAll(/[ -]/gu, '_')}`;
}

/** `approve` and retained show have no safe generic parity fixture in capabilities.json, so give Commander a
 * deliberately missing identity. It reaches the real owner and stops at its ordinary not-found fence before any
 * prompt can wait for input. */
function exceptionArguments(row: Capability): readonly string[] {
  if (row.id === 'events-daemon.approve') return ['ap_00000000000000000000000000'];
  if (row.id === 'events-daemon.dryrun.show') return ['delivery-1'];
  return row.argv ?? [];
}

async function daemonRows(): Promise<readonly Capability[]> {
  const table = JSON.parse(await readFile(join(ROOT, 'capabilities.json'), 'utf8')) as {
    readonly capabilities: readonly Capability[];
  };
  return table.capabilities.filter((row) => row.package === 'events-daemon');
}

function assertProductionResponse(
  result: { readonly code: number; readonly stdout: string; readonly stderr: string },
  row: Capability,
): void {
  // The CLI exits with core's typed codes (sysexits): success, or the operation's own refusal (a missing rule is
  // NOT_FOUND, 66). USAGE (64) would mean Commander refused before any action ran.
  const reached = new Set<number>(Object.values(EXIT_CODES).filter((code) => code !== EXIT_CODES.USAGE));
  assert.ok(reached.has(result.code), `${row.id} reaches the production command action (exit ${result.code})`);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /unknown command|unknown option|local event service is not running/u,
    `${row.id} is dispatched through the running foreground owner`,
  );
}

async function startSealedOwner(stateDir: string) {
  const configDir = join(stateDir, 'config');
  await mkdir(configDir, { recursive: true });
  return startEventOwner({ stateDir, configDir, tickMs: 60_000 });
}

/** A real activation/runtime/owner-service composition with only provider, cipher, and target-transport boundaries
 * faked. It makes the approval test observe the same durable rows and final re-plan fence as a foreground owner. */
async function approvalFlowFixture() {
  const root = await shortTempDir('aev-b3-e2e-approval-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
    id: 'ibx_AAAAAAAAAAAAAAAA',
    provider: 'gmail',
    email: 'b3-e2e-approval@example.test',
    identity: 'oidc',
    client: 'b3-e2e-approval-client',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: 'gmail:none:ibx_AAAAAAAAAAAAAAAA',
    internalDomains: [],
    createdAt: '2026-10-10T00:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  let now = Date.parse('2026-10-10T00:00:00.000Z');
  const store = await openEventDatabase({ stateDir });
  const configStore = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), {
    now: () => new Date(now),
    loadConfig: () => configStore.load(),
  });
  let mutateAfterApproval: (() => void) | undefined;
  const approvedChannels: Array<'terminal' | 'app' | undefined> = [];
  const runtimeApprovals = {
    createDisclosure: approvals.createDisclosure.bind(approvals),
    approveDisclosure: async (...input: Parameters<ApprovalStore['approveDisclosure']>) => {
      const approved = await approvals.approveDisclosure(...input);
      approvedChannels.push(approved.approvedVia);
      mutateAfterApproval?.();
      return approved;
    },
    claimForDisclosure: approvals.claimForDisclosure.bind(approvals),
    get: approvals.get.bind(approvals),
    issueDisclosureChallenge: approvals.issueDisclosureChallenge.bind(approvals),
    list: approvals.list.bind(approvals),
  };
  const versions = new ImmutableVersions(store.database);
  versions.createTarget({ targetId: 'target-b3-e2e-approval', version: 1, kind: 'dry-run', retentionMs: 60_000 });
  store.database.exec('UPDATE event_settings SET enabled = 1 WHERE singleton = 1');
  versions.createRule({
    ruleId: 'rule-b3-e2e-approval',
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: ['ibx_AAAAAAAAAAAAAAAA'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [{ targetId: 'target-b3-e2e-approval', version: 1, kind: 'dry-run', retentionMs: 60_000 }],
    subscribers: [],
    judges: [],
    deliveryRateCap: 1,
    retention: {
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
  });
  const newRuntime = () =>
    new ActivationRuntime({
      store,
      approvals: runtimeApprovals,
      config: configStore,
      now: () => now,
      newIntentId: () => 'act_b3_e2e_approval',
      gmailSourceFor: async () => ({
        getProfile: async () => ({
          emailAddress: 'b3-e2e-approval@example.test',
          messagesTotal: 0,
          threadsTotal: 0,
          historyId: '1',
        }),
      }),
      encryptBaseline: async (_intent, _account, position) => Buffer.from(JSON.stringify(position)),
      decryptBaseline: async (_intent, _account, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
      encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
      decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
      mailboxLock: new MailboxLock(),
    });
  const runtime = newRuntime();
  const preparedResult = await runtime.prepareRule({ ruleId: 'rule-b3-e2e-approval', version: 1 });
  if (!('approvalId' in preparedResult)) throw new Error('the approval-flow fixture unexpectedly derived a tightening');
  const sent: unknown[] = [];
  const service = createOwnerB3ControlService({
    store,
    ports: {
      quiescer: new WriterQuiescer(),
      secrets: {} as never,
      assertObjectSecretReady: async () => ({ ready: true as const }),
    },
    config: configStore,
    activations: runtime,
    cipher: { encrypt: async () => Buffer.alloc(0) },
    targetTestTransport: { send: async (input) => void sent.push(input) },
    now: () => now,
  });
  return {
    root,
    store,
    approvals,
    approvedChannels,
    prepared: preparedResult,
    runtime,
    service,
    sent,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    mutateAfterApproval: (mutation: () => void) => {
      mutateAfterApproval = mutation;
    },
  };
}

test('B3 app approval records app while ordinary CLI approval records terminal and an app terminal challenge is refused', {
  skip: WINDOWS_SKIP,
}, async () => {
  const app = await approvalFlowFixture();
  try {
    assert.equal(disclosureApprovalChannel('app-approval-screen'), 'app');
    assert.equal(disclosureApprovalChannel('events-cli'), 'terminal');
    const view = (await app.service.handle({
      operation: 'approvalView',
      args: { approvalId: app.prepared.approvalId, digest: app.prepared.binding.digest },
      origin: 'app-approval-screen',
    })) as { readonly kind: string; readonly challenge?: { readonly challenge: string } };
    assert.equal(view.kind, 'READY');
    await app.runtime.approve({
      approvalId: app.prepared.approvalId,
      answer: view.challenge?.challenge as string,
      via: 'app',
    });
    assert.deepEqual(app.approvedChannels, ['app'], 'the app approval screen records the only app approval channel');
  } finally {
    app.store.close();
    await rm(app.root, { recursive: true, force: true });
  }

  const terminal = await approvalFlowFixture();
  try {
    const challenge = await terminal.runtime.issueChallenge(terminal.prepared.approvalId);
    await terminal.runtime.approve({
      approvalId: terminal.prepared.approvalId,
      answer: challenge,
      via: 'terminal',
    });
    assert.deepEqual(
      terminal.approvedChannels,
      ['terminal'],
      'all non-app approval clients retain the terminal channel',
    );
  } finally {
    terminal.store.close();
    await rm(terminal.root, { recursive: true, force: true });
  }

  const rejected = await approvalFlowFixture();
  try {
    const challenge = await rejected.runtime.issueChallenge(rejected.prepared.approvalId);
    await assert.rejects(
      () =>
        rejected.runtime.approve({
          approvalId: rejected.prepared.approvalId,
          answer: challenge,
          via: 'app',
        }),
      (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
      'an app answer must bind a challenge issued by approval view, never approve-challenge',
    );
  } finally {
    rejected.store.close();
    await rm(rejected.root, { recursive: true, force: true });
  }
});

test('B3 terminal approval offers each owner-built pending target test before the challenge prompt', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await approvalFlowFixture();
  try {
    const events: string[] = [];
    let start:
      | {
          readonly challenge: string;
          readonly pendingTargetSelectors: readonly unknown[];
        }
      | undefined;
    await runTerminalApprovalFlow({
      approvalId: fixture.prepared.approvalId,
      terminal: {
        async question(prompt) {
          events.push(prompt.startsWith('Test pending target') ? 'prompt-test' : 'prompt-challenge');
          return prompt.startsWith('Test pending target') ? 'yes' : (start?.challenge as string);
        },
      },
      start: async (approvalId) => {
        events.push('start');
        const value = await issueTerminalApprovalChallenge({
          store: fixture.store,
          activations: fixture.runtime,
          approvalId,
          origin: 'terminal-approval',
        });
        if (typeof value === 'string')
          assert.fail('the terminal approval origin receives selectors with its challenge');
        start = value;
        return value;
      },
      testPendingTarget: async (selector) => {
        events.push('test');
        return fixture.service.handle({ operation: 'targetTest', args: { ...selector }, origin: 'terminal-approval' });
      },
      approve: async (approvalId, answer) => {
        events.push('approve');
        return fixture.runtime.approve({ approvalId, answer, via: 'terminal' });
      },
      print: () => events.push('print'),
    });
    assert.deepEqual(events, ['start', 'prompt-test', 'test', 'print', 'prompt-challenge', 'approve', 'print']);
    assert.equal(fixture.sent.length, 1, 'the offered target test uses the owner-built selector exactly once');
    assert.deepEqual(fixture.approvedChannels, ['terminal']);
  } finally {
    fixture.store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('B3 e2e drives every declared both control row through real Commander and MCP adapters', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-b3-e2e-');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    try {
      owner = await startSealedOwner(stateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('EPERM: the sandbox blocks the real owner Unix listener; run this whole-surface proof outside it');
        return;
      }
      throw error;
    }
    const { server } = await createEventsMcpServer({ stateDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'events-b3-e2e', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const rows = (await daemonRows()).filter((row) => row.status === 'both' && row.id !== 'events-daemon.stop');
      assert.ok(rows.length > 0, 'the capability registry declares the dual surface under test');
      for (const row of rows) {
        const command = await cli([...commandWords(row), ...(row.argv ?? [])], stateDir);
        assertProductionResponse(command, row);
        assert.ok(row.mcp, `${row.id} has an MCP route`);
        const reply = await client.callTool({ name: row.mcp as string, arguments: row.args ?? {} });
        const text = reply.content.find((item) => item.type === 'text');
        assert.doesNotMatch(
          text?.text ?? '',
          /tool not found|local event service is not running/u,
          `${row.id} reaches owner`,
        );
        if (row.id.startsWith('events-daemon.judge') || row.id.startsWith('events-daemon.budget')) {
          const rendered = JSON.stringify(reply.structuredContent);
          assert.match(rendered, /E(?:2)?_REQUIRED/u, `${row.id} remains a typed pre-E/E2 result`);
        }
      }
      const stale = await client.callTool({
        name: 'events_approval_view',
        arguments: { approvalId: 'ap_00000000000000000000000000', digest: 'missing-digest' },
      });
      assert.match(
        JSON.stringify(stale.structuredContent),
        /STALE_APPROVAL/u,
        'approval view has a stable stale variant',
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
    const stopped = await cli(['stop'], stateDir);
    assert.equal(stopped.code, 0, 'the CLI drives the stop half of its paired row');
    await owner.stopped;
    owner = undefined;

    const secondOwner = await startSealedOwner(stateDir);
    owner = secondOwner;
    const { server: stopServer } = await createEventsMcpServer({ stateDir });
    const [stopClientTransport, stopServerTransport] = InMemoryTransport.createLinkedPair();
    const stopClient = new Client({ name: 'events-b3-e2e-stop', version: '0' });
    await Promise.all([stopClient.connect(stopClientTransport), stopServer.connect(stopServerTransport)]);
    try {
      const stopped = await stopClient.callTool({ name: 'events_stop', arguments: {} });
      assert.deepEqual(
        stopped.structuredContent,
        { stopping: true },
        'the MCP stop route reaches the replacement owner',
      );
    } finally {
      await Promise.all([stopClient.close(), stopServer.close()]);
    }
    await secondOwner.stopped;
    owner = undefined;
  } finally {
    await owner?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 e2e keeps every terminal exception out of MCP and refuses forged secret-window labels', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-b3-e2e-exception-');
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    try {
      owner = await startSealedOwner(stateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('EPERM: the sandbox blocks the real owner Unix listener; run this exception proof outside it');
        return;
      }
      throw error;
    }
    const { server } = await createEventsMcpServer({ stateDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'events-b3-e2e-exception', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const allRows = await daemonRows();
      const mcpServe = allRows.find((row) => row.id === 'events-daemon.mcp.serve');
      assert.equal(
        mcpServe?.unchecked,
        'It starts the MCP server that an MCP tool would need already running.',
        'the server-start exception is explicitly unchecked rather than silently omitted from CLI/MCP parity',
      );
      assert.equal(mcpServe?.mcp, null, 'the server-start exception cannot have an MCP route');
      const rows = allRows.filter((row) => row.status === 'exception' && row.unchecked === undefined);
      for (const row of rows) {
        const result = await cli([...commandWords(row), ...exceptionArguments(row)], stateDir, {
          human: true,
          readSecret: async () => 'https://receiver.invalid/synthetic-hidden-value',
        });
        assertProductionResponse(result, row);
        if (row.cli !== null) {
          await assert.rejects(
            () =>
              client.callTool({
                name: forbiddenToolName(row as Capability & { readonly cli: string }),
                arguments: row.args ?? {},
              }),
            /not found/u,
            `${row.id} remains deliberately absent from MCP`,
          );
        }
      }
      const forged = await new EventControlClient({ stateDir, clientName: 'forged-secret-window' }).request(
        'targetSecretCreate',
        { targetId: 'target-1', version: 1 },
      );
      assert.deepEqual(forged, { kind: 'unavailable', code: 'APP_SECRET_CAPABILITY_UNAVAILABLE' });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  } finally {
    await owner?.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 owner-built approval view selectors pass unchanged to pending target testing and stay refused from MCP or ordinary CLI', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await approvalFlowFixture();
  try {
    assert.deepEqual(
      await fixture.service.handle({
        operation: 'approvalView',
        args: { approvalId: 'ap_00000000000000000000000000', digest: 'missing' },
      }),
      { kind: 'STALE_APPROVAL' },
      'a nonexistent approval has the stable stale view result',
    );
    assert.deepEqual(
      await fixture.service.handle({
        operation: 'approvalView',
        args: { approvalId: fixture.prepared.approvalId, digest: 'wrong-digest' },
      }),
      { kind: 'DIGEST_MISMATCH' },
      'the owner compares the view digest before issuing a challenge',
    );
    const ready = (await fixture.service.handle({
      operation: 'approvalView',
      args: { approvalId: fixture.prepared.approvalId, digest: fixture.prepared.binding.digest },
    })) as {
      readonly kind: string;
      readonly challenge?: { readonly challenge: string; readonly expiresAt: number };
      readonly pendingTargetSelectors?: readonly {
        readonly kind: 'pending-activation';
        readonly activationId: string;
        readonly ruleId: string;
        readonly ruleVersion: number;
        readonly targetId: string;
        readonly targetVersion: number;
        readonly approvalId: string;
        readonly digest: string;
        readonly challenge: string;
      }[];
    };
    assert.equal(ready.kind, 'READY');
    assert.equal(
      typeof ready.challenge?.challenge,
      'string',
      'only a real pending approval obtains a short-lived challenge',
    );
    assert.equal(typeof ready.challenge?.expiresAt, 'number');
    assert.equal(
      ready.pendingTargetSelectors?.length,
      1,
      'the view supplies one owner-built selector per pending target',
    );
    const selector = ready.pendingTargetSelectors?.[0];
    assert.ok(selector, 'the pending target selector exists');
    assert.deepEqual(
      await fixture.service.handle({ operation: 'targetTest', args: selector, origin: 'app-approval-screen' }),
      { attempts: 1, targetId: selector.targetId, targetVersion: selector.targetVersion },
      'only the approval screen can exercise its exact pending target selector',
    );
    assert.equal(fixture.sent.length, 1, 'the synthetic target transport saw only the approval-flow test');
    for (const origin of ['mcp', 'events-cli'] as const) {
      await assert.rejects(
        () => fixture.service.handle({ operation: 'targetTest', args: selector, origin }),
        /active exact rule reference|pending target selector/u,
        `the ${origin} target-test route cannot use the pending selector`,
      );
    }
    assert.equal(fixture.sent.length, 1, 'the rejected MCP selector never reaches target transport');

    fixture.advance(5 * 60 * 1_000);
    assert.deepEqual(
      await fixture.service.handle({
        operation: 'approvalView',
        args: { approvalId: fixture.prepared.approvalId, digest: fixture.prepared.binding.digest },
      }),
      { kind: 'CHALLENGE_EXPIRED' },
      'the first view after the five-minute deadline reports expiry instead of reviving its challenge',
    );
  } finally {
    fixture.store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }

  const replan = await approvalFlowFixture();
  try {
    const ready = (await replan.service.handle({
      operation: 'approvalView',
      args: { approvalId: replan.prepared.approvalId, digest: replan.prepared.binding.digest },
    })) as { readonly challenge?: { readonly challenge: string } };
    assert.equal(typeof ready.challenge?.challenge, 'string');
    replan.mutateAfterApproval(() => {
      replan.store.database
        .prepare('UPDATE activation_intents SET digest = ? WHERE id = ?')
        .run('changed-after-terminal-answer', replan.prepared.intentId);
    });
    await assert.rejects(
      () =>
        replan.runtime.approve({
          approvalId: replan.prepared.approvalId,
          answer: ready.challenge?.challenge as string,
        }),
      /activation document changed|approval|binding|digest/i,
      'terminal approval re-plans after persisting the answer and refuses a changed pending document',
    );
  } finally {
    replan.store.close();
    await rm(replan.root, { recursive: true, force: true });
  }
});

test('B3 e2e declares a mutation-backed integration ledger for the phase-level safety fences', async () => {
  const text = await readFile(join(import.meta.dirname, 'b3-guard-manifests', 'integration.json'), 'utf8');
  const manifest = JSON.parse(text) as { readonly cases?: readonly { readonly case?: string }[] };
  assert.deepEqual(
    manifest.cases?.map((entry) => entry.case).sort(),
    [
      'integration-app-approval-channel',
      'integration-approval-challenge-issuance-settlement',
      'integration-approval-operation-serialization',
      'integration-approval-view-selector-owner-binding',
      'integration-approval-view-selectors-present',
      'integration-awaiting-reapproval-restart-fence',
      'integration-e-e2-discriminator',
      'integration-pending-context-binding',
      'integration-sanitised-single-envelope',
      'integration-used-approval-issuing-residue-recovery',
    ],
    'Task 10 records each integration mutation outside the consumer-contract entry reserved for Task 9 merge',
  );
  assert.equal(B3_CAPABILITIES.filter((capability) => capability.status === 'both').length, 23);
});
