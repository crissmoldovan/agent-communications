import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AccountConfig,
  CommsError,
  type Config,
  findById,
  type LooseningConsent,
  newAccountId,
  retargetFormerNames,
  type SecretStore,
  secretsStoreOf,
} from '@agentcomms/core';
import { buildAuthorizeUrl, readExchange } from '../auth/authorize.ts';
import { serialiseBundle } from '../auth/bundle.ts';
import { FLOW_TTL_MS, newFlowId, type SlackFlow } from '../auth/flow.ts';
import { startLoopback } from '../auth/listener.ts';
import { sameState } from '../auth/pkce.ts';
import type { SlackContext } from '../context.ts';
import type { InstallMode } from '../manifest.ts';
import {
  accountFrom,
  bundleFrom,
  checkAliasFree,
  requireWorkspace,
  secretRefFor,
  validateExchange,
  viewOf,
  type WorkspaceView,
} from './workspaces.ts';

/**
 * Signing in, in two halves, because the process that starts one usually cannot wait for it.
 *
 * An agent's shell call returns in seconds; finding the Slack tab, reading the consent screen and approving takes
 * minutes. So the loopback listener runs in a **detached** child that outlives the command, writes what the
 * browser returned into the flow's outcome file, and exits. `--finish` collects it.
 *
 * This is the shape the Gmail side arrived at, deliberately repeated. One difference, and it is Slack's: the port
 * is chosen in advance rather than by the OS, because Slack matches redirect URLs exactly and the app's manifest
 * has to name one before any sign-in exists.
 */

export interface StartOptions {
  readonly mode: InstallMode;
  readonly alias: string;
  readonly clientId: string;
  /** Matching the one in the manifest. Slack compares redirect URLs exactly, so this is not negotiable. */
  readonly port: number;
  /** False keeps the listener in this process: the interactive flow, which waits. */
  readonly detached?: boolean | undefined;
  /** The account this must turn out to be, on a reauth. */
  readonly expect?: SlackFlow['expect'];
  /** Proof a person typed a challenge, when this sign-in widens what the workspace can do. */
  readonly consent?: LooseningConsent | undefined;
  /** Command that can run the hidden listener; tests point it at the source entry. */
  readonly listenerCommand?: ListenerEntry | undefined;
}

export interface StartedSignIn {
  readonly flowId: string;
  readonly alias: string;
  readonly mode: InstallMode;
  readonly authUrl: string;
  readonly redirectUrl: string;
  readonly expiresAt: string;
  /** Present only for an in-process flow: resolves once the browser has come back and the token is stored. */
  readonly listener?: { result: Promise<WorkspaceView>; close(): Promise<void> } | undefined;
}

export async function startSignIn(context: SlackContext, options: StartOptions): Promise<StartedSignIn> {
  const config = await context.config();
  if (options.expect) {
    requireWorkspace(config, options.alias);
  } else {
    checkAliasFree(config, options.alias);
  }
  if (!options.clientId) {
    throw new CommsError('USAGE', 'the Slack app’s Client ID is needed', {
      hint: 'Create the app first, with `agent-slack manifest --mode read --port 51234`.',
    });
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new CommsError('USAGE', 'a loopback port is needed, and must match the one in the manifest', {
      hint: 'Slack matches redirect URLs exactly. Use the same `--port` you built the manifest with.',
    });
  }

  const request = buildAuthorizeUrl({ clientId: options.clientId, mode: options.mode, port: options.port });
  const startedAt = context.now();
  const flow: SlackFlow = {
    flowId: newFlowId(),
    mode: options.mode,
    alias: options.alias,
    ...(options.expect ? { expect: options.expect } : {}),
    ...(options.consent ? { consent: options.consent } : {}),
    clientId: options.clientId,
    verifier: request.pkce.verifier,
    state: request.state,
    redirectUrl: request.redirectUrl,
    port: options.port,
    createdAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + FLOW_TTL_MS).toISOString(),
  };
  await context.flows.save(flow);

  /*
   * A flow that never gets a listener is discarded rather than left.
   *
   * The detached path already cleans up after itself; the interactive one did not, so a port already in use —
   * the commonest failure there is, since Slack forces a fixed one — left a PKCE verifier on disk with nothing
   * able to complete it and nothing that would ever remove it.
   */
  let listener: StartedSignIn['listener'];
  try {
    listener =
      options.detached === false ? await startInProcess(context, flow) : await startDetached(context, flow, options);
  } catch (error) {
    await context.flows.discard(flow.flowId);
    if (error instanceof CommsError) throw error;
    throw new CommsError('UNEXPECTED', `the sign-in could not start: ${(error as Error).message}`, {
      hint: `Port ${options.port} may already be in use.`,
      cause: error,
    });
  }

  return {
    flowId: flow.flowId,
    alias: flow.alias,
    mode: flow.mode,
    authUrl: request.url,
    redirectUrl: flow.redirectUrl,
    expiresAt: flow.expiresAt,
    ...(listener ? { listener } : {}),
  };
}

async function startInProcess(context: SlackContext, flow: SlackFlow): Promise<StartedSignIn['listener']> {
  const loopback = await startLoopback({
    state: flow.state,
    port: flow.port,
    timeoutMs: Math.max(1000, Date.parse(flow.expiresAt) - context.now().getTime()),
    about: { alias: flow.alias, mode: flow.mode, reauth: Boolean(flow.expect) },
  });
  const result = (async (): Promise<WorkspaceView> => {
    const outcome = await loopback.result;
    await loopback.close();
    if (outcome.kind === 'timeout') {
      await context.flows.discard(flow.flowId);
      throw new CommsError('TRANSIENT', 'nobody finished signing in within ten minutes', {
        hint: 'Start again when you are ready.',
      });
    }
    if (outcome.kind === 'denied') {
      await context.flows.discard(flow.flowId);
      throw slackDenied(outcome.error, outcome.description);
    }
    return completeSignIn(context, flow.flowId, outcome.code);
  })();
  return { result, close: () => loopback.close() };
}

/**
 * The detached half: holds the port open while a person reads a consent screen, then exits.
 *
 * It is started by `startSignIn` and is not meant to be run by hand, so the command that runs it is hidden.
 */
export async function runSignInListener(context: SlackContext, flowId: string): Promise<void> {
  const flow = await context.flows.get(flowId);
  const loopback = await startLoopback({
    state: flow.state,
    port: flow.port,
    timeoutMs: Math.max(1000, Date.parse(flow.expiresAt) - context.now().getTime()),
    about: { alias: flow.alias, mode: flow.mode, reauth: Boolean(flow.expect) },
  });
  await context.flows.patch(flowId, { listenerPid: process.pid });

  // The parent is waiting for exactly this before it prints the link; afterwards the two share only files.
  process.send?.({ type: 'ready', port: loopback.port });
  process.disconnect?.();

  const outcome = await loopback.result;
  await loopback.close();
  if (outcome.kind === 'code') {
    await context.flows.recordOutcome(flowId, { code: outcome.code });
  } else if (outcome.kind === 'denied') {
    await context.flows.recordOutcome(flowId, {
      error: outcome.error,
      ...(outcome.description ? { description: outcome.description } : {}),
    });
  } else {
    /*
     * A timeout ends the flow here, rather than leaving it to "expire on its own" — which files do not do.
     *
     * Nobody is coming: this listener held the port for the flow's whole life and saw no redirect. Leaving the
     * record behind leaves a PKCE verifier on disk until something happens to call `peek` on that exact id, which
     * nothing ever will.
     */
    await context.flows.discard(flowId);
  }
}

export interface ListenerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

async function startDetached(
  context: SlackContext,
  flow: SlackFlow,
  options: StartOptions,
): Promise<StartedSignIn['listener']> {
  const entry = options.listenerCommand ?? (await defaultListenerCommand());

  /*
   * The listener's stderr goes to a file, not to ours.
   *
   * Inheriting it would leave this detached child holding our stderr open for as long as it waits for the browser
   * — up to ten minutes — so anything that piped this command would hang on a command that had already printed
   * everything it was going to print. Dropping it entirely is the smaller change, but then a listener that fails
   * *after* reporting ready fails silently.
   */
  const logPath = join(context.core.paths.stateDir, 'slack', 'flows', `${flow.flowId}.log`);

  let child: ReturnType<typeof spawn>;
  let spawnFailure: Error | null = null;
  try {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    const log = await open(logPath, 'a');
    try {
      child = spawn(entry.command, [...entry.args, 'sign-in-listen', flow.flowId], {
        detached: true,
        // An IPC channel only for the "ready" message; nothing else passes between the two processes.
        stdio: ['ignore', 'ignore', log.fd, 'ipc'],
        env: { ...process.env, ...listenerEnv(context) },
      });
      // Attached before the next `await`, not after it: `spawn` reports a missing command on the following tick,
      // and an 'error' event with no listener is thrown by Node past every catch here.
      child.once('error', (error: Error) => {
        spawnFailure = error;
      });
    } finally {
      // The child holds its own duplicate; ours would otherwise keep the file open for this process's lifetime.
      await log.close();
    }
    if (spawnFailure) throw spawnFailure;
  } catch (error) {
    // The flow record, with its PKCE verifier, was written before any of this. Left behind it would be a sign-in
    // with no listener and no command that could finish it.
    await context.flows.discard(flow.flowId);
    throw new CommsError('UNEXPECTED', `the sign-in listener could not be started: ${(error as Error).message}`, {
      hint: 'Run the sign-in at a terminal instead, without `--start`.',
      cause: error,
    });
  }

  try {
    await new Promise<void>((settle, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the sign-in listener did not start within ten seconds')),
        10_000,
      );
      child.once('message', (message: { type?: string; error?: string }) => {
        clearTimeout(timer);
        if (message?.type === 'ready') settle();
        else reject(new Error(message?.error ?? 'the sign-in listener could not start'));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        // The likeliest reason by far, and the one whose fix is not obvious from an exit code.
        reject(
          new Error(
            `the sign-in listener stopped before it was ready (exit ${code}). Port ${flow.port} may be in use.`,
          ),
        );
      });
    });
  } catch (error) {
    child.kill();
    await context.flows.discard(flow.flowId);
    throw new CommsError('UNEXPECTED', String((error as Error).message), {
      hint: 'Run the sign-in at a terminal instead, without `--start`.',
      cause: error,
    });
  }

  releaseChannel(child);
  child.unref();
  return undefined;
}

/**
 * Drops the IPC channel to the listener, whoever closed it first.
 *
 * The child disconnects itself the instant after it reports ready, so the parent races it and loses whenever it
 * is not already on the next tick. `disconnect()` on an already-disconnected channel throws
 * `ERR_IPC_DISCONNECTED` — measured, every time once the parent pauses at all in between.
 *
 * Unguarded, that throw escapes `startSignIn` **after** the listener is running and the flow is on disk, and past
 * the block that would have discarded it. The caller is told the sign-in failed, the listener holds the port for
 * ten minutes, and the flow is still finishable: a failure reported for something that worked, which is the worst
 * shape a failure can take. A channel that is already closed is the outcome this wants, so there is nothing to
 * handle.
 */
export function releaseChannel(child: { disconnect(): void }): void {
  try {
    child.disconnect();
  } catch {
    // already disconnected by the child, which is the normal case
  }
}

function listenerEnv(context: SlackContext): NodeJS.ProcessEnv {
  // Only the two paths. The child re-opens the same config and state as this process and needs nothing else — in
  // particular no credential, because it never touches one: it receives a code and writes it down.
  return {
    AGENT_COMMS_CONFIG_DIR: context.core.paths.configDir,
    AGENT_COMMS_STATE_DIR: context.core.paths.stateDir,
  };
}

/**
 * The command that can run the hidden listener, resolved from this module rather than from `process.argv[1]`.
 *
 * `process.argv[1]` is whatever binary happens to be running, and only one of them understands the listener mode.
 * Started as `agent-slack` it is the CLI, which does; started as the packaged MCP server it is a different entry
 * with no such command, and the sign-in would fail before it returned a URL. The Gmail package learned this the
 * expensive way; the search is copied rather than re-derived.
 *
 * Separated from where it searches *from* so a test can point it at a layout that does not exist on this machine
 * — the packed one, `node_modules/@agentcomms/slack/dist/`, being the layout Gmail's version got wrong.
 */
export async function resolveListenerEntry(here: string): Promise<ListenerEntry | null> {
  const candidates = [
    join(here, '..', 'cli.ts'),
    join(here, '..', '..', 'cli.mjs'),
    join(here, 'cli.mjs'),
    join(here, '..', 'cli.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      const path = resolve(candidate);
      // Node 22.12–22.17 needs the flag to run the TypeScript source; the bundled `.mjs` needs nothing.
      const flags = path.endsWith('.ts') ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : [];
      return { command: process.execPath, args: [...flags, path] };
    } catch {
      // try the next layout
    }
  }
  return null;
}

async function defaultListenerCommand(): Promise<ListenerEntry> {
  const found = await resolveListenerEntry(dirname(fileURLToPath(import.meta.url)));
  if (found) return found;
  const entry = process.argv[1];
  if (!entry) throw new CommsError('UNEXPECTED', 'cannot work out how to start the sign-in listener');
  return { command: process.execPath, args: [entry] };
}

export interface FinishOptions {
  readonly flowId: string;
  /**
   * Refuse a flow that is not this kind.
   *
   * A flow id is all `--finish` needs, and the two kinds do very different things: `add` creates a workspace,
   * `reauth` replaces the credential an existing one uses. Whichever surface is allowed only the first must not
   * be able to finish a `reauth` the other started.
   */
  readonly only?: 'add' | 'reauth' | undefined;
  /**
   * Refuse a flow that is not for this workspace.
   *
   * `reauth <alias>` makes the caller name a workspace, and a flow id names a different one. Finishing the flow
   * and ignoring the name would re-authorise a workspace nobody asked about, and report it as the one they did.
   */
  readonly expectAlias?: string | undefined;
  /** The address-bar URL, pasted back on a machine whose browser is elsewhere. */
  readonly url?: string | undefined;
  readonly waitSeconds?: number | undefined;
  readonly pollMs?: number | undefined;
}

/**
 * Completes a sign-in exactly once.
 *
 * A wait that times out leaves the flow alone, so `--finish` can be run again; only an answer from the browser
 * claims it.
 */
export async function finishSignIn(context: SlackContext, options: FinishOptions): Promise<WorkspaceView> {
  const flow = await context.flows.get(options.flowId);
  const kind = flow.expect ? 'reauth' : 'add';
  if (options.expectAlias && !(await namesThisFlow(context, flow, options.expectAlias))) {
    throw new CommsError('USAGE', `that sign-in is for "${flow.alias}", not "${options.expectAlias}"`, {
      hint: `Finish it as \`agent-slack workspace ${kind === 'reauth' ? `reauth ${flow.alias}` : 'add'} --finish ${
        options.flowId
      }\`.`,
    });
  }
  if (options.only && kind !== options.only) {
    throw new CommsError(
      'USAGE',
      `that sign-in is ${kind === 'reauth' ? 're-authorising an existing workspace' : 'a new workspace'}, and this can only finish ${
        options.only === 'add' ? 'a new workspace' : 're-authorising an existing workspace'
      }`,
      { hint: `Finish it where it was started: \`agent-slack workspace ${kind} --finish ${options.flowId}\`.` },
    );
  }

  let code: string;
  if (options.url) {
    code = codeFromUrl(options.url, flow);
  } else {
    const outcome = await waitForOutcome(context, flow, options);
    if ('error' in outcome) {
      await context.flows.discard(flow.flowId);
      throw slackDenied(outcome.error, outcome.description);
    }
    code = outcome.code;
  }

  try {
    return await completeSignIn(context, flow.flowId, code);
  } finally {
    stopListener(flow, context.now());
    /*
     * No `discard` here. Only the caller that won the claim may clean up, and `completeSignIn` does that itself.
     *
     * This used to discard unconditionally — including when `completeSignIn` threw because *this* caller lost
     * the claim. The loser then deleted the winner's marker and record while the winner was mid-exchange, and a
     * third caller could claim the flow again. Cleanup belongs to ownership, not to whoever reaches a `finally`.
     */
  }
}

async function waitForOutcome(
  context: SlackContext,
  flow: SlackFlow,
  options: FinishOptions,
): Promise<{ code: string } | { error: string; description?: string | undefined }> {
  const deadline = context.now().getTime() + (options.waitSeconds ?? 60) * 1000;
  const pollMs = options.pollMs ?? 500;
  for (;;) {
    const outcome = await context.flows.readOutcome(flow.flowId);
    if (outcome) return outcome;
    if (context.now().getTime() >= deadline) {
      // Not a failure: the person is still reading the consent screen. The flow is left alone so the same
      // `--finish` works when they are done.
      throw new CommsError('APPROVAL_PENDING', 'nobody has finished signing in yet', {
        hint: `Open the link, approve it in Slack, then run \`agent-slack workspace ${
          flow.expect ? 'reauth' : 'add'
        } --finish ${flow.flowId} --wait 60\` again.`,
        details: { flowId: flow.flowId, expiresAt: flow.expiresAt },
      });
    }
    await new Promise((settle) => setTimeout(settle, pollMs));
  }
}

/** The code out of a pasted redirect URL, with the same `state` check the listener would have made. */
/**
 * Whether the name given to `--finish` is the workspace this sign-in is for.
 *
 * A reauth is bound to the account it set out to renew, not to the words it was started with: after a migration
 * renames `live` to `cue/slack`, finishing with `cue/slack` is right, and finishing with `live` is refused with what it
 * is called now — the same answer as every other lookup of a former name. The name it was started with also still
 * binds it, even when that name now holds a newer account: whether this sign-in may still overwrite anything is the
 * in-lock check's question, and it answers "changed while this sign-in was being completed", which is the truth. A
 * new workspace has no account yet, so its name is compared as given.
 */
async function namesThisFlow(context: SlackContext, flow: SlackFlow, name: string): Promise<boolean> {
  if (!flow.expect) return name === flow.alias;
  const named = requireWorkspace(await context.config(), name);
  return named.account.id === flow.expect.accountId || name === flow.alias;
}

function codeFromUrl(raw: string, flow: SlackFlow): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CommsError('USAGE', 'that is not the URL from the address bar', {
      hint: 'Paste the whole thing, starting `http://localhost:`.',
    });
  }
  // The same comparison the listener makes, rather than `!==`: one code path deciding `state` two different ways
  // is one of them being wrong later.
  if (!sameState(url.searchParams.get('state'), flow.state)) {
    throw new CommsError('USAGE', 'that URL is from a different sign-in', {
      hint: 'Paste the URL the browser landed on for this one.',
    });
  }
  const error = url.searchParams.get('error');
  if (error) throw slackDenied(error, url.searchParams.get('error_description') ?? undefined);
  const code = url.searchParams.get('code');
  if (!code) {
    throw new CommsError('USAGE', 'that URL carries neither a code nor an error', {
      hint: 'Paste the URL the browser landed on after approving.',
    });
  }
  return code;
}

function slackDenied(error: string, description?: string | undefined): CommsError {
  return new CommsError('AUTH_REQUIRED', `Slack did not grant access: ${error}`, {
    hint: description ?? 'Approve the app in Slack, leaving every permission ticked.',
  });
}

/**
 * The detached listener has done its job and nothing else will read from it, so stop it holding the port.
 *
 * The pid is only trusted while the flow that recorded it is still inside its own ten-minute window. If the
 * listener died early and the operating system reused its number, signalling it would kill an unrelated process
 * of the user's — and the listener times out on its own regardless, which is the real backstop. Copied from the
 * Gmail package, which reasoned this through first.
 */
function stopListener(flow: SlackFlow, now: Date): void {
  if (!flow.listenerPid || flow.listenerPid === process.pid) return;
  const expiresAt = Date.parse(flow.expiresAt);
  if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) return;
  try {
    process.kill(flow.listenerPid, 'SIGTERM');
  } catch {
    // Already gone, or owned by another user: nothing to do.
  }
}

/**
 * Exchange, check everything, and only then write anything down.
 *
 * The order matters and is the whole point of the function: `--mode read` is a guarantee about a token, and the
 * only moment it can be established is before the token is stored. Afterwards the label is a claim about
 * something nobody re-examined.
 */
/**
 * Whether the configuration now names `ref` under `alias` — read fresh, after a write that may or may not have
 * committed. `unknown` when the configuration cannot be read at all, which must never be treated as `absent`.
 */
async function committed(
  context: SlackContext,
  accountId: string,
  ref: string,
): Promise<'present' | 'absent' | 'unknown'> {
  try {
    // By the new account's id, not by name: a rename in the same write — or since — must not read as absent.
    return findById(await context.config(), 'account', accountId)?.account.secretRef === ref ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/** The original error, with the credential it may have left behind named — and deliberately not deleted. */
function keepAndReport(original: unknown, ref: string): CommsError {
  const base = original instanceof CommsError ? original : new CommsError('UNEXPECTED', String(original));
  return new CommsError(base.code, base.message, {
    hint:
      `${base.hint ? `${base.hint} ` : ''}Whether the sign-in was saved could not be confirmed, so the credential ` +
      `stored for it was kept rather than risk deleting a live one. Run \`agent-slack workspace list\`: if the ` +
      `workspace is not there, delete \`${ref}\` from your secret store.`,
    details: { possiblyStrandedSecretRef: ref },
    cause: original,
  });
}

/**
 * Takes back a credential that was stored for an attempt that then failed, and says so if it cannot.
 *
 * This used to be `delete().catch(() => undefined)`, and the commit that introduced it claimed the credential
 * "is deleted". It was deleted when the delete worked. When it did not — a keychain whose prompt is refused is
 * the realistic case — a live Slack token was left in the secret store under a reference nothing names, and
 * the only error anyone saw was the original one, which said nothing about it.
 *
 * So: one retry, because a keychain prompt dismissed by accident is common and a second chance is cheap; and
 * if that fails too, the original error comes back **with the stranded reference attached**, so the leak is
 * something a person is told about rather than something they would have to already know to look for.
 *
 * A `false` from `delete` is not a failure here. It means nothing was stored under that reference, and for a
 * rollback there is then nothing to take back.
 */
async function withdrawStaged(secrets: SecretStore, ref: string, original: unknown): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await secrets.delete(ref);
      return original;
    } catch (error) {
      last = error;
    }
  }
  const base = original instanceof CommsError ? original : new CommsError('UNEXPECTED', String(original));
  return new CommsError(base.code, base.message, {
    hint: `${base.hint ? `${base.hint} ` : ''}A credential stored for this attempt could not be removed: delete \`${ref}\` from your secret store.`,
    details: { strandedSecretRef: ref, cleanupError: (last as Error)?.message },
    cause: original,
  });
}

/** The workspace a reauth set out to renew, found by its id wherever it now lives — or a refusal. */
function renewing(config: Config, flow: SlackFlow): { alias: string; account: AccountConfig } {
  const found = flow.expect ? findById(config, 'account', flow.expect.accountId) : null;
  if (!found || found.account.platform !== 'slack') {
    // The same refusal as the check inside the lock: the account this set out to renew is not the one there now —
    // renewed by another sign-in, or removed.
    throw new CommsError('CONFIG', `"${flow.alias}" changed while this sign-in was being completed`, {
      hint: `Check it with \`agent-slack workspace list\`, then re-authorise if it is still yours.`,
    });
  }
  return found;
}

export async function completeSignIn(context: SlackContext, flowId: string, code: string): Promise<WorkspaceView> {
  // Claimed first, so two `--finish` calls cannot both spend one code. The claim is a file, so it is cleaned up
  // however this ends — the interactive path has no `--finish` above it to do that.
  const flow = await context.flows.claim(flowId);
  try {
    const token = readExchange(
      await context.exchange({
        client_id: flow.clientId,
        code,
        redirect_uri: flow.redirectUrl,
        code_verifier: flow.verifier,
      }),
    );

    const config = await context.config();
    /*
     * The alias is checked again here, not only when the sign-in started.
     *
     * Up to ten minutes pass in between, and `--finish` may run in a different process. Something else can
     * connect that name in the gap, and writing over it would not merely rename a workspace: the entry being
     * replaced carries the only reference to its credential, so the previous one would be stranded in the secret
     * store with nothing able to list, refresh or remove it.
     *
     * This is the cheap check on a snapshot. The one that actually holds is inside the config lock below —
     * everything read here can be stale by the time the write happens.
     */
    /*
     * A reauth is found by the account it set out to renew, not by the name it was started with: a migration between
     * starting and finishing renames every workspace, and the reauth should follow its workspace to the new name
     * rather than be refused for using the old one.
     */
    const existing = flow.expect ? renewing(config, flow) : undefined;
    if (!existing) checkAliasFree(config, flow.alias);
    validateExchange({ token, mode: flow.mode, flow, config, existing });

    const at = context.now();
    /*
     * A new secret reference on a reauth, rather than overwriting the old one.
     *
     * Overwriting first would open a window where the configuration says `read` while the credential behind it
     * is whatever the new grant turned out to be. Staging the new one under its own reference, moving the
     * pointer in a single config write, and only then deleting the old, means the old credential is
     * authoritative until the exact moment the new one is.
     */
    const accountId = newAccountId();
    const secrets = await context.secrets();
    const account = accountFrom({ token, mode: flow.mode, flow, accountId, now: at });
    let written: AccountConfig = account;
    let writtenAlias = flow.alias;
    let replacedRef: string | undefined;
    try {
      /*
       * The write is inside the boundary that takes it back, not before it.
       *
       * It used to sit one line above the `try`, on the reasoning that a write which failed had written nothing.
       * A keychain write is not like that: it cannot be cancelled, and it can finish *after* the store has
       * reported it timed out. Outside the boundary, that left a live token with no config entry and no error
       * naming it. Inside, the same withdrawal runs — and the keychain store refuses every call while such a
       * write is still in flight, so the withdrawal either fails loudly and names the reference, or runs after
       * the write has settled and is authoritative about it.
       */
      await secrets.set(secretRefFor(accountId), serialiseBundle(bundleFrom(token, at)));
      await context.core.config.update(
        (current) => {
          /*
           * The check that counts, because this one runs under the lock.
           *
           * Everything above was validated against a snapshot read before the network call. Two sign-ins
           * completing at once both pass those checks, both store a credential, and the second config write
           * simply overwrites the first — leaving a live Slack token that nothing names. So the assumption each
           * one made is re-stated here, where the file cannot move underneath it.
           */
          /*
           * The backend this credential went into must still be the one in force.
           *
           * `agentcomms secrets migrate` copies every credential to a new backend outside the lock and then
           * switches. A sign-in that picked its store before the switch and writes after it would put the token
           * in a backend nothing reads any more, and the config would name a credential the runtime cannot find.
           * The migration checks the same thing from its side; this is the half that belongs here.
           */
          if (secretsStoreOf(current) !== secrets.kind) {
            throw new CommsError('TRANSIENT', 'the secret store was changed while this sign-in was completing', {
              hint: 'Nothing was saved. Sign in again.',
            });
          }
          const held = flow.expect ? findById(current, 'account', flow.expect.accountId)?.account : undefined;
          if (flow.expect) {
            /*
             * Compared against the flow, not against the snapshot read a moment ago.
             *
             * `existing` was read *after* the exchange and is as stale as everything else here. Comparing
             * against it only asks "has the alias changed since I looked", which two reauths of the same
             * account both answer yes to — so the second, started first and finishing second, would overwrite
             * a credential minted in between and strand it. `flow.expect.accountId` is what this sign-in set
             * out to renew, written before the browser opened and unchangeable since.
             */
            if (!held) {
              throw new CommsError('CONFIG', `"${flow.alias}" changed while this sign-in was being completed`, {
                hint: `Check it with \`agent-slack workspace show ${flow.alias}\`, then re-authorise if it is still yours.`,
              });
            }
          } else {
            /*
             * The same checks `add` made before the network call, re-run where they hold.
             *
             * `held` alone is not the question. `checkAliasFree` also covers the `inboxes` map, which shares
             * one namespace with `accounts`, and `validateExchange` refuses the same workspace-and-person
             * under a second name — both of which a concurrent command can make true in the gap.
             */
            checkAliasFree(current, flow.alias);
            validateExchange({ token, mode: flow.mode, flow, config: current });
          }
          /*
           * The grant owns what it sets; everything else carries over.
           *
           * `accountFrom` builds a record from the token alone, so writing it whole on a reauth threw away every
           * setting the person had made since — most importantly `sendPolicy`. An explicit `never` became the
           * default `chat`, and because reauth rotates the account id, the loosening check read the result as a
           * brand-new account and asked nobody. Spreading the held record first keeps any field the grant does
           * not speak to, including fields a later version adds that this one has never heard of.
           */
          written = held && flow.expect ? { ...held, ...account } : account;
          if (held && flow.expect) {
            /*
             * Under the key it has now, and its former names carried to the new id.
             *
             * Reauth mints a new id so the new credential can be staged beside the old one. Every former name that
             * pointed at the old id is moved to the new one in this same write — otherwise `live`, renamed to
             * `cue/slack`, would say its workspace had been removed while it is plainly connected.
             */
            const renewed = findById(current, 'account', held.id);
            const key = renewed?.alias ?? flow.alias;
            writtenAlias = key;
            replacedRef = held.secretRef;
            const moved = retargetFormerNames(current, 'account', held.id, accountId);
            return { ...moved, accounts: { ...moved.accounts, [key]: written } };
          }
          writtenAlias = flow.alias;
          return { ...current, accounts: { ...current.accounts, [flow.alias]: written } };
        },
        // A reauth may narrow what a workspace can do freely; widening it is gated before we get here, and the
        // proof is carried in so the config layer can tell the two apart.
        flow.consent ? { consent: flow.consent } : {},
      );
    } catch (error) {
      /*
       * Look before undoing. A rejection does not mean the configuration was not written.
       *
       * `ConfigStore.update` commits its write atomically and *then* releases the lock in a `finally`; if that
       * release throws — a file Windows will not let go of — the call rejects with the write already in. Taking
       * the credential back then deletes the one the configuration now names, and turns a sign-in that worked
       * into a workspace with no token. So the configuration is read again first, and only a credential it does
       * not name is withdrawn. If it cannot even be read, nothing is deleted: a possible leftover is reported,
       * because the alternative risks deleting a live one.
       */
      const landed = await committed(context, accountId, secretRefFor(accountId));
      if (landed === 'unknown') throw keepAndReport(error, secretRefFor(accountId));
      if (landed === 'absent') throw await withdrawStaged(secrets, secretRefFor(accountId), error);
      // 'present': the write is in and only the lock's cleanup failed. The sign-in worked; carry on as it did.
    }

    /*
     * The superseded credential, removed last and not allowed to fail the reauth that has already succeeded.
     *
     * The swallow is deliberate and bounded. By this point the configuration already points at the new
     * credential, so the workspace works; throwing here would report a failure for a sign-in that worked and
     * send somebody to do it again. What is left behind if the delete fails — a keychain that prompts and is
     * refused is the only realistic way — is one Slack user token whose access half expires in twelve hours and
     * whose refresh half Slack expires thirty days after issue. It cannot be renewed, because nothing knows its
     * reference any more.
     *
     * That bound is the whole justification. A credential that did *not* expire on its own would have to be
     * reported rather than dropped.
     */
    // The credential of the row this write actually replaced, read under the lock — not the snapshot's.
    const previousRef = replacedRef ?? existing?.account.secretRef;
    if (previousRef && previousRef !== secretRefFor(accountId)) {
      await secrets.delete(previousRef).catch(() => undefined);
    }

    return viewOf(writtenAlias, written);
  } finally {
    await context.flows.discard(flowId);
  }
}
