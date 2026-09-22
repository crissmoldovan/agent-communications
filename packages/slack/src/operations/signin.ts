import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommsError, newAccountId } from '@agentcomms/core';
import { buildAuthorizeUrl, readExchange } from '../auth/authorize.ts';
import { serialiseBundle } from '../auth/bundle.ts';
import { FLOW_TTL_MS, newFlowId, type SlackFlow } from '../auth/flow.ts';
import { startLoopback } from '../auth/listener.ts';
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
    clientId: options.clientId,
    verifier: request.pkce.verifier,
    state: request.state,
    redirectUrl: request.redirectUrl,
    port: options.port,
    createdAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + FLOW_TTL_MS).toISOString(),
  };
  await context.flows.save(flow);

  const listener =
    options.detached === false ? await startInProcess(context, flow) : await startDetached(context, flow, options);

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
  }
  // On a timeout nothing is written: the flow expires on its own, and `--finish` says so.
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

  child.disconnect();
  child.unref();
  return undefined;
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
    stopListener(flow);
    await context.flows.discard(flow.flowId);
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
function codeFromUrl(raw: string, flow: SlackFlow): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CommsError('USAGE', 'that is not the URL from the address bar', {
      hint: 'Paste the whole thing, starting `http://localhost:`.',
    });
  }
  if (url.searchParams.get('state') !== flow.state) {
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

/** The detached listener is still holding the port; it has done its job and nothing else will read from it. */
function stopListener(flow: SlackFlow): void {
  if (!flow.listenerPid) return;
  try {
    process.kill(flow.listenerPid);
  } catch {
    // Already gone, or not ours to signal. Either way there is nothing to do about it.
  }
}

/**
 * Exchange, check everything, and only then write anything down.
 *
 * The order matters and is the whole point of the function: `--mode read` is a guarantee about a token, and the
 * only moment it can be established is before the token is stored. Afterwards the label is a claim about
 * something nobody re-examined.
 */
export async function completeSignIn(context: SlackContext, flowId: string, code: string): Promise<WorkspaceView> {
  // Claimed first, so two `--finish` calls cannot both spend one code.
  const flow = await context.flows.claim(flowId);

  const token = readExchange(
    await context.exchange({
      client_id: flow.clientId,
      code,
      redirect_uri: flow.redirectUrl,
      code_verifier: flow.verifier,
    }),
  );

  const config = await context.config();
  const existing = flow.expect ? requireWorkspace(config, flow.alias) : undefined;
  validateExchange({ token, mode: flow.mode, flow, config, existing });

  const at = context.now();
  /*
   * A new secret reference on a reauth, rather than overwriting the old one.
   *
   * Overwriting first would open a window where the configuration says `read` while the credential behind it is
   * whatever the new grant turned out to be. Staging the new one under its own reference, moving the pointer in a
   * single config write, and only then deleting the old, means the old credential is authoritative until the
   * exact moment the new one is.
   */
  const accountId = newAccountId();
  const secrets = await context.secrets();
  await secrets.set(secretRefFor(accountId), serialiseBundle(bundleFrom(token, at)));

  const account = accountFrom({ token, mode: flow.mode, flow, accountId, now: at });
  try {
    await context.core.config.update((current) => ({
      ...current,
      accounts: { ...current.accounts, [flow.alias]: account },
    }));
  } catch (error) {
    // The config write failed, so nothing points at the credential just stored. Leaving it would be a live Slack
    // token in the secret store that no command lists, removes or refreshes.
    await secrets.delete(secretRefFor(accountId)).catch(() => undefined);
    throw error;
  }

  const previousRef = existing?.account.secretRef;
  if (previousRef && previousRef !== secretRefFor(accountId)) {
    await secrets.delete(previousRef).catch(() => undefined);
  }

  return viewOf(flow.alias, account);
}
