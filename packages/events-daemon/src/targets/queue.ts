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
 * The person-only gate: the queue's content reads (Q1), and `queue clear`, which an agent must not be able to use to
 * make the person's queue disappear; binding a lane; and since 0.32.0 `delivery show`, the dry-run log's `list` and
 * `show`, `messages list` and `message show`, and judge setup and provider keys; and since 0.33.0 `integration show`.
 * It refuses inside an MCP server's process; a shell an agent runs is the person's own.
 */
export function assertNotMcpServer(
  env: NodeJS.ProcessEnv,
  action:
    | 'read'
    | 'clear'
    | 'bind'
    | 'delivery'
    | 'dryrun'
    | 'messages'
    | 'setup'
    | 'analyse'
    | 'integration'
    | 'relay'
    | 'sessions'
    | 'projects'
    | 'approve' = 'read',
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
    // 0.32.0 (owner feedback §3.5): one delivery's whole story — its decision, event and source ids — is the person's.
    delivery: {
      message:
        "a delivery's details are for a person, at a terminal or in the app — the event service's MCP server cannot read them",
      hint: 'events_deliveries_list gives an agent the content-free delivery rows.',
    },
    // 0.32.0 (§3.5, events design D7): the dry-run log holds the exact would-be event, for a person to read.
    dryrun: {
      message:
        "the dry-run log is for a person, at a terminal or in the app — the event service's MCP server cannot read it",
      hint: 'events_deliveries_list says which deliveries went to a dry-run target, without what they held.',
    },
    // 0.32.0 §3.6: what happened to each message — where it went, who read it — is the person's own view.
    messages: {
      message:
        "what happened to each message is for a person, at a terminal or in the app — the event service's MCP server cannot read it",
      hint: 'queue items gives an agent what is waiting, without what it says.',
    },
    // Judge setup and provider keys (owner decision 2026-10-26; Linear's from 0.33.0): the person's, from the app or
    // their terminal.
    setup: {
      message:
        "setting up a judge or a provider's key is for a person, at a terminal or in the app — the event service's MCP server cannot do it",
      hint: 'An agent can ask the person to set it up in the app: Events → Judges, Settings → AI providers, or Settings → Integrations for Linear.',
    },
    // Settings → Integrations (0.33.0 design §3.4): what the person's Linear key can see is their own read.
    integration: {
      message:
        "what your Linear key can see is for a person, at a terminal or in the app — the event service's MCP server cannot read it",
      hint: 'events_provider_list says whether a Linear key is kept; the person connects Linear in Settings → Integrations.',
    },
    // Analyse (0.33.0 §3.3): what a rule did and the suggestions for it are the person's, when they ask for them.
    analyse: {
      message:
        "analysing a rule is for a person, at a terminal or in the app — the event service's MCP server cannot do it",
      hint: 'An agent can ask the person to press Analyse on the rule in the app: Events → Rules.',
    },
    // Agent sessions (0.33.0 §3.5): where the person's claude-stream relay is, and its token's home, are the person's.
    relay: {
      message:
        "where Agent Comms finds your claude-stream relay is for a person, at a terminal or in the app — the event service's MCP server cannot read or change it",
      hint: 'An agent can ask the person to set it in the app: Settings → Integrations → Agent sessions.',
    },
    // A rule's activation, or switching the event service on, approved in the app (0.33.0 §3.1, 0.34.0 B4): the person's.
    approve: {
      message: "approving is for a person, in the app or at a terminal — the event service's MCP server cannot do it",
      hint: 'An agent gives the person the approval id and its preview; they approve it in the Agent Comms app, or with approve <approval-id> at their terminal.',
    },
    // The busy queue (0.33.0 §3.5): the person's to read and drop from; a bound window sees its own lane's over MCP.
    sessions: {
      message:
        "the items waiting for a busy session are for a person to manage, at a terminal or in the app — the event service's MCP server cannot drop one",
      hint: 'events_session_queue_list shows a bound window the items of its own lane.',
    },
    // Projects (0.36.0 §8.1): the repositories on this Mac, their folders, profile and hints, are the person's alone.
    projects: {
      message:
        "projects are for a person, at a terminal or in the app — the event service's MCP server cannot read or change them",
      hint: 'An agent can ask the person to add or change a project in the app: Events → Projects.',
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
