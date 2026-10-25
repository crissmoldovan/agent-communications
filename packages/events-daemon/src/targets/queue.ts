import { CommsError } from '@agentcomms/core';
import type { QueueItemV1, QueueJudgeV1, QueueListResultV1 } from '../runtime/queue.ts';

/**
 * The environment variable an MCP server sets in its own process, so every program it starts inherits it. The queue's
 * content reads refuse when it is set (action queue design Q1): no MCP server, and no agent through one, can read the
 * queue. A shell an agent runs is the person's own and is not refused — no CLI gate could make that true.
 */
export const MCP_SERVER_MARKER = 'AGENTCOMMS_MCP_SERVER';

/** Marks this process as an MCP server for itself and every child, before it serves anything. */
export function markMcpServerProcess(env: NodeJS.ProcessEnv, name: string): void {
  env[MCP_SERVER_MARKER] = name;
}

/** The queue's content-read gate (Q1): a separate gate from dry-run's terminal-only one, which is unchanged. */
export function assertNotMcpServer(env: NodeJS.ProcessEnv): void {
  const marker = env[MCP_SERVER_MARKER];
  if (marker !== undefined && marker !== '')
    throw new CommsError(
      'APPROVAL_REQUIRED',
      'queue item content is for a person, at a terminal or in the app — an MCP server cannot read it',
      {
        hint: 'queue items and queue counts give an agent what is waiting, without what it says.',
        details: { reason: 'MCP_SERVER_PROCESS', marker: MCP_SERVER_MARKER },
      },
    );
}

function judgeLine(judge: QueueJudgeV1): string {
  switch (judge.state) {
    case 'none':
      return 'Judge: none — the rule matched without one';
    case 'released':
      return `Judge: you let it through (${judge.kind ?? 'judge'} ${judge.id ?? ''})`.trimEnd();
    case 'expired':
      return "Judge: the judge's answer is no longer kept";
    case 'answered':
      return `Judge: ${judge.kind ?? 'judge'} ${judge.id ?? ''} answered ${judge.answer ?? '?'}, ${judge.confidence ?? '?'}${
        judge.uncalibrated ? ' (uncalibrated)' : ''
      }`;
  }
}

/** One item as a person reads it: its sender-written fields stay inside their envelopes, as the owner sent them. */
export function renderQueueItem(item: QueueItemV1): string {
  const lines = [
    `Queue item ${item.id} — ${item.state} since ${item.stateAt}`,
    `Rule ${item.rule.id}@${item.rule.version} · ${item.channel} · ${item.account.alias ?? item.account.id} · arrived ${item.arrivedAt} · content kept until ${item.expiresAt}`,
  ];
  if (item.from.name !== undefined) lines.push(`From (name): ${item.from.name}`);
  if (item.from.address !== undefined) lines.push(`From (address): ${item.from.address}`);
  if (item.subject !== undefined) lines.push(`Subject: ${item.subject}`);
  if (item.text !== undefined) lines.push(`First words: ${item.text}`);
  if (item.from.name === undefined && item.from.address === undefined && item.subject === undefined)
    lines.push('Its content is no longer kept.');
  if (item.link !== undefined)
    lines.push(`Open in ${item.link.kind === 'gmail' ? 'Gmail' : 'Slack'}: ${item.link.url}`);
  lines.push(judgeLine(item.judge));
  return lines.join('\n');
}

export function renderQueueList(result: QueueListResultV1): string {
  if (result.items.length === 0) return 'No queue items.';
  const blocks = result.items.map(renderQueueItem);
  if (result.more) blocks.push('More items are kept: narrow the list with --state, --rule, --channel or --since.');
  return blocks.join('\n\n');
}
