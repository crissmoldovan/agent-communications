import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError } from '@agentcomms/core';
import type { InstallMode } from '../manifest.ts';

/**
 * A sign-in that outlives the command that started it.
 *
 * The obvious design keeps the PKCE verifier in a variable and waits for the browser. It works at a terminal and
 * fails for the case this package exists to serve: an agent's shell call returns in seconds and consent takes
 * minutes, so by the time somebody has found the Slack tab, approved, and been redirected, the process holding
 * the verifier is long gone and the code it receives cannot be exchanged by anyone.
 *
 * So the verifier is written down, once, under 0600, with a ten-minute life — and `--finish` claims it. The
 * Gmail side reached the same shape for the same reason, and the parallel is deliberate: two flows that look
 * alike are two flows somebody can reason about together.
 *
 * What is on disk is a PKCE verifier and a `state`, not a credential. Both are useless after the flow completes
 * or expires, and the claim below is atomic so two `--finish` calls cannot both spend one.
 */

export const FLOW_TTL_MS: number = 10 * 60_000;
export const FLOW_ID_PATTERN: RegExp = /^sfl_[A-Za-z0-9]{22}$/;

export interface SlackFlow {
  readonly flowId: string;
  readonly mode: InstallMode;
  /** The alias the workspace will be connected under. */
  readonly alias: string;
  /** Present on a reauth: the account this must turn out to be, checked before anything is replaced. */
  readonly expect?:
    | {
        readonly accountId: string;
        readonly workspaceId: string;
        readonly userId: string;
        readonly oauthClientId?: string | undefined;
        readonly appId?: string | undefined;
      }
    | undefined;
  readonly clientId: string;
  readonly verifier: string;
  readonly state: string;
  readonly redirectUrl: string;
  readonly port: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newFlowId(): string {
  const bytes = randomBytes(22);
  let out = '';
  for (const byte of bytes) out += BASE62[byte % BASE62.length];
  return `sfl_${out}`;
}

function flowDir(stateDir: string): string {
  return join(stateDir, 'slack', 'flows');
}

function flowPath(stateDir: string, flowId: string): string {
  if (!FLOW_ID_PATTERN.test(flowId)) {
    // The id reaches this from a command line, and it is about to become a path. A pattern check here is what
    // stops `../` being one.
    throw new CommsError('USAGE', `${flowId} is not a sign-in id`, {
      hint: 'Use the id `workspace add --start` printed.',
    });
  }
  return join(flowDir(stateDir), `${flowId}.json`);
}

export interface FlowStore {
  save(flow: SlackFlow): Promise<void>;
  /** Reads without consuming. Used to report what is pending, never to complete one. */
  peek(flowId: string): Promise<SlackFlow | null>;
  /**
   * Takes the flow, so nothing else can.
   *
   * Removing the file *is* the claim: two `--finish` calls racing would otherwise both exchange the same code,
   * and Slack would refuse the second while the first had already written a credential — leaving a failure
   * reported for a sign-in that actually worked.
   */
  claim(flowId: string): Promise<SlackFlow>;
  discard(flowId: string): Promise<void>;
  /** Every flow that has not expired, newest first. */
  pending(): Promise<SlackFlow[]>;
}

export function openFlowStore(stateDir: string, now: () => Date): FlowStore {
  return {
    async save(flow) {
      await mkdir(flowDir(stateDir), { recursive: true, mode: 0o700 });
      await writeFile(flowPath(stateDir, flow.flowId), JSON.stringify(flow), { mode: 0o600 });
    },

    async peek(flowId) {
      try {
        const flow = JSON.parse(await readFile(flowPath(stateDir, flowId), 'utf8')) as SlackFlow;
        return Date.parse(flow.expiresAt) <= now().getTime() ? null : flow;
      } catch {
        return null;
      }
    },

    async claim(flowId) {
      const path = flowPath(stateDir, flowId);
      let flow: SlackFlow;
      try {
        flow = JSON.parse(await readFile(path, 'utf8')) as SlackFlow;
      } catch {
        throw new CommsError('NOT_FOUND', 'that sign-in is not waiting to be finished', {
          hint: 'It may have been completed already, or expired. Start again with `agent-slack workspace add`.',
        });
      }
      // Removed before the caller does anything with it, so a second `--finish` finds nothing rather than
      // exchanging the same code twice.
      await rm(path, { force: true });
      if (Date.parse(flow.expiresAt) <= now().getTime()) {
        throw new CommsError('NOT_FOUND', 'that sign-in expired before it was finished', {
          hint: 'Sign-ins last ten minutes. Start again with `agent-slack workspace add`.',
        });
      }
      return flow;
    },

    async discard(flowId) {
      await rm(flowPath(stateDir, flowId), { force: true });
    },

    async pending() {
      let names: string[];
      try {
        names = await readdir(flowDir(stateDir));
      } catch {
        return [];
      }
      const flows: SlackFlow[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const flow = JSON.parse(await readFile(join(flowDir(stateDir), name), 'utf8')) as SlackFlow;
          // Expired ones are swept rather than listed: a stale sign-in in a list is something to act on, and
          // there is nothing to do about one that can no longer be finished.
          if (Date.parse(flow.expiresAt) <= now().getTime()) {
            await rm(join(flowDir(stateDir), name), { force: true });
            continue;
          }
          flows.push(flow);
        } catch {
          // Unreadable: not this command's problem to report, and not safe to act on either.
        }
      }
      return flows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
  };
}
