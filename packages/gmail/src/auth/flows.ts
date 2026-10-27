import { randomInt } from 'node:crypto';
import { open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CliHandoffs,
  CommsError,
  ensurePrivateDir,
  handoffSentence,
  handoffSentenceToFill,
  writeFileAtomic,
} from '@agentcomms/core';
import type { LoopbackAbout } from './loopback.ts';

/**
 * A sign-in in progress. It is written to disk because the two halves run in different processes: an agent's shell
 * dies long before a person has finished clicking through Google's consent screens (Claude Code's Bash tool stops at
 * 120 s, the flow lasts up to 10 minutes), so `--start` records everything and returns, and `--finish` picks it up.
 *
 * The file holds the PKCE verifier and the expected `state`: enough to complete the sign-in, which is why it is
 * written 0600 inside the state directory and deleted as soon as the flow ends.
 */
export interface OAuthFlow {
  flowId: string;
  mode: 'add' | 'reauth';
  alias: string;
  clientName: string;
  tier: string;
  contacts: boolean;
  scopes: string[];
  state: string;
  codeVerifier: string;
  redirectUri: string;
  port: number;
  createdAt: string;
  expiresAt: string;
  /** What the sign-in must turn out to be, checked after consent and before anything is stored. */
  expect: {
    email?: string | undefined;
    sub?: string | undefined;
    inboxId?: string | undefined;
    /** The row the consent link was built for; absent only on a flow written by an earlier release. */
    clientId?: string | undefined;
    /** The organisation generation selected before consent, and which live routing predicates it depended on. */
    generation?:
      | {
          organisation: string;
          name: string;
          active: boolean;
          forOtherAddresses: boolean;
        }
      | undefined;
  };
  /** Set when a detached listener is waiting for the browser redirect. */
  listenerPid?: number | undefined;
  /**
   * The MCP client `setup --mcp-client` was asked to register the server with, when `setup` handed this sign-in off.
   *
   * `setup` without a terminal cannot wait for the browser, so it returns once the link exists and its own
   * registration step never runs. The request used to end there: the mailbox was connected later by a finish that
   * knew nothing of it, everything exited 0, and the server was never registered. So it travels with the flow, and
   * the finish that connects the mailbox takes it up. Absent on every other flow, and on every flow written before
   * this field existed; those finish exactly as they always did.
   */
  registerWith?: RegistrationIntent | undefined;
}

/**
 * A registration a sign-in carries to its finish: the client, how `setup` was asked to start the server, and whether
 * it was asked to replace the entry already there.
 */
export interface RegistrationIntent {
  client: string;
  /** `setup --launcher`, when it was given; the installer's default otherwise. */
  launcher?: string | undefined;
  /**
   * `setup --replace-server`: an entry of this server's own under the same name is replaced, not kept. The finish
   * makes it as `force`, and the `mcp install` that claims it carries `--force`.
   *
   * Carried for the same reason the client is: it used to stop at `setup`, so the finish found the very entry it had
   * been asked to replace and called the client registered, or prepared a change that could not be claimed because
   * replacing had not been asked for. Only written when given; a flow without it finishes as it always did.
   */
  replace?: boolean | undefined;
  /**
   * `setup --standalone`: an entry of the Gmail server's own, as before 0.35.0. Without it the finish puts Gmail into
   * the app's MCP connection, as `mcp install` does (single-server design D17). Only written when given; `replace`,
   * which only an entry of its own can be, finishes as one too.
   */
  standalone?: boolean | undefined;
}

export type FlowOutcome = { code: string } | { error: string; description?: string | undefined };

export const FLOW_ID_PATTERN: RegExp = /^fl_[A-Za-z0-9]{22}$/;
export const FLOW_TTL_MS: number = 10 * 60_000;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `fl_` + 22 base62 characters: 130 bits, and no characters that could confuse a file name.
 *
 * `randomInt`, not `byte % 62`: 256 is not a multiple of 62, so a reduced byte gives the first eight characters 5
 * chances in 256 and the rest 4 — a quarter likelier. The Slack package's flow ids already do it this way.
 */
export function newFlowId(): string {
  let out = 'fl_';
  for (let i = 0; i < 22; i += 1) out += BASE62[randomInt(BASE62.length)];
  return out;
}

/**
 * How to start a sign-in like this one again, in the words of the surface asking.
 *
 * Every refusal of a sign-in that had run out said "Start again with `agent-gmail inbox add <alias> --start`" —
 * to somebody re-authorising a mailbox, which would connect it as a new one and is refused because the name is taken,
 * and to an agent over MCP, sending it to a command it may have no shell for, for a step its own tools take. The
 * flow knows which kind it was and for which mailbox, and the store knows who is asking, so the step is named here.
 */
function startAgain(
  flow: Pick<OAuthFlow, 'mode' | 'alias'>,
  surface: 'cli' | 'mcp',
  handoffs: CliHandoffs,
  say: (step: string) => string,
): string {
  if (surface === 'mcp') {
    return say(
      flow.mode === 'reauth'
        ? `call gmail_inbox_reauth with inbox "${flow.alias}"`
        : `call gmail_inbox_add with alias "${flow.alias}"`,
    );
  }
  // This installation's own command, located; with none here, why — never another command in its place.
  return handoffSentence(
    handoffs.own(['inbox', flow.mode === 'reauth' ? 'reauth' : 'add', flow.alias, '--start']),
    (command) => say(`run ${command}`),
  );
}

/** Flow files, each usable exactly once. The claim is an `O_EXCL` marker, so two `--finish` calls cannot both win. */
export class FlowStore {
  readonly directory: string;
  readonly #now: () => Date;
  /** Who is asking, so a refusal names the next step as that surface takes it. */
  readonly #surface: 'cli' | 'mcp';
  /** The commands a refusal names at a terminal: the context's, asked for only when one is printed. */
  readonly #handoffs: () => CliHandoffs;

  constructor(stateDir: string, now: () => Date, surface: 'cli' | 'mcp', handoffs: () => CliHandoffs) {
    this.directory = join(stateDir, 'flows');
    this.#now = now;
    this.#surface = surface;
    this.#handoffs = handoffs;
  }

  #path(flowId: string, suffix = '.json'): string {
    // Validated before it names a file: a flow id arrives from an agent's command line.
    if (!FLOW_ID_PATTERN.test(flowId)) {
      throw new CommsError('USAGE', `${flowId} is not a flow id`, {
        hint: 'Flow ids look like fl_ followed by 22 letters and digits, and are printed by `inbox add --start`.',
      });
    }
    return join(this.directory, `${flowId}${suffix}`);
  }

  async create(flow: Omit<OAuthFlow, 'flowId' | 'createdAt' | 'expiresAt'>): Promise<OAuthFlow> {
    const now = this.#now();
    const record: OAuthFlow = {
      ...flow,
      flowId: newFlowId(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
    };
    await ensurePrivateDir(this.directory);
    await this.#sweep();
    await writeFileAtomic(this.#path(record.flowId), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  /**
   * Discards flows whose window has passed.
   *
   * Nothing swept before, so an abandoned `inbox add --start` left its PKCE verifier, its `state` and — if consent
   * happened but `--finish` never ran — the **authorization code** on disk for ever. All of it is 0600 inside a
   * 0700 directory, so no other user can read it; the exposure is to whatever else reads the user's own files, a
   * backup or a `~/.config` tarball attached to a bug report. Swept here rather than on a timer because this is
   * the moment somebody is already writing to the directory.
   */
  async #sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    const now = this.#now().getTime();
    for (const name of names) {
      const flowId = name.replace(/\.(outcome\.)?json$/, '');
      if (!FLOW_ID_PATTERN.test(flowId)) continue;
      try {
        const record = JSON.parse(await readFile(this.#path(flowId), 'utf8')) as OAuthFlow;
        // An unreadable expiry is a flow nobody can use, so it goes too.
        const expiresAt = new Date(record.expiresAt).getTime();
        if (Number.isFinite(expiresAt) && now < expiresAt) continue;
      } catch {
        // A flow file that will not parse cannot be completed either.
      }
      await this.discard(flowId);
    }
  }

  /** Merges fields into a flow that has not been claimed (used to record the listener's port and pid). */
  async patch(flowId: string, patch: Partial<OAuthFlow>): Promise<OAuthFlow> {
    const flow = { ...(await this.get(flowId)), ...patch };
    await writeFileAtomic(this.#path(flowId), `${JSON.stringify(flow, null, 2)}\n`);
    return flow;
  }

  async get(flowId: string): Promise<OAuthFlow> {
    let text: string;
    try {
      text = await readFile(this.#path(flowId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Nothing says which kind it was — an expired one is discarded when it is refused — so both are named.
      throw new CommsError('NOT_FOUND', `no sign-in is waiting under ${flowId}`, {
        hint: `A sign-in lasts ten minutes and can be finished once. ${
          this.#surface === 'mcp'
            ? 'Start again with gmail_inbox_add, or gmail_inbox_reauth for a mailbox already connected.'
            : handoffSentenceToFill(this.#handoffs().own(['inbox', 'add', '--start']), ['<alias>'], (add) =>
                handoffSentenceToFill(
                  this.#handoffs().own(['inbox', 'reauth', '--start']),
                  ['<alias>'],
                  (reauth) => `Start again with ${add}, or ${reauth} for a mailbox already connected.`,
                ),
              )
        }`,
      });
    }
    const flow = JSON.parse(text) as OAuthFlow;
    if (Date.parse(flow.expiresAt) <= this.#now().getTime()) {
      await this.discard(flowId);
      throw new CommsError('AUTH_REQUIRED', 'that sign-in took longer than ten minutes and has expired', {
        hint: startAgain(flow, this.#surface, this.#handoffs(), (step) => `Start again: ${step}.`),
      });
    }
    return flow;
  }

  /** The browser's answer, written by whichever process received the redirect. */
  async recordOutcome(flowId: string, outcome: FlowOutcome): Promise<void> {
    await ensurePrivateDir(this.directory);
    await writeFileAtomic(
      this.#path(flowId, '.outcome.json'),
      `${JSON.stringify({ ...outcome, at: this.#now().toISOString() }, null, 2)}\n`,
    );
  }

  async readOutcome(flowId: string): Promise<FlowOutcome | null> {
    try {
      return JSON.parse(await readFile(this.#path(flowId, '.outcome.json'), 'utf8')) as FlowOutcome;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Claims the flow for completion. `O_EXCL` on a marker file is the single-use guarantee: the file system decides,
   * not a lock we hold, so two processes racing to finish one sign-in cannot both exchange the code.
   */
  async claim(flowId: string): Promise<OAuthFlow> {
    const flow = await this.get(flowId);
    await ensurePrivateDir(this.directory);
    try {
      const handle = await open(this.#path(flowId, '.claim'), 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: this.#now().toISOString() })}\n`);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new CommsError('AUTH_REQUIRED', 'that sign-in has already been finished', {
        hint: startAgain(
          flow,
          this.#surface,
          this.#handoffs(),
          (step) => `Each sign-in completes once. To start another, ${step}.`,
        ),
      });
    }
    return flow;
  }

  /**
   * Removes every trace of a flow: the record with its verifier, the outcome, the claim marker and the detached
   * listener's log. Every one of them, or the state directory accumulates a file per sign-in that nothing reads.
   */
  async discard(flowId: string): Promise<void> {
    for (const suffix of ['.json', '.outcome.json', '.claim', '.log']) {
      await rm(this.#path(flowId, suffix), { force: true });
    }
  }
}

/**
 * What the loopback page may say about a flow.
 *
 * Derived here rather than assembled at each call site, so the two listeners — the detached one and the one the
 * interactive flow keeps in-process — cannot describe the same sign-in differently.
 */
export function aboutFlow(flow: OAuthFlow): LoopbackAbout {
  return {
    alias: flow.alias,
    mode: flow.mode,
    tier: flow.tier,
    ...(flow.expect.email ? { expectEmail: flow.expect.email } : {}),
  };
}
