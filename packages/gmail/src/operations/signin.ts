import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CommsError, requireInbox } from '@agentcomms/core';
import type { OAuthFlow } from '../auth/flows.ts';
import { startLoopback } from '../auth/loopback.ts';
import { buildAuthUrl, newPkce, newState, oauthError } from '../auth/oauth.ts';
import { scopesFor, TIERS, type Tier } from '../auth/scopes.ts';
import type { GmailContext } from '../context.ts';
import { type ConsentResult, completeConsent } from './consent.ts';

export interface StartOptions {
  mode: 'add' | 'reauth';
  alias: string;
  tier?: string | undefined;
  contacts?: boolean | undefined;
  client?: string | undefined;
  /** The address this sign-in must turn out to be. Refused afterwards if it is not. */
  email?: string | undefined;
  hostedDomain?: string | undefined;
  /** A fixed loopback port, for a network where only some ports are free. */
  port?: number | undefined;
  /** Command used to start the detached listener; tests point it at the source entry. */
  listenerCommand?: { command: string; args: string[] } | undefined;
  /** False keeps the listener in this process (the interactive flow, which waits). */
  detached?: boolean | undefined;
}

export interface StartedSignIn {
  flowId: string;
  authUrl: string;
  redirectUri: string;
  expiresAt: string;
  /**
   * The address this sign-in is bound to, when one was named.
   *
   * Absent means nothing checks which account consents, and the caller is told so — the link is a one-time
   * capability that has just been printed somewhere.
   */
  expectedEmail?: string | undefined;
  /** Present only for an in-process flow: resolves when the browser comes back. */
  listener?: { result: Promise<ConsentResult>; close(): Promise<void> } | undefined;
}

function parseTier(value: string | undefined, fallback: Tier = 'organize'): Tier {
  if (value === undefined) return fallback;
  if ((TIERS as readonly string[]).includes(value)) return value as Tier;
  throw new CommsError('USAGE', `"${value}" is not a permission tier`, {
    hint: `Use one of: ${TIERS.join(', ')}.`,
  });
}

/**
 * Starts a sign-in and returns the link to open. The listener that catches Google's redirect runs in a **detached**
 * child process, because the agent that runs this command usually cannot wait: its shell is killed long before a
 * person has read a consent screen. `--finish` then collects the result.
 */
export async function startSignIn(context: GmailContext, options: StartOptions): Promise<StartedSignIn> {
  const config = await context.config();
  // Resolved per mode, below, and deliberately not before: adding an inbox has no inbox to ask, but re-authorising
  // one does, and `Object.keys(config.clients)[0]` is insertion order rather than an answer to the question.
  let clientName = options.client ?? Object.keys(config.clients)[0] ?? 'default';

  let tier = parseTier(options.tier);
  let contacts = options.contacts ?? true;
  // Without `--email` nothing binds the consent to an intended account, and the consent URL is printed — into an
  // agent's transcript, among other places. Anyone who reads it can open it, consent with **their own** Google
  // account, and the listener will accept the code: the `state` and the PKCE challenge are the ones we issued.
  // The result names the address that was actually connected, which is the only thing standing between that and a
  // silently wrong mailbox, so the caller is told to pass `--email` when it can.
  let expect: OAuthFlow['expect'] = { email: options.email };
  if (options.mode === 'reauth') {
    const inbox = requireInbox(config, options.alias);
    // **The inbox's own client, not the first one in the file.** A re-consent has to go through the OAuth client the
    // inbox was registered against, or the code is exchanged with the wrong client's secret and the refresh token
    // that comes back is issued to a client the registry row does not name. The tool prints the path into this
    // itself: `import-legacy` registers the legacy client as `imported` and then tells the user to run
    // `agent-gmail inbox reauth <alias> --start`, so anyone who already had a `default` client re-consented through
    // `default` — which is first by insertion order — while the inbox said `imported`.
    clientName = options.client ?? inbox.client;
    tier = parseTier(
      options.tier,
      (TIERS as readonly string[]).includes(inbox.tier) ? (inbox.tier as Tier) : 'organize',
    );
    contacts = options.contacts ?? inbox.contacts;
    expect = { email: options.email ?? inbox.email, sub: inbox.sub, inboxId: inbox.id };
  } else if (config.inboxes[options.alias]) {
    throw new CommsError('CONFIG', `an inbox called "${options.alias}" already exists`, {
      hint: `Re-authorise it with \`agent-gmail inbox reauth ${options.alias}\`, or choose another name.`,
    });
  }

  const client = await context.client(clientName);
  const pkce = newPkce();
  const scopes = scopesFor(tier, contacts);
  const flow = await context.flows.create({
    mode: options.mode,
    alias: options.alias,
    clientName,
    tier,
    contacts,
    scopes,
    state: newState(),
    codeVerifier: pkce.verifier,
    // Filled in once the listener has a port; a flow is never usable before that.
    redirectUri: '',
    port: 0,
    expect,
  });

  const started =
    options.detached === false
      ? await startInProcess(context, flow, options.port)
      : await startDetached(context, flow, options);

  const authUrl = buildAuthUrl({
    client: { clientId: client.clientId, clientSecret: '' },
    endpoints: context.endpoints,
    redirectUri: started.redirectUri,
    scopes,
    state: flow.state,
    codeChallenge: pkce.challenge,
    loginHint: expect.email,
    hostedDomain: options.hostedDomain,
  });

  return {
    flowId: flow.flowId,
    expectedEmail: expect.email,
    authUrl,
    redirectUri: started.redirectUri,
    expiresAt: flow.expiresAt,
    listener: started.listener,
  };
}

async function startInProcess(
  context: GmailContext,
  flow: OAuthFlow,
  port: number | undefined,
): Promise<{ redirectUri: string; listener: StartedSignIn['listener'] }> {
  const listener = await startLoopback({
    state: flow.state,
    port,
    timeoutMs: Date.parse(flow.expiresAt) - context.now().getTime(),
  });
  await context.flows.patch(flow.flowId, { redirectUri: listener.redirectUri, port: listener.port });
  const result = (async (): Promise<ConsentResult> => {
    const outcome = await listener.result;
    await listener.close();
    if ('timeout' in outcome) {
      await context.flows.discard(flow.flowId);
      throw new CommsError('AUTH_REQUIRED', 'nobody finished signing in within ten minutes');
    }
    if ('error' in outcome) {
      await context.flows.discard(flow.flowId);
      throw oauthError(outcome.error, outcome.description);
    }
    const claimed = await context.flows.claim(flow.flowId);
    try {
      return await completeConsent(context, claimed, outcome.code);
    } finally {
      await context.flows.discard(flow.flowId);
    }
  })();
  return { redirectUri: listener.redirectUri, listener: { result, close: () => listener.close() } };
}

/** Starts the listener in a detached child and waits only for it to report the port it bound. */
async function startDetached(
  context: GmailContext,
  flow: OAuthFlow,
  options: StartOptions,
): Promise<{ redirectUri: string; listener: undefined }> {
  const entry = options.listenerCommand ?? defaultListenerCommand();

  /*
   * The listener's stderr goes to a file, not to ours.
   *
   * Inheriting it meant this detached child held our stderr open for as long as it waited for the browser — up to
   * ten minutes. A caller that piped the command anywhere (`inbox add --start | tee setup.log`, or any wrapper
   * that captures output) then hung on a command that had already printed everything it was going to print and
   * exited. The output was complete and the process was gone; only the inherited descriptor was still open.
   *
   * Dropping it entirely would be the smaller change, but a listener that fails after it reported ready — a port
   * taken, a redirect that never arrives — would then fail silently. So it is redirected rather than discarded,
   * and `doctor` can point at the file.
   */
  const logPath = join(context.core.paths.stateDir, 'flows', `${flow.flowId}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const log = await open(logPath, 'a');

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(entry.command, [...entry.args, 'oauth-listen', flow.flowId], {
      detached: true,
      // An IPC channel only for the "ready" message: nothing else passes between the processes.
      stdio: ['ignore', 'ignore', log.fd, 'ipc'],
      env: { ...process.env, ...listenerEnv(context, options.port) },
    });
  } finally {
    // The child holds its own duplicate of the descriptor; ours would otherwise keep the file open for this
    // process's lifetime, which is the same class of leak this whole change is about.
    await log.close();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the sign-in listener did not start within ten seconds')),
        10_000,
      );
      child.once('message', (message: { type?: string; error?: string }) => {
        clearTimeout(timer);
        if (message?.type === 'ready') resolve();
        else reject(new Error(message?.error ?? 'the sign-in listener could not start'));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the sign-in listener stopped before it was ready (exit ${code})`));
      });
    });
  } catch (error) {
    child.kill();
    await context.flows.discard(flow.flowId);
    throw new CommsError('UNEXPECTED', String((error as Error).message), {
      hint: 'Run the sign-in on a terminal instead: `agent-gmail inbox add <alias>`.',
      cause: error,
    });
  }

  child.disconnect();
  child.unref();
  const updated = await context.flows.get(flow.flowId);
  return { redirectUri: updated.redirectUri, listener: undefined };
}

function listenerEnv(context: GmailContext, port: number | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    AGENT_COMMS_CONFIG_DIR: context.core.paths.configDir,
    AGENT_COMMS_STATE_DIR: context.core.paths.stateDir,
  };
  if (context.env.AGENT_COMMS_GOOGLE_ROOT_URL) {
    env.AGENT_COMMS_GOOGLE_ROOT_URL = context.env.AGENT_COMMS_GOOGLE_ROOT_URL;
  }
  if (port !== undefined) env.AGENT_COMMS_LOOPBACK_PORT = String(port);
  return env;
}

function defaultListenerCommand(): { command: string; args: string[] } {
  const entry = process.argv[1];
  if (!entry) throw new CommsError('UNEXPECTED', 'cannot work out how to start the sign-in listener');
  return { command: process.execPath, args: [entry] };
}

export interface FinishOptions {
  flowId: string;
  /** The address bar URL, pasted back on a machine with no browser of its own. */
  url?: string | undefined;
  /** How long to wait for the detached listener, in seconds. */
  waitSeconds?: number;
  pollMs?: number;
}

/**
 * Completes a sign-in exactly once. A wait that times out leaves the flow alone, so the user can run `--finish`
 * again; only an answer from the browser claims it.
 */
export async function finishSignIn(context: GmailContext, options: FinishOptions): Promise<ConsentResult> {
  const flow = await context.flows.get(options.flowId);

  let code: string;
  if (options.url) {
    code = codeFromUrl(options.url, flow);
  } else {
    const outcome = await waitForOutcome(context, options, flow);
    if ('error' in outcome) {
      await context.flows.discard(flow.flowId);
      throw oauthError(outcome.error, outcome.description);
    }
    code = outcome.code;
  }

  const claimed = await context.flows.claim(flow.flowId);
  try {
    return await completeConsent(context, claimed, code);
  } finally {
    stopListener(claimed);
    await context.flows.discard(flow.flowId);
  }
}

async function waitForOutcome(
  context: GmailContext,
  options: FinishOptions,
  flow: OAuthFlow,
): Promise<{ code: string } | { error: string; description?: string | undefined }> {
  const deadline = context.now().getTime() + (options.waitSeconds ?? 60) * 1000;
  const pollMs = options.pollMs ?? 500;
  for (;;) {
    const outcome = await context.flows.readOutcome(flow.flowId);
    if (outcome) return outcome;
    if (context.now().getTime() >= deadline) {
      throw new CommsError('APPROVAL_PENDING', 'nobody has finished signing in yet', {
        hint: `Open the link, choose the account, then run \`agent-gmail inbox ${flow.mode === 'reauth' ? 'reauth' : 'add'} --finish ${flow.flowId} --wait 60\` again.`,
        details: { flowId: flow.flowId, expiresAt: flow.expiresAt },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function codeFromUrl(pasted: string, flow: OAuthFlow): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new CommsError('USAGE', 'that does not look like the address the browser ended up at', {
      hint: 'Copy the whole address, including everything after the question mark.',
    });
  }
  const error = url.searchParams.get('error');
  if (error) throw oauthError(error, url.searchParams.get('error_description') ?? undefined);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!code) {
    throw new CommsError('USAGE', 'that address carries no sign-in code', {
      hint: 'It should contain `code=` — copy the address the browser ended up at after the consent screen.',
    });
  }
  if (state !== flow.state) {
    throw new CommsError('AUTH_REQUIRED', 'that address belongs to a different sign-in', {
      hint: 'Use the address from the link this flow printed, or start again.',
    });
  }
  return code;
}

/** Best effort: the detached listener has done its job and would otherwise sit until the flow expires. */
function stopListener(flow: OAuthFlow): void {
  if (!flow.listenerPid || flow.listenerPid === process.pid) return;
  // A flow lives ten minutes. If the listener died early and the operating system reused its number, this would
  // signal an unrelated process of the user's — so the number is only trusted while the flow that recorded it is
  // still within its own window. It times out on its own regardless, which is the real backstop.
  const expiresAt = new Date(flow.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return;
  try {
    process.kill(flow.listenerPid, 'SIGTERM');
  } catch {
    // Already gone, or owned by another user: nothing to do.
  }
}
