import {
  agentMarker,
  askChallenge,
  CommsError,
  canPrompt,
  colorEnabled,
  type LooseningConsent,
  type OutputOptions,
  paint,
  runCommand,
  type Streams,
  writeResult,
} from '@agentcomms/core';
import { Command, CommanderError, Option } from 'commander';
import { isDue, parseBundle, type TokenBundle } from '../auth/bundle.ts';
import { SlackContext, type SlackContextOptions } from '../context.ts';
import { type InstallMode, renderManifest } from '../manifest.ts';
import { doctor, type IdentityProbe } from '../operations/doctor.ts';
import { type ProbeFetch, probeIdentity } from '../operations/identity.ts';
import {
  finishSignIn,
  type ListenerEntry,
  runSignInListener,
  type StartedSignIn,
  startSignIn,
} from '../operations/signin.ts';
import { listWorkspaces, removeWorkspace, requireWorkspace, viewOf } from '../operations/workspaces.ts';
import { VERSION } from '../version.ts';
import { openInBrowser } from './browser.ts';
import {
  renderConnected,
  renderDoctor,
  renderManifestHelp,
  renderRemoved,
  renderSignInStarted,
  renderWorkspace,
  renderWorkspaces,
} from './render.ts';

/**
 * The `agent-slack` command.
 *
 * S2 is the setup surface and deliberately nothing else: make an app, connect a workspace, see what is connected,
 * and be told what is broken. Reading, drafting and posting arrive in later phases, and a command that pretended
 * to do them now would be worse than one that is not there.
 *
 * Both a person and an agent run this, so every command prints a readable summary by default and the whole result
 * under `--json`, with the same exit codes either way.
 */

export interface CliDeps extends SlackContextOptions {
  streams?: Streams;
  /** Command used to start the detached sign-in listener; the tests point it at the source entry. */
  listenerCommand?: ListenerEntry;
  /** Opens the browser. Injected so a test does not. */
  openBrowser?: (url: string) => unknown;
  /** The fetch `doctor` asks Slack with. Injected so a test never reaches the real one. */
  probe?: ProbeFetch;
}

interface GlobalOptions {
  json: boolean;
  color: boolean;
}

type Options = Record<string, unknown>;

export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const streams: Streams = deps.streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const env = deps.env ?? process.env;
  const open = deps.openBrowser ?? openInBrowser;
  /** Best effort: the link is already printed, so a browser that will not start is not a failed sign-in. */
  const tryOpen = (url: string): void => {
    try {
      void open(url);
    } catch {
      // nothing to do; the link is on screen
    }
  };
  const program = new Command();
  let exitCode = 0;
  let ran = false;

  program
    .name('agent-slack')
    .description('Slack for coding agents: connect a workspace and check it works. Reading and posting come later.')
    .version(VERSION, '-v, --version')
    .option('--json', 'print the result as {"ok":true,"schemaVersion":1,"data":…}', false)
    .option('--no-color', 'never colour the output')
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
    })
    .addHelpText(
      'after',
      `
Getting started:
  agent-slack manifest --port 51234        the app to create in Slack, and how
  agent-slack workspace add acme --client-id <id> --port 51234
  agent-slack doctor                       what works and what does not

Exit codes: 0 ok · 1 unexpected · 10 waiting for someone to finish signing in · 64 usage ·
65 bad data · 66 not found · 69 provider or secret store unavailable · 75 temporary
(retry later) · 77 sign-in or permission needed · 78 configuration problem.`,
    )
    .exitOverride();

  const globals = (): GlobalOptions => {
    const options = program.opts();
    return {
      json: Boolean(options.json),
      color: colorEnabled(env, streams.stdout, options.color as boolean | undefined),
    };
  };
  const output = (): OutputOptions => ({ json: globals().json, color: globals().color });

  /**
   * A command that succeeded but wants a non-zero exit code — `doctor` finding something broken, where the
   * findings *are* the output and the envelope must still be the normal one. Throwing instead would print a
   * second envelope after the first, and `--json` promises exactly one document on stdout.
   */
  let softExit: number | null = null;

  const act =
    <A extends unknown[]>(body: (context: SlackContext, options: GlobalOptions, ...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      ran = true;
      softExit = null;
      const context = new SlackContext({ ...deps, env, surface: 'cli' });
      exitCode = await runCommand(output(), () => body(context, globals(), ...args), streams);
      if (exitCode === 0 && softExit !== null) exitCode = softExit;
    };

  const modeOption = (): Option =>
    new Option('--mode <mode>', 'how much access to ask Slack for').choices(['read', 'send']).default('read');

  const portOf = (flags: Options): number => {
    const raw = flags.port;
    if (raw === undefined) {
      throw new CommsError('USAGE', 'the loopback port is needed, and must match the one in the manifest', {
        hint: 'Slack matches redirect URLs exactly. Pass the same `--port` you built the manifest with.',
      });
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CommsError('USAGE', `"${String(raw)}" is not a port`, { hint: 'A whole number from 1 to 65535.' });
    }
    return port;
  };

  // ── manifest ────────────────────────────────────────────────────────────────────────────────────────────────

  program
    .command('manifest')
    .description('the Slack app to create, as a manifest you can paste')
    .addOption(modeOption())
    .option('--port <port>', 'the loopback port its redirect will use')
    .action(
      act(async (_context, options, flags: Options) => {
        const mode = String(flags.mode) as InstallMode;
        /*
         * The port is decided here, before any sign-in exists.
         *
         * Slack stores redirect URLs on the app and matches them exactly, so it cannot be whichever port the OS
         * hands out at sign-in time — which is what the Gmail side does, and why the two differ. Asking for it
         * now, and refusing to guess one, is what makes `workspace add --port` the same number by construction
         * rather than by luck.
         */
        const port = portOf(flags);
        const redirectUrl = `http://localhost:${port}/slack/callback`;
        const manifest = renderManifest(mode, redirectUrl);
        writeResult(
          { mode, port, redirectUrl, manifest: JSON.parse(manifest) as unknown },
          output(),
          () => `${renderManifestHelp(mode, port, options.color)}\n\n${manifest}`,
          streams,
        );
      }),
    );

  // ── workspace ───────────────────────────────────────────────────────────────────────────────────────────────

  const workspace = program.command('workspace').description('connect, inspect and disconnect Slack workspaces');

  const signInOptions = (command: Command): Command =>
    command
      .addOption(modeOption())
      .option('--port <port>', 'the loopback port, matching the one in the manifest')
      .option('--start', 'print the link and return, instead of waiting', false)
      .option('--finish <flowId>', 'complete a sign-in started with --start')
      .option('--wait <seconds>', 'with --finish, how long to wait for the browser', '60')
      .option('--url <url>', 'with --finish, the address-bar URL, pasted back by hand')
      .option('--no-browser', 'print the link instead of opening it');

  signInOptions(workspace.command('add [alias]'))
    .description('connect a workspace (opens Slack in a browser)')
    .option('--client-id <id>', 'the app’s Client ID, from its Basic Information page')
    .action(
      act(async (context, options, alias: string | undefined, flags: Options) => {
        if (flags.finish) {
          const view = await finishSignIn(context, {
            flowId: String(flags.finish),
            only: 'add',
            // Optional here, so bound only when it was given rather than invented from the flow.
            ...(alias ? { expectAlias: alias } : {}),
            ...(flags.url ? { url: String(flags.url) } : {}),
            waitSeconds: Number(flags.wait) || 60,
          });
          writeResult(view, output(), () => renderConnected(view, false, options.color), streams);
          return;
        }
        if (!alias) {
          throw new CommsError('USAGE', 'a name for the workspace is needed', {
            hint: 'e.g. `agent-slack workspace add acme --client-id <id> --port 51234`.',
          });
        }
        if (!flags.clientId) {
          throw new CommsError('USAGE', 'the Slack app’s Client ID is needed', {
            hint: 'Create the app first: `agent-slack manifest --port 51234`. The Client ID is not a secret.',
          });
        }
        await signIn(context, options, {
          alias,
          mode: String(flags.mode) as InstallMode,
          clientId: String(flags.clientId),
          port: portOf(flags),
          start: flags.start === true,
          browser: flags.browser !== false,
        });
      }),
    );

  workspace
    .command('list')
    .description('the workspaces this machine can reach')
    .action(
      act(async (context, options) => {
        const workspaces = listWorkspaces(await context.config());
        writeResult(workspaces, output(), () => renderWorkspaces(workspaces, options.color), streams);
      }),
    );

  workspace
    .command('show <alias>')
    .description('everything known about one workspace')
    .action(
      act(async (context, options, alias: string) => {
        const found = requireWorkspace(await context.config(), alias);
        const view = viewOf(found.alias, found.account);
        writeResult(view, output(), () => renderWorkspace(view, options.color), streams);
      }),
    );

  workspace
    .command('remove <alias>')
    .description('disconnect a workspace from this machine')
    .action(
      act(async (context, _options, alias: string) => {
        const removed = await removeWorkspace(
          {
            config: await context.config(),
            secrets: await context.secrets(),
            update: (mutator) => context.core.config.update(mutator),
          },
          alias,
        );
        writeResult(removed, output(), () => renderRemoved(alias), streams);
      }),
    );

  signInOptions(workspace.command('reauth <alias>'))
    .description('sign in again: renew the grant, or change how much access it has')
    .action(
      act(async (context, options, alias: string, flags: Options, command: Command) => {
        if (flags.finish) {
          const view = await finishSignIn(context, {
            flowId: String(flags.finish),
            only: 'reauth',
            // The caller named a workspace; a flow id names one too, and they have to be the same one.
            expectAlias: alias,
            ...(flags.url ? { url: String(flags.url) } : {}),
            waitSeconds: Number(flags.wait) || 60,
          });
          writeResult(view, output(), () => renderConnected(view, true, options.color), streams);
          return;
        }
        const { account } = requireWorkspace(await context.config(), alias);
        if (!account.oauthClientId) {
          throw new CommsError('CONFIG', `"${alias}" does not record which Slack app it was connected through`, {
            hint: `Remove and add it again: \`agent-slack workspace remove ${alias}\`.`,
          });
        }
        /*
         * The workspace's own mode by default, not `read`.
         *
         * `--mode` carries a default, so at this layer "not passed" and "passed read" look identical — and taking
         * the default would quietly downgrade a `send` workspace every time somebody renewed its grant, which is
         * the opposite of what "the same, again" means. Commander knows where the value came from; ask it.
         */
        const was = (account.mode ?? account.tier) as InstallMode;
        const mode = command.getOptionValueSource('mode') === 'default' ? was : (String(flags.mode) as InstallMode);
        const consent = mode === 'send' && was === 'read' ? await confirmWidening(context, options, alias) : undefined;
        await signIn(context, options, {
          alias,
          mode,
          ...(consent ? { consent } : {}),
          clientId: account.oauthClientId,
          port: portOf(flags),
          start: flags.start === true,
          browser: flags.browser !== false,
          expect: {
            accountId: account.id,
            workspaceId: account.workspace,
            userId: account.userId,
            oauthClientId: account.oauthClientId,
            ...(account.appId ? { appId: account.appId } : {}),
          },
        });
      }),
    );

  // ── doctor ──────────────────────────────────────────────────────────────────────────────────────────────────

  program
    .command('doctor')
    .description('check everything that has to work, and say how to fix what does not')
    .option('--offline', 'do not ask Slack anything; report only what the files say', false)
    .action(
      act(async (context, options, flags: Options) => {
        const config = await context.config();
        const secrets = await context.secrets();
        const bundles = new Map<string, TokenBundle | null | 'unreadable'>();
        for (const view of listWorkspaces(config)) {
          const account = config.accounts[view.alias];
          if (!account) continue;
          try {
            bundles.set(view.alias, parseBundle(await secrets.get(account.secretRef)));
          } catch {
            /*
             * An unreadable credential is a finding, not a crash — `doctor` is what somebody runs *because*
             * something is wrong, so it has to survive the thing being wrong.
             *
             * Reported as unreadable rather than as absent, which is a different problem with a different fix.
             * Collapsing the two said "no stored token" for a credential that is very much stored, and sent
             * people to `workspace add` — which then refuses it as already connected.
             */
            bundles.set(view.alias, 'unreadable');
          }
        }
        /*
         * One call per workspace, and only for a credential that could possibly work.
         *
         * `--offline` exists because this is the only thing here that needs a network, and somebody diagnosing a
         * machine with no network still deserves everything the files can tell them. Without the flag a failure
         * to reach Slack is reported as not having asked, never as a problem with the install.
         */
        const identities = new Map<string, IdentityProbe>();
        if (flags.offline !== true) {
          for (const [alias, bundle] of bundles) {
            if (bundle === null || bundle === 'unreadable') continue;
            /*
             * A token already past its expiry is not asked about.
             *
             * Slack would refuse it, and the refusal would be reported as a credential problem — which it is
             * not: an expired access token is the ordinary state of a workspace nobody has used today, and the
             * `credential-state` check above already says so. Asking anyway would turn "this is fine" into
             * "re-authorise", which is the one piece of advice that throws away a working refresh token.
             */
            if (isDue(bundle, context.now())) continue;
            identities.set(alias, await probeIdentity(bundle, deps.probe ? { fetch: deps.probe } : {}));
          }
        }
        const result = doctor({ config, now: context.now(), bundles, identities });
        if (!result.healthy) softExit = 78;
        writeResult(result, output(), () => renderDoctor(result, options.color), streams);
      }),
    );

  // ── the hidden half of a two-step sign-in ───────────────────────────────────────────────────────────────────

  program
    .command('sign-in-listen <flowId>', { hidden: true })
    .description('internal: hold the loopback port open for a sign-in started with --start')
    .action(
      act(async (context, _options, flowId: string) => {
        await runSignInListener(context, flowId);
      }),
    );

  // ── shared by add and reauth ────────────────────────────────────────────────────────────────────────────────

  /**
   * `read` → `send` is the one change here that a person has to make deliberately.
   *
   * A workspace connected as `read` holds a token that physically cannot post. That is the guarantee D1 makes,
   * and re-authorising as `send` replaces the token with one that can — so it is not a setting an agent may flip
   * on somebody's behalf, however reasonable the reason sounds in a transcript.
   *
   * Two things stand in the way, and they answer different threats. The agent marker refuses outright when the
   * caller is an agent, because an agent that can run commands can also type a challenge. The typed challenge
   * then makes it deliberate for the person who is left, which is what it is for: a speed bump against a hasty
   * change, never a security boundary.
   *
   * The consent travels on the flow, because the sign-in this gates may be finished by a different process.
   */
  async function confirmWidening(
    context: SlackContext,
    options: GlobalOptions,
    alias: string,
  ): Promise<LooseningConsent> {
    const marker = agentMarker(env);
    if (marker) {
      throw new CommsError('LOOSENING_REFUSED', `widening "${alias}" from read to send is not an agent's to do`, {
        hint: `Ask the user to run \`agent-slack workspace reauth ${alias} --mode send\` in their own terminal.`,
        details: { marker },
      });
    }
    if (!canPrompt(env, streams, { json: globals().json, noInput: false })) {
      throw new CommsError('LOOSENING_REFUSED', 'widening a workspace from read to send needs a terminal', {
        hint: `Run \`agent-slack workspace reauth ${alias} --mode send\` directly in a terminal.`,
      });
    }
    await askChallenge(streams, {
      prompt: `This replaces "${alias}"'s token with one that can post to Slack (read → send).`,
      color: options.color,
    });
    return { kind: 'loosening-consent', paths: [`accounts.${alias}.mode`] };
  }

  async function signIn(
    context: SlackContext,
    options: GlobalOptions,
    input: {
      alias: string;
      mode: InstallMode;
      clientId: string;
      port: number;
      start: boolean;
      browser: boolean;
      expect?: Parameters<typeof startSignIn>[1]['expect'];
    },
  ): Promise<void> {
    const started: StartedSignIn = await startSignIn(context, {
      alias: input.alias,
      mode: input.mode,
      clientId: input.clientId,
      port: input.port,
      detached: input.start,
      ...(input.expect ? { expect: input.expect } : {}),
      ...(deps.listenerCommand ? { listenerCommand: deps.listenerCommand } : {}),
    });
    const reauth = Boolean(input.expect);

    if (input.start) {
      /*
       * The two-step form, and why it exists: an agent's shell call returns in seconds while consent takes
       * minutes. The listener is detached and the flow is on disk, so whatever runs `--finish` need not be this
       * process — or even this session.
       */
      if (input.browser) tryOpen(started.authUrl);
      writeResult(
        {
          flowId: started.flowId,
          alias: started.alias,
          mode: started.mode,
          authUrl: started.authUrl,
          expiresAt: started.expiresAt,
        },
        output(),
        () => renderSignInStarted(started, reauth, options.color),
        streams,
      );
      return;
    }

    // Interactive. The link goes to stderr, so `--json` still puts exactly one document on stdout.
    streams.stderr.write(`${renderSignInStarted(started, reauth, options.color)}\n\n`);
    if (input.browser) tryOpen(started.authUrl);
    const listener = started.listener;
    if (!listener) throw new CommsError('UNEXPECTED', 'the sign-in listener did not start');
    try {
      const view = await listener.result;
      writeResult(view, output(), () => renderConnected(view, reauth, options.color), streams);
    } finally {
      await listener.close();
    }
  }

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander prints help and version itself; anything else is a usage error.
      if (['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(error.code)) return 0;
      return runCommand(
        output(),
        async () => {
          throw new CommsError('USAGE', error.message.replace(/^error: /, ''), {
            hint: 'Run `agent-slack --help` to see the commands.',
          });
        },
        streams,
      );
    }
    throw error;
  }
  if (!ran) {
    streams.stderr.write(`${paint(globals().color, 'dim', 'Nothing to do. Try `agent-slack --help`.')}\n`);
    return 64;
  }
  return exitCode;
}
