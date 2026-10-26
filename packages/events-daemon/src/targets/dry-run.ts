import { agentMarker, CommsError, canPrompt, newBoundary, renderFencedBody, wrapUntrusted } from '@agentcomms/core';
import { isJsonValue, type JsonValue } from '@agentcomms/events';
import type { DryRunRecord } from '../runtime/dispatcher.ts';

export interface TerminalGateStreams {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream & { readonly isTTY?: boolean };
}

/** Local retained content is a human-only terminal surface: neither JSON nor a detected agent can select it. */
export function assertHumanTerminal(
  env: NodeJS.ProcessEnv,
  streams: TerminalGateStreams,
  json: boolean,
  wording: { readonly agent: string; readonly terminal: string } = {
    agent: 'only a person at an interactive terminal can view retained local content',
    terminal: 'viewing retained local content needs an interactive terminal',
  },
): void {
  const marker = agentMarker(env);
  if (marker !== null)
    throw new CommsError('APPROVAL_REQUIRED', wording.agent, {
      details: { marker },
    });
  if (!canPrompt(env, streams, { json })) throw new CommsError('APPROVAL_REQUIRED', wording.terminal);
}

/** `dryrun show --json` (0.32.0, owner feedback §3.5): the record's metadata and the would-be CloudEvent itself. */
export interface DryRunRecordDataV1 {
  readonly deliveryId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly eventId: string;
  readonly accountId: string;
  readonly deliveredAt: number;
  readonly expiresAt: number;
  /** The exact would-be CloudEvent, parsed: its `agentcommsuntrusted` names the sender-written fields of its `data`. */
  readonly record: JsonValue;
}

/**
 * The record as data for the person's app, which renders every sender-written field as outside text. This is the
 * person's read only: the CLI refuses it inside an MCP server's process, and no MCP result ever carries it (D7).
 */
export function dryRunRecordAsData(record: DryRunRecord): DryRunRecordDataV1 {
  let event: unknown;
  try {
    event = JSON.parse(record.record.cloudEventBytes);
  } catch {
    throw new CommsError('BAD_DATA', 'the retained local record is not a JSON event');
  }
  if (!isJsonValue(event)) throw new CommsError('BAD_DATA', 'the retained local record is not a JSON event');
  return {
    deliveryId: record.deliveryId,
    ruleId: record.ruleId,
    ruleVersion: record.ruleVersion,
    targetId: record.targetId,
    targetVersion: record.targetVersion,
    eventId: record.eventId,
    accountId: record.accountId,
    deliveredAt: record.deliveredAt,
    expiresAt: record.expiresAt,
    record: event,
  };
}

/** Renders the already-authorised local record as untrusted terminal text: the terminal view keeps the envelope. */
export function renderDryRunRecord(record: DryRunRecord): string {
  const boundary = newBoundary();
  const body = wrapUntrusted(record.record.cloudEventBytes, { field: 'event', id: record.deliveryId }, boundary);
  return [
    `Local dry-run delivery ${record.deliveryId}`,
    `Rule ${record.ruleId}@${record.ruleVersion}; target ${record.targetId}@${record.targetVersion}`,
    `Retained until ${new Date(record.expiresAt).toISOString()}`,
    renderFencedBody(body),
  ].join('\n');
}

/** Lists content-free local record metadata for a person at a terminal. */
export function renderDryRunList(
  entries: readonly {
    readonly deliveryId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly expiresAt: number;
  }[],
): string {
  if (entries.length === 0) return 'No retained local dry-run records.';
  return entries
    .map(
      (entry) =>
        `${entry.deliveryId}  ${entry.ruleId}@${entry.ruleVersion}  expires ${new Date(entry.expiresAt).toISOString()}`,
    )
    .join('\n');
}
