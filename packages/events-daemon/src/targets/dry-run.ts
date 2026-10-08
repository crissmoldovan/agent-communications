import { agentMarker, CommsError, canPrompt, newBoundary, renderFencedBody, wrapUntrusted } from '@agentcomms/core';
import type { DryRunRecord } from '../runtime/dispatcher.ts';

export interface TerminalGateStreams {
  readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream & { readonly isTTY?: boolean };
}

/** Local retained content is a human-only terminal surface: neither JSON nor a detected agent can select it. */
export function assertHumanTerminal(env: NodeJS.ProcessEnv, streams: TerminalGateStreams, json: boolean): void {
  const marker = agentMarker(env);
  if (marker !== null)
    throw new CommsError(
      'APPROVAL_REQUIRED',
      'only a person at an interactive terminal can view retained local content',
      {
        details: { marker },
      },
    );
  if (!canPrompt(env, streams, { json }))
    throw new CommsError('APPROVAL_REQUIRED', 'viewing retained local content needs an interactive terminal');
}

/** Renders the already-authorised local record as untrusted terminal text, never as machine-readable output. */
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

/** Lists content-free local record metadata for the same interactive-human surface. */
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
