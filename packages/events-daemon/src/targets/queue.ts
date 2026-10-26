import { CommsError } from '@agentcomms/core';
import type { QueueItemV1, QueueJudgeV1, QueueListResultV1 } from '../runtime/queue.ts';

/**
 * The environment variable the event service's MCP server (`agent-events mcp`) sets in its own process, so every
 * program it starts inherits it. The queue's content reads and `queue clear` refuse when it is set (action queue design
 * Q1): that server, and no agent through it, can read or clear the queue. Core's and the channels' MCP servers do not
 * set it, and do not run the event service's CLI. A shell an agent runs is the person's own and is not refused — no
 * CLI gate could make that true.
 */
export const MCP_SERVER_MARKER = 'AGENTCOMMS_MCP_SERVER';

/** Marks this process as an MCP server for itself and every child, before it serves anything. */
export function markMcpServerProcess(env: NodeJS.ProcessEnv, name: string): void {
  env[MCP_SERVER_MARKER] = name;
}

/**
 * The queue's person-only gate: its content reads (Q1), and `queue clear`, which an agent must not be able to use to
 * make the person's queue disappear. A separate gate from dry-run's terminal-only one, which is unchanged.
 */
export function assertNotMcpServer(
  env: NodeJS.ProcessEnv,
  action: 'read' | 'clear' | 'bind' | 'messages' | 'setup' = 'read',
): void {
  const marker = env[MCP_SERVER_MARKER];
  if (marker === undefined || marker === '') return;
  const refusals = {
    read: {
      message:
        "queue item content is for a person, at a terminal or in the app — the event service's MCP server cannot read it",
      hint: 'queue items and queue counts give an agent what is waiting, without what it says.',
    },
    clear: {
      message:
        "clearing the queue is for a person, at a terminal or in the app — the event service's MCP server cannot clear it",
      hint: 'An agent may mark an item done, dismissed or reopened; done and dismissed items stay for their retention.',
    },
    // Routing B1: binding lets one agent window read a lane, so it is the person's act.
    bind: {
      message:
        "binding a lane is for a person, at a terminal or in the app — the event service's MCP server cannot bind one",
      hint: 'An agent gives the person its window id from events_lane_whoami; the person binds it.',
    },
    // 0.32.0 §3.6: what happened to each message — where it went, who read it — is the person's own view.
    messages: {
      message:
        "what happened to each message is for a person, at a terminal or in the app — the event service's MCP server cannot read it",
      hint: 'queue items gives an agent what is waiting, without what it says.',
    },
    // Judge setup and AI provider keys (owner decision 2026-10-26): the person's, from the app or their terminal.
    setup: {
      message:
        "setting up a judge or an AI provider's key is for a person, at a terminal or in the app — the event service's MCP server cannot do it",
      hint: 'An agent can ask the person to set it up in the app: Events → Judges, and Settings → AI providers.',
    },
  } as const;
  throw new CommsError('APPROVAL_REQUIRED', refusals[action].message, {
    hint: refusals[action].hint,
    details: { reason: 'MCP_SERVER_PROCESS', marker: MCP_SERVER_MARKER },
  });
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
  if (item.lane !== null) lines.push(`Lane: ${item.lane}`);
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
