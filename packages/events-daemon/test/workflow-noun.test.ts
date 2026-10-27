import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
// @ts-expect-error Repository operation driver is executable ESM without declaration files.
import { driveOperations } from '../../../scripts/operations.mjs';
// @ts-expect-error Repository registry tooling is executable ESM without declaration files.
import { entry, sections } from '../../../scripts/registries.mjs';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';

/*
 * One word (workflows design 2026-10-27, W22, §0.2): a workflow is the one concept, and nothing a person reads calls it
 * anything else. On the command line `workflow` and `workflows` are the names and `rule` and `rules` stay as aliases,
 * so scripts and the app keep working; the MCP tools keep their `events_rule_*` names, which are identifiers, and
 * their titles and descriptions say workflow. Identifiers inside (`ruleId`, the `rule` filter) stay.
 */

const scratch = await mkdtemp(join(tmpdir(), 'events-workflow-noun-'));
after(() => rm(scratch, { recursive: true, force: true }));

/** A stand-in home and Agent Comms folders: no run here resolves the person's own. */
const env: NodeJS.ProcessEnv = {
  HOME: join(scratch, 'home'),
  USERPROFILE: join(scratch, 'home'),
  AGENT_COMMS_CONFIG_DIR: join(scratch, 'config'),
  AGENT_COMMS_STATE_DIR: join(scratch, 'state'),
  AGENT_COMMS_DATA_DIR: join(scratch, 'data'),
  NO_COLOR: '1',
};

function streams(terminal = false): EventsCliStreams & { readonly text: () => string } {
  let text = '';
  const collect = (stream: PassThrough) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      text += String(chunk);
    });
    return Object.assign(stream, { isTTY: terminal });
  };
  return {
    stdin: Object.assign(new PassThrough(), { isTTY: terminal }),
    stdout: collect(new PassThrough()),
    stderr: collect(new PassThrough()),
    text: () => text,
  };
}

async function cli(argv: readonly string[]): Promise<{ readonly code: number; readonly text: string }> {
  const io = streams();
  const code = await run(argv, { env, streams: io });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { code, text: io.text() };
}

const cliHelp = async (path: readonly string[] = []): Promise<string> => (await cli([...path, '--help'])).text;

interface HelpNode {
  readonly path: readonly string[];
  readonly help: string;
}

/** Every node of the command tree, by its listed names, with its help. */
async function helpTree(): Promise<readonly HelpNode[]> {
  const nodes: HelpNode[] = [];
  const visit = async (path: readonly string[]): Promise<void> => {
    const help = await cliHelp(path);
    nodes.push({ path, help });
    for (const listed of sections(help).Commands as string[]) {
      const word = (entry(listed).name as string).split(' ')[0]?.split('|')[0] ?? '';
      if (word === '' || word === 'help') continue;
      await visit([...path, word]);
    }
  };
  await visit([]);
  return nodes;
}

/** Every description a person reads in the help: each command's own, and each command's, option's and argument's. */
async function everyDescription(): Promise<readonly string[]> {
  const lines: string[] = [];
  for (const { path, help } of await helpTree()) {
    const parsed = sections(help) as {
      readonly description: string;
      readonly Arguments: string[];
      readonly Options: string[];
      readonly Commands: string[];
    };
    const where = ['agent-events', ...path].join(' ');
    if (parsed.description !== '') lines.push(`${where}: ${parsed.description}`);
    for (const listed of [...parsed.Arguments, ...parsed.Options, ...parsed.Commands]) {
      const { name, text } = entry(listed) as { readonly name: string; readonly text: string };
      // The line names where it was read, its aliases left out: only its words are what this looks at.
      if (text !== '') lines.push(`${where} ${name.replace(/\|rules?\b/u, '')}: ${text}`);
    }
  }
  return lines;
}

/** Every name a person reads in the help — usage lines, commands, options and their placeholders — but the aliases. */
async function everyName(): Promise<readonly string[]> {
  const names: string[] = [];
  for (const { help } of await helpTree()) {
    const parsed = sections(help) as {
      readonly usage: string;
      readonly Arguments: string[];
      readonly Options: string[];
      readonly Commands: string[];
    };
    const listed = [...parsed.Arguments, ...parsed.Options, ...parsed.Commands];
    // Commander shows a command's alias beside its name, `workflow|rule`: the one place the old word stays.
    for (const name of [parsed.usage, ...listed.map((line) => (entry(line) as { readonly name: string }).name)])
      names.push(name.replace(/\b(workflows?)\|rules?\b/gu, '$1'));
  }
  return names;
}

interface ListedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

async function mcpTools(): Promise<readonly ListedTool[]> {
  const { server } = await createEventsMcpServer({ stateDir: join(scratch, 'mcp-state') });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'events-workflow-noun', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools as readonly ListedTool[];
  } finally {
    await client.close();
  }
}

/** The descriptions of a tool's arguments: words an agent reads, beside the names, which are identifiers. */
function argumentDescriptions(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === 'description' && typeof value === 'string' ? [value] : argumentDescriptions(value),
  );
}

interface Probe {
  readonly argv: readonly string[];
  readonly operation: string;
}

interface Reached {
  readonly calls: readonly string[];
  readonly received: Readonly<Record<string, unknown>>;
}

const PROBES = {
  workflowShow: { argv: ['workflow', 'show', 'w1'], operation: 'ruleShow' },
  ruleShow: { argv: ['rule', 'show', 'w1'], operation: 'ruleShow' },
  workflowsList: { argv: ['workflows', 'list'], operation: 'rulesList' },
  rulesList: { argv: ['rules', 'list'], operation: 'rulesList' },
  workflowRetained: {
    argv: ['workflow', 'test-retained', 'event-1', '--workflow', 'w1', '--version', '2'],
    operation: 'ruleTestRetained',
  },
  ruleRetained: {
    argv: ['rule', 'test-retained', 'event-1', '--rule', 'w1', '--version', '2'],
    operation: 'ruleTestRetained',
  },
  workflowQueueItems: { argv: ['queue', 'items', '--workflow', 'w1'], operation: 'queueItems' },
  ruleQueueItems: { argv: ['queue', 'items', '--rule', 'w1'], operation: 'queueItems' },
} as const satisfies Record<string, Probe>;

let drive: Promise<Readonly<Record<string, Reached>>> | undefined;

/**
 * What each probe's command reached, through the parity drive: every operation stood in for, in a sealed child with a
 * stand-in home and a fake terminal, so a person-only command runs to its operation and nothing it would do happens.
 */
function driven(): Promise<Readonly<Record<string, Reached>>> {
  drive ??= (async () => {
    const dir = await mkdtemp(join(scratch, 'drive-'));
    const rows = Object.entries(PROBES).map(([id, probe]) => ({
      id,
      package: 'events-daemon',
      cli: probe.argv.slice(0, 2).join(' '),
      argv: probe.argv.slice(2),
      mcp: null,
      status: 'exception',
      operation: probe.operation,
    }));
    const result = (await driveOperations({ capabilities: rows }, { dir, packages: ['events-daemon'] })) as {
      readonly fatal?: string;
      readonly reports: Readonly<Record<string, { readonly cli: Reached }>>;
    };
    assert.equal(result.fatal, undefined);
    return Object.fromEntries(Object.entries(result.reports).map(([id, report]) => [id, report.cli]));
  })();
  return drive;
}

async function reachedOperation(probe: keyof typeof PROBES): Promise<Reached> {
  const reached = (await driven())[probe];
  assert.ok(reached, `${probe} was driven`);
  return { calls: reached.calls, received: reached.received };
}

test('workflow and rule name one command; help lists workflow|rule', async () => {
  const help = await cliHelp();
  assert.match(help, /^ {2}workflows\|rules /mu);
  assert.match(help, /^ {2}workflow\|rule /mu);
  assert.doesNotMatch(help, /^ {2}rules? /mu, 'rule and rules are aliases, never commands of their own');
  assert.match(await cliHelp(['rule', 'show']), /^Usage: agent-events workflow show /mu, 'the alias reaches workflow');

  const show = await reachedOperation('workflowShow');
  assert.deepEqual(show.calls, ['events-daemon:ruleShow']);
  assert.equal((show.received as Record<string, Record<string, unknown>>)['events-daemon:ruleShow']?.ruleId, 'w1');
  assert.deepEqual(show, await reachedOperation('ruleShow'));
  const list = await reachedOperation('workflowsList');
  assert.deepEqual(list.calls, ['events-daemon:rulesList']);
  assert.deepEqual(list, await reachedOperation('rulesList'));
});

test('test-retained takes --workflow and still takes a hidden --rule', async () => {
  const help = await cliHelp(['workflow', 'test-retained']);
  assert.match(help, /^ {2}--workflow <workflow-id>(?: |$)/mu);
  assert.doesNotMatch(help, /--rule\b/u, '--rule is hidden');

  const workflow = await reachedOperation('workflowRetained');
  assert.deepEqual(workflow.calls, ['events-daemon:ruleTestRetained']);
  const received = (workflow.received as Record<string, Record<string, unknown>>)['events-daemon:ruleTestRetained'];
  assert.deepEqual(
    { eventId: received?.eventId, ruleId: received?.ruleId, ruleVersion: received?.ruleVersion },
    { eventId: 'event-1', ruleId: 'w1', ruleVersion: 2 },
  );
  assert.deepEqual(workflow, await reachedOperation('ruleRetained'));

  const missing = await cli(['workflow', 'test-retained', 'event-1', '--version', '2']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.text, /required option '--workflow <workflow-id>' not specified/u);
  const twice = await cli([
    'workflow',
    'test-retained',
    'event-1',
    '--workflow',
    'w1',
    '--rule',
    'w2',
    '--version',
    '2',
  ]);
  assert.equal(twice.code, 64, 'two different workflows is a usage error');
});

test('queue items and queue list take --workflow, and still take a hidden --rule', async () => {
  for (const path of [
    ['queue', 'items'],
    ['queue', 'list'],
  ]) {
    const help = await cliHelp(path);
    assert.match(help, /^ {2}--workflow <workflow-id> /mu, path.join(' '));
    assert.doesNotMatch(help, /--rule\b/u, `${path.join(' ')} hides --rule`);
  }
  const workflow = await reachedOperation('workflowQueueItems');
  assert.deepEqual(workflow.calls, ['events-daemon:queueItems']);
  const received = (workflow.received as Record<string, Record<string, unknown>>)['events-daemon:queueItems'];
  assert.equal(received?.['filters.rule'], 'w1', 'the filter keeps its identifier, rule');
  assert.deepEqual(workflow, await reachedOperation('ruleQueueItems'));
});

test('no description a person reads says rule', async () => {
  const descriptions = await everyDescription();
  assert.ok(descriptions.length > 100, 'the whole tree was read');
  for (const line of descriptions) assert.doesNotMatch(line, /\brules?\b/iu, line);
  for (const name of await everyName()) assert.doesNotMatch(name, /\brules?\b/iu, name);
  const tools = await mcpTools();
  assert.ok(
    tools.some((tool) => tool.name === 'events_rule_create'),
    'the tools keep their names',
  );
  for (const tool of tools) {
    assert.doesNotMatch(`${tool.title} ${tool.description}`, /\brules?\b/iu, tool.name);
    for (const words of argumentDescriptions(tool.inputSchema)) assert.doesNotMatch(words, /\brules?\b/iu, tool.name);
  }
  const create = tools.find((tool) => tool.name === 'events_rule_create');
  assert.match(`${create?.title}`, /workflow/u, 'a tool on workflows says workflow');
});
