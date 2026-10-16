import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { asV2, updateCheckPath } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { v1DownloadRecord, writeV1Record } from '../../core/test/fixtures/approval-v1-0.13.0.ts';
import { createGmailMcpServer } from '../src/mcp/server.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { assertNoBareCommand, gmailInline } from './support/handoffs.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';
import { cli, connect, type ToolResult, toolError, wire } from './support/surfaces.ts';

/*
 * `gmail_attachment_download` and `agent-gmail attachments download` ask the person where to save before they save
 * anything: Downloads, the current folder, or a folder they name. The tool answers the first call with the question
 * and a choice id; the command asks a person at a terminal there and then, answers an agent as the tool does (exit 10),
 * and takes a person's own `--to` in a script. Every folder here is a temporary one: the harness's home stands for the
 * person's, and each server and command is started "in" a temporary folder of its own.
 */

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

const MESSAGE: FakeMessage = {
  id: 'm1',
  threadId: 'm1',
  labelIds: ['INBOX'],
  internalDate: String(Date.parse('2026-09-15T09:00:00Z')),
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Sam Lee <sam@partner.test>' },
      { name: 'Subject', value: 'Invoice for August' },
    ],
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { size: 2, data: base64url('hi') } },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
        body: { size: 13, attachmentId: 'a1' },
      },
    ],
  },
};

async function mailbox(): Promise<{ harness: Harness; home: string; downloads: string; cwd: string }> {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test', messages: { m1: MESSAGE }, attachments: { a1: 'invoice bytes' } },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  // A home of its own, apart from the configuration folder the harness otherwise calls home: that is this package's
  // own folder, which no download is ever saved into (core's `save-deny.ts`). Every server and command below is
  // started with it, through the harness's environment.
  const home = tempDir('agent-gmail-home-');
  harness.env.HOME = home;
  harness.env.USERPROFILE = home;
  return { harness, home, downloads: join(home, 'Downloads'), cwd: tempDir('agent-gmail-cwd-') };
}

async function listing(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort();
  } catch {
    return [];
  }
}

// ── Over MCP ────────────────────────────────────────────────────────────────────────────────────────────────────

test('gmail_attachment_download asks first, with both folders by path, and saves where the answer says', async () => {
  const { harness, downloads, cwd, home } = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    for (const [saveTo, folder] of [
      ['downloads', downloads],
      ['current', cwd],
      [join(tempDir('agent-gmail-other-'), 'made'), undefined],
      ['~/Invoices', join(home, 'Invoices')],
    ] as const) {
      const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
      assert.equal(asked.destinationRequired, true);
      assert.deepEqual(asked.options, [
        { choice: 'downloads', path: downloads, default: true },
        { choice: 'current', path: cwd },
        { choice: 'other' },
      ]);
      assert.match(String(asked.question), /Where should the 1 file \(13 bytes\) from work be saved\?/);
      assert.equal((asked.files as Array<{ size: number }>)[0]?.size, 13);
      assert.match(String(asked.next), /call gmail_attachment_download again/);

      const saved = wire(
        await call('gmail_attachment_download', {
          inbox: 'work',
          messageIds: ['m1'],
          saveTo,
          choiceId: asked.choiceId,
        }),
      );
      assert.equal(saved.destinationRequired, false);
      const expected = folder ?? saveTo;
      assert.equal(saved.folder, expected, saveTo);
      const [file] = saved.files as Array<{ path: string; savedAs: string; size: number; from: string }>;
      assert.equal(file?.path, join(expected, file?.savedAs ?? ''), saveTo);
      assert.equal(file?.from, 'sam@partner.test');
      assert.equal(await readFile(file?.path ?? '', 'utf8'), 'invoice bytes', saveTo);
    }
    // Downloads got one file, the current folder one: each answer went where it said, and nowhere else.
    assert.deepEqual(await listing(downloads), ['invoice.pdf']);
    assert.deepEqual(await listing(cwd), ['invoice.pdf']);
  } finally {
    await close();
  }
});

test('gmail_attachment_download refuses `out` with what replaced it, and an answer the person was not asked for', async () => {
  const { harness, downloads, cwd } = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const out = toolError(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], out: 'x' }));
    assert.equal(out.code, 'USAGE');
    assert.equal(out.message, 'gmail_attachment_download no longer takes `out`');
    assert.match(out.hint ?? '', /`saveTo`/);
    const bare = toolError(
      await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], saveTo: 'downloads' }),
    );
    assert.equal(bare.code, 'USAGE');
    assert.match(bare.message, /`saveTo` answers the download’s question, and needs its `choiceId`/);
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const relative = toolError(
      await call('gmail_attachment_download', {
        inbox: 'work',
        messageIds: ['m1'],
        saveTo: 'Invoices',
        choiceId: asked.choiceId,
      }),
    );
    assert.match(relative.message, /is a relative path/);
    assert.deepEqual(await listing(downloads), []);
    assert.deepEqual(await listing(cwd), []);
  } finally {
    await close();
  }
});

// ── At the command line ──────────────────────────────────────────────────────────────────────────────────────────

test('agent-gmail attachments download asks a person at a terminal — 1, 2 or 3 — and saves where they said', async () => {
  const { harness, downloads, cwd } = await mailbox();
  const argv = ['attachments', 'download', 'm1', '--inbox', 'work'];
  const other = join(tempDir('agent-gmail-other-'), 'Invoices');
  for (const [replies, folder] of [
    [[[/Save them to/, '1']], downloads],
    [[[/Save them to/, '2']], cwd],
    [
      [
        [/Save them to/, '3'],
        [/Which folder\?/, other],
      ],
      other,
    ],
  ] as const) {
    const run = await cli(harness, argv, { tty: true, cwd, replies });
    assert.equal(run.code, 0, run.stderr);
    // The question first: the file, and both folders by path.
    assert.match(run.stdout, /13 bytes · message m1 · part 1 · from sam@partner\.test/);
    assert.ok(run.stdout.includes(`1. Downloads — ${downloads} (the default)`), run.stdout);
    assert.ok(run.stdout.includes(`2. The current folder — ${cwd}`), run.stdout);
    assert.ok(run.stdout.includes(` ${join(folder, 'invoice.pdf')} · 13 bytes · from sam@partner.test`), run.stdout);
    assert.ok(run.stdout.includes(`1 file(s), 13 bytes, saved in ${folder}.`), run.stdout);
    assert.equal(await readFile(join(folder, 'invoice.pdf'), 'utf8'), 'invoice bytes');
  }
  // Anything else cancels: nothing saved, and the question is spent on nothing.
  const cancelled = await cli(harness, argv, { tty: true, cwd, replies: [[/Save them to/, 'no']] });
  assert.equal(cancelled.code, 64, cancelled.stderr);
  assert.match(cancelled.stderr, /cancelled: nothing was saved/);
  assert.deepEqual(await listing(downloads), ['invoice.pdf']);
});

test('agent-gmail attachments download: an agent gets the question and a choice id (exit 10), and saves on its rerun', async () => {
  const { harness, downloads, cwd } = await mailbox();
  const argv = ['attachments', 'download', 'm1', '--inbox', 'work'];
  const agent = { AGENT_COMMS_AGENT: '1' };
  const asked = await cli(harness, [...argv, '--json'], { cwd, env: agent });
  assert.equal(asked.code, 10, asked.stdout);
  const error = asked.envelope().error;
  assert.equal(error?.code, 'APPROVAL_PENDING');
  const choiceId = String(error?.details?.choiceId);
  assert.match(choiceId, /^ap_/);
  assert.deepEqual(error?.details?.options, [
    { choice: 'downloads', path: downloads, default: true },
    { choice: 'current', path: cwd },
    { choice: 'other' },
  ]);
  assert.match(error?.hint ?? '', new RegExp(`--to <downloads\\|current\\|folder> --choice ${choiceId}`));
  assert.deepEqual(await listing(downloads), [], 'saved before anybody answered');

  // Printed for an agent reading plain output, as a change's preview is.
  const printed = await cli(harness, argv, { cwd, env: agent });
  assert.equal(printed.code, 10);
  assert.ok(printed.stdout.includes(`1. Downloads — ${downloads} (the default)`), printed.stdout);

  // `--to` alone, from an agent: refused, for want of the question it would answer.
  const alone = await cli(harness, [...argv, '--to', 'downloads', '--json'], { cwd, env: agent });
  assert.equal(alone.code, 64, alone.stdout);
  assert.match(
    alone.envelope().error?.message ?? '',
    /`--to` answers the download’s question, and needs its `--choice`/,
  );
  assert.deepEqual(await listing(downloads), []);

  // The rerun with the person's answer saves, where they said.
  const saved = await cli(harness, [...argv, '--to', 'current', '--choice', choiceId, '--json'], { cwd, env: agent });
  assert.equal(saved.code, 0, saved.stdout);
  const data = saved.envelope<{ folder: string; files: Array<{ path: string }> }>().data;
  assert.equal(data?.folder, cwd);
  assert.deepEqual(await listing(cwd), ['invoice.pdf']);
  // Once: the same choice again is refused.
  const again = await cli(harness, [...argv, '--to', 'current', '--choice', choiceId, '--json'], { cwd, env: agent });
  assert.equal(again.code, 10, again.stdout);
  assert.match(again.envelope().error?.message ?? '', /answered already/);
});

test('agent-gmail attachments download --to alone: only from a person at a terminal, never a pipe or --json', async () => {
  const { harness, downloads, cwd } = await mailbox();
  const argv = ['attachments', 'download', 'm1', '--inbox', 'work', '--to', 'downloads'];
  // No terminal — a script, a pipe, or an agent that set no marker at all: refused, whatever the environment says.
  for (const [label, extra, tty] of [
    ['no terminal', [], false],
    ['--json at a terminal', ['--json'], true],
    ['an agent at a terminal', [], true],
  ] as const) {
    const run = await cli(harness, [...argv, ...extra], {
      cwd,
      tty,
      env: label === 'an agent at a terminal' ? { CLAUDECODE: '1' } : {},
    });
    assert.equal(run.code, 64, `${label}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout + run.stderr, /`--to` answers the download’s question, and needs its `--choice`/, label);
  }
  assert.deepEqual(await listing(downloads), []);
  // A person at a terminal says where with --to, and nobody is asked: no question is kept.
  const run = await cli(harness, argv, { cwd, tty: true });
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stdout.includes(`1 file(s), 13 bytes, saved in ${downloads}.`), run.stdout);
  assert.deepEqual(await listing(downloads), ['invoice.pdf']);
  assert.deepEqual(await harness.core.approvals.list(), [], 'a question was kept that nobody was asked');
});

test('agent-gmail attachments download --out is refused with what replaced it', async () => {
  const { harness, downloads } = await mailbox();
  const run = await cli(harness, ['attachments', 'download', 'm1', '--inbox', 'work', '--out', 'reports', '--json']);
  assert.equal(run.code, 64, run.stdout);
  const error = run.envelope().error;
  assert.match(error?.message ?? '', /`--out` is no longer taken/);
  assert.match(error?.hint ?? '', /--to downloads, --to current, or --to <folder>/);
  assert.deepEqual(await listing(downloads), []);
  // And `--help` no longer offers it.
  const help = await cli(harness, ['attachments', 'download', '--help']);
  assert.doesNotMatch(help.stdout, /--out/);
  assert.match(help.stdout, /--to <where>/);
});

test('the command and the tool answer with the same question and the same saved result', async () => {
  const { harness, cwd } = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const tool = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const command = await cli(harness, ['attachments', 'download', 'm1', '--inbox', 'work', '--json'], {
      cwd,
      env: { AGENT_COMMS_AGENT: '1' },
    });
    const details = command.envelope().error?.details ?? {};
    // Each answer wraps with a boundary of its own, and names its own id and next step; the rest is the same.
    const unbound = (value: unknown): unknown =>
      typeof value === 'string'
        ? value.replace(/boundary="[^"]+"/g, 'boundary=""')
        : Array.isArray(value)
          ? value.map(unbound)
          : value !== null && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unbound(entry)]))
            : value;
    const same = (value: Record<string, unknown>) => {
      const { choiceId: _id, expiresAt: _at, next: _next, ...rest } = value;
      return unbound(rest);
    };
    assert.deepEqual(same(details), same(tool));

    const savedTool = wire(
      await call('gmail_attachment_download', {
        inbox: 'work',
        messageIds: ['m1'],
        saveTo: 'current',
        choiceId: tool.choiceId,
      }),
    );
    const savedCommand = await cli(
      harness,
      [
        'attachments',
        'download',
        'm1',
        '--inbox',
        'work',
        '--to',
        'current',
        '--choice',
        String(details.choiceId),
        '--json',
      ],
      { cwd, env: { AGENT_COMMS_AGENT: '1' } },
    );
    const data = savedCommand.envelope<Record<string, unknown>>().data ?? {};
    assert.deepEqual(Object.keys(data).sort(), Object.keys(savedTool).sort());
    assert.equal(data.folder, savedTool.folder);
    assert.equal(data.chosen, savedTool.chosen);
  } finally {
    await close();
  }
});

// ── The update notice ─────────────────────────────────────────────────────────────────────────────────────────

function updateOut(harness: Harness): void {
  harness.env.AGENT_COMMS_UPDATE_CHECK = 'on';
  harness.env.npm_config_registry = 'http://127.0.0.1:9/';
  const stateDir = harness.core.paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    updateCheckPath(stateDir),
    JSON.stringify({ lastChecked: new Date().toISOString(), latest: '99.0.0', behind: true, current: null }),
  );
}

test('with an update out, a download is never stopped: the question, then the person’s answer, save as they always do', async () => {
  // Nothing is refused for being behind (design 2026-10-16, U1): the stop that let only the answer's choice id past
  // it is gone, and the first result carries the notice beside it.
  const { harness, downloads, cwd } = await mailbox();
  updateOut(harness);
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const args = { inbox: 'work', messageIds: ['m1'] };
    const asked = await call('gmail_attachment_download', args);
    assert.equal(asked.isError, undefined, JSON.stringify(asked.structuredContent));
    assert.match(String((asked.structuredContent as { update?: unknown }).update), /99\.0\.0 is out/);
    const choiceId = String(wire(asked).choiceId);
    const answered = await call('gmail_attachment_download', { ...args, saveTo: 'downloads', choiceId });
    assert.equal(answered.isError, undefined, JSON.stringify(answered.structuredContent));
    assert.equal((answered.structuredContent as { update?: unknown }).update, undefined, 'said twice');
    assert.deepEqual(await listing(downloads), ['invoice.pdf']);
  } finally {
    await close();
  }

  // The command the same way: the answer saves, and the notice is on stderr.
  const { call: ask, close: closeAsk } = await connect({
    core: harness.core,
    env: { ...harness.env, AGENT_COMMS_UPDATE_CHECK: 'off' },
    cwd,
  });
  let second: string;
  try {
    second = String(wire(await ask('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] })).choiceId);
  } finally {
    await closeAsk();
  }
  const claimed = await cli(
    harness,
    ['attachments', 'download', 'm1', '--inbox', 'work', '--to', 'current', '--choice', second, '--json'],
    { cwd },
  );
  assert.equal(claimed.code, 0, claimed.stdout);
  assert.match(claimed.stderr, /99\.0\.0 is out/);
  assert.deepEqual(await listing(cwd), ['invoice.pdf']);
});

// ── The change policy ─────────────────────────────────────────────────────────────────────────────────────────────

/** The mailbox's change policy made `confirm`: a tightening, which needs nobody's approval. */
async function confirmPolicy(harness: Harness): Promise<void> {
  await harness.core.config.update((config) => {
    const work = config.inboxes.work;
    assert.ok(work);
    return { ...config, inboxes: { ...config.inboxes, work: { ...work, changePolicy: 'confirm' } } };
  });
}

test('under chat, the person’s answer relayed in the tool’s arguments saves', async () => {
  const { harness, cwd } = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    assert.equal(asked.policy, 'chat');
    const saved = wire(
      await call('gmail_attachment_download', {
        inbox: 'work',
        messageIds: ['m1'],
        saveTo: 'current',
        choiceId: asked.choiceId,
      }),
    );
    assert.equal(saved.folder, cwd);
    assert.deepEqual(await listing(cwd), ['invoice.pdf']);
  } finally {
    await close();
  }
});

test('under confirm, an answer in the tool’s arguments or the command’s flags is refused, naming the terminal command', async () => {
  const { harness, downloads, cwd } = await mailbox();
  await confirmPolicy(harness);
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const choiceId = String(asked.choiceId);
    assert.equal(asked.policy, 'confirm');
    // This installation's own `approve`, located (CUE-403).
    const approve = gmailInline(harness.core.paths, ['approve', choiceId]);
    assert.ok(String(asked.question).includes(`at your own terminal — ${approve}`), String(asked.question));
    assertNoBareCommand(String(asked.question));
    assert.match(String(asked.next), /you cannot answer it for them, and a saveTo you pass is refused/);
    for (const saveTo of ['downloads', 'current', undefined]) {
      const refused = toolError(
        await call('gmail_attachment_download', {
          inbox: 'work',
          messageIds: ['m1'],
          ...(saveTo === undefined ? {} : { saveTo }),
          choiceId,
        }),
      );
      assert.equal(refused.code, 'APPROVAL_PENDING', String(saveTo));
      assert.ok((refused.hint ?? '').includes(`${approve} in their own terminal`), refused.hint ?? '');
    }
    // The command's flags are arguments too.
    const flagged = await cli(
      harness,
      ['attachments', 'download', 'm1', '--inbox', 'work', '--to', 'current', '--choice', choiceId, '--json'],
      { cwd, env: { AGENT_COMMS_AGENT: '1' } },
    );
    assert.equal(flagged.code, 10, flagged.stdout);
    assert.equal(flagged.envelope().error?.code, 'APPROVAL_PENDING');
    assert.equal(asV2(await harness.core.approvals.get(choiceId))?.state, 'pending', 'the question was spent');
    assert.deepEqual(await listing(downloads), []);
    assert.deepEqual(await listing(cwd), []);
  } finally {
    await close();
  }
});

test('under confirm, the person answers at their own terminal with `approve`, and the id alone then saves there', async () => {
  const { harness, downloads, cwd } = await mailbox();
  await confirmPolicy(harness);
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const choiceId = String(asked.choiceId);
    // An agent cannot run it.
    const agent = await cli(harness, ['approve', choiceId], { tty: true, env: { CLAUDECODE: '1' } });
    assert.equal(agent.code, 10, agent.stderr);
    const answeredAt = await cli(harness, ['approve', choiceId], { tty: true, replies: [[/Save them to/, '2']] });
    assert.equal(answeredAt.code, 0, answeredAt.stderr);
    assert.match(answeredAt.stdout, /invoice\.pdf/);
    assert.ok(answeredAt.stdout.includes(`2. The current folder — ${cwd}`), answeredAt.stdout);
    assert.match(answeredAt.stdout, /Answered\. Nothing is saved yet/);
    // A relayed answer that is not the person's is refused; the id alone saves where they said.
    const other = toolError(
      await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], saveTo: 'downloads', choiceId }),
    );
    assert.equal(other.code, 'USAGE');
    assert.match(other.message, /answered this question themselves, with current/);
    const saved = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], choiceId }));
    assert.equal(saved.folder, cwd);
    assert.deepEqual(await listing(cwd), ['invoice.pdf']);
    assert.deepEqual(await listing(downloads), []);
    const audit = (await harness.core.audit.tail({ inbox: 'work' })).filter(
      (entry) => entry.operation === 'attachments.download',
    );
    assert.match(audit.at(-1)?.reason ?? '', /\(current, answered in terminal\)/);
  } finally {
    await close();
  }
});

test('the command at a person’s own terminal answers under confirm too: the answer is recorded as given there', async () => {
  const { harness, cwd } = await mailbox();
  await confirmPolicy(harness);
  const run = await cli(harness, ['attachments', 'download', 'm1', '--inbox', 'work'], {
    tty: true,
    cwd,
    replies: [[/Save them to/, '2']],
  });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(await listing(cwd), ['invoice.pdf']);
});

/**
 * A client that raises forms, under a name of its own, answering each form as `answer` says — or, given nothing to
 * answer with, declining it (or cancelling it, as `refuse` says).
 */
async function formClient(
  harness: Harness,
  cwd: string,
  name: string,
  answer: (message: string, schema: unknown) => Record<string, unknown> | null,
  refuse: 'decline' | 'cancel' = 'decline',
) {
  const built = await createGmailMcpServer({ core: harness.core, env: harness.env, cwd });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: '1.0.0' }, { capabilities: { elicitation: {} } });
  const asked: string[] = [];
  client.setRequestHandler('elicitation/create', async (request) => {
    const params = request.params as { message: string; requestedSchema?: unknown };
    asked.push(params.message);
    const content = answer(params.message, params.requestedSchema);
    return content === null
      ? { action: refuse }
      : { action: 'accept' as const, content: content as Record<string, string> };
  });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    asked,
    client,
    call: async (args: Record<string, unknown>) =>
      (await client.callTool({ name: 'gmail_attachment_download', arguments: args })) as ToolResult,
    close: async () => {
      await client.close();
      await built.close();
    },
  };
}

async function trustForms(harness: Harness, client: string): Promise<void> {
  await harness.core.config.update(
    (config) => ({
      ...config,
      defaults: { ...config.defaults, confirm: { ...config.defaults.confirm, elicitationClients: [client] } },
    }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.confirm.elicitationClients'] } },
  );
}

test('under confirm, a client trusted to show forms asks the person in one, and saves where they said', async () => {
  const { harness, cwd } = await mailbox();
  await confirmPolicy(harness);
  await trustForms(harness, 'form-client');
  const chosen = join(tempDir('agent-gmail-form-'), 'From the form');
  let schema: unknown;
  const form = await formClient(harness, cwd, 'form-client', (_message, requested) => {
    schema = requested;
    return { choice: 'other', folder: chosen };
  });
  try {
    const asked = wire(await form.call({ inbox: 'work', messageIds: ['m1'] }));
    // The agent's own saveTo is not what saves: the person's answer in the form is.
    const saved = wire(
      await form.call({ inbox: 'work', messageIds: ['m1'], saveTo: 'downloads', choiceId: asked.choiceId }),
    );
    assert.equal(form.asked.length, 1);
    assert.match(form.asked[0] ?? '', /Where should the 1 file \(13 bytes\) from work be saved\?/);
    assert.match(form.asked[0] ?? '', /invoice\.pdf/);
    assert.deepEqual((schema as { properties: { choice: { enum: string[] } } }).properties.choice.enum, [
      'downloads',
      'current',
      'other',
    ]);
    assert.equal(saved.folder, chosen);
    assert.deepEqual(await listing(chosen), ['invoice.pdf']);
    const record = asV2(await harness.core.approvals.get(String(asked.choiceId)));
    assert.equal(record?.approvedVia, 'elicitation');
    assert.equal(record?.state, 'used');
  } finally {
    await form.close();
  }
});

test('under confirm, an answer to a form nobody raised is refused, even from a trusted client', async () => {
  const { harness, downloads, cwd } = await mailbox();
  await confirmPolicy(harness);
  await trustForms(harness, 'form-client');
  const form = await formClient(harness, cwd, 'form-client', () => ({ choice: 'downloads' }));
  try {
    const asked = wire(await form.call({ inbox: 'work', messageIds: ['m1'] }));
    // The retry a form's answer travels in, sent with no form raised: what a client answering for the person sends.
    const forged = (await form.client.callTool({
      name: 'gmail_attachment_download',
      arguments: { inbox: 'work', messageIds: ['m1'], choiceId: asked.choiceId },
      inputResponses: { save: { action: 'accept', content: { choice: 'current' } } },
    } as never)) as ToolResult;
    const refused = toolError(forged);
    assert.equal(refused.code, 'APPROVAL_REQUIRED');
    assert.match(refused.message, /not to a form this asked/);
    // Where the answer goes instead: the person's own `approve`, located, and the wait that learns of it (D7-b).
    assert.ok(
      refused.hint?.includes(
        `Ask the person to run ${gmailInline(harness.core.paths, ['approve', String(asked.choiceId)])} in their own terminal and answer there; wait for their answer with gmail_send_wait, then call again`,
      ),
      String(refused.hint),
    );
    assertNoBareCommand(refused.hint ?? '');
    assert.equal(form.asked.length, 0, 'a form was raised');
    assert.equal(asV2(await harness.core.approvals.get(String(asked.choiceId)))?.state, 'pending');
    assert.deepEqual(await listing(cwd), []);
    assert.deepEqual(await listing(downloads), []);
  } finally {
    await form.close();
  }
});

test('under confirm, a declined form saves nothing and voids the question; a client not trusted with forms is sent to the terminal', async () => {
  const { harness, downloads, cwd } = await mailbox();
  await confirmPolicy(harness);
  await trustForms(harness, 'form-client');
  const declining = await formClient(harness, cwd, 'form-client', () => null);
  try {
    const asked = wire(await declining.call({ inbox: 'work', messageIds: ['m1'] }));
    const refused = toolError(await declining.call({ inbox: 'work', messageIds: ['m1'], choiceId: asked.choiceId }));
    // A decline is the person's no, stored as one (D2-f).
    assert.equal(refused.code, 'APPROVAL_VOID');
    assert.equal(refused.message, 'nothing was saved: the question was declined');
    const record = asV2(await harness.core.approvals.get(String(asked.choiceId)));
    assert.equal(record?.state, 'revoked');
    assert.equal(record?.reason, 'declined');
  } finally {
    await declining.close();
  }
  const untrusted = await formClient(harness, cwd, 'other-client', () => ({ choice: 'downloads' }));
  try {
    const asked = wire(await untrusted.call({ inbox: 'work', messageIds: ['m1'] }));
    const result = await untrusted.call({ inbox: 'work', messageIds: ['m1'], choiceId: asked.choiceId });
    const refused = toolError(result);
    assert.equal(untrusted.asked.length, 0, 'an untrusted client was handed a form');
    assert.equal(refused.code, 'APPROVAL_PENDING');
    assert.match(refused.message, /^nothing was saved: the change policy here is confirm, so the person answers/);
    // And where the question stands (design 2026-10-05 §D8; CUE-404): pending, and not to be claimed from here.
    const error = result.structuredContent?.error as { details?: { approval?: Record<string, unknown> } } | undefined;
    const stands = error?.details?.approval;
    assert.deepEqual(
      [stands?.id, stands?.kind, stands?.state, stands?.claimable],
      [asked.choiceId, 'download', 'pending', false],
    );
    /*
     * This installation's own `approve`, located, as the test above holds the question to: made for this machine's
     * shell, which is what the answer's refusal is rendered for — not read back as a POSIX line, which a Windows one
     * is not.
     */
    assert.ok(
      refused.hint?.includes(gmailInline(harness.core.paths, ['approve', String(asked.choiceId)])),
      String(refused.hint),
    );
    assertNoBareCommand(refused.hint ?? '');
  } finally {
    await untrusted.close();
  }
  assert.deepEqual(await listing(downloads), []);
  assert.deepEqual(await listing(cwd), []);
});

test('under confirm, a cancelled form decides nothing: the question waits, and the person can still answer it (D2-f)', async () => {
  const { harness, downloads, cwd } = await mailbox();
  await confirmPolicy(harness);
  await trustForms(harness, 'form-client');
  const cancelling = await formClient(harness, cwd, 'form-client', () => null, 'cancel');
  let choiceId = '';
  try {
    const asked = wire(await cancelling.call({ inbox: 'work', messageIds: ['m1'] }));
    choiceId = String(asked.choiceId);
    const waiting = toolError(await cancelling.call({ inbox: 'work', messageIds: ['m1'], choiceId }));
    assert.equal(waiting.code, 'APPROVAL_PENDING');
    assert.equal(waiting.message, 'nothing was saved: the form was cancelled, and the question is still waiting');
    // Where to go: the person's own terminal, and the wait that learns when they have answered.
    assert.ok(waiting.hint?.includes(gmailInline(harness.core.paths, ['approve', choiceId])), String(waiting.hint));
    assert.match(waiting.hint ?? '', /gmail_send_wait/);
    assertNoBareCommand(waiting.hint ?? '');
    assert.equal(asV2(await harness.core.approvals.get(choiceId))?.state, 'pending');
  } finally {
    await cancelling.close();
  }
  // Still the person's to answer: in a form raised again, and the files are saved where they said.
  const answering = await formClient(harness, cwd, 'form-client', () => ({ choice: 'current' }));
  try {
    const saved = wire(await answering.call({ inbox: 'work', messageIds: ['m1'], choiceId }));
    assert.equal(saved.folder, cwd);
    assert.deepEqual(await listing(cwd), ['invoice.pdf']);
  } finally {
    await answering.close();
  }
  assert.deepEqual(await listing(downloads), []);
});

/** A folder programs load from on their own: `~/Library`'s on macOS and Linux, AppData on Windows, whose list has no
 * `~/Library`. */
const LOADED_ON_THEIR_OWN = process.platform === 'win32' ? '~/AppData/Roaming' : '~/Library/LaunchAgents';

// ── Where a download is never saved ───────────────────────────────────────────────────────────────────────────

test('a hidden folder, one reached through a link, and this package’s own are refused over MCP, and the question kept', async () => {
  const { harness, home, cwd } = await mailbox();
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const elsewhere = tempDir('agent-gmail-link-');
  symlinkSync(join(home, '.ssh'), join(elsewhere, 'keys'));
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const approvals = join(harness.core.paths.stateDir, 'approvals');
    for (const saveTo of ['~/.ssh', join(elsewhere, 'keys'), approvals, LOADED_ON_THEIR_OWN]) {
      const refused = toolError(
        await call('gmail_attachment_download', {
          inbox: 'work',
          messageIds: ['m1'],
          saveTo,
          choiceId: asked.choiceId,
        }),
      );
      assert.equal(refused.code, 'BAD_DATA', saveTo);
      assert.match(refused.message, /^cannot save into /, saveTo);
    }
    assert.equal(asV2(await harness.core.approvals.get(String(asked.choiceId)))?.state, 'pending');
    assert.deepEqual(await listing(join(home, '.ssh')), []);
    assert.deepEqual(
      (await listing(approvals)).filter((name) => !name.startsWith('ap_')),
      [],
      'something but an approval was written with the approvals',
    );
  } finally {
    await close();
  }
});

test('a server started in a hidden folder does not offer it; one started in the home does, the home being the person’s own', async () => {
  const { harness, home, downloads } = await mailbox();
  const hidden = join(home, 'app', '.claude');
  mkdirSync(hidden, { recursive: true });
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd: hidden });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    assert.deepEqual(asked.options, [
      { choice: 'downloads', path: downloads, default: true },
      {
        choice: 'current',
        path: hidden,
        // `~/app/.claude`, written with this machine's separator: `~\app\.claude` on Windows.
        unavailable: `it is inside ${join('~', 'app', '.claude')}, a hidden folder: hidden folders hold settings, hooks and keys that programs read on their own`,
      },
      { choice: 'other' },
    ]);
    assert.match(
      String(asked.question),
      /2\. The current folder — .* — not available: it is inside ~[\\/]app[\\/]\.claude/,
    );
    const refused = toolError(
      await call('gmail_attachment_download', {
        inbox: 'work',
        messageIds: ['m1'],
        saveTo: 'current',
        choiceId: asked.choiceId,
      }),
    );
    assert.equal(refused.code, 'BAD_DATA');
  } finally {
    await close();
  }
  const inHome = await connect({ core: harness.core, env: harness.env, cwd: home });
  try {
    const asked = wire(await inHome.call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    assert.deepEqual((asked.options as unknown[])[1], { choice: 'current', path: home });
  } finally {
    await inHome.close();
  }
});

test('a file that could run is named in the question and in `next`, saved with .download after it, one that can hold macros is said to, and each is marked as downloaded', async () => {
  const claude: FakeMessage = {
    ...MESSAGE,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Sam Lee <sam@partner.test>' },
        { name: 'Subject', value: 'Notes' },
      ],
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { size: 2, data: base64url('hi') } },
        {
          partId: '1',
          mimeType: 'text/markdown',
          filename: 'CLAUDE.md',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="CLAUDE.md"' }],
          body: { size: 12, attachmentId: 'a1' },
        },
        {
          partId: '2',
          mimeType: 'application/octet-stream',
          filename: 'setup.exe',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="setup.exe"' }],
          body: { size: 2, attachmentId: 'a2' },
        },
        {
          partId: '3',
          mimeType: 'application/vnd.ms-excel',
          filename: 'report.xls',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="report.xls"' }],
          body: { size: 4, attachmentId: 'a3' },
        },
      ],
    },
  };
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: { m1: claude },
        attachments: { a1: 'instructions', a2: 'MZ', a3: 'xls!' },
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  const home = tempDir('agent-gmail-home-');
  harness.env.HOME = home;
  harness.env.USERPROFILE = home;
  const cwd = tempDir('agent-gmail-cwd-');
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const warnings = [
      'CLAUDE.md will be saved as CLAUDE.md.download — a file tools read or run on their own; rename it yourself if you trust it',
      'setup.exe (executable) will be saved as setup.exe.download — a type that could run; rename it yourself if you trust it',
      // Kept as it is — a person opens it as they open a .xlsx — but said, since it can carry macros.
      'report.xls can hold macros — open it only if you trust the sender',
    ];
    for (const warning of warnings) {
      assert.ok(String(asked.question).includes(`! ${warning}`), String(asked.question));
      assert.ok(String(asked.next).includes(warning), String(asked.next));
    }
    const flags = (asked.files as Array<{ riskFlags: string[] }>).map((file) => file.riskFlags);
    assert.deepEqual(flags, [
      ['auto-read', 'saved-as-download'],
      ['executable', 'saved-as-download'],
      ['macro-capable'],
    ]);
    const saved = wire(
      await call('gmail_attachment_download', {
        inbox: 'work',
        messageIds: ['m1'],
        saveTo: 'current',
        choiceId: asked.choiceId,
      }),
    );
    const files = saved.files as Array<{ savedAs: string; path: string; marked: string | null }>;
    assert.deepEqual(
      files.map((file) => file.savedAs),
      ['CLAUDE.md.download', 'setup.exe.download', 'report.xls'],
    );
    assert.deepEqual(await listing(cwd), ['CLAUDE.md.download', 'report.xls', 'setup.exe.download']);
    assert.deepEqual(
      saved.warnings,
      warnings.map((warning) => warning.replace('will be saved', 'was saved')),
    );
    // Marked as downloaded from the internet, as a browser marks what it saves — where the system has such a mark.
    const expected =
      process.platform === 'darwin' ? 'com.apple.quarantine' : process.platform === 'win32' ? 'Zone.Identifier' : null;
    assert.deepEqual(
      files.map((file) => file.marked),
      [expected, expected, expected],
    );
    if (process.platform === 'darwin') {
      const { execFileSync } = await import('node:child_process');
      for (const file of files) {
        const value = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file.path], { encoding: 'utf8' });
        assert.match(value, /^0081;[0-9a-f]+;agentcomms;/, file.savedAs);
      }
    }
  } finally {
    await close();
  }
});

test('a question an earlier release asked is never put in a form, and the download refuses it by its version', async () => {
  // CUE-404 Task 3 (G11, G1): only a valid version-2 question reaches the form or the save checks.
  const { harness, cwd } = await mailbox();
  await confirmPolicy(harness);
  await trustForms(harness, 'form-client');
  const form = await formClient(harness, cwd, 'form-client', () => ({ choice: 'downloads' }));
  const work = (await harness.core.config.load()).inboxes.work;
  assert.ok(work);
  const legacyId = `ap_${'0'.repeat(25)}Q`;
  writeV1Record(
    harness.core.paths.stateDir,
    v1DownloadRecord({
      approvalId: legacyId,
      digest: 'd'.repeat(64),
      download: {
        summary: 'where to save 1 file from work',
        target: { kind: 'inbox', name: 'work', id: work.id },
        operation: 'attachments.download',
        request: {},
        files: ['m1/1'],
        names: ['invoice.pdf'],
        folders: { downloads: cwd, current: cwd },
      },
      policy: 'confirm',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  try {
    const refused = toolError(await form.call({ inbox: 'work', messageIds: ['m1'], choiceId: legacyId }));
    assert.equal(refused.code, 'APPROVAL_VOID');
    assert.match(refused.message, /prepared by a different version of agent-communications/);
    assert.deepEqual(form.asked, [], 'no form was shown for it');
    assert.deepEqual(await listing(cwd), [], 'nothing was saved');
  } finally {
    await form.close();
  }
});

// ── What the person was shown, and what is saved (CUE-404 Task 19) ─────────────────────────────────────────────

/** Edits a question's record where the store keeps it, as another program could. */
async function tamper(
  harness: Harness,
  choiceId: string,
  edit: (kept: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(harness.core.approvals.directory, `${choiceId}.json`);
  const kept = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(kept);
  writeFileSync(path, JSON.stringify(kept, null, 2));
}

/** Whether Gmail was asked for any attachment's bytes since `from`, its count of requests then. */
const fetchedSince = (harness: Harness, from: number) =>
  harness.google.requests.slice(from).some((request) => request.path.includes('/attachments/'));

test('under confirm, a download waiting for the person names gmail_send_wait, which sees the question waiting, answered, then used', async () => {
  const { harness, cwd } = await mailbox();
  await confirmPolicy(harness);
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const choiceId = String(asked.choiceId);
    const current = String((asked.options as Array<{ path?: string }>)[1]?.path);
    const refused = toolError(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], choiceId }));
    assert.equal(refused.code, 'APPROVAL_PENDING');
    assert.match(refused.hint ?? '', /wait for their answer with gmail_send_wait/);
    const waiting = wire(await call('gmail_send_wait', { approvalId: choiceId, waitSeconds: 0 }));
    assert.deepEqual([waiting.state, waiting.claimable], ['pending', false]);

    const person = await cli(harness, ['approve', choiceId], { tty: true, replies: [[/Save them to/, '2']] });
    assert.equal(person.code, 0, person.stderr);
    const answered = wire(await call('gmail_send_wait', { approvalId: choiceId, waitSeconds: 0 }));
    assert.deepEqual([answered.state, answered.claimable], ['answered', true]);
    assert.equal(
      (answered.approval as { said?: string }).said,
      `answered at the terminal: save to current (${current})`,
    );

    const saved = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], choiceId }));
    assert.equal(saved.folder, cwd);
    const used = wire(await call('gmail_send_wait', { approvalId: choiceId, waitSeconds: 0 }));
    assert.deepEqual([used.state, used.claimable], ['answered', false]);
  } finally {
    await close();
  }
});

test('under chat, the question the tool saved with says it was answered in the chat, and nothing of where', async () => {
  const { harness, cwd } = await mailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const choiceId = String(asked.choiceId);
    wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], saveTo: 'current', choiceId }));
    const status = wire(await call('gmail_send_wait', { approvalId: choiceId, waitSeconds: 0 }));
    const listed = (
      wire(await call('gmail_send_list', { inbox: 'work' })).approvals as Array<Record<string, unknown>>
    ).find((entry) => entry.approvalId === choiceId);
    for (const [surface, view] of [
      ['status', status.approval],
      ['list', listed],
    ] as const) {
      const shown = view as { state?: string; said?: string };
      assert.deepEqual([shown.state, shown.said], ['answered', 'answered (in chat)'], surface);
      assert.ok(!JSON.stringify(view).includes(cwd), `${surface}: where it was saved is shown`);
    }
    assert.equal(
      asV2(await harness.core.approvals.get(choiceId))?.download?.answer,
      undefined,
      'the chat answer was kept',
    );
  } finally {
    await close();
  }
});

test('a question changed after it was asked or answered saves nothing over MCP, and Gmail is never asked for the attachment (R16b, R19b)', async () => {
  const { harness, downloads, cwd, home } = await mailbox();
  const elsewhere = join(home, 'elsewhere');
  const { call, close } = await connect({ core: harness.core, env: harness.env, cwd });
  try {
    // Under chat: the listing the person was shown, changed before their answer is claimed.
    const chat = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    await tamper(harness, String(chat.choiceId), (kept) => {
      const download = kept.download as { listing: Array<{ size: number }> };
      download.listing[0] = { ...download.listing[0], size: 1 } as { size: number };
    });
    const from = harness.google.requests.length;
    const listingChanged = toolError(
      await call('gmail_attachment_download', {
        inbox: 'work',
        messageIds: ['m1'],
        saveTo: 'current',
        choiceId: chat.choiceId,
      }),
    );
    assert.equal(listingChanged.code, 'APPROVAL_VOID');
    assert.match(listingChanged.message, /is corrupt \(binding-mismatch\)/);
    assert.equal(fetchedSince(harness, from), false, 'Gmail was asked for the attachment');

    // Under confirm: the person's answer, changed after they gave it.
    await confirmPolicy(harness);
    const asked = wire(await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'] }));
    const choiceId = String(asked.choiceId);
    const person = await cli(harness, ['approve', choiceId], { tty: true, replies: [[/Save them to/, '1']] });
    assert.equal(person.code, 0, person.stderr);
    await tamper(harness, choiceId, (kept) => {
      (kept.download as Record<string, unknown>).answer = { choice: 'other', folder: elsewhere };
    });
    const before = harness.google.requests.length;
    const answerChanged = toolError(
      await call('gmail_attachment_download', { inbox: 'work', messageIds: ['m1'], choiceId }),
    );
    assert.equal(answerChanged.code, 'APPROVAL_VOID');
    assert.match(answerChanged.message, /is corrupt \(evidence-contradictory\)/);
    assert.equal(fetchedSince(harness, before), false, 'Gmail was asked for the attachment');
    const status = wire(await call('gmail_send_wait', { approvalId: choiceId, waitSeconds: 0 }));
    assert.equal(status.state, 'corrupt');

    assert.deepEqual(await listing(downloads), []);
    assert.deepEqual(await listing(cwd), []);
    assert.deepEqual(await listing(elsewhere), []);
  } finally {
    await close();
  }
});

test('under confirm, a question whose listing was changed is never put in a form, even to a trusted client, and saves nothing (R18b)', async () => {
  const { harness, downloads, cwd } = await mailbox();
  await confirmPolicy(harness);
  await trustForms(harness, 'form-client');
  const form = await formClient(harness, cwd, 'form-client', () => ({ choice: 'downloads' }));
  try {
    const asked = wire(await form.call({ inbox: 'work', messageIds: ['m1'] }));
    await tamper(harness, String(asked.choiceId), (kept) => {
      const download = kept.download as { listing: Array<Record<string, unknown>> };
      download.listing[0] = { ...download.listing[0], flags: ['macro-capable'] };
    });
    const before = harness.google.requests.length;
    const refused = toolError(await form.call({ inbox: 'work', messageIds: ['m1'], choiceId: asked.choiceId }));
    assert.equal(form.asked.length, 0, 'a form showed a corrupt question');
    assert.equal(refused.code, 'APPROVAL_VOID');
    assert.match(refused.message, /is corrupt \(binding-mismatch\)/);
    assert.equal(fetchedSince(harness, before), false, 'Gmail was asked for the attachment');
    assert.deepEqual(await listing(downloads), []);
    assert.deepEqual(await listing(cwd), []);
  } finally {
    await form.close();
  }
});
