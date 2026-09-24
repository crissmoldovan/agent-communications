import {
  agentMarker,
  CommsError,
  canPrompt,
  colorEnabled,
  type LooseningConsent,
  lookupName,
  type OutputOptions,
  paint,
  renderChannelPreview,
  requirePerson,
  runCommand,
  type Streams,
  withCredentialsLock,
  writeResult,
} from '@agentcomms/core';
import { Command, CommanderError, Option } from 'commander';
import type { FetchLike } from '../api/guard.ts';
import { closedPermit } from '../api/guard.ts';
import { isExpired, parseBundle, type TokenBundle } from '../auth/bundle.ts';
import { compose, type Mention } from '../compose/blocks.ts';
import { openDraftStore } from '../compose/drafts.ts';
import { SlackContext, type SlackContextOptions } from '../context.ts';
import { type InstallMode, parseMode, renderManifest } from '../manifest.ts';
import { beginApproval, finishApproval, revokeApproval, workspaceForApproval } from '../operations/approve.ts';
import { doctor, type IdentityProbe } from '../operations/doctor.ts';
import { type ProbeFetch, probeIdentity } from '../operations/identity.ts';
import { modeReport, narrowingSteps, wideningSteps } from '../operations/mode.ts';
import { NameBook } from '../operations/people.ts';
import { listChannels, listFiles, listPeople, readChannel, readThread, searchMessages } from '../operations/read.ts';
import { postPrepared, preparePost, prepareReaction, reactPrepared } from '../operations/send.ts';
import { openWorkspace } from '../operations/session.ts';
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
import { askFor } from './prompt.ts';
import {
  renderChannels,
  renderConnected,
  renderDoctor,
  renderFiles,
  renderHistory,
  renderInstall,
  renderManifestHelp,
  renderMode,
  renderPeople,
  renderRemoved,
  renderSearch,
  renderSignInStarted,
  renderSteps,
  renderThread,
  renderWorkspace,
  renderWorkspaces,
} from './render.ts';

/**
 * The `agent-slack` command.
 *
 * Setup and reading: make an app, connect a workspace, see what is connected, be told what is broken — and read
 * channels, threads, search, people and files. Drafting and posting arrive in later phases, and a command that
 * pretended to do them now would be worse than one that is not there.
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
  /** The fetch the read commands use. Injected the same way, and for the same reason. */
  read?: FetchLike;
  /** Where Slack is, for a test that stands one up locally rather than relaxing the origin check. */
  slackBaseUrl?: string;
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
    .description('Slack for coding agents: connect a workspace, check it works, and read it. Posting comes later.')
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
  agent-slack workspace add acme/slack --client-id <id> --port 51234
  agent-slack doctor                       what works and what does not
  agent-slack channels --workspace acme/slack
  agent-slack read <channel> --workspace acme/slack

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

  /**
   * How long `--finish` waits for the browser, checked rather than coerced.
   *
   * `Number(flags.wait) || 60` turned `--wait 0` into sixty seconds, accepted a negative number, and accepted
   * `Infinity` — an unbounded deadline on a command whose whole job is to return. `0` now means what it says:
   * look once and report. The ceiling is the flow's own life, since nothing can arrive after it has expired.
   */
  const waitOf = (flags: Options): number => {
    const raw = flags.wait ?? '60';
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
      throw new CommsError('USAGE', `"${String(raw)}" is not a wait`, {
        hint: 'A number of seconds from 0 to 600. A sign-in lasts ten minutes, so there is nothing to wait for after that.',
      });
    }
    return seconds;
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
            waitSeconds: waitOf(flags),
          });
          writeResult(view, output(), () => renderConnected(view, false, options.color), streams);
          return;
        }
        if (!alias) {
          throw new CommsError('USAGE', 'a name for the workspace is needed', {
            hint: 'e.g. `agent-slack workspace add acme/slack --client-id <id> --port 51234`.',
          });
        }
        if (!flags.clientId) {
          throw new CommsError('USAGE', 'the Slack app’s Client ID is needed', {
            hint: 'Create the app first: `agent-slack manifest --port 51234`. The Client ID is not a secret.',
          });
        }
        const mode = String(flags.mode) as InstallMode;
        // A new workspace that can post is a widening from nothing, and asked about as one. See `startSignIn`.
        const consent =
          mode === 'send'
            ? await confirmPosting(options, alias, {
                command: `agent-slack workspace add ${alias} --mode send --client-id ${String(flags.clientId)} --port ${portOf(flags)}`,
                prompt: `This connects "${alias}" with a token that can post to Slack.`,
              })
            : undefined;
        await signIn(context, options, {
          alias,
          mode,
          ...(consent ? { consent } : {}),
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

  /*
   * The mode, and moving it — one command for what `show`, `reauth` and the Slack admin pages each hold part of.
   *
   * Reporting is anybody's. `send` is the gated widening under a name people look for, and only a person runs it.
   * `read` changes nothing: Slack cannot take a scope back from a token, only removing the app's installation resets
   * it, and that is in Slack's settings — so this says exactly how, in the order that keeps the workspace's name.
   */
  workspace
    .command('mode <alias> [mode]')
    .description('what a workspace can do, and how to change it: `mode <name> send`, or `mode <name> read`')
    .option('--port <port>', 'the loopback port in the app’s manifest')
    .option('--start', 'print the sign-in link and return, instead of waiting', false)
    .option('--no-browser', 'print the link instead of opening it')
    .action(
      act(async (context, options, alias: string, target: string | undefined, flags: Options) => {
        const found = requireWorkspace(await context.config(), alias);
        const port = flags.port === undefined ? undefined : portOf(flags);
        const report = modeReport(found.alias, found.account, port);
        if (target === undefined || target === report.mode) {
          writeResult(report, output(), () => renderMode(report, options.color), streams);
          return;
        }
        if (target === 'read') {
          // The port is in two of the steps and the configuration does not keep it, so it is asked for, as for `send`.
          const steps = narrowingSteps(found.alias, portOf(flags), {
            knowsItsApp: found.account.oauthClientId !== undefined,
          });
          writeResult(
            { alias: found.alias, mode: report.mode, changed: false, steps },
            output(),
            () =>
              renderSteps(
                `Slack cannot take posting away from "${found.alias}"'s token. Removing the app's installation does:`,
                steps,
                options.color,
              ),
            streams,
          );
          return;
        }
        if (target !== 'send') {
          throw new CommsError('USAGE', `"${target}" is not a mode`, { hint: 'The modes are `read` and `send`.' });
        }
        if (!found.account.oauthClientId) {
          throw new CommsError('CONFIG', `"${found.alias}" does not record which Slack app it was connected through`, {
            hint: `Remove and add it again: \`agent-slack workspace remove ${found.alias}\`.`,
          });
        }
        // Both steps name the port, and the configuration does not keep it, so it is asked for rather than guessed.
        const chosen = portOf(flags);
        streams.stderr.write(
          `${renderSteps('Moving to send takes two steps:', wideningSteps(found.alias, chosen), options.color)}\n`,
        );
        const consent = await confirmWidening(options, found.alias, chosen);
        // A reauth, bound to this account as `workspace reauth` binds it: without `expect` the sign-in is an add,
        // and an add refuses a name that is already connected.
        const { account } = found;
        await signIn(context, options, {
          alias: found.alias,
          mode: 'send',
          consent,
          clientId: found.account.oauthClientId,
          port: chosen,
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

  workspace
    .command('remove <alias>')
    .description('disconnect a workspace from this machine')
    .action(
      act(async (context, _options, alias: string) => {
        /*
         * Under the credentials lock, from reading the configuration to the last write.
         *
         * Removal deletes a credential and then drops the entry naming it, and a migration running in between
         * saw an account still configured whose credential was already gone — skipped it as having nothing to
         * copy, switched backends, and left the removal refusing because the backend had moved. The account stayed
         * configured with its credential in neither backend. Holding the lock makes the two strictly one after
         * the other, and reading the configuration inside it means the store chosen is the one actually in force.
         *
         * A sign-in does not take it, deliberately: it only ever *adds* a reference, which the migration's own
         * check of the reference set does see, and the sign-in checks the backend from its side. Making it wait
         * here would spend a one-shot authorisation code on a five-second lock timeout.
         */
        const removed = await withCredentialsLock(context.core.paths.configDir, async () =>
          removeWorkspace(
            {
              config: await context.config(),
              secrets: await context.secrets(),
              update: (mutator) => context.core.config.update(mutator),
            },
            alias,
          ),
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
            waitSeconds: waitOf(flags),
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
        const was = parseMode(account.mode ?? account.tier, `"${alias}"`);
        const mode = command.getOptionValueSource('mode') === 'default' ? was : (String(flags.mode) as InstallMode);
        const consent =
          mode === 'send' && was === 'read' ? await confirmWidening(options, alias, portOf(flags)) : undefined;
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
          const account = lookupName(config, 'account', view.alias);
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
            if (isExpired(bundle, context.now())) continue;
            identities.set(alias, await probeIdentity(bundle, deps.probe ? { fetch: deps.probe } : {}));
          }
        }
        const result = doctor({ config, now: context.now(), bundles, identities });
        if (!result.healthy) softExit = 78;
        writeResult(result, output(), () => renderDoctor(result, options.color), streams);
      }),
    );

  // ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────

  /*
   * One option on every read, for the same reason Gmail's commands take `--inbox`: there is no default workspace.
   * A machine with two of them would otherwise pick one, and a person reading the output could not tell which.
   */
  const workspaceOption = (command: Command): Command =>
    command.requiredOption('--workspace <name>', 'which workspace to read, as `organisation/slack`');

  const session = (context: SlackContext, alias: string) =>
    openWorkspace(context, alias, { fetch: deps.read, baseUrl: deps.slackBaseUrl });

  workspaceOption(program.command('channels'))
    .description('the channels and conversations this account can see')
    .option('--all', 'include channels this account is not a member of', false)
    .option('--limit <n>', 'how many to return', (value: string) => Number(value), 100)
    .action(
      act(async (context, options, flags: Options) => {
        const { call } = await session(context, String(flags.workspace));
        const result = await listChannels(call, { all: flags.all === true, limit: Number(flags.limit) });
        writeResult(result, output(), () => renderChannels(result, options.color), streams);
      }),
    );

  workspaceOption(program.command('read <channel>'))
    .description('a channel’s recent messages, newest first')
    .option('--limit <n>', 'how many messages', (value: string) => Number(value), 50)
    .option('--oldest <ts>', 'only messages at or after this Slack timestamp')
    .option('--latest <ts>', 'only messages at or before this Slack timestamp')
    .option('--cursor <cursor>', 'resume where an earlier, incomplete read stopped')
    .action(
      act(async (context, options, channel: string, flags: Options) => {
        const { call, name, teamId } = await session(context, String(flags.workspace));
        const result = await readChannel(call, name, channel, {
          limit: Number(flags.limit),
          oldest: flags.oldest as string | undefined,
          latest: flags.latest as string | undefined,
          cursor: flags.cursor as string | undefined,
          ourTeamId: teamId,
        });
        writeResult(result, output(), () => renderHistory(result, options.color), streams);
      }),
    );

  workspaceOption(program.command('thread <channel> <ts>'))
    .description('one thread, parent first')
    .option('--limit <n>', 'how many replies', (value: string) => Number(value), 100)
    .option('--cursor <cursor>', 'resume where an earlier, incomplete read stopped')
    .action(
      act(async (context, options, channel: string, ts: string, flags: Options) => {
        const { call, name, teamId } = await session(context, String(flags.workspace));
        const result = await readThread(call, name, channel, ts, {
          limit: Number(flags.limit),
          cursor: flags.cursor as string | undefined,
          ourTeamId: teamId,
        });
        writeResult(result, output(), () => renderThread(result, options.color), streams);
      }),
    );

  workspaceOption(program.command('search <query>'))
    .description('Slack’s own search, in Slack’s syntax, over this workspace')
    .option('--limit <n>', 'how many matches', (value: string) => Number(value), 20)
    .option('--page <n>', 'which page of results; `nextPage` in an incomplete result says which is next')
    .action(
      act(async (context, options, query: string, flags: Options) => {
        const { call, name } = await session(context, String(flags.workspace));
        const result = await searchMessages(call, name, query, {
          limit: Number(flags.limit),
          page: flags.page === undefined ? undefined : Number(flags.page),
        });
        writeResult(result, output(), () => renderSearch(result, options.color), streams);
      }),
    );

  workspaceOption(program.command('files'))
    .description('files shared in this workspace')
    .option('--channel <id>', 'only files in one channel')
    .option('--limit <n>', 'how many', (value: string) => Number(value), 50)
    .option('--page <n>', 'which page; an incomplete result says which is next')
    .action(
      act(async (context, options, flags: Options) => {
        const { call } = await session(context, String(flags.workspace));
        const result = await listFiles(call, {
          channel: flags.channel as string | undefined,
          limit: Number(flags.limit),
          page: flags.page === undefined ? undefined : Number(flags.page),
        });
        writeResult(result, output(), () => renderFiles(result, options.color), streams);
      }),
    );

  workspaceOption(program.command('people'))
    .description('the members of this workspace')
    .option('--limit <n>', 'how many', (value: string) => Number(value), 200)
    .action(
      act(async (context, options, flags: Options) => {
        const { call } = await session(context, String(flags.workspace));
        const result = await listPeople(call, { limit: Number(flags.limit) });
        writeResult(result, output(), () => renderPeople(result, options.color), streams);
      }),
    );

  // ── Drafting and posting ────────────────────────────────────────────────────────────────────────────────────

  /*
   * Everything the gate needs, assembled once.
   *
   * The audit sink and the surface go in here rather than at each call site: an operation that records what it
   * did in three places out of four is an operation whose log cannot be trusted, and the missing one is always
   * the interesting one.
   */
  const gateDeps = async (context: SlackContext, alias: string) => {
    const config = await context.config();
    const { alias: name, account } = requireWorkspace(config, alias);
    const { call, teamId } = await openWorkspace(context, name, { fetch: deps.read, baseUrl: deps.slackBaseUrl });
    return {
      call,
      accountId: account.id,
      workspaceId: teamId,
      workspaceName: name,
      postingAs: account.userId,
      policy: account.sendPolicy ?? config.defaults.sendPolicy,
      approvals: context.core.approvals,
      audit: context.core.audit,
      surface: 'cli' as const,
      permit: closedPermit(),
    };
  };

  /**
   * A draft, if it belongs to the workspace being asked about.
   *
   * Drafts are stored by id in one directory shared by every workspace, so without this a caller naming workspace
   * A could prepare and post workspace B's draft. Slack would probably refuse the channel id, which is luck
   * rather than a check — and on the two workspaces of one organisation that share channel ids, it would not.
   */
  const ownDraft = async (store: ReturnType<typeof openDraftStore>, accountId: string, draftId: string) => {
    const found = await store.get(draftId);
    if (found.accountId !== accountId) {
      throw new CommsError('NOT_FOUND', `no draft "${draftId}" in this workspace`, {
        hint: 'List this workspace’s drafts with `agent-slack draft list --workspace <name>`.',
      });
    }
    return found;
  };

  const draft = program.command('draft').description('compose and keep messages locally; nothing reaches Slack');

  workspaceOption(draft.command('create'))
    .description('write a draft. It lives on this machine — Slack has no server-side draft')
    .requiredOption('--channel <id>', 'the channel or conversation id')
    .requiredOption('--text <text>', 'what to say. Markup in it is shown, not interpreted')
    .option('--thread <ts>', 'reply inside this thread')
    .option('--mention <userId...>', 'mention someone, by id — a name is ambiguous')
    .option('--broadcast <who>', '`here`, `channel` or `everyone`; always needs a person to approve')
    .action(
      act(async (context, options, flags: Options) => {
        const { account } = requireWorkspace(await context.config(), String(flags.workspace));
        const mentions: Mention[] = [
          ...((flags.mention as string[] | undefined) ?? []).map((id) => ({ kind: 'user' as const, id })),
          ...(flags.broadcast
            ? [{ kind: 'broadcast' as const, who: String(flags.broadcast) as 'here' | 'channel' | 'everyone' }]
            : []),
        ];
        const store = openDraftStore(context.core.paths.stateDir, context.now);
        const created = await store.create(
          account.id,
          compose({
            channel: String(flags.channel),
            text: String(flags.text),
            threadTs: flags.thread as string | undefined,
            mentions,
          }),
          String(flags.text),
        );
        writeResult(
          created,
          output(),
          (data) =>
            `Draft ${data.draftId}. Nothing has reached Slack.\nPreview it with: agent-slack post prepare --workspace ${flags.workspace} --draft ${data.draftId}`,
          streams,
        );
      }),
    );

  workspaceOption(draft.command('list'))
    .description('the drafts held for this workspace')
    .action(
      act(async (context, options, flags: Options) => {
        const { account } = requireWorkspace(await context.config(), String(flags.workspace));
        const store = openDraftStore(context.core.paths.stateDir, context.now);
        const drafts = await store.list(account.id);
        writeResult(
          drafts,
          output(),
          (rows) =>
            rows.length === 0
              ? 'No drafts.'
              : rows.map((row) => `${row.draftId}  ${row.payload.channel}  ${row.source.slice(0, 60)}`).join('\n'),
          streams,
        );
      }),
    );

  workspaceOption(draft.command('delete <draftId>'))
    .description('throw a draft away')
    .action(
      act(async (context, _options, draftId: string, flags: Options) => {
        const { account } = requireWorkspace(await context.config(), String(flags.workspace));
        const store = openDraftStore(context.core.paths.stateDir, context.now);
        await ownDraft(store, account.id, draftId);
        await store.remove(draftId);
        writeResult({ draftId, deleted: true }, output(), () => `Deleted ${draftId}.`, streams);
      }),
    );

  const post = program.command('post').description('take a draft through the approval gate');

  workspaceOption(post.command('prepare'))
    .description('show what would be posted, and how many people it interrupts. Posts nothing')
    .requiredOption('--draft <draftId>', 'the draft to prepare')
    .action(
      act(async (context, options, flags: Options) => {
        const gate = await gateDeps(context, String(flags.workspace));
        const store = openDraftStore(context.core.paths.stateDir, context.now);
        const target = await ownDraft(store, gate.accountId, String(flags.draft));
        const prepared = await preparePost(gate, target, new NameBook());
        writeResult(prepared, output(), (data) => renderChannelPreview(data.preview), streams);
      }),
    );

  workspaceOption(post.command('send'))
    .description('post a prepared draft. Refuses unless the approval, the draft and the room are what they were')
    .requiredOption('--draft <draftId>', 'the draft')
    .requiredOption('--approval <approvalId>', 'the approval `post prepare` returned')
    .requiredOption('--expect-channel <id>', 'the channel you believe this goes to')
    .action(
      act(async (context, options, flags: Options) => {
        const gate = await gateDeps(context, String(flags.workspace));
        const store = openDraftStore(context.core.paths.stateDir, context.now);
        const target = await ownDraft(store, gate.accountId, String(flags.draft));
        const posted = await postPrepared(
          gate,
          target,
          String(flags.approval),
          String(flags.expectChannel),
          new NameBook(),
        );
        writeResult(posted, output(), (data) => `Posted to ${data.channel} at ${data.ts}.`, streams);
      }),
    );

  workspaceOption(program.command('react'))
    .description('add or remove a reaction. Behind the same gate, at lower ceremony')
    .requiredOption('--channel <id>', 'the channel')
    .requiredOption('--ts <ts>', 'the message timestamp')
    .requiredOption('--emoji <name>', 'the emoji name, without colons')
    .option('--remove', 'take one off instead', false)
    .action(
      act(async (context, options, flags: Options) => {
        const gate = await gateDeps(context, String(flags.workspace));
        const wanted = {
          channel: String(flags.channel),
          ts: String(flags.ts),
          name: String(flags.emoji),
          remove: flags.remove === true,
        };
        const prepared = await prepareReaction(gate, wanted);
        const done = await reactPrepared(gate, prepared.approvalId, wanted);
        writeResult(done, output(), () => `:${wanted.name}: on ${wanted.ts}.`, streams);
      }),
    );

  program
    .command('approve <approvalId>')
    .description('approve a post at this terminal: read it, then type the code back')
    .action(
      act(async (context, globalOptions, approvalId: string) => {
        /*
         * The one command an agent may not run for the user.
         *
         * A shell agent can defeat this — `script -q /dev/null` makes any command see a terminal — and this is a
         * speed bump against the ordinary case, not a boundary. The boundary for an agent with a shell is the
         * `never` policy, and a workspace installed in `read` mode, whose token cannot post at all.
         */
        const marker = agentMarker(env);
        if (marker) {
          throw new CommsError('APPROVAL_REQUIRED', 'only a person can approve a post, not an agent', {
            hint: `Ask the user to run \`agent-slack approve ${approvalId}\` in their own terminal.`,
            details: { marker },
          });
        }
        if (!canPrompt(env, streams, { json: globalOptions.json })) {
          throw new CommsError('APPROVAL_REQUIRED', 'approving a post needs an interactive terminal', {
            hint: `Run \`agent-slack approve ${approvalId}\` directly in a terminal.`,
          });
        }
        void (await workspaceForApproval(context, approvalId));
        const prompt = await beginApproval(context, approvalId);
        streams.stdout.write(`${prompt.preview}\n\n`);
        const answer = await askFor(streams, {
          question: `Type ${paint(globalOptions.color, 'bold', prompt.challenge)} to approve this, or press Enter to cancel: `,
        });
        if (!answer.trim()) {
          await revokeApproval(context, approvalId);
          streams.stdout.write('Cancelled. Nothing was posted.\n');
          return;
        }
        await finishApproval(context, approvalId, answer);
        streams.stdout.write('Approved. This command approves; it does not post.\n');
      }),
    );

  const mcp = program
    .command('mcp')
    .description('run the MCP server on stdio, for a coding agent to connect to')
    .option('--workspace <name>', 'pin the server to one workspace; every tool then acts on it and no other')
    .action(async (flags: Options) => {
      ran = true;
      const { startSlackStdioServer } = await import('../mcp/stdio-entry.ts');
      await startSlackStdioServer({
        env,
        ...(flags.workspace ? { workspace: String(flags.workspace) } : {}),
      });
    });

  mcp
    .command('install')
    .description('register this server with an MCP client, and prove it starts')
    .addOption(
      new Option('--client <client>', 'which client to register with').choices([
        'claude-code',
        'claude-desktop',
        'codex',
        'cursor',
        'gemini',
        'vscode',
        'json',
      ]),
    )
    .option('--name <name>', 'the name the client will show', 'slack')
    .option('--workspace <name>', 'pin the server to one workspace')
    .addOption(new Option('--launcher <launcher>', 'how the server is started').choices(['managed', 'npx', 'local']))
    .option('--no-verify', 'do not start the server to check the entry works')
    .option('--force', 'replace an entry of the same name — this is how you upgrade', false)
    .option('--print', 'only print what would be written', false)
    .action(
      act(async (context, options, flags: Options) => {
        /*
         * The parent's value counts too — see the note in the Gmail package, which had this bug shipped.
         *
         * `mcp` and `mcp install` both take `--workspace`, and Commander gives a repeated name to the parent, so
         * the subcommand's own option is always undefined and the pin is silently dropped.
         */
        const pinned = (flags.workspace ?? mcp.opts().workspace) as string | undefined;
        const { mcpInstall } = await import('../mcp/install.ts');
        const result = await mcpInstall(context, {
          client: (flags.client ?? 'claude-code') as Parameters<typeof mcpInstall>[1]['client'],
          name: flags.name as string | undefined,
          workspace: pinned,
          launcher: flags.launcher as 'managed' | 'npx' | 'local' | undefined,
          noVerify: flags.verify === false,
          apply: flags.print !== true,
          force: flags.force === true,
        });
        writeResult(result, output(), () => renderInstall(result, options.color), streams);
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
  /** The same gate for a workspace connected able to post from the start: no earlier mode, but the same risk. */
  async function confirmPosting(
    options: GlobalOptions,
    alias: string,
    ask: { command: string; prompt: string },
  ): Promise<LooseningConsent> {
    await requirePerson(env, streams, {
      refusedToAgent: `connecting "${alias}" able to post to Slack is not an agent's to do`,
      refusedWithoutTerminal: 'connecting a workspace that can post needs a terminal',
      command: ask.command,
      prompt: ask.prompt,
      color: options.color,
      json: globals().json,
      noInput: false,
    });
    return { kind: 'loosening-consent', paths: [`accounts.${alias}.mode`] };
  }

  async function confirmWidening(options: GlobalOptions, alias: string, port: number): Promise<LooseningConsent> {
    await requirePerson(env, streams, {
      refusedToAgent: `widening "${alias}" from read to send is not an agent's to do`,
      refusedWithoutTerminal: 'widening a workspace from read to send needs a terminal',
      // With the port: the command is copied as printed, and without one it is a usage error.
      command: `agent-slack workspace reauth ${alias} --mode send --port ${port}`,
      prompt: `This replaces "${alias}"'s token with one that can post to Slack (read → send).`,
      color: options.color,
      json: globals().json,
      noInput: false,
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
      /**
       * Proof a person typed a challenge to widen this workspace.
       *
       * Declared here because leaving it out did not fail to compile: the caller passed it, this signature
       * ignored it, and the consent was dropped between the two. `ConfigStore.update` then refused every
       * approved widening, so the gate stopped meaning "a person must approve this" and started meaning "this
       * can never happen" — while every refusal test went on passing.
       */
      consent?: LooseningConsent | undefined;
    },
  ): Promise<void> {
    const started: StartedSignIn = await startSignIn(context, {
      alias: input.alias,
      mode: input.mode,
      clientId: input.clientId,
      port: input.port,
      detached: input.start,
      ...(input.expect ? { expect: input.expect } : {}),
      ...(input.consent ? { consent: input.consent } : {}),
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
