import { randomInt } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError, type LooseningConsent } from '@agentcomms/core';
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
  /**
   * Proof that a person at a terminal typed a challenge to widen this workspace's access.
   *
   * On the flow rather than gathered at `--finish`, because `--finish` may be headless and may be a different
   * process entirely — which is the whole reason the two-step form exists. The person consented when the sign-in
   * was started, which is also the moment they were told what they were about to change.
   *
   * It sits beside the PKCE verifier under the same 0600 file and the same ten-minute life. Anything that can
   * read this file can already finish the sign-in.
   */
  readonly consent?: LooseningConsent | undefined;
  readonly verifier: string;
  readonly state: string;
  readonly redirectUrl: string;
  readonly port: number;
  /** The detached listener holding that port open, once it has said it is ready. */
  readonly listenerPid?: number | undefined;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * What the detached listener saw, left for `--finish` to collect.
 *
 * A separate file from the flow itself, written by a different process. Keeping them apart means the listener
 * never rewrites the record holding the PKCE verifier, so a crash mid-write cannot destroy the one thing that
 * makes the code exchangeable.
 */
export type FlowOutcome =
  | { readonly code: string; readonly at?: string | undefined }
  | { readonly error: string; readonly description?: string | undefined; readonly at?: string | undefined };

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `randomInt`, not `byte % 62`.
 *
 * 256 is not a multiple of 62, so reducing a random byte modulo 62 makes the first eight characters of the
 * alphabet one part in thirty-one likelier than the rest. Small, and a flow id is not what secures a sign-in —
 * the `state` and the PKCE verifier are — but it is the kind of small that code scanning is right to refuse, and
 * `randomInt` rejects the out-of-range values instead of folding them back in. `@agentcomms/core` already does it
 * this way for challenges; the Gmail package's flow ids have the same bias and are not changed here.
 */
export function newFlowId(): string {
  let out = '';
  for (let i = 0; i < 22; i += 1) out += BASE62[randomInt(BASE62.length)];
  return `sfl_${out}`;
}

function flowDir(stateDir: string): string {
  return join(stateDir, 'slack', 'flows');
}

function flowPath(stateDir: string, flowId: string, suffix = '.json'): string {
  if (!FLOW_ID_PATTERN.test(flowId)) {
    // The id reaches this from a command line, and it is about to become a path. A pattern check here is what
    // stops `../` being one.
    throw new CommsError('USAGE', `${flowId} is not a sign-in id`, {
      hint: 'Use the id `workspace add --start` printed.',
    });
  }
  return join(flowDir(stateDir), `${flowId}${suffix}`);
}

export interface FlowStore {
  save(flow: SlackFlow): Promise<void>;
  /** Reads without consuming. Used to report what is pending, never to complete one. */
  peek(flowId: string): Promise<SlackFlow | null>;
  /** Like `peek`, but a missing or expired flow is an error with the command that starts a new one. */
  get(flowId: string): Promise<SlackFlow>;
  /** Records what the listener learned once it bound — the port it actually got, and its own pid. */
  patch(flowId: string, patch: Partial<SlackFlow>): Promise<SlackFlow>;
  /** Written by the detached listener; read by `--finish`. */
  recordOutcome(flowId: string, outcome: FlowOutcome): Promise<void>;
  readOutcome(flowId: string): Promise<FlowOutcome | null>;
  /**
   * Takes the flow, so nothing else can.
   *
   * The claim is a separate file created with `O_EXCL`, which is the only part of this that is actually atomic.
   * Reading the record and then deleting it is not: two processes can both finish the read before either delete
   * runs, and both deletes then succeed — so both would exchange the same code. Slack refuses the second, and
   * the first has already written a credential, which reports a failure for a sign-in that worked.
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
      let flow: SlackFlow;
      try {
        flow = JSON.parse(await readFile(flowPath(stateDir, flowId), 'utf8')) as SlackFlow;
      } catch {
        return null;
      }
      if (Date.parse(flow.expiresAt) > now().getTime()) return flow;
      /*
       * Swept, not merely reported as absent.
       *
       * A flow file holds a PKCE verifier. Saying "there is nothing there" while leaving it on disk means the
       * only thing that ever removes one is somebody calling `pending()`, and nothing in the product does.
       */
      await this.discard(flowId);
      return null;
    },

    async get(flowId) {
      const flow = await this.peek(flowId);
      if (!flow) {
        throw new CommsError('NOT_FOUND', 'that sign-in is not waiting to be finished', {
          hint: 'It may have been completed already, or expired. Start again with `agent-slack workspace add`.',
        });
      }
      return flow;
    },

    async patch(flowId, patch) {
      const next = { ...(await this.get(flowId)), ...patch };
      await this.save(next);
      return next;
    },

    async recordOutcome(flowId, outcome) {
      await mkdir(flowDir(stateDir), { recursive: true, mode: 0o700 });
      await writeFile(
        flowPath(stateDir, flowId, '.outcome.json'),
        JSON.stringify({ ...outcome, at: now().toISOString() }),
        { mode: 0o600 },
      );
    },

    async readOutcome(flowId) {
      try {
        return JSON.parse(await readFile(flowPath(stateDir, flowId, '.outcome.json'), 'utf8')) as FlowOutcome;
      } catch {
        return null;
      }
    },

    async claim(flowId) {
      const path = flowPath(stateDir, flowId);
      const marker = flowPath(stateDir, flowId, '.claim');
      /*
       * Acquire first, read second — the order is the guarantee.
       *
       * `wx` is `O_EXCL`: the kernel creates the file for exactly one caller and fails for everybody else. But a
       * marker only helps if nothing is trusted before it exists. Reading the record first let a delayed caller
       * hold the flow in memory, wait while the winner finished and `discard` removed both files, then create a
       * fresh marker and exchange the same code with the copy it already had.
       *
       * Holding the marker before reading closes that: a caller arriving after the winner has discarded
       * acquires a marker for a flow that no longer exists, finds nothing, and lets the marker go. The record's
       * absence *is* the tombstone — which is also why `discard` removes the record before the marker.
       */
      await mkdir(flowDir(stateDir), { recursive: true, mode: 0o700 });
      try {
        const handle = await open(marker, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: now().toISOString() }));
        await handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new CommsError('NOT_FOUND', 'that sign-in has already been finished', {
          hint: 'Each sign-in completes once. Start another with `agent-slack workspace add`.',
        });
      }

      let flow: SlackFlow;
      try {
        flow = JSON.parse(await readFile(path, 'utf8')) as SlackFlow;
      } catch {
        // Nothing to claim after all — let the marker go, so it does not stand as a claim on nothing.
        await rm(marker, { force: true });
        throw new CommsError('NOT_FOUND', 'that sign-in is not waiting to be finished', {
          hint: 'It may have been completed already, or expired. Start again with `agent-slack workspace add`.',
        });
      }
      if (Date.parse(flow.expiresAt) <= now().getTime()) {
        await this.discard(flowId);
        throw new CommsError('NOT_FOUND', 'that sign-in expired before it was finished', {
          hint: 'Sign-ins last ten minutes. Start again with `agent-slack workspace add`.',
        });
      }
      return flow;
    },

    async discard(flowId) {
      /*
       * Every trace, and **the record before the marker**.
       *
       * The order is load-bearing, not tidy. `claim` acquires the marker and then reads the record; if the marker
       * went first, a caller arriving between the two removals would acquire it, still find the record, and
       * exchange a code that has already been spent. Record first means the record's absence is what a late
       * caller finds.
       */
      for (const suffix of ['.json', '.outcome.json', '.claim', '.log']) {
        await rm(flowPath(stateDir, flowId, suffix), { force: true });
      }
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
        // `.outcome.json` also ends in `.json`, and parsing one as a flow yields a record with no `expiresAt`:
        // `Date.parse(undefined)` is NaN, every comparison against it is false, and the expired sweep below would
        // have listed it forever as a sign-in that can still be finished.
        if (!name.endsWith('.json') || name.endsWith('.outcome.json')) continue;
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
