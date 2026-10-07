import {
  agentMarker,
  answerDownloadAtTerminal,
  approvalsOf,
  approveChangeAtTerminal,
  approveRefusedHint,
  CommsError,
  canPrompt,
  cliHandoffs,
  colorEnabled,
  commandPathOf,
  DOWNLOAD_CLAIM,
  downloadAtTerminal,
  EXIT_CODES,
  exemptFromUpdateGate,
  type GatedChange,
  gatedChangeAtTerminal,
  handoffSentence,
  installExitStatus,
  integrityRefusal,
  kindOf,
  MAX_WAIT_SECONDS,
  type OutputOptions,
  openCore,
  PATH_OPTIONS,
  paint,
  pathOverridesFromCliOptions,
  personAtTerminal,
  refuseRetiredOut,
  refuseUnclaimedApproval,
  renderApprovalWait,
  renderChannelPreview,
  renderPrune,
  resolvePaths,
  runCommand,
  runUpdateCheckChild,
  type Streams,
  serverInstallChange,
  serverPruneChange,
  terminalUpdateHooks,
  UPDATE_CHECK_CHILD_COMMAND,
  updateGateAtTerminal,
  waitForApproval,
  wholeNumber,
  writeError,
  writeResult,
} from '@agentcomms/core';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import type { FetchLike } from '../api/guard.ts';
import { exitAfterRefreshes, type SignalHost, settleBeforeExit } from '../auth/exit.ts';
import { SLACK_CALLER } from '../caller.ts';
import { BROADCASTS } from '../compose/blocks.ts';
import { openDraftStore } from '../compose/drafts.ts';
import { SlackContext, type SlackContextOptions } from '../context.ts';
import { handoffsSentence } from '../handoffs.ts';
import { type InstallMode, parseMode, renderManifest } from '../manifest.ts';
import { SLACK_MCP, type SupportedClient } from '../mcp/install.ts';
import { renderDeletionPreview } from '../operations/amend.ts';
import { createApp, updateApp } from '../operations/app.ts';
import { beginApproval, finishApproval, revokeApproval, workspaceForApproval } from '../operations/approve.ts';
import {
  connectWorkspace,
  planModeSet,
  policyApprovalRefusal,
  policyChange,
  policyReport,
  policyWanted,
  reauthWorkspace,
  removeWorkspaceChange,
  signInStarted,
} from '../operations/changes.ts';
import { runDoctor } from '../operations/doctor.ts';
import { createDraft, deleteOwnDraft, listDrafts, showDraft, updateDraft } from '../operations/drafts.ts';
import {
  downloadFiles,
  downloadSelection,
  type FileDownloader,
  type FileDownloadQuestion,
  type FileDownloadResult,
} from '../operations/files.ts';
import type { ProbeFetch } from '../operations/identity.ts';
import { checkedPort, manifestFor } from '../operations/manifest.ts';
import {
  prepareDelete,
  prepareDraftPost,
  prepareEdit,
  react,
  sendDelete,
  sendEdit,
  sendPost,
} from '../operations/post.ts';
import {
  filesPaging,
  listChannels,
  listFiles,
  listPeople,
  readChannel,
  readThread,
  searchMessages,
  searchPaging,
} from '../operations/read.ts';
import { openWorkspace } from '../operations/session.ts';
import { finishSignIn, type ListenerEntry, runSignInListener, type StartedSignIn } from '../operations/signin.ts';
import { checkAliasFree, listWorkspaces, requireWorkspace, showWorkspace } from '../operations/workspaces.ts';
import { VERSION } from '../version.ts';
import { openInBrowser } from './browser.ts';
import { readConfigurationToken } from './config-token.ts';
import { askFor } from './prompt.ts';
import {
  renderAppCreated,
  renderAppUpdated,
  renderAppUpdateNeeded,
  renderChanged,
  renderChannels,
  renderConnected,
  renderCreatedDraft,
  renderDeletedDraft,
  renderDoctor,
  renderDraft,
  renderDrafts,
  renderFileDownload,
  renderFileDownloadQuestion,
  renderFiles,
  renderHistory,
  renderInstall,
  renderManifestHelp,
  renderMode,
  renderPeople,
  renderPolicies,
  renderPosted,
  renderRemoved,
  renderSearch,
  renderSignInStarted,
  renderSteps,
  renderThread,
  renderUpdatedDraft,
  renderWorkspace,
  renderWorkspaces,
} from './render.ts';

/**
 * The `agent-slack` command.
 *
 * Make an app, connect a workspace, see what is connected, be told what is broken; read channels, threads,
 * search, people and files; and draft, prepare and — with a person's approval at a terminal — post and react.
 *
 * Both a person and an agent run this, so every command prints a readable summary by default and the whole result
 * under `--json`, with the same exit codes either way.
 */

export interface CliDeps extends SlackContextOptions {
  streams?: Streams;
  platform?: NodeJS.Platform | undefined;
  /** Starts the stdio server. Injected so a test can inspect its inputs without opening stdio. */
  startMcp?: ((options: import('../mcp/server.ts').SlackMcpOptions) => Promise<void>) | undefined;
  /** Command used to start the detached sign-in listener; the tests point it at the source entry. */
  listenerCommand?: ListenerEntry;
  /** Opens the browser. Injected so a test does not. */
  openBrowser?: (url: string) => unknown;
  /** The fetch `doctor` asks Slack with. Injected so a test never reaches the real one. */
  probe?: ProbeFetch;
  /** The fetch the read commands use. Injected the same way, and for the same reason. */
  read?: FetchLike;
  /**
   * What `files download` fetches a file's bytes with: the guarded transport when left out. Injected so a test saves
   * files without anything being fetched.
   */
  fileDownload?: FileDownloader;
  /**
   * The fetch `app update` and `app create` use. Its own, not `read`'s: these calls change an app, carry a
   * configuration token rather than a workspace's, and a test that scripts one should not be able to answer the other.
   */
  appConfig?: FetchLike;
  /** Where Slack is, for a test that stands one up locally rather than relaxing the origin check. */
  slackBaseUrl?: string;
  /**
   * Where the hold on SIGINT and SIGTERM listens and sends the signal back once it is done, and how it exits where
   * that does not end the process. Injected so a test is not killed by it.
   */
  signals?: { host: SignalHost; exit(code: number): void };
}

interface GlobalOptions {
  json: boolean;
  color: boolean;
}

type Options = Record<string, unknown>;

/**
 * A usage error with the value of any `--option=value` it quotes taken out.
 *
 * Commander quotes an unknown `--option=value` back whole, value and all. No option here takes a secret, but somebody
 * will try `--token=…` on `app update`, and the refusal must not print the token it refuses. The option's name is
 * enough to say what was wrong.
 */
function withoutOptionValues(text: string): string {
  return text.replace(/'(-{1,2}[^'=\s]+)=[^']*'/g, "'$1=…'");
}

/**
 * `--finish` collects a sign-in already started, and claims nothing: the approval a widening needs is claimed where
 * the sign-in starts, before its link exists. One given with it is refused rather than dropped — the update check's
 * stop had let the command past on it — as core's `refuseUnclaimedApproval` says.
 */
const FINISH_TAKES_NO_APPROVAL = {
  message: '--finish collects a sign-in already started, so it takes no --approval',
  hint: 'An approval is claimed where the sign-in starts, and finishing it needs none: run the same command again without --approval.',
} as const;

export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const streams: Streams = deps.streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
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
    .description(
      'Slack for coding agents: connect a workspace, read it, and draft posts that go out only when a person approves them.',
    )
    .version(VERSION, '-v, --version')
    .option('--json', 'print the result as {"ok":true,"schemaVersion":1,"data":…}', false)
    .option('--no-color', 'never colour the output')
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
      // Commander prints its own copy of a usage error before throwing it; that copy is redacted too.
      outputError: (text, write) => write(withoutOptionValues(text)),
    })
    .addHelpText(
      'after',
      `
Getting started — run these with this CLI:
  manifest --port 51234        the app to create in Slack, and how
  app create --port 51234      or create it from here, with an app configuration token
  workspace add acme/slack --client-id <id> --port 51234
  doctor                       what works and what does not
  mcp install --client claude-code
  channels --workspace acme/slack
  read <channel> --workspace acme/slack

Exit codes: 0 ok · 1 unexpected · 10 a post or a change was refused or needs approval, or a
sign-in is still waiting · 11 an update is out: update first, or put it off, with the commands
it names · 64 usage · 65 bad data · 66 not found · 69 provider or secret store unavailable · 75
temporary (retry later) · 77 sign-in or permission needed · 78 configuration problem.`,
    )
    .exitOverride();

  for (const { flag } of PATH_OPTIONS) {
    program.addOption(
      new Option(`${flag} <dir>`, 'pin this suite directory for this run').argParser((value) => {
        if (value.length === 0) throw new InvalidArgumentError(`${flag} needs a non-empty directory`);
        return value;
      }),
    );
  }

  let invocationCore: ReturnType<typeof openCore> | undefined;
  const coreForInvocation = (): ReturnType<typeof openCore> => {
    if (invocationCore) return invocationCore;
    const options = program.opts();
    const pathOverrides = pathOverridesFromCliOptions(
      Object.fromEntries(PATH_OPTIONS.map(({ key, option }) => [option, options[key] as string | undefined])),
    );
    // With this package's caller, so every command it prints is this installation's own, located.
    invocationCore =
      Object.keys(pathOverrides).length === 0 && deps.core
        ? deps.core
        : openCore({ env, platform, pathOverrides, caller: SLACK_CALLER });
    return invocationCore;
  };

  /*
   * This installation's own help, for a usage error before the folders are known: it reads none of them, so none is
   * pinned, and a path option that would not parse cannot stop it being named.
   */
  const help = cliHandoffs({ caller: SLACK_CALLER, paths: resolvePaths({ env, platform }), platform, env }).own(
    ['--help'],
    { uses: [] },
  );

  const globals = (): GlobalOptions => {
    const options = program.opts();
    return {
      json: Boolean(options.json),
      color: colorEnabled(env, streams.stdout, options.color as boolean | undefined),
    };
  };
  const output = (): OutputOptions => ({ json: globals().json, color: globals().color, platform });

  /**
   * A command that succeeded but wants a non-zero exit code — `doctor` finding something broken, where the
   * findings *are* the output and the envelope must still be the normal one. Throwing instead would print a
   * second envelope after the first, and `--json` promises exactly one document on stdout.
   */
  let softExit: number | null = null;

  /*
   * The daily update check (design 2026-09-28 §3), before any command but the exempt ones: an update that is out
   * stops it — a person at a terminal is asked "Update now, later today, or cancel?", anything else ends with
   * UPDATE_REQUIRED (exit 11). A hook on the program, so a command added later is gated by being a command at all;
   * `act` ends with the exit status it decided, when it decided one.
   */
  let gated: number | null = null;
  program.hook('preAction', async (_program, command) => {
    const path = commandPathOf(command);
    // `sign-in-listen` too: it is the listener a sign-in started, not a command anybody types, and stopping it would
    // break the sign-in the person is in the middle of. So is the update check a command handed on (#48).
    if (exemptFromUpdateGate(path, ['sign-in-listen', UPDATE_CHECK_CHILD_COMMAND])) return;
    const core = coreForInvocation();
    let ended: number | null = null;
    const code = await runCommand(
      output(),
      async () => {
        ended = await updateGateAtTerminal({
          core,
          env,
          binary: 'agent-slack',
          channel: 'slack',
          running: VERSION,
          output: output(),
          noInput: false,
          streams,
          approvals: approvalsOf(command),
          // A download's `--choice` is the question the person just answered: held to that kind, as the tool's is.
          // A wait only looks: it answers while an update is out, for any approval this machine can read (decision 7).
          approvalClaim:
            path.join(' ') === 'files download'
              ? DOWNLOAD_CLAIM
              : path.join(' ') === 'approval wait'
                ? { lookup: true }
                : undefined,
          ...terminalUpdateHooks(core, env, { channel: 'slack', output: output(), streams }),
        });
      },
      streams,
    );
    gated = code !== 0 ? code : ended;
  });

  const act =
    <A extends unknown[]>(body: (context: SlackContext, options: GlobalOptions, ...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      ran = true;
      softExit = null;
      if (gated !== null) {
        exitCode = gated;
        return;
      }
      const interrupted = new AbortController();
      let foreground: { flowId: string; settled: Promise<unknown> } | undefined;
      const context = new SlackContext({
        ...deps,
        core: coreForInvocation(),
        env,
        pathOverrides: coreForInvocation().pathOverrides,
        surface: 'cli',
        foregroundSignIn: {
          signal: interrupted.signal,
          register: (flowId, settled) => {
            foreground = { flowId, settled };
          },
        },
      });
      /*
       * Any command that reads may refresh a token, and the MCP server's two protections apply here for the same
       * reason: Ctrl-C between Slack's reply and the write would lose the renewed token, and a token kept because
       * the store failed is never written if the process simply ends — a command has no next call. So the command
       * runs under the same signal hold, and before it returns, one more attempt is made to write down what it is
       * holding, with a line on stderr naming the workspace if that fails too.
       */
      const release = exitAfterRefreshes({
        ...deps.signals,
        stderr: streams.stderr,
        beforeExit: async () => {
          interrupted.abort();
          if (foreground) {
            // Startup and any accepted callback must finish, including staged-secret withdrawal, before exit.
            const error = await foreground.settled;
            if (
              error instanceof CommsError &&
              (error.details?.strandedSecretRef || error.details?.possiblyStrandedSecretRef)
            ) {
              // Cancellation itself is silent. A credential we could not safely withdraw is not: the person
              // needs its reference before signal redelivery, even when the command requested JSON output.
              writeError(error, { json: false, color: false }, streams);
            }
            await context.flows.discard(foreground.flowId);
          }
        },
      });
      try {
        exitCode = await runCommand(
          output(),
          async () => {
            try {
              await body(context, globals(), ...args);
            } catch (error) {
              if (!interrupted.signal.aborted) throw error;
              // The signal handler owns exit. Do not render a cancellation error while it settles owned state.
              await new Promise<void>(() => {});
            }
          },
          streams,
        );
        await settleBeforeExit(streams.stderr);
      } finally {
        release();
      }
      if (exitCode === 0 && softExit !== null) exitCode = softExit;
    };

  const modeOption = (): Option =>
    new Option('--mode <mode>', 'how much access to ask Slack for').choices(['read', 'send']).default('read');

  /** `--port`, else the port the workspace last signed in with, which is the one its app's redirect names. */
  const portOf = (flags: Options, recorded?: number): number => checkedPort(flags.port, recorded);

  /**
   * `--limit` on `channels`, `read`, `thread` and `people`, checked as the MCP tools check it: a whole number from 1.
   *
   * It was `Number(value)` in Commander's parser, so `--limit abc` became `NaN`, was sent to Slack as `limit=NaN`, and
   * came back `ok` — a result bounded by whatever Slack made of that, reported as if it were the bound asked for. The
   * same input over MCP was refused by the schema. And `Number` still read `1e2` as 100 and `0x10` as 16, so digits
   * are all core's `wholeNumber` takes. Checked here rather than in Commander's parser because a parser that throws
   * escapes the envelope, and `--json` promises exactly one document. `search` and `files` hand theirs, and `--page`,
   * to the operation as typed: those have a most, and the operation checks it for the tool as well.
   *
   * It always has a default, so it is never absent by the time a command reads it.
   */
  const limitOf = (flags: Options): number => wholeNumber(flags.limit, { name: '--limit', min: 1 }) as number;

  // ── manifest ────────────────────────────────────────────────────────────────────────────────────────────────

  program
    .command('manifest')
    .description('the Slack app to create, as a manifest you can paste')
    .addOption(modeOption())
    .option('--port <port>', 'the loopback port its redirect will use')
    .option('--workspace <name>', 'for a workspace already connected: its port, and the link to its own app')
    .action(
      act(async (context, options, flags: Options) => {
        // The same operation as `slack_manifest`, port check and all: see `manifestFor`.
        const result = await manifestFor(context, {
          mode: String(flags.mode) as InstallMode,
          port: flags.port,
          workspace: flags.workspace === undefined ? undefined : String(flags.workspace),
        });
        writeResult(
          result,
          output(),
          (data) =>
            `${renderManifestHelp(data.mode, data.port, options.color, data, context.handoffs)}\n\n${renderManifest(data.mode, data.redirectUrl)}`,
          streams,
        );
      }),
    );

  // ── app ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /*
   * The optional path beside `manifest`: the same manifest, sent to Slack from here with an app configuration token,
   * so connecting or widening a workspace needs no visit to the app's page.
   *
   * The token comes from a hidden prompt or `SLACK_APP_CONFIG_TOKEN` and nowhere else — no option takes it, because a
   * command line lands in shell history — and there is no MCP tool for either command, because a token typed into a
   * chat stays in the transcript. Neither command writes anything to this machine's configuration.
   */
  const app = program
    .command('app')
    .description('change the Slack app itself with an app configuration token, instead of on the api.slack.com page');

  app
    .command('update <alias>')
    .description("replace a connected workspace's Slack app manifest with the one the `manifest` command prints")
    .addOption(
      new Option('--mode <mode>', "which manifest to apply; the workspace's own mode if left out").choices([
        'read',
        'send',
      ]),
    )
    .option('--port <port>', "the loopback port for the app's redirect; the workspace's recorded one if left out")
    .action(
      act(async (context, options, alias: string, flags: Options) => {
        const found = requireWorkspace(await context.config(), alias, context.handoffs);
        const mode =
          flags.mode === undefined
            ? parseMode(found.account.mode ?? found.account.tier, `"${found.alias}"`)
            : (String(flags.mode) as InstallMode);
        const port = portOf(flags, found.account.redirectPort);
        const result = await updateApp({
          alias: found.alias,
          account: found.account,
          mode,
          port,
          askToken: async () => {
            /*
             * Said before the token is asked for, because Slack's update replaces the app's whole configuration: an
             * app somebody renamed by hand comes back as `agent-slack`, and the person should know before typing.
             */
            streams.stderr.write(
              `This replaces the whole configuration of Slack app ${found.account.appId ?? ''} ("${found.alias}") with the ${mode} manifest — its name and description included.\n`,
            );
            return readConfigurationToken(env, streams, {
              json: globals().json,
              command: context.handoffs.own(['app', 'update', found.alias, '--mode', mode, '--port', String(port)]),
            });
          },
          transport: { fetch: deps.appConfig, baseUrl: deps.slackBaseUrl },
          audit: context.core.audit,
          surface: 'cli',
          handoffs: context.handoffs,
        });
        writeResult(result, output(), () => renderAppUpdated(result, options.color), streams);
      }),
    );

  app
    .command('create [alias]')
    .description(
      'create a new Slack app from the manifest the `manifest` command prints, and print the command that connects it',
    )
    .addOption(modeOption())
    .option('--port <port>', 'the loopback port its redirect will use')
    .action(
      act(async (context, options, alias: string | undefined, flags: Options) => {
        const mode = String(flags.mode) as InstallMode;
        const port = portOf(flags);
        // The name is only printed, in the command to run next — but a name that command would refuse is better
        // refused now, before a token is typed and an app is made.
        if (alias !== undefined) checkAliasFree(await context.config(), alias, context.handoffs);
        const result = await createApp({
          mode,
          port,
          ...(alias === undefined ? {} : { alias }),
          askToken: () =>
            readConfigurationToken(env, streams, {
              json: globals().json,
              command: context.handoffs.own([
                'app',
                'create',
                ...(alias === undefined ? [] : [alias]),
                '--mode',
                mode,
                '--port',
                String(port),
              ]),
            }),
          transport: { fetch: deps.appConfig, baseUrl: deps.slackBaseUrl },
          audit: context.core.audit,
          surface: 'cli',
          handoffs: context.handoffs,
        });
        writeResult(result, output(), () => renderAppCreated(result, options.color), streams);
      }),
    );

  // ── workspace ───────────────────────────────────────────────────────────────────────────────────────────────

  const workspace = program.command('workspace').description('connect, inspect and disconnect Slack workspaces');

  const signInOptions = (command: Command, mode: Option = modeOption()): Command =>
    command
      .addOption(mode)
      .option('--port <port>', 'for your own app, the loopback port in its manifest; a profile uses its recorded port')
      .option('--start', 'print the link and return, instead of waiting', false)
      .option('--finish <flowId>', 'complete a sign-in started with --start')
      .option('--wait <seconds>', 'with --finish, how long to wait for the browser', '60')
      .option('--url <url>', 'with --finish, the address-bar URL, pasted back by hand')
      .option('--no-browser', 'print the link instead of opening it');

  /** Every command that changes a workspace takes the approval a person gave for it, so an agent can finish the job. */
  const approvalOption = (command: Command): Command =>
    command.option(
      '--approval <approvalId>',
      'apply a change a person approved: said yes to in chat, or approved at a terminal with `approve`',
    );

  /**
   * Runs a change the way every changing command and tool does — core's `gatedChangeAtTerminal`.
   *
   * With `--approval` it claims that approval. Without one, a person at a terminal approves there and then (a yes, or
   * the typed code under `confirm`), and an agent or a script gets the preview and the approval id and exits 10, as a
   * post waiting for approval does. This replaced a typed challenge that refused agents outright: since 2026-09-25 an
   * agent may make these changes, once a person has approved each one.
   */
  const changeAt = <T>(
    context: SlackContext,
    change: GatedChange<T>,
    flags: Options,
    /** This command's words after the program, run again with `--approval <id>`: located by core from Slack's caller. */
    rerun: readonly string[],
  ): Promise<T> =>
    gatedChangeAtTerminal(context.core, change, {
      channel: 'slack',
      approvalId: flags.approval === undefined ? undefined : String(flags.approval),
      env,
      output: output(),
      rerun,
      streams,
    });

  /** The parts of a command line that were given, for the command an agent is told to run again. */
  const given = (flags: Options, names: readonly ('port' | 'start')[]): string[] =>
    names.flatMap((name) => {
      if (name === 'start') return flags.start === true ? ['--start'] : [];
      return flags.port === undefined ? [] : ['--port', String(flags.port)];
    });

  approvalOption(
    signInOptions(workspace.command('add [alias]'))
      .description(
        'connect through the named organisation profile’s read app, or send app with --mode send; an own app uses --client-id and --port',
      )
      .option('--client-id <id>', 'use your own app’s Client ID; also requires --port'),
  ).action(
    act(async (context, options, alias: string | undefined, flags: Options) => {
      if (flags.finish) {
        refuseUnclaimedApproval(flags.approval, FINISH_TAKES_NO_APPROVAL);
        const view = await finishSignIn(context, {
          flowId: String(flags.finish),
          only: 'add',
          // Optional here, so bound only when it was given rather than invented from the flow.
          ...(alias ? { expectAlias: alias } : {}),
          ...(flags.url ? { url: String(flags.url) } : {}),
          // Checked in `finishSignIn`, as `slack_workspace_finish` is: see `checkedWait`.
          waitSeconds: flags.wait,
        });
        writeResult(view, output(), () => renderConnected(view, false, options.color, context.handoffs), streams);
        return;
      }
      if (!alias) {
        throw new CommsError('USAGE', 'a name for the workspace is needed', {
          hint: handoffsSentence(
            [
              context.handoffs.own(['workspace', 'add', 'acme/slack']),
              context.handoffs.own(['workspace', 'add', 'acme/slack', '--client-id', '<id>', '--port', '51234']),
            ],
            ([profile, own]) => `e.g. ${profile}, or use your own app with ${own}.`,
            'Name it as organisation/slack, e.g. acme/slack.',
          ),
        });
      }
      const mode = String(flags.mode) as InstallMode;
      // The same operation as `slack_workspace_add`: in send mode, a change approved before the sign-in starts.
      const started = await changeAt(
        context,
        connectWorkspace(context, {
          alias,
          mode,
          clientId: flags.clientId === undefined ? undefined : String(flags.clientId),
          port: flags.port,
          detached: flags.start === true,
          listenerCommand: deps.listenerCommand,
        }),
        flags,
        [
          'workspace',
          'add',
          alias,
          '--mode',
          mode,
          ...(flags.clientId === undefined ? [] : ['--client-id', String(flags.clientId)]),
          ...given(flags, ['port', 'start']),
        ],
      );
      await presentSignIn(context, started, false, options, {
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
        writeResult(workspaces, output(), () => renderWorkspaces(workspaces, options.color, context.handoffs), streams);
      }),
    );

  workspace
    .command('show <alias>')
    .description('everything known about one workspace')
    .action(
      act(async (context, options, alias: string) => {
        const view = showWorkspace(await context.config(), alias, context.handoffs);
        writeResult(view, output(), () => renderWorkspace(view, options.color), streams);
      }),
    );

  /*
   * The mode, and moving it — one command for what `show`, `reauth` and the Slack admin pages each hold part of.
   *
   * Reporting is anybody's. `send` is the widening under a name people look for: the app step first, while nothing
   * shows the app has been widened, then a change approved before its sign-in starts. `read` changes nothing: Slack
   * cannot take a scope back from a token, only removing the app's installation resets it, and that is in Slack's
   * settings — so this says exactly how, in the order that keeps the workspace's name.
   */
  approvalOption(
    workspace
      .command('mode <alias> [mode]')
      .description(
        'report access or move a profile account between organisation apps; own-app accounts use the manifest/update or removal procedure',
      )
      .option('--port <port>', 'for your own app, the loopback port in its manifest; a profile uses its recorded port')
      .option('--app-updated', 'for your own app with send: its manifest already asks for the send scopes', false)
      .option('--start', 'print the sign-in link and return, instead of waiting', false)
      .option('--no-browser', 'print the link instead of opening it'),
  ).action(
    act(async (context, options, alias: string, target: string | undefined, flags: Options) => {
      // The same operation as `slack_mode_set`: see `planModeSet` for what each direction does.
      const planned = await planModeSet(context, alias, target, {
        port: flags.port,
        appUpdated: flags.appUpdated === true,
        detached: flags.start === true,
        listenerCommand: deps.listenerCommand,
        // Claimed by the widening; refused by the report, the steps and the app step, in `planModeSet` itself.
        approvalId: flags.approval,
      });
      switch (planned.kind) {
        case 'report':
          writeResult(planned.report, output(), () => renderMode(planned.report, options.color), streams);
          return;
        case 'steps':
          writeResult(
            planned.result,
            output(),
            () =>
              renderSteps(
                `Slack cannot take posting away from "${planned.result.alias}"'s token. Removing the app's installation does:`,
                planned.result.steps,
                options.color,
              ),
            streams,
          );
          return;
        case 'app-update-needed':
          writeResult(
            planned.result,
            output(),
            () => renderAppUpdateNeeded(planned.result, options.color, context.handoffs),
            streams,
          );
          return;
        case 'change': {
          const started = await changeAt(context, planned.change, flags, [
            'workspace',
            'mode',
            alias,
            'send',
            ...(flags.appUpdated === true ? ['--app-updated'] : []),
            ...given(flags, ['port', 'start']),
          ]);
          await presentSignIn(context, started, true, options, {
            start: flags.start === true,
            browser: flags.browser !== false,
          });
        }
      }
    }),
  );

  approvalOption(
    workspace
      .command('remove <alias>')
      .description('disconnect a workspace from this machine, once a person approves it'),
  ).action(
    act(async (context, _options, alias: string, flags: Options) => {
      // The same operation as `slack_workspace_remove`: approved, because a deleted token cannot be taken back.
      const removed = await changeAt(context, removeWorkspaceChange(context, alias), flags, [
        'workspace',
        'remove',
        alias,
      ]);
      writeResult(removed, output(), () => renderRemoved(removed, context.handoffs), streams);
    }),
  );

  approvalOption(
    signInOptions(
      workspace.command('reauth <alias>'),
      /*
       * No default, and the help says what an absent `--mode` means: the workspace's own mode, not `read`.
       *
       * It used to share `add`'s option, default `read` and all, so `--help` (and the reference page generated from
       * it) promised a downgrade the command has never made — it asked Commander where the value came from instead.
       */
      new Option('--mode <mode>', 'how much access to ask Slack for; its own mode when left out').choices([
        'read',
        'send',
      ]),
    ).description('sign in again: renew the grant, or change how much access it has'),
  ).action(
    act(async (context, options, alias: string, flags: Options) => {
      if (flags.finish) {
        refuseUnclaimedApproval(flags.approval, FINISH_TAKES_NO_APPROVAL);
        const view = await finishSignIn(context, {
          flowId: String(flags.finish),
          only: 'reauth',
          // The caller named a workspace; a flow id names one too, and they have to be the same one.
          expectAlias: alias,
          ...(flags.url ? { url: String(flags.url) } : {}),
          // Checked in `finishSignIn`, as `slack_workspace_finish` is: see `checkedWait`.
          waitSeconds: flags.wait,
        });
        writeResult(view, output(), () => renderConnected(view, true, options.color, context.handoffs), streams);
        return;
      }
      /*
       * The workspace's own mode when `--mode` is not given, not `read`: renewing a `send` workspace's grant must not
       * quietly downgrade it, which is the opposite of what "the same, again" means.
       */
      const mode = flags.mode === undefined ? undefined : (String(flags.mode) as InstallMode);
      // The same operation as `slack_workspace_reauth`: a widening is approved before its sign-in starts.
      const started = await changeAt(
        context,
        reauthWorkspace(context, {
          alias,
          mode,
          port: flags.port,
          detached: flags.start === true,
          listenerCommand: deps.listenerCommand,
        }),
        flags,
        [
          'workspace',
          'reauth',
          alias,
          ...(mode === undefined ? [] : ['--mode', mode]),
          ...given(flags, ['port', 'start']),
        ],
      );
      await presentSignIn(context, started, true, options, {
        start: flags.start === true,
        browser: flags.browser !== false,
      });
    }),
  );

  /*
   * How posting and changes to a workspace are approved.
   *
   * With neither option it reports. Tightening applies at once; loosening — a send policy towards `chat`, a change
   * policy from `confirm` to `chat` — is a change approval, decided by the change policy in force before it.
   */
  approvalOption(
    workspace
      .command('policy <alias>')
      .description('how its posts and its changes are approved: report them, or set --send and --change')
      .option('--send <policy>', 'how a post or reaction is approved: chat, confirm or never')
      .option('--change <policy>', 'how a change that loosens or removes it is approved: chat or confirm'),
  ).action(
    act(async (context, options, alias: string, flags: Options) => {
      // The same operation as `slack_workspace_policy`, checks and all.
      const wanted = policyWanted({ send: flags.send, change: flags.change });
      const reporting = wanted.send === undefined && wanted.change === undefined;
      if (reporting) refuseUnclaimedApproval(flags.approval, policyApprovalRefusal('cli'));
      const result = reporting
        ? policyReport(await context.config(), alias, context.handoffs)
        : await changeAt(context, policyChange(context, alias, wanted), flags, [
            'workspace',
            'policy',
            alias,
            ...(wanted.send ? ['--send', wanted.send] : []),
            ...(wanted.change ? ['--change', wanted.change] : []),
          ]);
      writeResult(result, output(), () => renderPolicies(result, options.color), streams);
    }),
  );

  // ── doctor ──────────────────────────────────────────────────────────────────────────────────────────────────

  program
    .command('doctor')
    .description('check everything that has to work, and say how to fix what does not')
    .option('--offline', 'do not ask Slack anything; report only what the files say', false)
    .option('--workspace <name>', 'check only this workspace')
    .action(
      act(async (context, options, flags: Options) => {
        // The same reading and the same verdict as `slack_doctor`: see `runDoctor`.
        const result = await runDoctor(context, {
          offline: flags.offline === true,
          workspace: flags.workspace === undefined ? undefined : String(flags.workspace),
          probe: deps.probe,
        });
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
    command.requiredOption('--workspace <name>', 'which workspace, as `organisation/slack`');

  const session = (context: SlackContext, alias: string) =>
    openWorkspace(context, alias, { fetch: deps.read, baseUrl: deps.slackBaseUrl });

  workspaceOption(program.command('channels'))
    .description('the channels and conversations this account can see')
    .option('--all', 'include channels this account is not a member of', false)
    .option('--limit <n>', 'how many to return', '100')
    .action(
      act(async (context, options, flags: Options) => {
        const { call } = await session(context, String(flags.workspace));
        const result = await listChannels(call, { all: flags.all === true, limit: limitOf(flags) });
        writeResult(
          result,
          output(),
          () => renderChannels(result, options.color, context.handoffs, String(flags.workspace)),
          streams,
        );
      }),
    );

  workspaceOption(program.command('read <channel>'))
    .description('a channel’s recent messages, newest first')
    .option('--limit <n>', 'how many messages', '50')
    .option('--oldest <ts>', 'only messages at or after this Slack timestamp')
    .option('--latest <ts>', 'only messages at or before this Slack timestamp')
    .option('--cursor <cursor>', 'resume where an earlier, incomplete read stopped')
    .action(
      act(async (context, options, channel: string, flags: Options) => {
        const { call, name, teamId } = await session(context, String(flags.workspace));
        const result = await readChannel(call, name, channel, {
          limit: limitOf(flags),
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
    .option('--limit <n>', 'how many replies', '100')
    .option('--cursor <cursor>', 'resume where an earlier, incomplete read stopped')
    .action(
      act(async (context, options, channel: string, ts: string, flags: Options) => {
        const { call, name, teamId } = await session(context, String(flags.workspace));
        const result = await readThread(call, name, channel, ts, {
          limit: limitOf(flags),
          cursor: flags.cursor as string | undefined,
          ourTeamId: teamId,
        });
        writeResult(result, output(), () => renderThread(result, options.color), streams);
      }),
    );

  workspaceOption(program.command('search <query>'))
    .description('Slack’s own search, in Slack’s syntax, over this workspace')
    .option('--limit <n>', 'how many matches: 1 to 100, one page of results', '20')
    .option('--page <n>', 'which page of results; `nextPage` in an incomplete result says which is next')
    .action(
      act(async (context, options, query: string, flags: Options) => {
        // As typed, and checked before the workspace is opened: opening it reads the secret store and may renew a
        // token with Slack, which a refusal of the number alone should not cost — see `searchPaging`. `slack_search`
        // checks them the same way.
        const { limit, page } = searchPaging({ limit: flags.limit, page: flags.page, surface: context.surface });
        // `teamId` too, as `read` and `thread` pass it: without it an author from another organisation was not
        // marked `external` here, while the same search over MCP marked them — one message, two answers.
        const { call, name, teamId } = await session(context, String(flags.workspace));
        const result = await searchMessages(call, name, query, {
          limit,
          page,
          ourTeamId: teamId,
          surface: context.surface,
        });
        writeResult(result, output(), () => renderSearch(result, options.color), streams);
      }),
    );

  const files = program.command('files');
  workspaceOption(files)
    .description('files shared in this workspace')
    .option('--channel <id>', 'only files in one channel')
    .option('--limit <n>', 'how many: 1 to 200, one page of files', '50')
    .option('--page <n>', 'which page; an incomplete result says which is next')
    .action(
      act(async (context, options, flags: Options) => {
        // As typed, and checked before the workspace is opened, as `search` checks them — see `filesPaging`.
        // `slack_files` checks them the same way.
        const { limit, page } = filesPaging({ limit: flags.limit, page: flags.page, surface: context.surface });
        const { call } = await session(context, String(flags.workspace));
        const result = await listFiles(call, {
          channel: flags.channel as string | undefined,
          limit,
          page,
          surface: context.surface,
        });
        writeResult(result, output(), () => renderFiles(result, options.color), streams);
      }),
    );

  /*
   * `--message <channel> <ts>` is one option taking two words.
   *
   * Commander has no such option, so this is a variadic one shown as the two words it takes; the action refuses any
   * other number of them. Written as `<channel...>` the help would promise a list of channels.
   */
  const messageOption = new Option('--message <channel> <ts>', 'the files of one message: its conversation and its ts');
  messageOption.variadic = true;

  files
    .command('download')
    .description(
      'save files where you say — Downloads, the current folder, or a folder you name: by id, from one message, or from a conversation. Opens nothing',
    )
    .option('--workspace <name>', 'which workspace, as `organisation/slack`')
    .option('--file <id...>', 'these files, by Slack file id')
    .addOption(messageOption)
    .option('--channel <id>', 'the files shared in this conversation — a channel, a DM or a group DM — newest first')
    // Uploaded, not shared: `files.list` filters on when a file was created, in whole seconds.
    .option('--since <ts>', 'with --channel: only files uploaded at or after this Slack timestamp, to the second')
    .option('--max-files <n>', 'stop after this many files: 1 to 200 (default 50)')
    .option(
      '--to <where>',
      'where to save: downloads, current, or a folder (absolute, or starting with ~) — alone only at your own terminal',
    )
    .option(
      '--choice <id>',
      'the choice id the question came with: beside --to, or alone once the person answered it with approve',
    )
    // Removed: the person chooses the folder now. Kept only to say so, rather than as Commander's "unknown option".
    .addOption(new Option('--out <folder>').hideHelp())
    .action(
      act(async (context, options, flags: Options) => {
        refuseRetiredOut(flags.out, 'cli');
        /*
         * `files` takes `--workspace` and `--channel` too, and Commander gives a name both declare to the parent — so
         * the subcommand's own is always undefined, as `mcp install` found with `--workspace`. Either counts.
         */
        const parent = files.opts();
        const workspace = (flags.workspace ?? parent.workspace) as string;
        const channel = (flags.channel ?? parent.channel) as string | undefined;
        // `files`'s own options, read by `files` and nothing else: taken here they would be dropped without a word.
        if (files.getOptionValueSource('limit') === 'cli' || parent.page !== undefined) {
          throw new CommsError(
            'USAGE',
            '`--limit` and `--page` page through `files`; `files download` does not take them',
            {
              hint: 'Use `--max-files` to bound a download.',
            },
          );
        }
        const message = flags.message as string[] | undefined;
        if (message !== undefined && message.length !== 2) {
          throw new CommsError('USAGE', '`--message` takes two words: the conversation and the message’s ts', {
            hint: 'For example `--message C024BE7LR 1700000000.000100`.',
          });
        }
        if (message !== undefined && channel !== undefined) {
          throw new CommsError('USAGE', 'name the files one way, not two: `--message` names its own conversation', {
            hint: '`--channel` is for the files shared in a whole conversation.',
          });
        }
        const request = {
          fileIds: flags.file as string[] | undefined,
          channel: message?.[0] ?? channel,
          ts: message?.[1],
          since: flags.since as string | undefined,
          maxFiles: flags.maxFiles,
          surface: context.surface,
        };
        const to = flags.to === undefined ? undefined : String(flags.to);
        const choice = flags.choice === undefined ? undefined : String(flags.choice);
        // Checked before the workspace is opened, as `slack_file_download` checks it: see `downloadSelection`. The
        // answer is checked with it, in the form the command will pass it.
        downloadSelection(
          {
            ...request,
            saveTo: to,
            choiceId: choice,
            personChose: choice === undefined && personAtTerminal(env, streams, { json: options.json }),
          },
          context.handoffs,
        );
        const opened = await session(context, workspace);
        const result = await downloadAtTerminal<FileDownloadQuestion>({
          core: context.core,
          download: (answer) =>
            downloadFiles(context, opened, { ...request, ...answer }, { download: deps.fileDownload }),
          to,
          choice,
          env,
          output: output(),
          // Run again with the answer: located by core from Slack's caller, the downloads folder pinned with the rest.
          rerun: [
            'files',
            'download',
            '--workspace',
            workspace,
            ...(request.fileIds === undefined ? [] : ['--file', ...request.fileIds]),
            ...(message === undefined ? [] : ['--message', ...message]),
            ...(message === undefined && channel !== undefined ? ['--channel', channel] : []),
            ...(request.since === undefined ? [] : ['--since', request.since]),
            ...(request.maxFiles === undefined ? [] : ['--max-files', String(request.maxFiles)]),
          ],
          render: (question) => renderFileDownloadQuestion(question, options.color),
          streams,
        });
        writeResult(result as FileDownloadResult, output(), (data) => renderFileDownload(data, options.color), streams);
      }),
    );

  workspaceOption(program.command('people'))
    .description('the members of this workspace')
    .option('--limit <n>', 'how many', '200')
    .action(
      act(async (context, options, flags: Options) => {
        const { call } = await session(context, String(flags.workspace));
        const result = await listPeople(call, { limit: limitOf(flags) });
        writeResult(result, output(), () => renderPeople(result, options.color), streams);
      }),
    );

  // ── Drafting and posting ────────────────────────────────────────────────────────────────────────────────────

  const draft = program.command('draft').description('compose and keep messages locally; nothing reaches Slack');

  /*
   * The three the preview can count, and no other word. This took any word, and `--broadcast subteam^S0123` wrote a
   * user-group mention the preview counted as nobody, under `chat`. `createDraft` refuses it too, for any caller.
   */
  const broadcastOption = () =>
    new Option('--broadcast <who>', 'interrupt the room; always needs a person to approve').choices([...BROADCASTS]);
  const FILE_HELP = 'a local file to post, under your home folder and not in a hidden folder there; up to 10';

  workspaceOption(draft.command('create'))
    .description('write a draft. It lives on this machine — Slack has no server-side draft')
    .requiredOption('--channel <id>', 'the conversation id: a channel’s C… or G…, or a DM’s D… — never a user id')
    .option(
      '--text <text>',
      'what to say — optional with --file, as the files’ message. Markup in it is shown, not interpreted',
    )
    .option('--thread <ts>', 'reply inside this thread')
    .option('--mention <userId...>', 'mention someone, by id — a name is ambiguous')
    .addOption(broadcastOption())
    .option('--file <path...>', FILE_HELP)
    .action(
      act(async (context, options, flags: Options) => {
        // The same operation `slack_post_prepare` writes a draft with, mentions and files checked and all.
        const created = await createDraft(context, String(flags.workspace), {
          channel: String(flags.channel),
          text: flags.text as string | undefined,
          threadTs: flags.thread as string | undefined,
          mentionUsers: flags.mention as string[] | undefined,
          broadcast: flags.broadcast,
          files: flags.file as string[] | undefined,
        });
        writeResult(
          created,
          output(),
          (data) => renderCreatedDraft(data, String(flags.workspace), context.handoffs),
          streams,
        );
      }),
    );

  workspaceOption(draft.command('update <draftId>'))
    .description('change a draft: what you give replaces what it had. Any approval it had no longer holds')
    .option('--channel <id>', 'post it to this conversation id instead — never a user id')
    .option('--text <text>', 'what to say instead. Markup in it is shown, not interpreted')
    .option('--thread <ts>', 'reply inside this thread instead')
    .option('--mention <userId...>', 'mention these people instead, by id')
    .addOption(broadcastOption())
    .option('--file <path...>', `${FILE_HELP}. Replaces the files it had`)
    .option('--add-file <path...>', 'a local file to add to the ones it has, from the same folders')
    // `files: []` on `slack_draft_update`, which a list of paths cannot say: an empty `--file` is no option at all.
    .option('--no-files', 'take every file off it')
    .action(
      act(async (context, _options, draftId: string, flags: Options) => {
        const noFiles = flags.files === false;
        const naming = flags.file !== undefined ? '--file' : flags.addFile !== undefined ? '--add-file' : undefined;
        if (noFiles && naming !== undefined) {
          throw new CommsError(
            'USAGE',
            `--no-files takes every file off, and ${naming} names files to put on it: give one or the other`,
            { hint: 'To replace its files, give --file alone; to take them all off, --no-files alone.' },
          );
        }
        // The same operation as `slack_draft_update`: a new revision whatever it changes — see `updateDraft`.
        const updated = await updateDraft(context, String(flags.workspace), draftId, {
          channel: flags.channel as string | undefined,
          text: flags.text as string | undefined,
          threadTs: flags.thread as string | undefined,
          mentionUsers: flags.mention as string[] | undefined,
          broadcast: flags.broadcast,
          files: noFiles ? [] : (flags.file as string[] | undefined),
          addFiles: flags.addFile as string[] | undefined,
        });
        writeResult(
          updated,
          output(),
          (data) => renderUpdatedDraft(data, String(flags.workspace), context.handoffs),
          streams,
        );
      }),
    );

  workspaceOption(draft.command('list'))
    .description('the drafts held for this workspace, each as it would be posted')
    .action(
      act(async (context, options, flags: Options) => {
        // The same operation as `slack_draft_list`: each draft as the gate would post it — see `listDrafts`.
        const drafts = await listDrafts(context, String(flags.workspace));
        writeResult(drafts, output(), (rows) => renderDrafts(rows, options.color), streams);
      }),
    );

  workspaceOption(draft.command('show <draftId>'))
    .description('one draft, exactly as it would be posted')
    .action(
      act(async (context, options, draftId: string, flags: Options) => {
        // The same operation as `slack_draft_get`: refused when the gate would refuse it, in its words.
        const shown = await showDraft(context, String(flags.workspace), draftId);
        writeResult(shown, output(), (row) => renderDraft(row, options.color), streams);
      }),
    );

  workspaceOption(draft.command('delete <draftId>'))
    .description('throw a draft away')
    .action(
      act(async (context, _options, draftId: string, flags: Options) => {
        const { account } = requireWorkspace(await context.config(), String(flags.workspace), context.handoffs);
        const store = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
        const deleted = await deleteOwnDraft(store, account.id, draftId);
        writeResult(deleted, output(), renderDeletedDraft, streams);
      }),
    );

  const post = program.command('post').description('take a draft through the approval gate');

  workspaceOption(post.command('prepare'))
    .description('show what would be posted, and how many people it interrupts. Posts nothing')
    .requiredOption('--draft <draftId>', 'the draft to prepare')
    .action(
      act(async (context, options, flags: Options) => {
        // The same operation as `slack_post_prepare` given a `draftId`: one draft, one preview, from either surface.
        const prepared = await prepareDraftPost(
          context,
          String(flags.workspace),
          { draftId: String(flags.draft) },
          { fetch: deps.read, baseUrl: deps.slackBaseUrl },
        );
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
        // The same operation as `slack_post_send`: see `sendPost`.
        const posted = await sendPost(
          context,
          String(flags.workspace),
          {
            draftId: String(flags.draft),
            approvalId: String(flags.approval),
            expectChannel: String(flags.expectChannel),
          },
          { fetch: deps.read, baseUrl: deps.slackBaseUrl },
        );
        writeResult(posted, output(), renderPosted, streams);
      }),
    );

  workspaceOption(program.command('react'))
    .description('add a reaction or remove your reaction. Behind the same gate, at lower ceremony')
    .requiredOption('--channel <id>', 'the channel')
    .requiredOption('--ts <ts>', 'the message timestamp')
    .requiredOption('--emoji <name>', 'the emoji name, without colons')
    .option('--remove', 'remove your reaction instead', false)
    .option('--approval <approvalId>', 'the approval a person gave with `approve`, under `confirm`')
    .action(
      act(async (context, options, flags: Options) => {
        const wanted = {
          channel: String(flags.channel),
          ts: String(flags.ts),
          name: String(flags.emoji),
          remove: flags.remove === true,
        };
        /*
         * One step under `chat`, two under `confirm`, through the operation `slack_react` and `slack_react_send` use.
         *
         * There was no `--approval`, so a rerun after a person approved made a new approval nobody had seen, and a
         * reaction under `confirm` could never be made. `react` in the operations says what each form does.
         */
        const done = await react(
          context,
          String(flags.workspace),
          wanted,
          flags.approval ? String(flags.approval) : undefined,
          { fetch: deps.read, baseUrl: deps.slackBaseUrl },
        );
        writeResult(
          done,
          output(),
          () =>
            `:${wanted.name}: on ${wanted.ts}.${
              done.note === undefined
                ? ''
                : ` ${done.note.charAt(0).toUpperCase()}${done.note.slice(1)}${/[.!?]$/.test(done.note) ? '' : '.'}`
            }`,
          streams,
        );
      }),
    );

  /*
   * Editing and deleting a message this account posted (design 2026-10-06), through the gate a post goes through: a
   * preview of the act on the message as Slack has it now, an approval bound to both, and a second command that makes
   * it once. `edit` takes its new words from a draft, as `post` does; `delete` takes only the message.
   */
  const edit = program
    .command('edit')
    .description('change the words of a message this account posted, through the gate');

  workspaceOption(edit.command('prepare'))
    .description('show the message as it is and as it would be, and how many people see it. Changes nothing')
    .requiredOption(
      '--draft <draftId>',
      'the draft holding the new words and files to add, in the message’s channel — with no words, the message keeps its own',
    )
    .requiredOption('--ts <ts>', 'the message to edit')
    .option(
      '--remove-file <fileId...>',
      'take this file of the message off it, by id; it stays in Slack, shared nowhere',
    )
    .action(
      act(async (context, _options, flags: Options) => {
        // The same operation as `slack_edit_prepare` given a `draftId`: see `prepareEdit`.
        const prepared = await prepareEdit(
          context,
          String(flags.workspace),
          {
            draftId: String(flags.draft),
            ts: String(flags.ts),
            removeFiles: flags.removeFile as string[] | undefined,
          },
          { fetch: deps.read, baseUrl: deps.slackBaseUrl },
        );
        writeResult(prepared, output(), (data) => renderChannelPreview(data.preview), streams);
      }),
    );

  workspaceOption(edit.command('send'))
    .description(
      'make a prepared edit. Refuses unless the approval, the draft, the message and the room are what they were',
    )
    .requiredOption('--draft <draftId>', 'the draft')
    .requiredOption('--approval <approvalId>', 'the approval `edit prepare` returned')
    .requiredOption('--expect-channel <id>', 'the channel you believe the message is in')
    .requiredOption('--ts <ts>', 'the message you believe this edits')
    .action(
      act(async (context, _options, flags: Options) => {
        // The same operation as `slack_edit_send`: see `sendEdit`.
        const edited = await sendEdit(
          context,
          String(flags.workspace),
          {
            draftId: String(flags.draft),
            approvalId: String(flags.approval),
            expectChannel: String(flags.expectChannel),
            ts: String(flags.ts),
          },
          { fetch: deps.read, baseUrl: deps.slackBaseUrl },
        );
        writeResult(edited, output(), (data) => renderChanged(data, 'edit'), streams);
      }),
    );

  const remove = program.command('delete').description('delete a message this account posted, through the gate');

  workspaceOption(remove.command('prepare'))
    .description('show the message that would be deleted, and what stays behind. Deletes nothing')
    .requiredOption('--channel <id>', 'the conversation the message is in')
    .requiredOption('--ts <ts>', 'the message to delete')
    .action(
      act(async (context, _options, flags: Options) => {
        // The same operation as `slack_delete_prepare`: see `prepareDelete`.
        const prepared = await prepareDelete(
          context,
          String(flags.workspace),
          { channel: String(flags.channel), ts: String(flags.ts) },
          { fetch: deps.read, baseUrl: deps.slackBaseUrl },
        );
        writeResult(prepared, output(), (data) => renderDeletionPreview(data.preview), streams);
      }),
    );

  workspaceOption(remove.command('send'))
    .description('delete a message as prepared. Refuses unless the approval and the message are what they were')
    .requiredOption('--channel <id>', 'the conversation the message is in')
    .requiredOption('--ts <ts>', 'the message')
    .requiredOption('--approval <approvalId>', 'the approval `delete prepare` returned')
    .action(
      act(async (context, _options, flags: Options) => {
        // The same operation as `slack_delete_send`: see `sendDelete`.
        const deleted = await sendDelete(
          context,
          String(flags.workspace),
          { channel: String(flags.channel), ts: String(flags.ts), approvalId: String(flags.approval) },
          { fetch: deps.read, baseUrl: deps.slackBaseUrl },
        );
        writeResult(deleted, output(), (data) => renderChanged(data, 'delete'), streams);
      }),
    );

  // Where an approval stands, waited for: the one look an agent makes to learn that a person approved (§D3).
  const approval = program.command('approval').description('where an approval stands');
  approval
    .command('wait <approvalId>')
    .description(
      'wait for an approval to be usable or finished, and say where it stands — it only looks, and never posts',
    )
    .option(
      '--wait-seconds <n>',
      `how long to wait: 30 when left out, ${MAX_WAIT_SECONDS} at most, 0 for the status now`,
    )
    .action(
      act(async (context, _globalOptions, approvalId: string, flags: Options) => {
        const result = await waitForApproval(context.core, approvalId, {
          waitSeconds: wholeNumber(flags.waitSeconds, { name: '--wait-seconds', min: 0, max: MAX_WAIT_SECONDS }),
          channel: 'slack',
        });
        writeResult(result, output(), renderApprovalWait, streams);
      }),
    );

  program
    .command('approve <approvalId>')
    .description(
      'approve a post, a reaction, an edit, a deletion or a change at this terminal: read it, then type the code back — or answer where a download is saved',
    )
    .action(
      act(async (context, globalOptions, approvalId: string) => {
        /*
         * The one command an agent may not run for the user, checked before the id is even looked up, so an agent is
         * told to hand this to a person whatever it passed.
         *
         * A shell agent can defeat this — `script -q /dev/null` makes any command see a terminal — and this is a
         * speed bump against the ordinary case, not a boundary. The boundary for an agent with a shell is the
         * `never` policy, and a workspace installed in `read` mode, whose token cannot post at all.
         */
        const marker = agentMarker(env);
        if (marker) {
          throw new CommsError(
            'APPROVAL_REQUIRED',
            'only a person can approve a post, a reaction, an edit, a deletion or a change, not an agent',
            {
              // Terminal-only: with no command here, the sentence saying why, and no other way to approve it. With
              // one, the wait that learns when they have (design 2026-10-05 §D7).
              hint: approveRefusedHint(context.handoffs, approvalId),
              details: { marker },
            },
          );
        }
        if (!canPrompt(env, streams, { json: globalOptions.json })) {
          throw new CommsError(
            'APPROVAL_REQUIRED',
            'approving a post, a reaction, an edit, a deletion or a change needs an interactive terminal',
            {
              hint: handoffSentence(
                context.handoffs.own(['approve', approvalId]),
                (command) => `Run ${command} directly in a terminal.`,
              ),
            },
          );
        }
        /*
         * A change approval too. `agentcomms` is not installed beside this package, and a person told to run
         * `agentcomms approve` has nothing to run — so the command they already have approves a change as well, through
         * core's own terminal approval.
         */
        const pending = await context.core.approvals.get(approvalId);
        if (kindOf(pending) === 'change') {
          const outcome = await approveChangeAtTerminal(
            context.core,
            approvalId,
            env,
            { json: globalOptions.json, color: globalOptions.color, platform: context.platform },
            streams,
          );
          streams.stdout.write(
            outcome.state === 'approved'
              ? 'Approved. This command approves; the change is applied by the command that prepared it.\n'
              : 'Cancelled. Nothing was changed.\n',
          );
          return;
        }
        /*
         * A download's question, answered here: where a stranger's files are saved, said by the person at their own
         * terminal — the one way to answer it when the workspace's change policy is `confirm`, since an agent cannot
         * type into this. The download that asked saves where this says, when it is made again with the choice id alone.
         */
        if (kindOf(pending) === 'download') {
          const outcome = await answerDownloadAtTerminal(context.core, approvalId, {
            env,
            color: globalOptions.color,
            platform,
            streams,
          });
          streams.stdout.write(
            outcome.state === 'approved'
              ? `Answered. Nothing is saved yet: the download that asked saves there when it is made again with --choice ${approvalId}, or choiceId "${approvalId}".\n`
              : 'Cancelled. Nothing was saved.\n',
          );
          return;
        }
        // A record that cannot be used is refused for what it is (N4) — this command is no workspace's in particular —
        // before its workspace is looked for: whose it is cannot be read from it.
        if (pending !== null && (pending.form === 'corrupt' || pending.form === 'unreadable')) {
          throw integrityRefusal(pending);
        }
        void (await workspaceForApproval(context, approvalId));
        const slack = { fetch: deps.read, baseUrl: deps.slackBaseUrl };
        const prompt = await beginApproval(context, approvalId, slack);
        // What it does, and what nothing was, in the words of what is being approved.
        const words = {
          post: { verb: 'post', done: 'posted' },
          reaction: { verb: 'react', done: 'added' },
          edit: { verb: 'edit', done: 'changed' },
          delete: { verb: 'delete', done: 'deleted' },
        }[prompt.kind];
        streams.stdout.write(`${prompt.preview}\n\n`);
        const answer = await askFor(streams, {
          question: `Type ${paint(globalOptions.color, 'bold', prompt.challenge)} to approve this, or press Enter to cancel: `,
        });
        if (!answer.trim()) {
          await revokeApproval(context, approvalId);
          streams.stdout.write(`Cancelled. Nothing was ${words.done}.\n`);
          return;
        }
        await finishApproval(context, approvalId, answer, slack);
        streams.stdout.write(`Approved. This command approves; it does not ${words.verb}.\n`);
      }),
    );

  const mcp = program
    .command('mcp')
    .description('run the MCP server on stdio, for a coding agent to connect to')
    .option('--workspace <name>', 'pin the server to one workspace; every tool then acts on it and no other')
    .action(async (flags: Options) => {
      ran = true;
      const startSlackStdioServer = deps.startMcp ?? (await import('../mcp/stdio-entry.ts')).startSlackStdioServer;
      await startSlackStdioServer({
        env,
        platform,
        ...deps,
        core: coreForInvocation(),
        pathOverrides: coreForInvocation().pathOverrides,
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
    .option(
      '--name <name>',
      'the name the client will show: 1 to 64 letters, digits, dots, underscores or hyphens',
      'slack',
    )
    .option('--workspace <name>', 'pin the server to one workspace')
    .addOption(new Option('--launcher <launcher>', 'how the server is started').choices(['managed', 'npx', 'local']))
    .option('--no-verify', 'do not start the server to check the entry works')
    .option('--force', "replace this server's own earlier entry — this is how you upgrade", false)
    .option('--print', 'only print what would be written', false)
    .option('--approval <approvalId>', 'register the server this approval was given for')
    .action(
      act(async (context, options, flags: Options) => {
        /*
         * Named, never assumed — the same rule as Gmail's.
         *
         * This defaulted to `claude-code` while Gmail refused without one, so the same command wrote to a
         * client's config in one CLI and asked which client in the other. Writing into a configuration nobody
         * named is the thing to ask about.
         */
        if (!flags.client) {
          throw new CommsError('USAGE', 'name the client with --client', {
            hint: handoffSentence(
              context.handoffs.own(['mcp', 'install', '--client', 'claude-code']),
              (example) => `For example: ${example}.`,
              { instead: 'For example, --client claude-code.' },
            ),
          });
        }
        /*
         * The parent's value counts too — see the note in the Gmail package, which had this bug shipped.
         *
         * `mcp` and `mcp install` both take `--workspace`, and Commander gives a repeated name to the parent, so
         * the subcommand's own option is always undefined and the pin is silently dropped.
         */
        const pinned = (flags.workspace ?? mcp.opts().workspace) as string | undefined;
        const launcher = flags.launcher as 'managed' | 'npx' | 'local' | undefined;
        const name = flags.name as string | undefined;
        /*
         * Registering a server is a change a person approves (design §3.1), and this is the change
         * `comms_server_install` makes, with this package's own product for its version and its code. It registered with no approval at all while the tool asked for one — the same
         * operation, refused on one surface and not the other. An approval from the tool is claimed here with
         * `--approval`, and one from here by the tool. `--print` and `--client json` write nothing, and ask nobody.
         */
        const again = [
          'mcp',
          'install',
          '--client',
          String(flags.client),
          ...(name !== undefined && name !== 'slack' ? ['--name', name] : []),
          ...(pinned !== undefined ? ['--workspace', pinned] : []),
          ...(launcher !== undefined ? ['--launcher', launcher] : []),
          ...(flags.verify === false ? ['--no-verify'] : []),
          ...(flags.force === true ? ['--force'] : []),
        ];
        const result = await changeAt(
          context,
          serverInstallChange(
            context.core,
            env,
            {
              channel: 'slack',
              client: flags.client as SupportedClient,
              name,
              workspace: pinned,
              launcher,
              noVerify: flags.verify === false,
              print: flags.print === true,
              force: flags.force === true,
            },
            SLACK_MCP,
          ),
          flags,
          again,
        );
        // Asked to register and did not — the client's CLI is not on PATH — or registered an entry that did not
        // start. The result is still printed, but a zero exit told a script (or an agent) that it worked.
        const status = installExitStatus(result);
        if (status !== EXIT_CODES.OK) softExit = status;
        writeResult(result, output(), () => renderInstall(result, options.color), streams);
      }),
    );

  mcp
    .command('prune')
    .description(
      'remove managed runtimes that no client config it can read names, no printed entry names, and no process runs',
    )
    .option('--dry-run', 'only say what would be removed', false)
    .option(
      '--include-printed',
      'also remove runtimes kept only because an entry for them was printed (--client json, --print), once those entries are gone',
      false,
    )
    .option('--approval <approvalId>', 'remove the runtimes this approval was given for')
    .action(
      act(async (context, options, flags: Options) => {
        // The change `comms_server_prune` makes: a dry run is free; removing is approved as the list it shows, and
        // removes no more than that list, because a deleted runtime cannot be taken back.
        const result = await changeAt(
          context,
          serverPruneChange(
            context.core,
            env,
            { channel: 'slack', dryRun: flags.dryRun === true, includePrinted: flags.includePrinted === true },
            SLACK_MCP,
          ),
          flags,
          ['mcp', 'prune', ...(flags.includePrinted === true ? ['--include-printed'] : [])],
        );
        writeResult(result, output(), () => renderPrune(result, options.color), streams);
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

  // ── the hidden rest of the day's update check, handed on by a command (#48) ─────────────────────────────────────

  program
    .command(`${UPDATE_CHECK_CHILD_COMMAND} <claimedAt>`, { hidden: true })
    .description("internal: finish the day's update check a command handed on")
    .action(
      act(async (context, _options, claimedAt: string) => {
        await runUpdateCheckChild(context.core, env, claimedAt);
      }),
    );

  // ── shared by add, reauth and mode ──────────────────────────────────────────────────────────────────────────

  /**
   * A sign-in that has started, shown the way it was asked for.
   *
   * With `--start` the listener is detached and the flow is on disk, so the link is the result and whatever runs
   * `--finish` need not be this process — or even this session: an agent's shell call returns in seconds while consent
   * takes minutes. Without it, the link goes to stderr, so `--json` still puts exactly one document on stdout, and
   * this waits for the browser.
   */
  async function presentSignIn(
    context: SlackContext,
    started: StartedSignIn,
    reauth: boolean,
    options: GlobalOptions,
    how: { start: boolean; browser: boolean },
  ): Promise<void> {
    if (how.start) {
      if (how.browser) tryOpen(started.authUrl);
      writeResult(
        signInStarted(context, started, reauth),
        output(),
        () => renderSignInStarted(started, reauth, options.color, context.handoffs),
        streams,
      );
      return;
    }
    context.foregroundSignIn?.signal.throwIfAborted();
    streams.stderr.write(`${renderSignInStarted(started, reauth, options.color, context.handoffs)}\n\n`);
    if (how.browser) tryOpen(started.authUrl);
    const listener = started.listener;
    if (!listener) throw new CommsError('UNEXPECTED', 'the sign-in listener did not start');
    try {
      const view = await listener.result;
      writeResult(view, output(), () => renderConnected(view, reauth, options.color, context.handoffs), streams);
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
      const message = withoutOptionValues(error.message.replace(/^error: /, ''));
      return runCommand(
        output(),
        async () => {
          throw new CommsError('USAGE', message, {
            hint: handoffSentence(help, (command) => `Run ${command} to see the commands.`),
          });
        },
        streams,
      );
    }
    throw error;
  }
  if (!ran) {
    const tryHelp = handoffSentence(help, (command) => `Nothing to do. Try ${command}.`, { instead: 'Nothing to do.' });
    streams.stderr.write(`${paint(globals().color, 'dim', tryHelp)}\n`);
    return 64;
  }
  return exitCode;
}
