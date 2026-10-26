import {
  agentMarker,
  answerDownloadAtTerminal,
  approvalHint,
  approveChangeAtTerminal,
  approveRefusedHint,
  CommsError,
  type CoreHandOff,
  canPrompt,
  cliHandoffs,
  colorEnabled,
  commandPathOf,
  describeFenceReport,
  downloadAtTerminal,
  EXIT_CODES,
  exemptFromUpdateNotice,
  type GatedChange,
  gatedChange,
  gatedChangeAtTerminal,
  handoffSentence,
  handoffSentenceToFill,
  handoffText,
  handoffTextToFill,
  homeDirectory,
  insertWordsBeforeSentinel,
  installExitStatus,
  kindOf,
  MAX_WAIT_SECONDS as MAX_APPROVAL_WAIT_SECONDS,
  markMcpServerProcess,
  type OutputOptions,
  openCore,
  orgAddChange,
  PATH_OPTIONS,
  paint,
  pathOverridesFromCliOptions,
  profileSourcePath,
  refuseRetiredOut,
  refuseUnclaimedApproval,
  renderApprovalWait,
  resolvePaths,
  runCommand,
  runUpdateCheckChild,
  type ServerInstallResult,
  type Streams,
  serverInstallChange,
  serverPruneChange,
  terminalUpdateHooks,
  toCommsError,
  UPDATE_CHECK_CHILD_COMMAND,
  updateNoticeAtTerminal,
  waitForApproval,
  wholeNumber,
  withoutOptionsBeforeSentinel,
  writeResult,
} from '@agentcomms/core';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import type { RegistrationIntent } from '../auth/flows.ts';
import { TIERS } from '../auth/scopes.ts';
import { GMAIL_CALLER } from '../caller.ts';
import { GmailContext, type GmailContextOptions } from '../context.ts';
import { gmailApprovalView } from '../domain/untrusted-fields.ts';
import type { Launcher, SupportedClient } from '../mcp/install.ts';
import { listLabels, listSendAs, threadTimeline } from '../operations/analyse.ts';
import {
  type DownloadQuestion,
  type DownloadResult,
  downloadAttachments,
  findAttachments,
} from '../operations/attachments.ts';
import { clientAddChange, clientList, clientRemoveChange, STORE_KINDS } from '../operations/clients.ts';
import { confirmClientAddChange, listConfirmClients, removeConfirmClient } from '../operations/confirm-clients.ts';
import { CONTACT_SOURCES, FOLLOW_UP_DIRECTIONS, followUps, searchContacts } from '../operations/contacts.ts';
import { doctor } from '../operations/doctor.ts';
import {
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  REPLY_MODES,
  replyDraft,
  updateDraft,
} from '../operations/drafts.ts';
import { EXPORT_FORMATS, exportMail } from '../operations/export.ts';
import { inboxImportChange } from '../operations/import-legacy.ts';
import {
  inboxList,
  inboxPolicyChange,
  inboxRemoveChange,
  inboxRename,
  inboxShow,
  whoami,
} from '../operations/inboxes.ts';
import { runOauthListener } from '../operations/oauth-listen.ts';
import { applyUndo, createLabel, modify, trash } from '../operations/organise.ts';
import { readMessage, readThread } from '../operations/read.ts';
import { search } from '../operations/search.ts';
import {
  beginApproval,
  executeSend,
  finishApproval,
  listApprovals,
  prepareSend,
  revokeApproval,
} from '../operations/send.ts';
import {
  checkedPort,
  checkedWait,
  FINISH_WAIT_SECONDS,
  finishSignIn,
  inboxReauthChange,
  MAX_WAIT_SECONDS,
  type StartOptions,
  startSignIn,
} from '../operations/signin.ts';
import { VERSION } from '../version.ts';
import { openInBrowser } from './browser.ts';
import { askFor } from './prompt.ts';
import {
  type FinishRegistration,
  renderApprovals,
  renderAttachments,
  renderClientAdd,
  renderClients,
  renderContacts,
  renderDoctor,
  renderDownloadQuestion,
  renderDownloads,
  renderDraft,
  renderDrafts,
  renderFollowUps,
  renderImport,
  renderInboxList,
  renderInboxShow,
  renderInstall,
  renderLabels,
  renderMessage,
  renderModify,
  renderPrune,
  renderSearch,
  renderSendAs,
  renderSendPreparation,
  renderSent,
  renderSetupPlan,
  renderSignedIn,
  renderSignInStarted,
  renderThread,
  renderTrash,
  renderWhoami,
  type SetupHandoff,
} from './render.ts';

export interface CliDeps extends GmailContextOptions {
  streams?: Streams;
  platform?: NodeJS.Platform | undefined;
  /** Starts the stdio server. Injected so a test can inspect its inputs without opening stdio. */
  startMcp?: ((options: import('../mcp/server.ts').GmailMcpOptions) => Promise<void>) | undefined;
  /** The send operation; tests replace it so parser round trips cannot send mail. */
  executeSend?: typeof executeSend | undefined;
  /** Command used to start the detached sign-in listener; the tests point it at the source entry. */
  listenerCommand?: { command: string; args: string[] };
  /**
   * How the day's update check is handed to core's CLI (design 2026-10-22, P2): core's command, at this package's own
   * version, located and started as the default does. Injected so a test can see what would be started without
   * starting it.
   */
  updateHandOff?: CoreHandOff | undefined;
}

interface GlobalOptions {
  json: boolean;
  color: boolean;
  noInput: boolean;
}

type Options = Record<string, unknown>;

/** Where an undo receipt comes from: said in words, since it is the output of a run already made, not one to make. */
const UNDO_HINT = 'Pipe in the `undo` array that an organise run printed with --json.';

/**
 * The `agent-gmail` command. Both a person and an agent run it, so every command prints a readable summary by default
 * and the full result under `--json`, with the same exit codes either way (documented in `--help`).
 */
export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const streams: Streams = deps.streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const program = new Command();
  let exitCode = 0;
  let ran = false;

  program
    .name('agent-gmail')
    .description('Gmail for coding agents: read, search, draft and organise across inboxes — sending needs approval.')
    .version(VERSION, '-v, --version')
    .option('--json', 'print the result as {"ok":true,"schemaVersion":1,"data":…}', false)
    .option('--no-color', 'never colour the output')
    .option('--no-input', 'never prompt, even on a terminal')
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
    })
    .addHelpText(
      'after',
      `
Exit codes: 0 ok · 1 unexpected · 10 send refused or approval required · 64 usage · 65 bad data ·
66 not found · 69 provider or secret store unavailable · 75 temporary (retry later) ·
77 sign-in or permission needed · 78 configuration problem.`,
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
    // Opened with Gmail's caller, so every command it prints — its own, core's — is this installation's, located.
    invocationCore =
      Object.keys(pathOverrides).length === 0 && deps.core
        ? deps.core
        : openCore({ env, platform, pathOverrides, caller: GMAIL_CALLER });
    return invocationCore;
  };
  /**
   * This installation's own `--help`, which reads no folder: for a usage error, which can come before any folder is
   * known — a path option that is not one — so it is located without opening core.
   */
  const help = () =>
    cliHandoffs({ caller: GMAIL_CALLER, paths: resolvePaths({ env, platform }), platform, env }).own(['--help'], {
      uses: [],
    });

  const globals = (): GlobalOptions => {
    const options = program.opts();
    return {
      json: Boolean(options.json),
      color: colorEnabled(env, streams.stdout, options.color as boolean | undefined),
      noInput: options.input === false,
    };
  };
  const output = (): OutputOptions => ({ json: globals().json, color: globals().color, platform });

  /** Wraps a command body so every failure becomes the documented envelope and exit code. */
  /**
   * A command that succeeded but wants a non-zero exit code — `doctor` finding something broken, where the findings
   * *are* the output and the envelope must still be the normal one. Throwing instead would print a second envelope
   * after the first, and `--json` promises exactly one document on stdout.
   */
  let softExit: number | null = null;

  /*
   * The update notice (design 2026-10-16, U1), before any command but the exempt ones: the day's check, waited for
   * about three seconds at most, and — when a newer release is out and no command on this machine said so today — one
   * line on stderr. It never stops the command. A hook on the program, so a command added later has it by being a
   * command at all.
   */
  program.hook('preAction', async (_program, command) => {
    const path = commandPathOf(command);
    // `oauth-listen` too: it is the listener a sign-in started, not a command anybody types, and stopping it would
    // break the sign-in the person is in the middle of. So is the update check a command handed on (#48).
    if (exemptFromUpdateNotice(path, ['oauth-listen', UPDATE_CHECK_CHILD_COMMAND])) return;
    const core = coreForInvocation();
    await updateNoticeAtTerminal({
      core,
      env,
      channel: 'gmail',
      running: VERSION,
      output: output(),
      streams,
      ...terminalUpdateHooks(core, env, { handOff: deps.updateHandOff ?? {} }),
    });
  });

  const act =
    <A extends unknown[]>(body: (context: GmailContext, options: GlobalOptions, ...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      ran = true;
      softExit = null;
      const core = coreForInvocation();
      const context = new GmailContext({ ...deps, core, env, pathOverrides: core.pathOverrides, surface: 'cli' });
      exitCode = await runCommand(output(), () => body(context, globals(), ...args), streams);
      if (exitCode === 0 && softExit !== null) exitCode = softExit;
    };

  /**
   * The body of a message, from `--text`, from `--file`, or from standard input.
   *
   * Standard input matters more than it looks: a body is prose with newlines and quotes in it, and an agent that has
   * to fit one into a shell argument will mangle it. Piping it in is the way that always works.
   *
   * `--file -` asks for standard input by name. A new draft or a reply also reads it when nothing else is given,
   * because it cannot exist without a body. An update never does: there, no body means "keep the one it has" — what
   * `gmail_draft_update` does when `text` is left out — and guessing from standard input is what broke it. An agent's
   * shell hands a command standard input that has already ended, which read as an empty body and was refused; or a
   * pipe nobody closes, which was read until the end that never came. Only an explicit `--file -` reads it now.
   */
  const bodyText = async (options: Options, behaviour: { bodyOptional?: boolean } = {}): Promise<string> => {
    if (typeof options.text === 'string') return options.text;
    if (options.file === '-') return pipedBody();
    if (typeof options.file === 'string') {
      // Bounded at the size a message can be anyway: anything larger was going to be refused by `compose` a
      // moment later, so the ceiling costs nothing — and a FIFO or a device at `--file` no longer reads until
      // the process dies rather than failing at the point it was always going to fail.
      const { readSmallFile } = await import('../operations/small-file.ts');
      const { MAX_MESSAGE_BYTES } = await import('../domain/compose.ts');
      const path = String(options.file);
      const content = await readSmallFile(path, { follow: true, maxBytes: MAX_MESSAGE_BYTES });
      if (!content.ok) {
        throw new CommsError(
          content.problem === 'missing' ? 'NOT_FOUND' : 'USAGE',
          content.problem === 'too-large' ? `${path} is larger than a message can be` : `cannot read ${path}`,
          { hint: 'Pass a regular file holding the message body, or use --text.' },
        );
      }
      return content.text;
    }
    // On an update, no body means "keep the one that is there" — whatever standard input is.
    if (behaviour.bodyOptional) return undefined as unknown as string;
    if ((streams.stdin as { isTTY?: boolean }).isTTY) {
      throw new CommsError('USAGE', 'no message body', {
        hint: 'Pass --text "…", or --file <path>, or pipe the body in on standard input.',
      });
    }
    return pipedBody();
  };

  /** Standard input, read to its end as a message body. */
  const pipedBody = async (): Promise<string> => {
    const stdin = streams.stdin as NodeJS.ReadableStream;
    // Bounded the same way `--file` is, and at the same ceiling: a pipe is the easier of the two to point at
    // something endless, and the size check in `compose` only runs once the whole thing is already in memory.
    const { readBoundedStream } = await import('../operations/small-file.ts');
    const { MAX_MESSAGE_BYTES } = await import('../domain/compose.ts');
    const piped = await readBoundedStream(stdin, MAX_MESSAGE_BYTES);
    if (!piped.ok) {
      throw new CommsError(
        'USAGE',
        piped.problem === 'too-large'
          ? 'the piped message body is larger than a message can be'
          : 'the piped message body could not be read to the end',
        {
          hint:
            piped.problem === 'too-large'
              ? 'A Gmail message tops out at 35MB including attachments.'
              : 'Whatever was piping the body stopped before it finished. Pass --text or --file instead.',
        },
      );
    }
    const text = piped.text;
    if (!text.trim()) {
      throw new CommsError('USAGE', 'the message body was empty', {
        hint: 'Pass --text "…", or --file <path>, or pipe the body in on standard input.',
      });
    }
    return text;
  };

  /** An optional legacy `--expect-*` list as the caller meant it. `none` is the explicit empty list. */
  const expected = (value: unknown): string[] => {
    const list = (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String);
    return list.length === 1 && list[0] === 'none' ? [] : list;
  };

  /** The options every draft command shares, so `draft new` and `draft reply` take the same flags. */
  const withDraftOptions = (command: Command): Command =>
    command
      .option('--text <text>', 'the body, as plain text (the HTML part is generated from it)')
      .option('--file <path>', 'read the body from a file; `-` reads standard input')
      .option('--cc <address...>', 'copy these people')
      .option('--bcc <address...>', 'blind-copy these people')
      .option('--attach <path...>', 'attach these local files')
      .option('--no-signature', 'leave the mailbox signature off')
      .option('--no-quote', 'do not quote the original (a reply only; a forward needs it)')
      .option('--profile', 'include the mailbox writing profile in the result', false)
      .option(
        '--as <who>',
        'who it appears to come from: agent (labelled in the From line) or me (unlabelled, only when the person said so)',
      );

  const draftInput = async (
    options: Options,
    behaviour: { bodyOptional?: boolean } = {},
  ): Promise<Parameters<typeof createDraft>[2]> => ({
    to: options.to as string[] | undefined,
    cc: options.cc as string[] | undefined,
    bcc: options.bcc as string[] | undefined,
    subject: options.subject === undefined ? undefined : String(options.subject),
    text: await bodyText(options, behaviour),
    attach: options.attach as string[] | undefined,
    signature: options.signature !== false,
    includeProfile: Boolean(options.profile),
    as: options.as === undefined ? undefined : String(options.as),
  });

  /**
   * This command as it was typed, without an `--approval` it already carried: the words, after the program, to run
   * again once a change it prepared has been approved.
   *
   * From the arguments themselves rather than rebuilt per command, so every flag the person or agent gave is in it
   * — `--rename`, `--dir`, `--revoke` — and running it again prepares nothing new: it claims the approval for the
   * same change. `setup` leaves out its `--mcp-approval` too, the second approval it can carry. Only options before a
   * `--` are removed: what follows one is positional data, kept word for word. Core's flow puts the approval back
   * before any `--`, and the locator makes it this installation's command with this run's folders pinned, in place of
   * any path option the words carried (CUE-403).
   */
  const again = (approvalFlags: readonly string[] = ['--approval']): string[] =>
    withoutOptionsBeforeSentinel(argv, approvalFlags);

  /**
   * A command that changes an account, asked the way every surface asks: through core's one flow.
   *
   * With `--approval <id>` it claims that approval and applies the change. Without one, a change that loosens nothing
   * is applied at once; one that does is prepared, and a person at this terminal approves it there — a yes under the
   * `chat` change policy, the code under `confirm` — while an agent, or anything without a terminal, gets the preview
   * and the approval id and exits 10. `gmail_*` tools call the same flow with the same change, so the two surfaces
   * cannot ask differently.
   */
  const changed = <T>(
    context: GmailContext,
    globalOptions: GlobalOptions,
    change: GatedChange<T>,
    approvalId: unknown,
  ): Promise<T> =>
    gatedChangeAtTerminal(context.core, change, {
      channel: 'gmail',
      approvalId: typeof approvalId === 'string' ? approvalId : undefined,
      env,
      // `--no-input` means nobody is asked anything. The flow's one way to hear that is `json`, which it reads only
      // to decide whether a person could answer a question — so both say the same thing to it.
      output: { json: globalOptions.json || globalOptions.noInput, color: globalOptions.color, platform },
      rerun: again(),
      streams,
    });

  /**
   * The agent connection as a change: the one `mcp install` and `comms_server_install` make, for this package's own
   * server, with what `setup` has always registered — the default name, pinned to nothing. `setup --mcp-client` makes
   * it, and so does `inbox add --finish` for a sign-in `setup` handed off with that flag: one change, written once, so
   * an approval any of them prepared is claimed by the others, `mcp install --approval` among them.
   */
  const setupRegistration = async (
    context: GmailContext,
    request: {
      client: string;
      launcher?: string | undefined;
      force?: boolean | undefined;
      /** The mailbox to pin it to: the one just connected, when the entry in its place serves another (#47). */
      inbox?: string | undefined;
    },
  ) => {
    const { GMAIL_MCP } = await import('../mcp/install.ts');
    return serverInstallChange(
      context.core,
      env,
      {
        channel: 'gmail',
        client: request.client as SupportedClient,
        force: request.force === true,
        ...(request.launcher ? { launcher: request.launcher as Launcher } : {}),
        ...(request.inbox ? { inbox: request.inbox } : {}),
      },
      GMAIL_MCP,
    );
  };

  /**
   * The pin a registration for `inbox` takes: that mailbox, when the entry of ours in its place serves another
   * (`mailboxServedElsewhere`), so a replacement serves the mailbox just connected rather than keeping the other's
   * pin, and a refusal names a second entry for it; otherwise none, as `setup` has always registered.
   */
  const pinFor = async (client: string, inbox: string): Promise<string | undefined> => {
    const { mailboxServedElsewhere } = await import('../mcp/install.ts');
    return (await mailboxServedElsewhere(env, { client, inbox })) === null ? undefined : inbox;
  };

  /**
   * Takes up the registration a finished sign-in carried from `setup --mcp-client`: see `OAuthFlow.registerWith`.
   *
   * The mailbox is connected by the time this runs, and nothing here may say otherwise — what happens to the
   * registration is reported beside it, never in its place. A client whose entry of ours already serves this mailbox
   * is left alone (`clientServesInbox`), unless `setup` was given `--replace-server`, which asked for exactly that
   * entry to be replaced. Otherwise it is `setup`'s own registration step, through the same change: a person at this
   * terminal reads the preview and approves it there and then; an agent, or anything without a terminal, gets the
   * preview, the approval id and the `mcp install` command that claims it — the same change, so the claim succeeds —
   * and the command exits 10, as `setup` does when it stops at this step, so a script reading only the status does
   * not take a registration nobody approved for one that happened. One the change refuses — somebody else's server
   * under that name, or ours without `--replace-server` — is `not-registered`, with the refusal's reason.
   */
  const registerForFinish = async (
    context: GmailContext,
    globalOptions: GlobalOptions,
    intent: RegistrationIntent,
    connected: { alias: string; inbox: { email: string } },
  ): Promise<FinishRegistration> => {
    const { client } = intent;
    const replace = intent.replace === true;
    if (!replace) {
      const { clientServesInbox } = await import('../mcp/install.ts');
      if (await clientServesInbox(env, { client, inbox: connected.alias })) {
        return { client, status: 'already-registered' };
      }
    }
    const pin = await pinFor(client, connected.alias);
    // `mcp install` with what `setup` was given: the request `setupRegistration` makes, and so the same change.
    const install = [
      'mcp',
      'install',
      '--client',
      client,
      ...(intent.launcher ? ['--launcher', intent.launcher] : []),
      ...(pin ? ['--inbox', pin] : []),
      // Without it the claim's own preflight refuses the entry the prepared change replaces: not the same change.
      ...(replace ? ['--force'] : []),
    ];
    const person =
      agentMarker(env) === null &&
      canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput });
    try {
      const change = await setupRegistration(context, {
        client,
        ...(intent.launcher ? { launcher: intent.launcher } : {}),
        force: replace,
        ...(pin ? { inbox: pin } : {}),
      });
      let result: ServerInstallResult;
      if (person) {
        // Said before the preview, so the person deciding knows the mailbox is in whatever they answer.
        streams.stderr.write(
          `Connected ${connected.inbox.email} as "${connected.alias}". Setup also asked to register the Gmail server with ${client}.\n\n`,
        );
        result = await gatedChangeAtTerminal(context.core, change, {
          channel: 'gmail',
          env,
          output: { json: globalOptions.json || globalOptions.noInput, color: globalOptions.color, platform },
          rerun: install,
          streams,
        });
      } else {
        const outcome = await gatedChange(context.core, change, { channel: 'gmail', surface: 'cli', platform });
        if (outcome.status === 'approval-required') {
          const { prepared } = outcome;
          // This installation's own `mcp install`, located, carrying the approval: a result field, not in the digest.
          const claimCommand = context.handoffs.own(
            insertWordsBeforeSentinel(install, '--approval', prepared.approvalId),
          );
          softExit = EXIT_CODES.APPROVAL;
          return {
            client,
            status: 'approval-required',
            approvalId: prepared.approvalId,
            policy: prepared.policy,
            summary: prepared.summary,
            preview: prepared.preview,
            expiresAt: prepared.expiresAt,
            claim: claimCommand,
            hint: approvalHint(prepared, claimCommand, context.handoffs),
          };
        }
        result = outcome.result;
      }
      const status = installExitStatus(result);
      if (status !== EXIT_CODES.OK) softExit = status;
      // Written, or only printed because the client could not be written to: the second is not a registration.
      return result.applied
        ? { client, status: 'registered', install: result }
        : { client, status: 'not-registered', reason: result.notApplied ?? 'nothing was written', install: result };
    } catch (error) {
      // Refused, or declined at the terminal: the registration did not happen, and the mailbox still did.
      const failure = toCommsError(error);
      softExit = failure.exitCode;
      return { client, status: 'not-registered', reason: failure.message, hint: failure.hint };
    }
  };

  // ---- clients ----------------------------------------------------------------
  const client = program.command('client').description('the Google Cloud OAuth client every inbox signs in through');
  client
    .command('add <path>')
    .description('register a Desktop OAuth client JSON downloaded from Google Cloud (needs a change approval)')
    .option('--name <name>', 'register it under this name', 'default')
    .addOption(new Option('--store <store>', 'where secrets are kept (first time only)').choices([...STORE_KINDS]))
    .option('--move', 'delete the downloaded file once the secret is stored', false)
    .option('--replace', 'rotate the secret of the client already registered under this name', false)
    .option('--no-probe', 'do not check the credentials with Google first')
    .option('--approval <id>', 'apply the change this approval was given for')
    .action(
      act(async (context, globalOptions, path: string, options: Options) => {
        const change = clientAddChange(context, {
          path,
          name: String(options.name ?? 'default'),
          store: options.store === undefined ? undefined : String(options.store),
          move: Boolean(options.move),
          replace: Boolean(options.replace),
          noProbe: options.probe === false,
        });
        const result = await changed(context, globalOptions, change, options.approval);
        writeResult(result, output(), (data) => renderClientAdd(data, globalOptions.color, context.handoffs), streams);
      }),
    );
  client
    .command('list')
    .description('list the registered OAuth clients')
    .action(
      act(async (context, globalOptions) => {
        writeResult(
          await clientList(context),
          output(),
          (data) => renderClients(data, globalOptions.color, context.handoffs),
          streams,
        );
      }),
    );
  client
    .command('remove <name>')
    .description('forget an OAuth client and delete its secret (needs a change approval)')
    .option('--approval <id>', 'apply the change this approval was given for')
    .action(
      act(async (context, globalOptions, name: string, options: Options) => {
        writeResult(
          await changed(context, globalOptions, clientRemoveChange(context, name), options.approval),
          output(),
          (data) => `Removed the OAuth client "${data.name}".`,
          streams,
        );
      }),
    );

  // ---- inboxes ----------------------------------------------------------------
  const inbox = program.command('inbox').description('connect, inspect and disconnect mailboxes');
  const withSignInOptions = (command: Command): Command =>
    command
      .option('--email <address>', 'the address this must turn out to be; refused if it is not')
      .addOption(new Option('--tier <tier>', 'how much access to ask for').choices([...TIERS]))
      // Both forms, because `grantHint` tells a user to run `--contacts` when a contacts search is refused, and
      // Commander does not create the positive form from `--no-contacts`. A hint naming a flag that does not exist
      // is worse than no hint: the user runs it, Commander rejects it, and the real fix stays hidden.
      // An explicit `undefined` default, so "not given" is distinguishable from "given as yes". Commander's
      // implicit default for a `--no-x` flag is `true`, which made `options.contacts` a boolean in every case —
      // so `signin.ts`'s `options.contacts ?? inbox.contacts` could never reach its fallback, and re-authorising
      // a mailbox connected with `--no-contacts` put the address-book scopes back on the consent screen. The
      // standing advice is to leave every box ticked, so the access a person deliberately declined got granted.
      .option('--no-contacts', 'do not ask for contacts access', undefined)
      .option('--contacts', 'ask for contacts access (the default)')
      .option('--client <name>', 'sign in through this OAuth client')
      // As typed, and checked by the operation (`checkedPort`): `Number.parseInt` made `abc` NaN, which the listener
      // took as any free port.
      .option('--port <number>', 'use this loopback port for the redirect: 1 to 65535, or 0 for any free one')
      .option('--no-browser', 'do not open the link, just print it')
      .option('--hd <domain>', 'restrict the account chooser to a Google Workspace domain')
      .option('--start', 'start the sign-in and return the link, to be finished later', false)
      .option('--finish <flowId>', 'finish a sign-in started earlier')
      .option('--url <url>', 'the address the browser ended up at, pasted back')
      // Taken as typed and checked by the operation (`checkedWait`), not parsed here: `Number.parseInt` made `abc` NaN,
      // a deadline never reached, and `12abc` twelve.
      .option(
        '--wait <seconds>',
        `with --finish, how long to wait for the browser: 0 to ${MAX_WAIT_SECONDS} seconds`,
        String(FINISH_WAIT_SECONDS),
      );

  const signIn = async (
    context: GmailContext,
    globalOptions: GlobalOptions,
    mode: 'add' | 'reauth',
    alias: string | undefined,
    options: Options,
  ): Promise<void> => {
    // Whatever else is asked: a wait or a port that is not one is refused as USAGE, not taken as some other number.
    const waitSeconds = checkedWait(options.wait, context.surface);
    const port = checkedPort(options.port, context.surface);
    if (options.finish) {
      /*
       * `--finish` collects a sign-in already started, and claims nothing: the approval a wider re-authorisation needs
       * is claimed where the sign-in starts, before its link exists. One given with it is refused rather than dropped
       * — the update check's stop had let the command past on it — as core's `refuseUnclaimedApproval` says.
       */
      refuseUnclaimedApproval(options.approval, {
        message: '--finish collects a sign-in already started, so it takes no --approval',
        hint: 'An approval is claimed where the sign-in starts, and finishing it needs none: run the same command again without --approval.',
      });
      const result = await finishSignIn(context, {
        flowId: String(options.finish),
        onlyMode: mode,
        onlyAlias: alias,
        url: options.url ? String(options.url) : undefined,
        waitSeconds,
      });
      /*
       * A sign-in `setup --mcp-client` handed off carries the registration it was asked for, and this is where it is
       * made: `setup` returned before the browser, so nothing else is left to make it. Only for a new mailbox — the
       * only kind `setup` starts — and only when the flow carries one: any other finish prints what it always did.
       */
      if (mode === 'add' && result.registerWith) {
        const { registerWith, ...connected } = result;
        const registration = await registerForFinish(context, globalOptions, registerWith, connected);
        writeResult(
          { ...connected, registration },
          output(),
          (data) => renderSignedIn(data, globalOptions.color, context.handoffs),
          streams,
        );
        return;
      }
      writeResult(result, output(), (data) => renderSignedIn(data, globalOptions.color, context.handoffs), streams);
      return;
    }
    if (!alias) {
      const example = (await context.config()).version === 2 ? 'acme/gmail' : 'work';
      throw new CommsError('USAGE', 'name the inbox', {
        hint: handoffSentence(
          context.handoffs.own(['inbox', mode, example, '--start']),
          (command) => `For example: ${command}.`,
        ),
      });
    }

    // A person at a terminal can wait for the browser; an agent cannot, so its sign-in is two commands.
    const interactive =
      !options.start && canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput });
    const signInOptions = {
      alias,
      tier: options.tier ? String(options.tier) : undefined,
      contacts: options.contacts === undefined ? undefined : options.contacts !== false,
      client: options.client ? String(options.client) : undefined,
      email: options.email ? String(options.email) : undefined,
      hostedDomain: options.hd ? String(options.hd) : undefined,
      port,
      detached: !interactive,
      listenerCommand: deps.listenerCommand,
    };
    // A re-authorisation that asks for more than the mailbox holds is approved before the link exists, exactly as
    // `gmail_inbox_reauth` approves it; renewing or narrowing a grant starts at once.
    const started =
      mode === 'reauth'
        ? await changed(context, globalOptions, inboxReauthChange(context, signInOptions), options.approval)
        : await startSignIn(context, { ...signInOptions, mode });

    if (!interactive || !started.listener) {
      writeResult(
        started,
        output(),
        (data) => renderSignInStarted(data, mode, globalOptions.color, context.handoffs),
        streams,
      );
      return;
    }
    streams.stderr.write(`${renderSignInStarted(started, mode, globalOptions.color, context.handoffs)}\n`);
    if (options.browser !== false) openInBrowser(started.authUrl);
    const result = await started.listener.result;
    writeResult(result, output(), (data) => renderSignedIn(data, globalOptions.color, context.handoffs), streams);
  };

  withSignInOptions(inbox.command('add [alias]').description('connect a mailbox (opens Google in a browser)')).action(
    act(async (context, globalOptions, alias: string | undefined, options: Options) => {
      await signIn(context, globalOptions, 'add', alias, options);
    }),
  );

  withSignInOptions(
    inbox
      .command('reauth [alias]')
      .description('sign in again: renew the grant, or change how much access it has (more needs a change approval)'),
  )
    .option('--approval <id>', 'start the sign-in this approval was given for')
    .action(
      act(async (context, globalOptions, alias: string | undefined, options: Options) => {
        await signIn(context, globalOptions, 'reauth', alias, options);
      }),
    );

  inbox
    .command('list')
    .description('list the connected mailboxes')
    .action(
      act(async (context, globalOptions) => {
        writeResult(
          await inboxList(context),
          output(),
          (data) => renderInboxList(data, globalOptions.color, context.handoffs),
          streams,
        );
      }),
    );

  inbox
    .command('show <alias>')
    .description('everything known about one mailbox')
    .action(
      act(async (context, globalOptions, alias: string) => {
        writeResult(
          await inboxShow(context, alias),
          output(),
          (data) => renderInboxShow(data, globalOptions.color),
          streams,
        );
      }),
    );

  inbox
    .command('rename <from> <to>')
    .description('change the name an inbox is known by')
    .action(
      act(async (context, _globalOptions, from: string, to: string) => {
        writeResult(
          await inboxRename(context, from, to),
          output(),
          (data) => `Renamed "${data.from}" to "${data.to}".`,
          streams,
        );
      }),
    );

  inbox
    .command('policy <alias>')
    .description('how sending from this inbox, and loosening its settings, must be approved (looser needs approval)')
    .option('--send <policy>', 'how a send is approved: chat | confirm | never')
    .option('--change <policy>', 'how a loosening of its settings is approved: chat | confirm')
    .option('--approval <id>', 'apply the change this approval was given for')
    .action(
      act(async (context, globalOptions, alias: string, options: Options) => {
        // Which direction this goes is core's classifier's call, through the same change `gmail_inbox_policy` runs,
        // so the two surfaces cannot disagree about what needs approval.
        const change = inboxPolicyChange(context, alias, {
          sendPolicy: options.send === undefined ? undefined : String(options.send),
          changePolicy: options.change === undefined ? undefined : String(options.change),
        });
        writeResult(
          await changed(context, globalOptions, change, options.approval),
          output(),
          (data) =>
            [
              ...(options.send === undefined
                ? []
                : [`Sending from "${data.alias}" now needs: ${data.sendPolicy} (was ${data.previous}).`]),
              ...(options.change === undefined
                ? []
                : [`Loosening "${data.alias}" now needs: ${data.changePolicy} (was ${data.previousChangePolicy}).`]),
              // What a change to never did to the approvals prepared before it.
              ...(data.fenced === undefined ? [] : describeFenceReport(data.fenced)),
            ].join('\n'),
          streams,
        );
      }),
    );

  inbox
    .command('import [source]')
    .description(
      'copy the mailboxes set up in another Gmail MCP server (default: @artymclabin/gmail-mcp; needs a change approval)',
    )
    .option('--dir <path>', 'where that server keeps its files', '~/.gmail-mcp')
    .option('--name <name>', 'register its OAuth client under this name', 'imported')
    .addOption(new Option('--store <store>', 'where secrets are kept (first time only)').choices([...STORE_KINDS]))
    .option('--dry-run', 'say what would be imported, and change nothing', false)
    .option(
      '--rename <old=new>',
      'import one under another name (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--approval <id>', 'apply the import this approval was given for')
    .action(
      act(async (context, globalOptions, source: string | undefined, options: Options) => {
        if (source && source !== 'artymclabin') {
          throw new CommsError('USAGE', `"${source}" is not a source this can import from`, {
            hint: handoffSentence(
              context.handoffs.own(['inbox', 'import']),
              (command) => `Only \`artymclabin\` (and the servers sharing its file layout) is supported: ${command}.`,
            ),
          });
        }
        // A dry run changes nothing and asks nobody; the import itself connects accounts, and is approved first.
        const change = inboxImportChange(context, {
          dir: options.dir ? String(options.dir) : undefined,
          clientName: options.name ? String(options.name) : undefined,
          store: options.store === undefined ? undefined : String(options.store),
          dryRun: Boolean(options.dryRun),
          renames: Array.isArray(options.rename) ? options.rename.map(String) : [],
        });
        const result = await changed(context, globalOptions, change, options.approval);
        writeResult(result, output(), (data) => renderImport(data, globalOptions.color), streams);
      }),
    );

  inbox
    .command('remove <alias>')
    .description('disconnect a mailbox and delete its token (needs a change approval)')
    .option('--revoke', 'also ask Google to revoke the token (may affect other tools sharing the grant)', false)
    .option('--approval <id>', 'apply the removal this approval was given for')
    .action(
      act(async (context, globalOptions, alias: string, options: Options) => {
        writeResult(
          await changed(
            context,
            globalOptions,
            inboxRemoveChange(context, alias, { revoke: Boolean(options.revoke) }),
            options.approval,
          ),
          output(),
          (data) =>
            `Disconnected "${data.alias}" (${data.email}).\n` +
            (data.revoked
              ? 'Its token was revoked with Google.'
              : 'Its token was not revoked. To revoke it with Google: https://myaccount.google.com/connections') +
            (data.orphanedSecret
              ? `\nIts token could not be deleted from this machine: remove ${data.orphanedSecret} from the secret store${
                  data.orphanRecorded
                    ? handoffSentence(context.handoffs.own(['doctor']), (command) => ` (${command} lists it).`, {
                        instead: '. The doctor lists it.',
                      })
                    : '. It could not be recorded either, so nothing else will list it.'
                }`
              : '\nIts token was deleted from this machine.'),
          streams,
        );
      }),
    );

  // ---- reading ----------------------------------------------------------------
  program
    .command('search <query>')
    .description('search across mailboxes, newest first')
    .option('--inbox <alias...>', 'search these mailboxes (default: all)')
    .option('--all', 'search every connected mailbox', false)
    .option('--messages', 'return messages rather than threads', false)
    .option('--limit <number>', 'how many rows: 1 to 50 (default 20)')
    .option('--cursor <cursor>', 'continue a previous search')
    .option('--include-spam-trash', 'include spam and trash', false)
    .action(
      act(async (context, globalOptions, query: string, options: Options) => {
        const result = await search(context, {
          query,
          inboxes: options.all ? 'all' : (options.inbox as string[] | undefined),
          kind: options.messages ? 'messages' : 'threads',
          limit: options.limit,
          cursor: options.cursor ? String(options.cursor) : undefined,
          includeSpamTrash: Boolean(options.includeSpamTrash),
        });
        writeResult(result, output(), (data) => renderSearch(data, globalOptions.color), streams);
      }),
    );

  program
    .command('read <messageId>')
    .description('read one message: headers, body, attachments and what was hidden in it')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--quoted', 'keep quoted history and signatures', false)
    .option('--max-chars <number>', 'how much body to return')
    .option('--offset <number>', 'continue from this character')
    .action(
      act(async (context, globalOptions, messageId: string, options: Options) => {
        const result = await readMessage(context, String(options.inbox), messageId, {
          includeQuoted: Boolean(options.quoted),
          maxChars: options.maxChars,
          offset: options.offset,
        });
        writeResult(result, output(), (data) => renderMessage(data, globalOptions.color), streams);
      }),
    );

  program
    .command('thread <threadId>')
    .description('read a whole conversation, oldest first')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--quoted', 'keep quoted history and signatures', false)
    .option('--max-chars <number>', 'how much of each body to return')
    .action(
      act(async (context, globalOptions, threadId: string, options: Options) => {
        const result = await readThread(context, String(options.inbox), threadId, {
          includeQuoted: Boolean(options.quoted),
          maxChars: options.maxChars,
        });
        writeResult(result, output(), (data) => renderThread(data, globalOptions.color), streams);
      }),
    );

  program
    .command('timeline <threadId>')
    .description('what happened in a conversation, computed from the messages')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .addOption(new Option('--format <format>', 'how to render it').choices(['md', 'json', 'mermaid']))
    .option('--business-hours', 'count waiting time in working hours only', false)
    .action(
      act(async (context, _globalOptions, threadId: string, options: Options) => {
        const result = await threadTimeline(context, String(options.inbox), threadId, {
          businessHours: Boolean(options.businessHours),
        });
        const format = String(options.format ?? 'md');
        writeResult(
          format === 'json' ? result.timeline : result,
          output(),
          () => (format === 'mermaid' ? result.mermaid : result.markdown),
          streams,
        );
      }),
    );

  const attachments = program.command('attachments').description('find and download files people sent');
  attachments
    .command('find')
    .description('find attachments across mailboxes')
    .option('--inbox <alias...>', 'search these mailboxes (default: all)')
    .option('--from <address>', 'only from this sender')
    .option('--filename <text>', 'name or extension')
    .option('--after <date>', 'only after this date')
    .option('--before <date>', 'only before this date')
    .option('--min-bytes <number>', 'at least this big')
    .option('--max-bytes <number>', 'at most this big')
    .option('--type <mimeType>', 'only this content type')
    .option('--query <query>', 'extra Gmail search syntax')
    .option('--limit <number>', 'how many rows: 1 to 100 (default 25)')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await findAttachments(context, {
          inboxes: options.inbox as string[] | undefined,
          from: options.from ? String(options.from) : undefined,
          filename: options.filename ? String(options.filename) : undefined,
          after: options.after ? String(options.after) : undefined,
          before: options.before ? String(options.before) : undefined,
          minBytes: options.minBytes,
          maxBytes: options.maxBytes,
          mimeType: options.type ? String(options.type) : undefined,
          query: options.query ? String(options.query) : undefined,
          limit: options.limit,
        });
        writeResult(
          result,
          output(),
          (data) => renderAttachments(data, globalOptions.color, context.handoffs),
          streams,
        );
      }),
    );
  attachments
    .command('download <messageId...>')
    .description(
      'save the attachments of one or more messages where you say: Downloads, the current folder, or a folder you name',
    )
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--part <partId>', 'one specific attachment')
    .option('--max-files <number>', 'stop after this many files: 1 to 200 (default 50)')
    .option(
      '--to <where>',
      'where to save: downloads, current, or a folder (absolute, or starting with ~) — alone only at your own terminal',
    )
    .option(
      '--choice <id>',
      'the choice id the question came with: beside --to, or alone once the person answered it with approve',
    )
    // Removed: the person chooses the folder now. Kept only to say so, rather than as Commander's "unknown option".
    .addOption(new Option('--out <subpath>').hideHelp())
    .action(
      act(async (context, globalOptions, messageIds: string[], options: Options) => {
        refuseRetiredOut(options.out, 'cli');
        const inbox = String(options.inbox);
        const part = options.part ? String(options.part) : undefined;
        const result = await downloadAtTerminal<DownloadQuestion>({
          core: context.core,
          download: (answer) =>
            downloadAttachments(
              context,
              inbox,
              messageIds.map((messageId) => ({ messageId, partId: part })),
              { maxFiles: options.maxFiles, ...answer },
            ),
          to: options.to === undefined ? undefined : String(options.to),
          choice: options.choice === undefined ? undefined : String(options.choice),
          env,
          output: output(),
          noInput: globalOptions.noInput,
          // Core makes it this installation's own command, located, with the downloads folder pinned beside the rest.
          rerun: [
            'attachments',
            'download',
            ...messageIds,
            '--inbox',
            inbox,
            ...(part === undefined ? [] : ['--part', part]),
            ...(options.maxFiles === undefined ? [] : ['--max-files', String(options.maxFiles)]),
          ],
          render: (question) => renderDownloadQuestion(question, globalOptions.color),
          streams,
        });
        writeResult(result as DownloadResult, output(), (data) => renderDownloads(data, globalOptions.color), streams);
      }),
    );

  program
    .command('contacts <query>')
    .description('find someone’s address: from the address book, from people written to, and from past mail')
    .option('--inbox <alias...>', 'search these mailboxes (default: all)')
    .addOption(
      new Option('--sources <source...>', 'where to look; all three when left out').choices([...CONTACT_SOURCES]),
    )
    .option('--limit <number>', 'how many rows: 1 to 50 (default 20)')
    .action(
      act(async (context, globalOptions, query: string, options: Options) => {
        const result = await searchContacts(context, query, {
          inboxes: options.inbox as string[] | undefined,
          sources: options.sources as string[] | undefined,
          limit: options.limit,
        });
        writeResult(result, output(), (data) => renderContacts(data, globalOptions.color), streams);
      }),
    );

  program
    .command('followups')
    .description('conversations waiting on somebody')
    .option('--inbox <alias...>', 'these mailboxes (default: all)')
    .addOption(new Option('--direction <who>', 'who is being waited on').choices([...FOLLOW_UP_DIRECTIONS]))
    .option('--older-than <days>', 'only threads quiet for this long')
    .option('--lookback <days>', 'how far back to look')
    .option('--limit <number>', 'how many rows: 1 to 50 (default 20)')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await followUps(context, {
          inboxes: options.inbox as string[] | undefined,
          direction: options.direction === undefined ? undefined : String(options.direction),
          olderThanDays: options.olderThan,
          lookbackDays: options.lookback,
          limit: options.limit,
        });
        writeResult(result, output(), (data) => renderFollowUps(data, globalOptions.color), streams);
      }),
    );

  program
    .command('export <id>')
    .description('write a message or a thread to a file, to read without filling the conversation')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--thread', 'export the whole conversation', false)
    .addOption(new Option('--format <format>', 'md, json or eml').choices([...EXPORT_FORMATS]))
    .option('--out <subpath>', 'a folder inside the downloads root')
    .option('--quoted', 'keep quoted history', false)
    .action(
      act(async (context, _globalOptions, id: string, options: Options) => {
        const result = await exportMail(context, String(options.inbox), id, {
          thread: Boolean(options.thread),
          format: options.format === undefined ? undefined : String(options.format),
          out: options.out ? String(options.out) : undefined,
          includeQuoted: Boolean(options.quoted),
        });
        writeResult(
          result,
          output(),
          (data) =>
            `Wrote ${data.kind === 'thread' ? `${data.messageCount} messages` : 'the message'} to ${data.path} ` +
            `(${Math.round(data.bytes / 1024)} KB, ${data.format}).`,
          streams,
        );
      }),
    );

  // ---- drafts -----------------------------------------------------------------
  // Everything here writes to the Drafts folder and nothing else. A draft is the finished article sitting where the
  // user can read it, change it and send it themselves; sending it from here is a separate, approved act.
  const draft = program.command('draft').description('write messages into Drafts — never sent from here');

  withDraftOptions(draft.command('new').description('write a new message into Drafts'))
    .requiredOption('--inbox <alias>', 'which mailbox')
    .requiredOption('--to <address...>', 'who it goes to')
    .option('--subject <subject>', 'the subject line')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await createDraft(context, String(options.inbox), await draftInput(options));
        writeResult(result, output(), (data) => renderDraft(data, globalOptions.color), streams);
      }),
    );

  withDraftOptions(draft.command('reply <messageId>').description('reply, reply to all, or forward'))
    .requiredOption('--inbox <alias>', 'which mailbox')
    .addOption(new Option('--mode <mode>', 'how to answer').choices([...REPLY_MODES]))
    .option('--to <address...>', 'who it goes to (a forward needs this; a reply computes it)')
    .action(
      act(async (context, globalOptions, messageId: string, options: Options) => {
        const result = await replyDraft(context, String(options.inbox), messageId, {
          ...(await draftInput(options)),
          mode: options.mode === undefined ? undefined : String(options.mode),
          quote: options.quote !== false,
        });
        writeResult(result, output(), (data) => renderDraft(data, globalOptions.color), streams);
      }),
    );

  draft
    .command('list')
    .description('the drafts in a mailbox')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--limit <number>', 'how many rows (default 20)')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await listDrafts(context, String(options.inbox), options.limit);
        writeResult(result, output(), (data) => renderDrafts(data, globalOptions.color), streams);
      }),
    );

  draft
    .command('show <draftId>')
    .description('read a draft back, with the preview the sender would approve')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .action(
      act(async (context, globalOptions, draftId: string, options: Options) => {
        const result = await getDraft(context, String(options.inbox), draftId);
        writeResult(result, output(), (data) => renderDraft(data, globalOptions.color), streams);
      }),
    );

  withDraftOptions(
    draft
      .command('update <draftId>')
      .description(
        'change a draft — the body, files and headers you do not restate are kept; a new body comes only from --text or --file (`--file -` for standard input)',
      ),
  )
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--to <address...>', 'replace the recipients')
    .option('--subject <subject>', 'replace the subject line')
    .action(
      act(async (context, globalOptions, draftId: string, options: Options) => {
        const input = await draftInput(options, { bodyOptional: true });
        const result = await updateDraft(context, String(options.inbox), draftId, input);
        writeResult(result, output(), (data) => renderDraft(data, globalOptions.color), streams);
      }),
    );

  draft
    .command('delete <draftId>')
    .description('throw a draft away')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .action(
      act(async (context, _globalOptions, draftId: string, options: Options) => {
        const result = await deleteDraft(context, String(options.inbox), draftId);
        writeResult(result, output(), (data) => `Deleted draft ${data.draftId}.`, streams);
      }),
    );

  // ---- sending ------------------------------------------------------------------
  // Two commands, deliberately. `send prepare` shows what would go and records an approval; `send` sends what was
  // approved and nothing else. They are separate because an agent that can do both in one step can send mail nobody
  // read, and the whole point of this package is that it cannot.
  const send = program
    .command('send')
    .description('send a draft that has been prepared and approved — never anything else');

  send
    .command('prepare <draftId>')
    .description('show exactly what would be sent, and record an approval for it')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option(
      '--as <who>',
      'who it appears to come from: agent (labelled in the From line) or me (unlabelled, only when the person said so)',
    )
    .action(
      act(async (context, globalOptions, draftId: string, options: Options) => {
        const result = await prepareSend(context, String(options.inbox), draftId, {
          as: options.as === undefined ? undefined : String(options.as),
        });
        writeResult(
          result,
          output(),
          (data) => renderSendPreparation(data, globalOptions.color, context.handoffs),
          streams,
        );
      }),
    );

  send
    .command('execute <id>')
    .description('send it by approval id; legacy callers may also pass a draft id and --approval')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--approval <id>', 'legacy form: the approval when <id> is the draft id')
    .option('--expect-to <address...>', 'legacy exact check: To recipients; `none` for nobody')
    .option('--expect-subject <subject>', 'legacy exact check: subject; `none` for an empty one')
    .option('--expect-cc <address...>', 'legacy exact check: Cc recipients; `none` for nobody')
    .option('--expect-bcc <address...>', 'legacy exact check: Bcc recipients; `none` for nobody')
    .action(
      act(async (context, globalOptions, id: string, options: Options) => {
        const hasExpect = [options.expectTo, options.expectCc, options.expectBcc, options.expectSubject].some(
          (value) => value !== undefined,
        );
        if (hasExpect && (options.expectTo === undefined || options.expectSubject === undefined)) {
          throw new CommsError('USAGE', '--expect-to and --expect-subject must be given together');
        }
        const expectSubject = options.expectSubject === undefined ? undefined : String(options.expectSubject);
        const legacy = options.approval !== undefined;
        const result = await (deps.executeSend ?? executeSend)(context, String(options.inbox), {
          ...(legacy ? { draftId: id } : {}),
          approvalId: legacy ? String(options.approval) : id,
          ...(hasExpect
            ? {
                expect: {
                  to: expected(options.expectTo),
                  cc: expected(options.expectCc),
                  bcc: expected(options.expectBcc),
                  subject: expectSubject as string,
                },
                expectSubjectNone: expectSubject === 'none',
              }
            : {}),
        });
        writeResult(result, output(), (data) => renderSent(data, globalOptions.color), streams);
      }),
    );

  send
    .command('list')
    .description('approvals waiting, what each one is for, and the drafts whose last preparation expired')
    .option('--inbox <alias>', 'only this mailbox')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await listApprovals(context, { inbox: options.inbox ? String(options.inbox) : undefined });
        writeResult(result, output(), (data) => renderApprovals(data, globalOptions.color), streams);
      }),
    );

  send
    .command('wait <approvalId>')
    .description(
      'wait for an approval to be usable or finished, and say where it stands — it only looks, and never sends',
    )
    .option(
      '--wait-seconds <n>',
      `how long to wait: 30 when left out, ${MAX_APPROVAL_WAIT_SECONDS} at most, 0 for the status now`,
    )
    .action(
      act(async (context, _globalOptions, approvalId: string, options: Options) => {
        const result = await waitForApproval(context.core, approvalId, {
          waitSeconds: wholeNumber(options.waitSeconds, {
            name: '--wait-seconds',
            min: 0,
            max: MAX_APPROVAL_WAIT_SECONDS,
          }),
          channel: 'gmail',
        });
        writeResult(result, output(), renderApprovalWait, streams);
      }),
    );

  send
    .command('cancel <approvalId>')
    .description('cancel an approval — refusing to send is never the dangerous direction')
    .action(
      act(async (context, _globalOptions, approvalId: string) => {
        const stored = await revokeApproval(context, approvalId);
        const config = await context.config();
        const aliases = new Map(Object.entries(config.inboxes).map(([alias, inbox]) => [inbox.id, alias]));
        // Its public object, through the same Gmail field helpers as `send list` (design §D8; CUE-413).
        const { approval: result } = gmailApprovalView(stored, await context.core.approvals.outcomeOf(stored), aliases);
        writeResult(
          result,
          output(),
          (data) => `Approval ${data.approvalId} is ${data.state}. Nothing was sent.`,
          streams,
        );
      }),
    );

  program
    .command('approve <approvalId>')
    .description(
      'approve a send or a change at this terminal: read it, then type the code back — or answer where a download is saved',
    )
    .action(
      act(async (context, globalOptions, approvalId: string) => {
        // The one command an agent may not run for the user, checked before the id is even looked up, so an agent is
        // told to hand this to a person whatever it passed. A shell agent can defeat this — `script -q /dev/null` makes
        // any command see a terminal — and SECURITY.md says so. It is a speed bump against the ordinary case, not a
        // boundary; the boundary for an agent with a shell is the `never` policy and sending from Gmail.
        const marker = agentMarker(env);
        if (marker) {
          throw new CommsError('APPROVAL_REQUIRED', 'only a person can approve a send or a change, not an agent', {
            // And the wait that learns when they have (design 2026-10-05 §D7).
            hint: approveRefusedHint(context.handoffs, approvalId),
            details: { marker },
          });
        }
        if (!canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput })) {
          throw new CommsError('APPROVAL_REQUIRED', 'approving a send or a change needs an interactive terminal', {
            hint: handoffSentence(
              context.handoffs.own(['approve', approvalId]),
              (command) => `Run ${command} directly in a terminal, or send the draft from Gmail.`,
              { instead: 'Send the draft from Gmail.' },
            ),
          });
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
         * terminal — the one way to answer it when the mailbox's change policy is `confirm`, since an agent cannot type
         * into this. The download that asked saves where this says, when it is made again with the choice id alone.
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
        const prompt = await beginApproval(context, approvalId);
        streams.stdout.write(`${prompt.preview}\n\n`);
        const answer = await askFor(streams, {
          question: `Type ${paint(globalOptions.color, 'bold', prompt.challenge)} to send this, or press Enter to cancel: `,
        });
        if (!answer.trim()) {
          await revokeApproval(context, approvalId);
          streams.stdout.write('Cancelled. Nothing was sent.\n');
          return;
        }
        await finishApproval(context, approvalId, answer);
        streams.stdout.write('Approved. The agent can send it now — this command approves, it does not send.\n');
      }),
    );

  // The clients the person chose to trust with approval forms. Empty by default and fail-closed: `clientInfo.name` is
  // self-reported, and no MCP mechanism proves a person answered a form, so a name gets here only by the person's
  // decision, after a probe whose code came back.
  const confirmClients = program
    .command('confirm-clients')
    .description('MCP clients you chose to trust with approval forms');

  confirmClients
    .command('list')
    .description('the clients on the list')
    .action(
      act(async (context, _globalOptions) => {
        writeResult(
          await listConfirmClients(context),
          output(),
          (data) =>
            data.length === 0
              ? 'No client may show approval forms. Sends under "confirm" are approved in a terminal, or from Gmail.'
              : `Trusted to show approval forms: ${data.join(', ')}.`,
          streams,
        );
      }),
    );

  confirmClients
    .command('add <name>')
    .description('trust a client that has just passed the probe (needs a change approval)')
    .option('--approval <id>', 'apply the change this approval was given for')
    .action(
      act(async (context, globalOptions, name: string, options: Options) => {
        // The probe is the evidence and the approval is the decision: the change refuses a client that has not
        // passed the probe before anybody is asked, and a person approves the rest as every loosening is approved.
        const clients = await changed(context, globalOptions, confirmClientAddChange(context, name), options.approval);
        writeResult(clients, output(), (data) => `Trusted to show approval forms: ${data.join(', ')}.`, streams);
      }),
    );

  confirmClients
    .command('remove <name>')
    .description('stop trusting a client — never needs permission')
    .action(
      act(async (context, _globalOptions, name: string) => {
        const clients = await removeConfirmClient(context, name);
        writeResult(
          clients,
          output(),
          (data) =>
            data.length === 0 ? 'No client may show approval forms now.' : `Still trusted: ${data.join(', ')}.`,
          streams,
        );
      }),
    );

  // ---- organising ---------------------------------------------------------------
  program
    .command('organise')
    .alias('organize')
    .description('label, archive, star and mark read — every change reversible, and previewable with --dry-run')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--message <id...>', 'these messages')
    .option('--thread <id...>', 'every message in these conversations')
    .option('--add <label...>', 'add these labels (by name or id)')
    .option('--remove <label...>', 'remove these labels')
    .option('--archive', 'take it out of the inbox', false)
    .option('--read', 'mark it read', false)
    .option('--unread', 'mark it unread', false)
    .option('--star', 'star it', false)
    .option('--unstar', 'unstar it', false)
    .option('--dry-run', 'say what would change and change nothing', false)
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await modify(context, String(options.inbox), {
          messageIds: options.message as string[] | undefined,
          threadIds: options.thread as string[] | undefined,
          addLabels: options.add as string[] | undefined,
          removeLabels: options.remove as string[] | undefined,
          archive: Boolean(options.archive),
          markRead: Boolean(options.read),
          markUnread: Boolean(options.unread),
          star: Boolean(options.star),
          unstar: Boolean(options.unstar),
          dryRun: Boolean(options.dryRun),
        });
        writeResult(result, output(), (data) => renderModify(data, globalOptions.color, context.handoffs), streams);
      }),
    );

  program
    .command('organise-undo')
    .alias('organize-undo')
    .description('put an organising change back, from the `undo` a --json organise returned')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--from <path>', 'a file holding the undo array; `-` reads standard input', '-')
    .action(
      act(async (context, _globalOptions, options: Options) => {
        const source = String(options.from);
        const raw =
          source === '-'
            ? await (async () => {
                const { readBoundedStream } = await import('../operations/small-file.ts');
                const piped = await readBoundedStream(streams.stdin as NodeJS.ReadableStream, 4 * 1024 * 1024);
                if (!piped.ok) {
                  throw new CommsError(
                    'USAGE',
                    piped.problem === 'too-large'
                      ? 'that is far larger than an undo receipt'
                      : 'the piped undo receipt could not be read to the end',
                    { hint: UNDO_HINT },
                  );
                }
                return piped.text;
              })()
            : await (async () => {
                // A receipt this tool wrote, so it is JSON and it is small. The bound is generous — a hundred
                // thousand message ids — and it exists so `--from /dev/zero` fails instead of never returning.
                const { readSmallFile } = await import('../operations/small-file.ts');
                const content = await readSmallFile(source, { follow: true, maxBytes: 4 * 1024 * 1024 });
                if (!content.ok) {
                  throw new CommsError(
                    content.problem === 'missing' ? 'NOT_FOUND' : 'USAGE',
                    `cannot read the undo receipt at ${source}`,
                    { hint: 'Pass the file an organise run with --json wrote, or pipe it in on stdin.' },
                  );
                }
                return content.text;
              })();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new CommsError('BAD_DATA', 'that is not the undo from an organise result', {
            hint: UNDO_HINT,
          });
        }
        // The envelope or the array itself, because both are things a person plausibly pipes in.
        const entries = Array.isArray(parsed)
          ? parsed
          : ((parsed as { data?: { undo?: unknown } })?.data?.undo ?? (parsed as { undo?: unknown })?.undo);
        if (!Array.isArray(entries)) {
          throw new CommsError('BAD_DATA', 'that JSON has no undo array in it', {
            hint: UNDO_HINT,
          });
        }
        const result = await applyUndo(context, String(options.inbox), entries as never);
        writeResult(
          result,
          output(),
          (data) => `Put ${data.messages} message(s) back in ${data.inbox}, exactly as each one was.`,
          streams,
        );
      }),
    );

  program
    .command('trash')
    .description('move mail to the bin, or take it out again — nothing is ever deleted outright')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--message <id...>', 'these messages')
    .option('--thread <id...>', 'every message in these conversations')
    .option('--undo', 'take them out of the bin instead', false)
    .option('--dry-run', 'say what would move and move nothing', false)
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await trash(context, String(options.inbox), {
          messageIds: options.message as string[] | undefined,
          threadIds: options.thread as string[] | undefined,
          undo: Boolean(options.undo),
          dryRun: Boolean(options.dryRun),
        });
        writeResult(result, output(), (data) => renderTrash(data, globalOptions.color), streams);
      }),
    );

  program
    .command('label <name>')
    .description('create a label, or find the one already there')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .action(
      act(async (context, _globalOptions, name: string, options: Options) => {
        const result = await createLabel(context, String(options.inbox), name);
        writeResult(
          result,
          output(),
          (data) =>
            data.existed ? `"${data.name}" already exists (${data.id}).` : `Created "${data.name}" (${data.id}).`,
          streams,
        );
      }),
    );

  program
    .command('labels')
    .description('the labels in a mailbox')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .action(
      act(async (context, globalOptions, options: Options) => {
        writeResult(
          await listLabels(context, String(options.inbox)),
          output(),
          (data) => renderLabels(data, globalOptions.color),
          streams,
        );
      }),
    );

  program
    .command('sendas')
    .description('the addresses this mailbox can send as')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .action(
      act(async (context, globalOptions, options: Options) => {
        writeResult(
          await listSendAs(context, String(options.inbox)),
          output(),
          (data) => renderSendAs(data, globalOptions.color),
          streams,
        );
      }),
    );

  // ---- one-offs ---------------------------------------------------------------
  program
    .command('whoami')
    .description('what Google says about an inbox, and how it is configured')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .action(
      act(async (context, globalOptions, options: Options) => {
        writeResult(
          await whoami(context, String(options.inbox)),
          output(),
          (data) => renderWhoami(data, globalOptions.color),
          streams,
        );
      }),
    );

  const mcp = program
    .command('mcp')
    .description('run the MCP server on stdio, for a client to connect to')
    .option('--inbox <alias>', 'serve only this mailbox')
    .option('--read-only', 'leave out every tool that changes the mailbox', false)
    .action(
      act(async (context, _globalOptions, options: Options) => {
        ran = true;
        // Every program this server starts inherits the mark, so none of them can make a person's read (§4).
        markMcpServerProcess(env, 'gmail');
        const startStdioServer = deps.startMcp ?? (await import('../mcp/stdio-entry.ts')).startStdioServer;
        // Returns when the client disconnects.
        await startStdioServer({
          ...deps,
          core: context.core,
          env,
          pathOverrides: context.core.pathOverrides,
          platform,
          inbox: options.inbox ? String(options.inbox) : undefined,
          readOnly: Boolean(options.readOnly),
        });
      }),
    );

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
      'gmail',
    )
    .option('--inbox <alias>', 'serve only this mailbox')
    .option('--read-only', 'leave out every tool that changes the mailbox', false)
    .addOption(new Option('--launcher <launcher>', 'how the server is started').choices(['managed', 'npx', 'local']))
    .option('--no-verify', 'do not start the server to check the entry works')
    .option('--force', "replace this server's own earlier entry — this is how you upgrade", false)
    .option('--print', 'only print what would be written', false)
    .option('--approval <id>', 'register the server this approval was given for')
    .action(
      act(async (context, globalOptions, options: Options) => {
        if (!options.client) {
          throw new CommsError('USAGE', 'name the client with --client', {
            hint: handoffSentence(
              context.handoffs.own(['mcp', 'install', '--client', 'claude-code']),
              (command) => `For example: ${command}.`,
            ),
          });
        }
        /*
         * The parent's value counts too.
         *
         * `mcp` and `mcp install` both take this flag — one pins the server being *run*, the other the server
         * being *registered* — and Commander gives a repeated name to the parent, so the subcommand's own option
         * was always undefined. `mcp install --inbox work` therefore registered an **unpinned** server: one meant
         * to reach a single mailbox reaching every one on the machine, silently, which is the opposite of what
         * the flag is for. Shipped that way in 0.4.0.
         */
        const pinned = options.inbox ?? mcp.opts().inbox;
        /*
         * Registering a server is a change a person approves (design §3.1), and this is the change
         * `comms_server_install` makes, with this package's own product for its version and its code. It
         * registered with no approval at all while the tool asked for one: the same operation, refused on one
         * surface and not the other, and a way for an agent to hand a client a new set of tools unasked. So an
         * approval an agent got from the tool is claimed here with `--approval`, and one from here by the tool.
         * `--print` and `--client json` write nothing, and so ask nobody.
         */
        const { GMAIL_MCP } = await import('../mcp/install.ts');
        const result = await changed(
          context,
          globalOptions,
          serverInstallChange(
            context.core,
            env,
            {
              channel: 'gmail',
              client: options.client as SupportedClient,
              name: String(options.name ?? 'gmail'),
              inbox: pinned ? String(pinned) : undefined,
              /*
               * The same, for `--read-only`, which the `--inbox` fix above missed: `mcp install --read-only`
               * registered a server with every tool that trashes, labels and drafts, and doctor's repair — which
               * keeps `--read-only` precisely so a narrowed server stays narrow — lost it the same way.
               */
              readOnly: Boolean(options.readOnly || mcp.opts().readOnly),
              launcher: options.launcher as Launcher | undefined,
              noVerify: options.verify === false,
              print: options.print === true,
              force: Boolean(options.force),
            },
            GMAIL_MCP,
          ),
          options.approval,
        );
        // Asked to register and did not — the client's CLI is not on PATH — or registered an entry that did not
        // start. The result is still printed, but a zero exit told a script (or an agent) that it worked.
        const status = installExitStatus(result);
        if (status !== EXIT_CODES.OK) softExit = status;
        writeResult(result, output(), (data) => renderInstall(data, globalOptions.color), streams);
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
    .option('--approval <id>', 'remove the runtimes this approval was given for')
    .action(
      act(async (context, globalOptions, options: Options) => {
        // The change `comms_server_prune` makes: a dry run is free; removing is approved as the list it shows, and
        // removes no more than that list, because a deleted runtime cannot be taken back.
        const { GMAIL_MCP } = await import('../mcp/install.ts');
        const result = await changed(
          context,
          globalOptions,
          serverPruneChange(
            context.core,
            env,
            { channel: 'gmail', dryRun: options.dryRun === true, includePrinted: options.includePrinted === true },
            GMAIL_MCP,
          ),
          options.approval,
        );
        writeResult(result, output(), (data) => renderPrune(data, globalOptions.color), streams);
      }),
    );

  program
    .command('setup')
    .description('set this up from nothing: the Google client, a mailbox, and the agent connection')
    .option('--client-json <path>', 'the OAuth client JSON, if you already have it')
    .option('--inbox <alias>', 'the name to connect the first mailbox under')
    .option('--email <address>', 'the address that mailbox must turn out to be')
    .option('--client <name>', 'sign that mailbox in through this OAuth client')
    .option('--profile <file>', 'add this organisation profile before continuing setup')
    .option('--org-approval <id>', 'add the organisation profile this approval was given for')
    .addOption(
      new Option('--mcp-client <client>', 'register with this MCP client when the mailbox is connected').choices([
        'claude-code',
        'claude-desktop',
        'codex',
        'cursor',
        'gemini',
        'vscode',
      ]),
    )
    .option('--replace-server', 'replace an MCP entry of the same name that is already there', false)
    /*
     * `--store` exists here because without it this command dead-ends on a machine with no keychain.
     *
     * `clientAdd` defaults to the keychain, probes it, and on a headless Linux box tells you to run the command
     * again with `--store file` — a flag `setup` did not accept. The instruction was correct and impossible to
     * follow, in the one command whose whole purpose is to be where a new install starts.
     */
    .addOption(new Option('--store <store>', 'where secrets are kept (first time only)').choices([...STORE_KINDS]))
    .option('--move', 'delete the downloaded client JSON once its secret is stored', false)
    /*
     * Parity with `mcp install`, which has had this since the start. Without it `setup` could only ever register
     * the managed runtime — an `npm install` — so somebody working from a checkout had to leave this command to
     * get `--launcher local`.
     *
     * Both call sites are tested, the headless one through `cursor` — a client configured by a file rather than
     * by a CLI, so the registration lands on disk where a test can read which entry was written.
     */
    .addOption(new Option('--launcher <launcher>', 'how the server is started').choices(['managed', 'npx', 'local']))
    .option('--restart', 'walk the Google Cloud steps again even if a client is registered', false)
    .option('--approval <id>', 'register the client this approval was given for')
    /*
     * A second approval, and a second flag for it. The OAuth client and the server registration are two changes,
     * each approved for exactly what it does, and one run can meet both: `--approval` is spent on the first, so the
     * second could not be carried by the same flag without claiming one approval for the other change.
     */
    .option('--mcp-approval <id>', 'register the MCP server this approval was given for')
    .option('--no-tui', 'plain one-line prompts instead of lists and fields')
    .option('--no-browser', 'print the links instead of opening them')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const { loadSetupProfile, requireSetupTarget, setupClientChoiceNeedsMailbox, setupState, CONSOLE_STEPS } =
          await import('../operations/setup.ts');
        const out = streams.stderr;
        const bold = (text: string) => paint(globalOptions.color, 'bold', text);
        const dim = (text: string) => paint(globalOptions.color, 'dim', text);

        /**
         * The agent connection as a change: `setupRegistration`, the one `mcp install` and `comms_server_install`
         * make. An approval for it from either of those is claimed here with `--mcp-approval`, and one from here by
         * them.
         */
        const registration = async (client: string) => {
          // The mailbox this run connected with `--inbox`, when the entry in its place serves another: see `pinFor`.
          const pin = options.inbox ? await pinFor(client, String(options.inbox)) : undefined;
          return setupRegistration(context, {
            client,
            ...(options.launcher ? { launcher: String(options.launcher) } : {}),
            // `force` removes an existing entry before adding its replacement. Doing that silently, from a
            // headless run, would take somebody's working server away on the strength of a flag they passed for
            // a different reason — so it needs asking for, exactly as `mcp install` makes you ask.
            force: options.replaceServer === true,
            ...(pin ? { inbox: pin } : {}),
          });
        };
        const mcpApproval = typeof options.mcpApproval === 'string' ? options.mcpApproval : undefined;
        // This command again, without the approvals it carried: the OAuth client's is spent by the time the
        // registration is reached, and the registration's is the one to put back.
        const againForMcp = () => again(['--approval', '--mcp-approval']);

        const { interactionFor, askText, askChoice, askYesNo } = await import('./tui.ts');
        const mode = interactionFor({
          streams,
          env,
          json: Boolean(globalOptions.json),
          noInput: Boolean(globalOptions.noInput),
          noTui: options.tui === false,
          canPrompt: canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput }),
        });
        if (!options.profile) {
          refuseUnclaimedApproval(options.orgApproval, {
            message: '--org-approval goes with --profile: without it this run adds no organisation profile',
            hint: handoffSentence(
              context.handoffs.own(['setup', '--help'], { uses: [] }),
              (command) => `Run ${command} and include the --profile file the preview named. Nothing was done.`,
            ),
          });
        }

        const configBeforeProfile = await context.config();
        const profilePath = options.profile
          ? profileSourcePath(String(options.profile), context.env, context.cwd, context.handoffs)
          : undefined;
        const incomingProfile = profilePath ? await loadSetupProfile(profilePath, context.handoffs) : undefined;
        const incomingProfileHasGmail = incomingProfile?.profile.gmail !== undefined;
        /*
         * The client step is decided for the mailbox this run is adding only when a Gmail profile participates in
         * routing (design 2026-10-02 §D6). An incoming --profile will do so after approval; an installed Gmail
         * profile already does. Without either, setup keeps its pre-profile order: finish the ordinary client step,
         * then ask for a mailbox in the mailbox step below.
         */
        const clientChoiceNeedsMailbox = incomingProfileHasGmail || setupClientChoiceNeedsMailbox(configBeforeProfile);
        const startSetupSignIn = (signIn: Omit<StartOptions, 'mode' | 'setupWithoutGmailProfile'>) =>
          startSignIn(context, {
            ...signIn,
            mode: 'add',
            setupWithoutGmailProfile: !clientChoiceNeedsMailbox,
          });
        if (clientChoiceNeedsMailbox && mode !== 'none' && !options.inbox) {
          const organisationNames = incomingProfileHasGmail || configBeforeProfile.version === 2;
          options.inbox = await askText(mode, streams, {
            message: organisationNames ? 'A name for it: organisation/gmail' : 'A short name for it',
            placeholder: organisationNames ? 'acme/gmail' : 'work',
            ...(organisationNames ? {} : { defaultValue: 'work' }),
          });
          if (!options.email) {
            const address = await askText(mode, streams, {
              message: 'Which address (blank to choose in the browser)',
            });
            if (address) options.email = address;
          }
        }
        if (clientChoiceNeedsMailbox && !options.inbox) {
          throw new CommsError('USAGE', 'name the mailbox with --inbox before setup can choose its client', {
            hint: handoffSentence(
              context.handoffs.own(['setup', '--inbox', 'acme/gmail']),
              (command) => `Run ${command}, replacing acme/gmail with the name being added. Nothing was done.`,
            ),
          });
        }
        if (clientChoiceNeedsMailbox && options.inbox) requireSetupTarget(configBeforeProfile, String(options.inbox));

        if (profilePath) {
          await gatedChangeAtTerminal(
            context.core,
            orgAddChange(
              context.core,
              {
                file: profilePath,
                loadedProfile: incomingProfile,
                ...(options.store ? { store: String(options.store) } : {}),
                ...(typeof options.orgApproval === 'string' ? { approvalId: options.orgApproval } : {}),
              },
              {
                env: context.env,
                platform: context.platform,
                surface: context.surface,
                cwd: context.cwd,
                now: context.now,
              },
            ),
            {
              channel: 'gmail',
              approvalId: typeof options.orgApproval === 'string' ? options.orgApproval : undefined,
              env,
              output: { json: globalOptions.json || globalOptions.noInput, color: globalOptions.color },
              rerun: again(['--org-approval']),
              approvalFlag: '--org-approval',
              streams,
            },
          );
        }

        const setupStateOptions = (scanDownloads = true) => ({
          scanDownloads,
          ...(options.inbox ? { alias: String(options.inbox) } : {}),
          ...(options.email ? { email: String(options.email) } : {}),
          ...(options.client ? { client: String(options.client) } : {}),
        });
        let state = await setupState(context, setupStateOptions());
        if (mode !== 'none' && state.clientChoice?.organisationLabel) {
          out.write(`Your organisation, ${state.clientChoice.organisationLabel}, provides the Google client.\n\n`);
        }

        /*
         * Each approval this run carries is refused before anything is done, unless the run reaches the step that
         * claims it: `--approval` the OAuth client's registration, `--mcp-approval` the server's.
         *
         * The update check's stop lets the run through on either (design 2026-09-28 §2). One the run never reached was
         * dropped, and the steps before it — a sign-in started, a preview prepared — ran past the stop on an approval
         * nobody claimed: see core's `refuseUnclaimedApproval`. Which steps a run reaches is known from here. The
         * client step runs only while no client is registered, and with nobody to ask only with `--client-json`. The
         * registration comes last: with nobody to ask it is reached only past a mailbox already connected, with no
         * `--inbox` to sign in first — the mailbox step waits for a browser — and, where there is no client yet, with
         * the client's approval to register one on the way. At a terminal every step runs, and the registration claims
         * the approval only for a client named with `--mcp-client`: one picked from the list may be declined.
         */
        const headless = mode === 'none';
        const clientStep = state.next === 'client';
        const targetAlreadyConnected =
          clientChoiceNeedsMailbox && options.inbox && Array.isArray(state.inboxes)
            ? state.inboxes.includes(String(options.inbox))
            : false;
        if (!clientStep || (headless && !options.clientJson)) {
          refuseUnclaimedApproval(
            options.approval,
            clientStep
              ? {
                  message: '--approval goes with --client-json: without it this run registers no OAuth client',
                  hint: 'Run it again with --client-json <path> as well, as the preview named it. Nothing was done.',
                }
              : {
                  message: 'an OAuth client is already registered, so this run registers none and takes no --approval',
                  hint: handoffSentenceToFill(
                    context.handoffs.own(['client', 'add']),
                    ['<client_secret.json>'],
                    (command) => `Leave out --approval; ${command} registers another. Nothing was done.`,
                    { instead: 'Leave out --approval. Nothing was done.' },
                  ),
                },
          );
        }
        const stopsBefore = !options.mcpClient
          ? 'it names no client with --mcp-client'
          : !headless
            ? null
            : options.inbox && !targetAlreadyConnected
              ? 'it signs a mailbox in first, and that waits for a browser'
              : state.inboxes.length === 0
                ? 'no mailbox is connected yet, and connecting one waits for a browser'
                : clientStep && !(options.clientJson && options.approval !== undefined)
                  ? 'the OAuth client comes first, and this run does not register it'
                  : null;
        if (stopsBefore !== null) {
          refuseUnclaimedApproval(options.mcpApproval, {
            message: `this run does not reach the server's registration — ${stopsBefore} — so it takes no --mcp-approval`,
            hint: 'Carry it on the run that registers the server, as the preview named it. Nothing was done.',
          });
        }

        if (mode === 'none') {
          /*
           * Nobody is here to answer a question — but that is not the same as nobody wanting anything done.
           * An agent supplies the answers as flags, so each step either has what it needs and runs, or does not
           * and the run stops there and says so. Printing the plan and doing nothing, whatever it was given, was
           * the first version of this and it made every flag decorative.
           *
           * One step cannot be finished this way at all: consent is granted on Google's screen, in a browser
           * this command does not drive. So the mailbox step goes as far as producing the link and the command
           * that finishes it, and hands both back rather than waiting for something that is not going to happen.
           */
          const did: string[] = [];
          // What the install had to say — a pin it kept from the entry it replaced, another Gmail server with send
          // tools. The interactive branch prints them with the rest of the install; this one dropped them.
          const warnings: string[] = [];
          let blocked: {
            step: string;
            needs: string;
            hint?: string;
            /** A change waiting for a person: what they read, and the approval to run this again with. */
            approvalId?: string;
            policy?: string;
            preview?: string;
            expiresAt?: string;
          } | null = null;
          let handoff: SetupHandoff | null = null;

          if (state.next === 'client') {
            const path = options.clientJson ? String(options.clientJson) : '';
            if (path) {
              // The same change as `client add`, approved the same way: an agent gets the preview and the approval
              // id, and runs this again with `--approval <id>` once the person has agreed.
              const added = await changed(
                context,
                globalOptions,
                clientAddChange(context, {
                  path,
                  name: 'desktop',
                  ...(options.store ? { store: String(options.store) } : {}),
                  ...(options.move === true ? { move: true } : {}),
                }),
                options.approval,
              );
              did.push(
                `registered the OAuth client as "${added.name}" (secret in the ${added.store} store)` +
                  (added.sourceRemoved ? ', and removed the downloaded file' : ''),
              );
              // Scanned, not skipped: this `state` is folded into the report below, and the report lists what is
              // in the downloads directory.
              state = await setupState(context, setupStateOptions());
            } else {
              const usable = state.candidates.find((candidate) => candidate.kind === 'desktop');
              blocked = {
                step: 'client',
                needs: '--client-json <path>',
                ...(usable ? { hint: `a Desktop client is already downloaded: ${usable.path}` } : {}),
              };
            }
          }

          // An explicit `--inbox` is a request, not a step in a sequence: most people have more than one
          // mailbox, and the first one connected must not close the door on the rest.
          if (!blocked && (state.next === 'inbox' || (options.inbox && !targetAlreadyConnected))) {
            const alias = options.inbox ? String(options.inbox) : '';
            if (alias) {
              /*
               * `--mcp-client` asked for a step this run stops before: the registration comes after the mailbox, and
               * the mailbox waits for a browser. So it goes with the sign-in, and the finish that connects the
               * mailbox registers the server too — approved there, as this run would have had it approved. It used
               * to be dropped here, and a setup asked for both ended with one of them and exit 0.
               */
              const registerWith: RegistrationIntent | undefined = options.mcpClient
                ? {
                    client: String(options.mcpClient),
                    ...(options.launcher ? { launcher: String(options.launcher) } : {}),
                    // `--replace-server` too: the finish makes the registration this run would have, not a narrower one.
                    ...(options.replaceServer === true ? { replace: true } : {}),
                  }
                : undefined;
              const started = await startSetupSignIn({
                alias,
                ...(options.email ? { email: String(options.email) } : {}),
                ...(options.client ? { client: String(options.client) } : {}),
                detached: true,
                ...(deps.listenerCommand ? { listenerCommand: deps.listenerCommand } : {}),
                ...(registerWith ? { registerWith } : {}),
              });
              handoff = {
                authUrl: started.authUrl,
                finish: context.handoffs.own([
                  'inbox',
                  'add',
                  '--finish',
                  started.flowId,
                  '--wait',
                  String(FINISH_WAIT_SECONDS),
                ]),
                ...(registerWith ? { registerWith } : {}),
              };
              did.push(`started a sign-in for "${alias}"`);
              blocked = {
                step: 'inbox',
                needs: 'the link opened and approved in a browser',
                hint: registerWith
                  ? `This command does not open browsers or grant consent. Give the user the link, then run the finish command: it also registers the server with ${registerWith.client}, and stops for the person's approval of that.`
                  : 'This command does not open browsers or grant consent. Give the user the link, then run the finish command.',
              };
            } else {
              blocked = { step: 'inbox', needs: '--inbox <alias> [--email <address>]' };
            }
          }

          if (!blocked && (state.next === 'mcp' || options.mcpClient)) {
            const which = options.mcpClient ? String(options.mcpClient) : '';
            if (which) {
              /*
               * Registered through the change flow, as `mcp install` is — this step registered with nobody's
               * approval while `mcp install` asked, so an agent could hand a client a new set of tools by calling
               * `setup` instead. Nobody here can answer, so a registration that needs approval is not made: the
               * step stops, the report carries the preview and the approval id, and running this again with
               * `--mcp-approval <id>` once the person has agreed claims it. Reported rather than thrown, like every
               * other step that waits for a person, so what this run did is still in `did`.
               */
              const outcome = await gatedChange(context.core, await registration(which), {
                channel: 'gmail',
                surface: 'cli',
                approvalId: mcpApproval,
                platform,
              });
              if (outcome.status === 'approval-required') {
                const { prepared } = outcome;
                blocked = {
                  step: 'mcp',
                  needs: `a person's approval to register the server with ${which}`,
                  hint: approvalHint(
                    prepared,
                    context.handoffs.own(
                      insertWordsBeforeSentinel(againForMcp(), '--mcp-approval', prepared.approvalId),
                    ),
                    context.handoffs,
                  ),
                  approvalId: prepared.approvalId,
                  policy: prepared.policy,
                  preview: prepared.preview,
                  expiresAt: prepared.expiresAt,
                };
                // Exit 10, which every command here means as "waiting for an approval": a script that reads only
                // the status must not take a registration nobody has approved for one that happened.
                softExit = EXIT_CODES.APPROVAL;
              } else {
                const result = outcome.result;
                warnings.push(...result.warnings);
                // Only what happened. Reporting "registered" for an install that did not apply, or that failed its
                // own start-up check, is the kind of claim the `did` list exists to make impossible.
                if (result.applied && result.verified) did.push(`registered the server with ${which}`);
                else
                  blocked = {
                    step: 'mcp',
                    needs: result.applied ? 'a server that starts' : 'a client this can write to',
                    ...(result.verifyDetail ? { hint: result.verifyDetail } : {}),
                  };
              }
              state = await setupState(context, setupStateOptions());
            } else {
              blocked = { step: 'mcp', needs: '--mcp-client <client>' };
            }
          }

          const report = { ...state, did, warnings, blocked, handoff };
          const nameExample = (await context.config()).version === 2 ? 'acme/gmail' : 'work';
          writeResult(
            report,
            output(),
            () => renderSetupPlan({ ...report, nameExample }, CONSOLE_STEPS, globalOptions.color, context.handoffs),
            streams,
          );
          return;
        }

        // A second run says what it is resuming from, rather than silently doing something different from the
        // first. Nothing here is destructive, so "start over" only re-walks the console; it removes nothing.
        let walkConsole = state.next === 'client' || options.restart === true;
        /*
         * Set when a finished setup is asked to do more, so the steps below run for a state already past them.
         *
         * An explicit `--inbox` or `--mcp-client` sets it before anything is asked. Consuming the flags inside
         * the mailbox loop was not enough: the loop is entered on `state.next === 'inbox'`, so
         * `setup --inbox personal` on a machine that already has one mailbox never reached them — it went to the
         * agent step, or asked "what would you like to do?" of somebody who had already said.
         */
        let addAnother = Boolean(options.inbox && !targetAlreadyConnected);
        let addMcp = Boolean(options.mcpClient);
        /** Set by `--restart`, or by answering "start over": the walk then begins at 1/5 whatever is recorded. */
        let startOver = options.restart === true;
        if (state.done.length > 0 && !options.restart && !addAnother && !addMcp) {
          out.write(`${bold('Picking up where you left off.')}\n`);
          if (state.clients.length > 0) out.write(`  done · client "${state.clients.join('", "')}" registered\n`);
          if (state.inboxes.length > 0)
            out.write(`  done · ${state.inboxes.length} mailbox(es): ${state.inboxes.join(', ')}\n`);
          if (state.registeredWith.length > 0) out.write(`  done · connected to ${state.registeredWith.join(', ')}\n`);
          if (state.next === 'done') {
            // Not a dead end: "set up" is a state you pass through, not one you arrive at. Somebody running this
            // again almost always wants another mailbox — the first one connected must not close that door.
            const what = await askChoice(mode, streams, {
              message: 'Everything is set up. What would you like to do?',
              choices: [
                { value: 'inbox', label: 'Connect another mailbox', hint: 'you can have as many as you like' },
                {
                  value: 'mcp',
                  label: 'Register with another agent',
                  hint: `already: ${state.registeredWith.join(', ')}`,
                },
                {
                  value: 'console',
                  label: 'Walk the Google Cloud steps again',
                  hint: 'changes nothing on this machine',
                },
                { value: 'nothing', label: 'Nothing, thanks' },
              ],
              initial: 'inbox',
            });
            if (what === 'nothing') return;
            if (what === 'console') walkConsole = true;
            if (what === 'inbox') addAnother = true;
            if (what === 'mcp') addMcp = true;
            out.write('\n');
          }
          const choice = await askChoice(mode, streams, {
            message: 'Continue from here, or start over?',
            choices: [
              { value: 'continue', label: 'Continue', hint: 'pick up at the next unfinished step' },
              { value: 'restart', label: 'Start over', hint: 'walk the Google Cloud steps again; removes nothing' },
            ],
            initial: 'continue',
          });
          if (choice === 'restart') {
            walkConsole = true;
            startOver = true;
          }
          out.write('\n');
        } else {
          out.write(`${bold('Setting up Gmail')}\n\n`);
        }

        // ── 1. The Google client ──────────────────────────────────────────────────────────────────────────────
        const { planConsoleWalk, runConsoleWalk } = await import('./console-walk.ts');
        const { asTyped, chooseClientFile } = await import('./client-step.ts');
        const { readSetupProgress, recordConsoleStep } = await import('../operations/setup-progress.ts');
        const { downloadDirectory, findClientJson } = await import('../operations/setup.ts');
        const stateDir = context.core.paths.stateDir;
        const where = asTyped(downloadDirectory(context.env), homeDirectory(context.env));
        let clientPath = options.clientJson ? String(options.clientJson) : '';
        /*
         * Where the walk starts. A run that has no client yet asks before walking it all again (CUE-298): a client file
         * already in the download directory, or a step confirmed by an earlier run, is offered as a place to resume.
         * `--client-json` puts the file in hand, so there is nothing in the console left to do.
         */
        let walkFrom = 0;
        if (walkConsole && state.next === 'client' && !startOver) {
          if (clientPath) walkFrom = CONSOLE_STEPS.length;
          else {
            const plan = await planConsoleWalk({
              steps: CONSOLE_STEPS,
              progress: await readSetupProgress(stateDir, CONSOLE_STEPS.length),
              candidates: state.candidates,
              where,
              choose: (question) => askChoice(mode, streams, question),
            });
            walkFrom = plan.from;
            if (plan.path) clientPath = plan.path;
            out.write('\n');
          }
        }
        if (walkConsole && walkFrom < CONSOLE_STEPS.length) {
          if (walkFrom === 0)
            out.write(
              'Gmail only accepts calls from an OAuth client registered to a Google Cloud project, and it has to be\n' +
                'yours, unless an organisation profile provides one. This is once per person, and one client covers every\n' +
                'mailbox you connect and everyone you share it with.\n\n',
            );
          await runConsoleWalk({
            steps: CONSOLE_STEPS,
            from: walkFrom,
            show: async (step, index) => {
              out.write(`${bold(`${index + 1}/${CONSOLE_STEPS.length}  ${step.title}`)}\n`);
              out.write(`${dim(`      ${step.why}`)}\n`);
              out.write(`      ${dim(step.url)}\n\n`);
              for (const action of step.actions) out.write(`      • ${action}\n`);
              for (const warning of step.avoid)
                out.write(`      ${paint(globalOptions.color, 'yellow', '!')} ${warning}\n`);
              out.write('\n');
              if (options.browser !== false) openInBrowser(step.url);
              await askFor(streams, { question: '      press Enter when that is done — ' });
              out.write('\n');
            },
            // Only while there is no client: walking the console again on a finished setup is a re-read, not progress.
            // And never at the walk's expense: a state directory that cannot be written costs the resume, not the setup.
            record: async (consoleStep) => {
              if (state.next === 'client')
                await recordConsoleStep(stateDir, consoleStep, context.now()).catch(() => undefined);
            },
          });
        }

        if (state.next === 'client') {
          // Looked for now, not taken from the scan made as the command started: that was before the walk, and so
          // before the download this step is waiting for.
          const path =
            clientPath ||
            (await chooseClientFile(
              {
                choose: (question) => askChoice(mode, streams, question),
                type: (question) => askText(mode, streams, question),
              },
              () => findClientJson(context.env),
              where,
            ));

          // Asked here as `client add` asks: the person reads what is registered, and says yes to it.
          const added = await changed(
            context,
            globalOptions,
            clientAddChange(context, {
              path,
              name: 'desktop',
              ...(options.store ? { store: String(options.store) } : {}),
              ...(options.move === true ? { move: true } : {}),
            }),
            options.approval,
          );
          out.write(`\n${bold('Client registered')} as "${added.name}".\n`);
          // What happened, not what usually happens: this said "your keychain, never to a file" whatever the
          // store turned out to be, including on the machines where the keychain is exactly what is missing.
          out.write(
            `${dim(
              added.store === 'keychain'
                ? 'The id went to your config; the secret to your keychain, never to a file.'
                : // Not "because no keychain is available": `--store file` is a choice somebody can make on a
                  // machine whose keychain works perfectly, and telling them otherwise is a guess reported as a fact.
                  'The id went to your config; the secret to an owner-only file beside it, in the file store.',
            )}\n`,
          );
          if (added.sourceRemoved) out.write(`${dim('The downloaded JSON has been deleted.')}\n`);
          out.write('\n');
          state = await setupState(context, setupStateOptions(false));
        }

        // ── 2. A mailbox ──────────────────────────────────────────────────────────────────────────────────────
        /** Reads a flag once and forgets it, so the second mailbox is not offered the first one's name. */
        const pending: Record<string, string> = {
          inbox: options.inbox ? String(options.inbox).trim() : '',
          email: options.email ? String(options.email).trim() : '',
        };
        const takeFlag = (name: 'inbox' | 'email'): string => {
          const value = pending[name] ?? '';
          pending[name] = '';
          return value;
        };

        while (state.next === 'inbox' || addAnother) {
          addAnother = false;
          out.write(`${bold('Connect a mailbox')}\n`);
          out.write(`${dim('Google will warn the app is not verified. That is expected for a client you made')}\n`);
          out.write(`${dim('yourself: choose Advanced, then "Go to … (unsafe)", and leave every box ticked.')}\n\n`);
          /*
           * The flags are answers, not decoration — on this path too.
           *
           * `--inbox` and `--email` were advertised by `--help` and read only by the headless branch, so somebody
           * at a terminal who passed them was asked the same two questions anyway. They are consumed once here,
           * so the first mailbox uses them and "connect another" asks properly rather than proposing the same
           * name a second time.
           */
          /*
           * No default once names are organisation/platform.
           *
           * The name is asked before the address, so nothing is known yet to suggest one from — and a default of
           * `work` is not a name version 2 accepts. So on a migrated config the prompt shows the shape and waits for
           * an answer; version 1 keeps the default it always had.
           */
          const organisationNames = (await context.config()).version === 2;
          const alias =
            takeFlag('inbox') ||
            (await askText(
              mode,
              streams,
              organisationNames
                ? { message: 'A name for it: organisation/gmail', placeholder: 'acme/gmail' }
                : { message: 'A short name for it', placeholder: 'work', defaultValue: 'work' },
            ));
          const email =
            takeFlag('email') ||
            (await askText(mode, streams, { message: 'Which address (blank to choose in the browser)' }));

          const started = await startSetupSignIn({
            alias,
            ...(email ? { email } : {}),
            ...(options.client ? { client: String(options.client) } : {}),
            detached: false,
            ...(deps.listenerCommand ? { listenerCommand: deps.listenerCommand } : {}),
          });
          out.write(`\n${renderSignInStarted(started, 'add', globalOptions.color, context.handoffs)}\n`);
          if (options.browser !== false) openInBrowser(started.authUrl);
          if (started.listener) {
            const signedIn = await started.listener.result;
            out.write(`\n${renderSignedIn(signedIn, globalOptions.color, context.handoffs)}\n\n`);
          }
          state = await setupState(context, setupStateOptions(false));
          if (!(await askYesNo(mode, streams, { message: 'Connect another mailbox?', defaultYes: false }))) break;
          out.write('\n');
        }

        // ── 3. The agent connection ───────────────────────────────────────────────────────────────────────────
        if (state.next === 'mcp' || addMcp) {
          const named = options.mcpClient ? String(options.mcpClient) : '';
          const wanted = named !== '' || (await askYesNo(mode, streams, { message: 'Connect this to an agent?' }));
          if (wanted) {
            const which =
              named ||
              (await askChoice(mode, streams, {
                message: 'Which client?',
                choices: [
                  { value: 'claude-code', label: 'Claude Code' },
                  { value: 'claude-desktop', label: 'Claude Desktop' },
                  { value: 'codex', label: 'Codex' },
                  { value: 'cursor', label: 'Cursor' },
                  { value: 'gemini', label: 'Gemini CLI' },
                  { value: 'vscode', label: 'VS Code' },
                ],
                initial: 'claude-code',
              }));
            /*
             * Two ways to get here, and they are asked differently — through the same gate as `mcp install`.
             *
             * Answered: the person at this terminal has just said yes to "Connect this to an agent?" and picked the
             * client, in this command, a moment ago. Under the `chat` change policy that answer is the approval, from
             * the one who gives it: showing a preview and asking again for what they have just asked for teaches
             * people to agree without reading. Under `confirm` they still type the code, as for any registration.
             *
             * Named: `--mcp-client` skips both questions, so nobody has been asked anything — and an interactive run
             * proves a terminal, not a person: an agent can hold one. A person here reads the preview and says yes;
             * anything with an agent's marker gets the preview and the approval id, to run this again with
             * `--mcp-approval` once the person agrees.
             */
            const result = await gatedChangeAtTerminal(context.core, await registration(which), {
              channel: 'gmail',
              approvalId: mcpApproval,
              env,
              output: { json: globalOptions.json || globalOptions.noInput, color: globalOptions.color },
              // The client picked from the list is named in the command to run again: `--mcp-approval` is claimed
              // only for a client named with `--mcp-client`, and refused without one.
              rerun: named ? againForMcp() : insertWordsBeforeSentinel(againForMcp(), '--mcp-client', which),
              approvalFlag: '--mcp-approval',
              answered: named === '',
              streams,
            });
            out.write(`\n${renderInstall(result, globalOptions.color)}\n`);
          }
        }

        const final = await setupState(context, setupStateOptions(false));
        const [first] = final.inboxes;
        out.write(`\n${bold('Done.')} ${final.inboxes.length} mailbox(es): ${final.inboxes.join(', ')}\n`);
        // A name to copy, or no line at all. The old fallback printed `--inbox work`, which is not a name a config
        // made today will accept and was never a name this machine had.
        if (first) {
          out.write(
            `${dim(`Try: ${handoffText(context.handoffs.own(['search', 'newer_than:7d', '--inbox', first]))}`)}\n`,
          );
        }
        const another = handoffTextToFill(context.handoffs.own(['inbox', 'add']), [
          '<organisation>/gmail',
          '--email',
          '<address>',
        ]);
        out.write(`${dim(`${first ? 'Add another' : 'Add one'} with: ${another}`)}\n`);
      }),
    );

  program
    .command('doctor')
    .description('check everything that has to work, and say how to fix what does not')
    .option('--inbox <alias>', 'check only this mailbox')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await doctor(context, { inbox: options.inbox ? String(options.inbox) : undefined });
        writeResult(result, output(), (data) => renderDoctor(data, globalOptions.color), streams);
        // A failing check is a finding rather than a crash, so the envelope stays `ok` and the checks carry the
        // detail — but the **exit code** has to say something went wrong, or nothing can gate on this. It printed
        // "1 broken" and exited 0, which is what a script reads as a healthy install; `agentcomms doctor` has
        // always exited non-zero on the same condition, so the two disagreed about the same word.
        // The findings are the output, so the envelope stays the normal one and only the exit code carries the
        // verdict. It reported "1 broken" and exited 0 — which a script reads as a healthy install, and which
        // disagreed with `agentcomms doctor`, the other half of the same product, on the meaning of the same word.
        // A warning is not a failure: `healthy` is false only when something is actually broken.
        if (!result.healthy) softExit = EXIT_CODES.CONFIG;
      }),
    );

  program
    .command('oauth-listen <flowId>', { hidden: true })
    .description('internal: hold the loopback port open for a sign-in started with --start')
    .action(
      act(async (context, _globalOptions, flowId: string) => {
        await runOauthListener(context, flowId);
      }),
    );

  program
    .command(`${UPDATE_CHECK_CHILD_COMMAND} <claimedAt>`, { hidden: true })
    .description("internal: finish the day's update check a command handed on")
    .action(
      act(async (context, _globalOptions, claimedAt: string) => {
        await runUpdateCheckChild(context.core, env, claimedAt);
      }),
    );

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
            hint: handoffSentence(help(), (command) => `Run ${command} to see the commands.`),
          });
        },
        streams,
      );
    }
    throw error;
  }
  if (!ran) {
    streams.stderr.write(
      `${paint(
        globals().color,
        'dim',
        handoffSentence(help(), (command) => `Nothing to do. Try ${command}.`, { instead: 'Nothing to do.' }),
      )}\n`,
    );
    return 64;
  }
  return exitCode;
}
