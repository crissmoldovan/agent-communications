import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommsError, findById, lookupName, requireInbox } from '@agentcomms/core';
import type { OAuthFlow } from '../auth/flows.ts';
import { aboutFlow } from '../auth/flows.ts';
import { startLoopback } from '../auth/loopback.ts';
import { buildAuthUrl, newPkce, newState, oauthError } from '../auth/oauth.ts';
import { scopesFor, TIERS, type Tier } from '../auth/scopes.ts';
import type { GmailContext } from '../context.ts';
import { type ConsentResult, completeConsent } from './consent.ts';
import { requireNewInboxName } from './inbox-names.ts';

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
  } else {
    // Before the browser opens, not only when it comes back: a name the file cannot take would otherwise be refused
    // after the person has already been through Google's consent screens.
    requireNewInboxName(config, options.alias);
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
    about: aboutFlow(flow),
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
  const entry = options.listenerCommand ?? (await defaultListenerCommand());

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

  let child: ReturnType<typeof spawn>;
  let spawnFailure: Error | null = null;
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const log = await open(logPath, 'a');
    try {
      child = spawn(entry.command, [...entry.args, 'oauth-listen', flow.flowId], {
        detached: true,
        // An IPC channel only for the "ready" message: nothing else passes between the processes.
        stdio: ['ignore', 'ignore', log.fd, 'ipc'],
        env: { ...process.env, ...listenerEnv(context, options.port) },
      });
      // Attached before the next `await`, not after it. `spawn` reports a missing or unexecutable command on the
      // following tick, which lands in the middle of `log.close()` — and an 'error' event with no listener is
      // thrown by Node as an uncaught exception, past every catch here including the one that discards the flow.
      child.once('error', (error: Error) => {
        spawnFailure = error;
      });
    } finally {
      // The child holds its own duplicate of the descriptor; ours would otherwise keep the file open for this
      // process's lifetime, which is the same class of leak this whole change is about.
      await log.close();
    }
    if (spawnFailure) throw spawnFailure;
  } catch (error) {
    // The flow record, with its PKCE verifier, was written before any of this. A failure here — no permission to
    // create the log, no descriptors left, a spawn that throws outright — would otherwise leave it on disk with
    // no listener and no command that can finish it, and the next run would not know it was dead.
    await context.flows.discard(flow.flowId);
    throw new CommsError('UNEXPECTED', `the sign-in listener could not be started: ${(error as Error).message}`, {
      hint: 'Run the sign-in on a terminal instead: `agent-gmail inbox add <alias>`.',
      cause: error,
    });
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

  detachListener(child);
  const updated = await context.flows.get(flow.flowId);
  return { redirectUri: updated.redirectUri, listener: undefined };
}

/**
 * Lets the listener outlive this process, whoever closed the channel first.
 *
 * The listener disconnects itself straight after saying it is ready, so by the time this runs the channel may
 * already be closed from the other end — and `disconnect()` on a closed channel throws. It did, on a busy machine:
 * a pause of a few tens of milliseconds between "ready" and here was enough, every time, and a sign-in whose
 * listener was alive and waiting for the browser was reported as an unexpected failure.
 */
export function detachListener(child: Pick<ChildProcess, 'connected' | 'disconnect' | 'unref'>): void {
  if (child.connected) child.disconnect();
  child.unref();
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

export interface ListenerEntry {
  command: string;
  args: string[];
}

/**
 * The command that can run `oauth-listen`, resolved from this module rather than from `process.argv[1]`.
 *
 * `process.argv[1]` is whatever binary happens to be running, and only one of them understands the hidden
 * listener mode. Started as `agent-gmail` it is the CLI, which does. Started as `agent-gmail-mcp` — the packaged
 * standalone server, and how most people run it — it is a different entry with no `oauth-listen` command at all,
 * so the sign-in failed before it could return a URL. Under a test runner it is the test file.
 *
 * This package's own CLI is the thing that answers, wherever it is. The same reasoning, and nearly the same code,
 * is in `mcp/install.ts`; the lesson had been learned once already and not carried here.
 *
 * The search is separated from where it searches *from* so a test can put it in a layout that does not exist on
 * this machine — the packed one, `node_modules/@agentcomms/gmail/dist/`, being the layout this got wrong.
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
  // A last resort rather than a failure: in a layout none of the above matches, the running entry is the best
  // guess there is, and it is what this always used.
  const entry = process.argv[1];
  if (!entry) throw new CommsError('UNEXPECTED', 'cannot work out how to start the sign-in listener');
  return { command: process.execPath, args: [entry] };
}

export interface FinishOptions {
  flowId: string;
  /**
   * Refuse a flow that is not this kind.
   *
   * A flow id is the only thing `finish` needs, and the two kinds do very different things: an `add` creates a
   * mailbox, a `reauth` re-points an existing one at a possibly different client and tier. The MCP surface is
   * allowed the first and not the second, and without this it could finish a `reauth` the CLI had started —
   * changing a mailbox somebody else was in the middle of re-authorising, through a tool whose whole permission
   * to exist is that it only ever adds.
   *
   * The CLI sets it to its own subcommand, so `inbox add --finish` cannot quietly complete a reauth. Every finish
   * command this package prints names the flow's own mode, so nothing it tells anybody to type is refused.
   */
  onlyMode?: 'add' | 'reauth' | undefined;
  /**
   * Refuse a flow for a different mailbox.
   *
   * `--finish` takes a flow id and used to ignore a name given beside it, so `inbox reauth acme/gmail --finish …`
   * finished whatever that flow was — possibly connecting a different mailbox — while the person who typed it
   * believed they had re-authorised the one they named. A name is optional, and the printed commands omit it; one
   * that is given has to be the flow's.
   */
  onlyAlias?: string | undefined;
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
  if (options.onlyMode && flow.mode !== options.onlyMode) {
    const wanted = options.onlyMode === 'add' ? 'a new mailbox' : 're-authorising an existing mailbox';
    throw new CommsError(
      'USAGE',
      `that sign-in is ${flow.mode === 'reauth' ? 're-authorising an existing mailbox' : 'a new mailbox'}, and this can only finish ${wanted}`,
      {
        hint: `Finish it where it was started: \`agent-gmail inbox ${flow.mode} --finish ${options.flowId}\`.`,
      },
    );
  }

  if (options.onlyAlias !== undefined) {
    /*
     * The same mailbox, not the same spelling.
     *
     * A reauth is bound to an inbox id and writes by it, so the name given is resolved to the mailbox it names now
     * and compared by id. Comparing strings refused the current name of a mailbox renamed since the sign-in began,
     * and — worse, under version 1, where a name can be given to another mailbox — accepted the old name while the
     * write went to the original. An add has no id yet: its name is the one it will create, so that is compared as
     * written.
     */
    const expected = flow.mode === 'reauth' ? flow.expect.inboxId : undefined;
    const config = expected === undefined ? null : await context.config();
    const named = config ? lookupName(config, 'inbox', options.onlyAlias) : undefined;
    const same = expected === undefined ? flow.alias === options.onlyAlias : named?.id === expected;
    if (!same) {
      const current = config && expected ? (findById(config, 'inbox', expected)?.alias ?? flow.alias) : flow.alias;
      throw new CommsError('USAGE', `that sign-in is for "${current}", not "${options.onlyAlias}"`, {
        hint: `Finish it without a name — \`agent-gmail inbox ${flow.mode} --finish ${options.flowId}\` — or start a sign-in for "${options.onlyAlias}".`,
      });
    }
  }

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
