import {
  agentMarker,
  approveChangeAtTerminal,
  approveRefusedHint,
  CommsError,
  type CoreHandOff,
  canPrompt,
  cliHandoffs,
  colorEnabled,
  commandPathOf,
  EXIT_CODES,
  exemptFromUpdateNotice,
  type GatedChange,
  gatedChangeAtTerminal,
  type Handoff,
  handoffSentence,
  installExitStatus,
  kindOf,
  MAX_WAIT_SECONDS,
  type OutputOptions,
  openCore,
  PATH_OPTIONS,
  paint,
  pathOverridesFromCliOptions,
  refuseUnclaimedApproval,
  renderApprovalWait,
  renderInstall,
  renderPrune,
  resolvePaths,
  runCommand,
  runUpdateCheckChild,
  type Streams,
  type SupportedClient,
  serverInstallChange,
  serverPruneChange,
  terminalUpdateHooks,
  UPDATE_CHECK_CHILD_COMMAND,
  updateNoticeAtTerminal,
  waitForApproval,
  wholeNumber,
  writeResult,
} from '@agentcomms/core';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { checkNewName } from '../accounts.ts';
import { RESEND_CALLER } from '../caller.ts';
import { ResendContext, type ResendContextOptions } from '../context.ts';
import { RESEND_MCP } from '../mcp/install.ts';
import {
  addAccountChange,
  inspectKey,
  listAccounts,
  modeOf,
  policyApprovalRefusal,
  policyChange,
  policyReport,
  policyWanted,
  removeAccountChange,
  sendPolicyOf,
  showAccount,
} from '../operations/accounts.ts';
import { runDoctor } from '../operations/doctor.ts';
import {
  downloadReceived,
  getMetrics,
  listDomains,
  listReceived,
  listScheduled,
  listSentEmails,
  listSuppressions,
  showReceived,
  showSentEmail,
} from '../operations/read.ts';
import { cancelScheduledChange } from '../operations/scheduled.ts';
import {
  beginSendApproval,
  executeSend,
  finishSendApproval,
  prepareSend,
  revokeSendApproval,
  sendStatus,
} from '../operations/send.ts';
import { VERSION } from '../version.ts';
import { askFor, readApiKey } from './prompt.ts';
import {
  renderAccount,
  renderAccounts,
  renderAdded,
  renderCancelled,
  renderDoctor,
  renderPolicy,
  renderPrepared,
  renderRead,
  renderRemoved,
  renderSent,
  renderStatus,
} from './render.ts';

/**
 * The `agent-resend` command.
 *
 * Connect a Resend account (a person, at a terminal), see what it can do, read domains, sent and received mail,
 * metrics and suppressions, and send an email — prepared, previewed, approved by a person, and sent once. Every
 * command prints a readable summary by default and the whole result under `--json`, with the same exit codes.
 *
 * Every command but three runs the same operation as its MCP tool. The three: `account add` (a key is typed at a
 * terminal, never into a chat), `approve` (under `confirm`, approving is a person at a terminal) and `mcp` (it starts
 * the server a tool would need already running).
 */

export interface CliDeps extends ResendContextOptions {
  streams?: Streams | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Starts the stdio server. Injected so a test can inspect its inputs without opening stdio. */
  startMcp?: ((options: import('../mcp/server.ts').ResendMcpOptions) => Promise<void>) | undefined;
  /**
   * How the day's update check is handed to core's CLI (design 2026-10-22, P2): core's command, at this package's own
   * version, located and started as the default does. Injected so a test can see what would be started without
   * starting it.
   */
  updateHandOff?: CoreHandOff | undefined;
}

type Options = Record<string, unknown>;

interface GlobalOptions {
  json: boolean;
  color: boolean;
}

/** Commander quotes an unknown `--option=value` back whole; the value is taken out, in case it was a key. */
function withoutOptionValues(text: string): string {
  return text.replace(/'(-{1,2}[^'=\s]+)=[^']*'/g, "'$1=…'").replace(/\bre_[A-Za-z0-9_]{4,}/g, 're_…');
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** What a usage error tells the person: this installation's own `--help`, located — or why there is none here. */
export function usageHint(help: Handoff): string {
  return handoffSentence(help, (command) => `Run ${command} to see the commands.`);
}

/**
 * What a command line that ran nothing says. Commander shows the help for an empty one itself, so this is the fallback
 * for a parse that ends with no command run and no error — never a bare name either way.
 */
export function nothingToDo(help: Handoff): string {
  return handoffSentence(help, (command) => `Nothing to do. Try ${command}.`);
}

/** `--expect-to a@x.test,b@x.test`, or `none`: a list is always written out, so a permission prompt shows it. */
function expectList(raw: unknown, flag: string): string[] {
  const value = String(raw ?? '').trim();
  if (value === '') throw new CommsError('USAGE', `${flag} is required; write none for an empty list`);
  if (value.toLowerCase() === 'none') return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const streams: Streams = deps.streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const program = new Command();
  let exitCode = 0;
  let ran = false;
  let softExit: number | null = null;

  program
    .name('agent-resend')
    .description(
      'Resend for coding agents: read domains, sent and received mail, and send email that goes out only when a person approves exactly what it says.',
    )
    .version(VERSION, '-v, --version')
    .option('--json', 'print the result as {"ok":true,"schemaVersion":1,"data":…}', false)
    .option('--no-color', 'never colour the output')
    .configureOutput({
      writeOut: (text) => streams.stdout.write(text),
      writeErr: (text) => streams.stderr.write(text),
      outputError: (text, write) => write(withoutOptionValues(text)),
    })
    .addHelpText(
      'after',
      `
Getting started — run these with this CLI:
  account add acme/resend            a person types the key; it goes into the keychain
  doctor                              what works, and who enforces what
  domains --account acme/resend
  received list --account acme/resend
  mcp install --client claude-code   register the server with an agent, once a person approves it

Exit codes: 0 ok · 1 unexpected · 10 a send or a change was refused or needs approval · 64 usage ·
65 bad data · 66 not found · 69 provider or secret store unavailable · 75 temporary (retry later) ·
77 key or permission needed · 78 configuration problem.`,
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

  /*
   * Core, opened as Resend — its caller — so every command this prints for a person is this installation's own, its
   * folders pinned (CUE-403). A core handed in is a test's, opened the same way; `ResendContext` refuses one that is not.
   */
  let invocationCore: ReturnType<typeof openCore> | undefined;
  const coreForInvocation = (): ReturnType<typeof openCore> => {
    if (invocationCore) return invocationCore;
    const options = program.opts();
    const pathOverrides = pathOverridesFromCliOptions(
      Object.fromEntries(PATH_OPTIONS.map(({ key, option }) => [option, options[key] as string | undefined])),
    );
    invocationCore =
      Object.keys(pathOverrides).length === 0 && deps.core
        ? deps.core
        : openCore({ env, platform, pathOverrides, caller: RESEND_CALLER });
    return invocationCore;
  };

  /** This installation's own `--help`, for a usage error or an empty command line: it opens no folder, so pins none. */
  const help = (): Handoff =>
    cliHandoffs({ caller: RESEND_CALLER, paths: resolvePaths({ env, platform }), platform, env }).own(['--help'], {
      uses: [],
    });

  const globals = (): GlobalOptions => {
    const options = program.opts();
    return {
      json: Boolean(options.json),
      color: colorEnabled(env, streams.stdout, options.color as boolean | undefined),
    };
  };
  const output = (): OutputOptions => ({ json: globals().json, color: globals().color, platform });

  /*
   * The update notice (design 2026-10-16, U1), before any command but the exempt ones: the day's check, waited for
   * about three seconds at most, and — when a newer release is out and no command on this machine said so today — one
   * line on stderr. It never stops the command. A hook on the program, so a command added later has it by being a
   * command at all.
   */
  program.hook('preAction', async (_program, command) => {
    const path = commandPathOf(command);
    // The update check a command handed on (#48) is part of the notice, not a command anybody types.
    if (exemptFromUpdateNotice(path, [UPDATE_CHECK_CHILD_COMMAND])) return;
    const core = coreForInvocation();
    await updateNoticeAtTerminal({
      core,
      env,
      channel: 'resend',
      running: VERSION,
      output: output(),
      streams,
      ...terminalUpdateHooks(core, env, { handOff: deps.updateHandOff ?? {} }),
    });
  });

  const act =
    <A extends unknown[]>(body: (context: ResendContext, options: GlobalOptions, ...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      ran = true;
      softExit = null;
      const core = coreForInvocation();
      const context = new ResendContext({ ...deps, core, env, pathOverrides: core.pathOverrides, surface: 'cli' });
      exitCode = await runCommand(output(), () => body(context, globals(), ...args), streams);
      if (exitCode === 0 && softExit !== null) exitCode = softExit;
    };

  /**
   * A change the way every changing command runs one: core's `gatedChangeAtTerminal`. `rerun` is this command's words
   * after the program, which core locates as Resend's own and runs again with `--approval <id>`.
   */
  const changeAt = <T>(
    context: ResendContext,
    change: GatedChange<T>,
    flags: Options,
    rerun: readonly string[],
  ): Promise<T> =>
    gatedChangeAtTerminal(context.core, change, {
      channel: 'resend',
      approvalId: flags.approval === undefined ? undefined : String(flags.approval),
      env,
      output: output(),
      rerun,
      streams,
    });

  const approvalOption = (command: Command): Command =>
    command.option(
      '--approval <approvalId>',
      'apply a change a person approved: said yes to in chat, or approved with the approve command it gave',
    );
  const accountOption = (command: Command): Command =>
    command.requiredOption('--account <name>', 'which account, as `organisation/resend`');

  // ── account ────────────────────────────────────────────────────────────────────────────────────────────────────

  const account = program.command('account').description('connect, inspect, re-police and remove Resend accounts');

  approvalOption(
    account
      .command('add <name>')
      .description(
        'connect a Resend API key, typed by a person at this terminal (or RESEND_API_KEY); never from a chat',
      )
      .addOption(
        new Option('--mode <mode>', 'read (the default for a full-access key) or send').choices(['read', 'send']),
      )
      .addOption(
        new Option('--send <policy>', 'how its sends are approved; the machine default if left out').choices([
          'chat',
          'confirm',
          'never',
        ]),
      )
      .option('--domain <domain>', 'for a sending-only key restricted to one domain: that domain'),
  ).action(
    act(async (context, options, name: string, flags: Options) => {
      const mode = modeOf(flags.mode);
      const rerun = [
        'account',
        'add',
        name,
        ...(mode ? ['--mode', mode] : []),
        ...(flags.send ? ['--send', String(flags.send)] : []),
        ...(flags.domain ? ['--domain', String(flags.domain)] : []),
      ];
      // The name first: a name that cannot be taken is refused before anybody types a key for it.
      checkNewName(await context.config(), name, context.handoffs);
      const key = await readApiKey(env, streams, { json: options.json, command: context.handoffs.own(rerun) });
      // Through the machine's one throttle, like every other request: the key is on some team's budget already.
      const inspection = await inspectKey(context, key);
      const added = await changeAt(
        context,
        addAccountChange(
          context,
          {
            name,
            key,
            mode,
            sendPolicy: sendPolicyOf(flags.send),
            domain: flags.domain === undefined ? undefined : String(flags.domain),
          },
          inspection,
        ),
        flags,
        rerun,
      );
      writeResult(added, output(), (data) => renderAdded(data, options.color), streams);
    }),
  );

  account
    .command('list')
    .description('the Resend accounts this machine can use, and what each may do')
    .action(
      act(async (context, options) => {
        const result = await listAccounts(context);
        writeResult(result, output(), (data) => renderAccounts(data, options.color, context.handoffs), streams);
      }),
    );

  account
    .command('show <name>')
    .description('one account: its key’s permission, its mode, its send policy, and who enforces what')
    .action(
      act(async (context, options, name: string) => {
        const result = await showAccount(context, name);
        writeResult(result, output(), (data) => renderAccount(data, options.color), streams);
      }),
    );

  approvalOption(
    account.command('remove <name>').description('forget an account and delete its key, once a person approves it'),
  ).action(
    act(async (context, _options, name: string, flags: Options) => {
      const removed = await changeAt(context, removeAccountChange(context, name), flags, ['account', 'remove', name]);
      writeResult(removed, output(), renderRemoved, streams);
    }),
  );

  approvalOption(
    account
      .command('policy <name>')
      .description(
        'report how its sends and changes are approved, or set --send, --mode and --change; loosening is approved by a person',
      )
      .option('--send <policy>', 'chat, confirm or never')
      .option('--mode <mode>', 'read or send')
      .option('--change <policy>', 'how a loosening of this account is approved: chat or confirm'),
  ).action(
    act(async (context, _options, name: string, flags: Options) => {
      const wanted = policyWanted({ send: flags.send, mode: flags.mode, change: flags.change });
      const reporting = wanted.send === undefined && wanted.mode === undefined && wanted.change === undefined;
      if (reporting) refuseUnclaimedApproval(flags.approval, policyApprovalRefusal('cli'));
      const result = reporting
        ? await policyReport(context, name)
        : await changeAt(context, policyChange(context, name, wanted), flags, [
            'account',
            'policy',
            name,
            ...(wanted.send ? ['--send', wanted.send] : []),
            ...(wanted.mode ? ['--mode', wanted.mode] : []),
            ...(wanted.change ? ['--change', wanted.change] : []),
          ]);
      writeResult(result, output(), renderPolicy, streams);
    }),
  );

  // ── doctor ─────────────────────────────────────────────────────────────────────────────────────────────────────

  program
    .command('doctor')
    .description(
      'check what has to work, and say who enforces what — read-only is this package’s promise, not the key’s',
    )
    .option('--account <name>', 'check only this account')
    .option('--offline', 'do not ask Resend anything', false)
    .action(
      act(async (context, options, flags: Options) => {
        const result = await runDoctor(context, {
          account: flags.account === undefined ? undefined : String(flags.account),
          offline: flags.offline === true,
        });
        if (!result.healthy) softExit = 78;
        writeResult(result, output(), (data) => renderDoctor(data, options.color), streams);
      }),
    );

  // ── reading ────────────────────────────────────────────────────────────────────────────────────────────────────

  accountOption(program.command('domains'))
    .description('the team’s domains and their status; with --domain, the DNS records one needs')
    .option('--domain <domain>', 'one domain, by name or id')
    .action(
      act(async (context, options, flags: Options) => {
        const result = await listDomains(context, String(flags.account), {
          domain: flags.domain === undefined ? undefined : String(flags.domain),
        });
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  const emails = program.command('emails').description('sent emails: what went, and what happened to it');

  accountOption(emails.command('list'))
    .description('recent sent emails, newest first, with their last event')
    .option('--limit <n>', 'how many: 1 to 100', '20')
    .option('--after <id>', 'continue after this email id, from an earlier page')
    .action(
      act(async (context, options, flags: Options) => {
        const result = await listSentEmails(context, String(flags.account), { limit: flags.limit, after: flags.after });
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  accountOption(emails.command('show <id>'))
    .description('one sent email: its last event, its Message-ID, and what it said')
    .action(
      act(async (context, options, id: string, flags: Options) => {
        const result = await showSentEmail(context, String(flags.account), id);
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  const received = program
    .command('received')
    .description('received emails — untrusted content, shown with Resend’s SPF, DKIM and DMARC results');

  accountOption(received.command('list'))
    .description('recent received emails, newest first')
    .option('--limit <n>', 'how many: 1 to 100', '20')
    .option('--after <id>', 'continue after this email id, from an earlier page')
    .action(
      act(async (context, options, flags: Options) => {
        const result = await listReceived(context, String(flags.account), { limit: flags.limit, after: flags.after });
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  accountOption(received.command('show <id>'))
    .description('one received email: its body, its authentication, and its attachments listed, not downloaded')
    .action(
      act(async (context, options, id: string, flags: Options) => {
        const result = await showReceived(context, String(flags.account), id);
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  accountOption(received.command('download <id>'))
    .description(
      'save a received email’s attachments under the downloads folder, each under its attachment id; nothing is opened',
    )
    .option('--attachment <attachmentId>', 'only this attachment')
    .option('--out <subpath>', 'a folder inside the account’s downloads folder')
    .action(
      act(async (context, options, id: string, flags: Options) => {
        const result = await downloadReceived(context, String(flags.account), id, {
          attachmentId: flags.attachment,
          out: flags.out === undefined ? undefined : String(flags.out),
        });
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  accountOption(program.command('metrics'))
    .description('delivery, bounce and complaint counts; the last 7 days unless --start and --end say otherwise')
    .option('--start <date>', 'the first day, like 2026-09-01')
    .option('--end <date>', 'the last day')
    .action(
      act(async (context, options, flags: Options) => {
        const result = await getMetrics(context, String(flags.account), { start: flags.start, end: flags.end });
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  accountOption(program.command('suppressions'))
    .description('addresses Resend will not send to, and why')
    .option('--origin <origin>', 'bounce, complaint or manual')
    .option('--limit <n>', 'how many: 1 to 100', '20')
    .option('--after <id>', 'continue after this id, from an earlier page')
    .action(
      act(async (context, options, flags: Options) => {
        const result = await listSuppressions(context, String(flags.account), {
          origin: flags.origin,
          limit: flags.limit,
          after: flags.after,
        });
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  // ── sending ────────────────────────────────────────────────────────────────────────────────────────────────────

  const send = program.command('send').description('prepare an email, and send it once a person has approved it');

  accountOption(send.command('prepare'))
    .description('build an email and show exactly what would go, to whom. Sends nothing')
    .requiredOption('--from <address>', 'the sender, at a verified domain: `Name <you@example.com>` or a bare address')
    .requiredOption('--to <address>', 'a recipient; repeat for more', collect, [])
    .option('--cc <address>', 'a copy recipient; repeat for more', collect, [])
    .option('--bcc <address>', 'a blind recipient; repeat for more — the preview lists every one', collect, [])
    .requiredOption('--subject <subject>', 'the subject')
    .option('--text <text>', 'the plain-text body')
    .option('--html <html>', 'an HTML body whose visible text is the text body; no images, forms or hidden parts')
    .option('--attach <path>', 'a file to attach, from an allowed folder; repeat for more', collect, [])
    .option('--reply-to <address>', 'where replies go; repeat for more', collect, [])
    .option('--in-reply-to <messageId>', 'the Message-ID this replies to, to keep the thread')
    .option('--references <messageId>', 'an earlier Message-ID in the thread; repeat for more', collect, [])
    .option('--scheduled-at <time>', 'send later: an ISO 8601 time with a zone, at most 30 days ahead')
    .option(
      '--as <who>',
      'who it appears to come from: agent (From labelled) or me (From as given, only when the person said so)',
    )
    .action(
      act(async (context, _options, flags: Options) => {
        const prepared = await prepareSend(context, String(flags.account), {
          from: String(flags.from),
          to: flags.to as string[],
          cc: flags.cc as string[],
          bcc: flags.bcc as string[],
          subject: String(flags.subject),
          text: flags.text === undefined ? undefined : String(flags.text),
          html: flags.html === undefined ? undefined : String(flags.html),
          attachments: flags.attach as string[],
          replyTo: flags.replyTo as string[],
          inReplyTo: flags.inReplyTo === undefined ? undefined : String(flags.inReplyTo),
          references: flags.references as string[],
          scheduledAt: flags.scheduledAt === undefined ? undefined : String(flags.scheduledAt),
          as: flags.as === undefined ? undefined : String(flags.as),
        });
        writeResult(prepared, output(), renderPrepared, streams);
      }),
    );

  accountOption(send.command('execute <approvalId>'))
    .description('send a prepared email by approval id; optional legacy expectations are checked exactly')
    .option('--expect-to <addresses>', 'legacy exact check: To list, comma-separated, or none')
    .option('--expect-cc <addresses>', 'legacy exact check: Cc list, or none')
    .option('--expect-bcc <addresses>', 'legacy exact check: Bcc list, or none')
    .option('--expect-subject <subject>', 'legacy exact check: subject')
    .action(
      act(async (context, _options, approvalId: string, flags: Options) => {
        const expectation = [flags.expectTo, flags.expectCc, flags.expectBcc, flags.expectSubject];
        const hasExpect = expectation.some((value) => value !== undefined);
        if (hasExpect && expectation.some((value) => value === undefined)) {
          throw new CommsError('USAGE', 'give all four --expect-* options together, or leave all four out');
        }
        const sent = await executeSend(context, String(flags.account), {
          approvalId,
          ...(hasExpect
            ? {
                expect: {
                  to: expectList(flags.expectTo, '--expect-to'),
                  cc: expectList(flags.expectCc, '--expect-cc'),
                  bcc: expectList(flags.expectBcc, '--expect-bcc'),
                  subject: String(flags.expectSubject),
                },
              }
            : {}),
        });
        writeResult(sent, output(), renderSent, streams);
      }),
    );

  accountOption(send.command('status <approvalId>'))
    .description('what happened to a send — the local record, and Resend’s last event. Never sends again')
    .action(
      act(async (context, _options, approvalId: string, flags: Options) => {
        const status = await sendStatus(context, String(flags.account), approvalId);
        writeResult(status, output(), renderStatus, streams);
      }),
    );

  send
    .command('wait <approvalId>')
    .description(
      'wait for an approval to be usable or finished, and say where it stands — it only looks, and never sends',
    )
    .option(
      '--wait-seconds <n>',
      `how long to wait: 30 when left out, ${MAX_WAIT_SECONDS} at most, 0 for the status now`,
    )
    .action(
      act(async (context, _options, approvalId: string, flags: Options) => {
        const result = await waitForApproval(context.core, approvalId, {
          waitSeconds: wholeNumber(flags.waitSeconds, { name: '--wait-seconds', min: 0, max: MAX_WAIT_SECONDS }),
          channel: 'resend',
        });
        writeResult(result, output(), renderApprovalWait, streams);
      }),
    );

  const scheduled = program.command('scheduled').description('emails waiting to be sent at a later time');

  accountOption(scheduled.command('list'))
    .description('scheduled emails among the most recent 300 sent')
    .action(
      act(async (context, options, flags: Options) => {
        const result = await listScheduled(context, String(flags.account));
        writeResult(result, output(), (data) => renderRead(data, options.color), streams);
      }),
    );

  approvalOption(
    accountOption(scheduled.command('cancel <id>')).description(
      'cancel a scheduled email; one this machine did not schedule is approved by a person first',
    ),
  ).action(
    act(async (context, _options, id: string, flags: Options) => {
      const cancelled = await changeAt(context, cancelScheduledChange(context, String(flags.account), id), flags, [
        'scheduled',
        'cancel',
        id,
        '--account',
        String(flags.account),
      ]);
      writeResult(cancelled, output(), renderCancelled, streams);
    }),
  );

  program
    .command('approve <approvalId>')
    .description('approve a send or a change at this terminal: read it, then type the code back')
    .action(
      act(async (context, options, approvalId: string) => {
        // Checked before the id is looked up, so an agent is told to hand this to a person whatever it passed. A
        // speed bump against the ordinary case, not a boundary: `script -q /dev/null` gives any command a terminal.
        const marker = agentMarker(env);
        const approve = context.handoffs.own(['approve', approvalId]);
        if (marker) {
          throw new CommsError('APPROVAL_REQUIRED', 'only a person can approve a send or a change, not an agent', {
            // And the wait that learns when they have (design 2026-10-05 §D7).
            hint: approveRefusedHint(context.handoffs, approvalId),
            details: { marker },
          });
        }
        if (!canPrompt(env, streams, { json: options.json })) {
          throw new CommsError('APPROVAL_REQUIRED', 'approving needs an interactive terminal', {
            hint: handoffSentence(approve, (command) => `Run ${command} directly in a terminal.`),
          });
        }
        const pending = await context.core.approvals.get(approvalId);
        if (kindOf(pending) === 'change') {
          const outcome = await approveChangeAtTerminal(
            context.core,
            approvalId,
            env,
            { json: options.json, color: options.color, platform: context.platform },
            streams,
          );
          streams.stdout.write(
            outcome.state === 'approved'
              ? 'Approved. This command approves; the change is applied by the command that prepared it.\n'
              : 'Cancelled. Nothing was changed.\n',
          );
          return;
        }
        const prompt = await beginSendApproval(context, approvalId);
        streams.stdout.write(`${prompt.preview}\n\n`);
        const answer = await askFor(
          streams,
          `Type ${paint(options.color, 'bold', prompt.challenge)} to approve this email, or press Enter to cancel: `,
        );
        if (!answer.trim()) {
          await revokeSendApproval(context, approvalId);
          streams.stdout.write('Cancelled. Nothing was sent.\n');
          return;
        }
        await finishSendApproval(context, approvalId, answer);
        streams.stdout.write('Approved. This command approves; it does not send.\n');
      }),
    );

  const mcp = program
    .command('mcp')
    .description('run the MCP server on stdio, for a coding agent to connect to')
    .option('--account <name>', 'pin the server to one account; every tool then acts on it and no other')
    .action(async (flags: Options) => {
      ran = true;
      const startResendStdioServer = deps.startMcp ?? (await import('../mcp/stdio-entry.ts')).startResendStdioServer;
      const core = coreForInvocation();
      await startResendStdioServer({
        ...deps,
        core,
        env,
        pathOverrides: core.pathOverrides,
        platform,
        ...(flags.account ? { account: String(flags.account) } : {}),
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
      'resend',
    )
    .option('--account <name>', 'pin the server to one account')
    .addOption(new Option('--launcher <launcher>', 'how the server is started').choices(['managed', 'npx', 'local']))
    .option('--no-verify', 'do not start the server to check the entry works')
    .option('--force', "replace this server's own earlier entry — this is how you upgrade", false)
    .option('--print', 'only print what would be written', false)
    .option('--approval <approvalId>', 'register the server this approval was given for')
    .action(
      act(async (context, options, flags: Options) => {
        // Named, never assumed: writing into a client's configuration nobody named is the thing to ask about.
        if (!flags.client) {
          throw new CommsError('USAGE', 'name the client with --client', {
            hint: handoffSentence(
              context.handoffs.own(['mcp', 'install', '--client', 'claude-code']),
              (command) => `For example: ${command}.`,
            ),
          });
        }
        // `mcp` and `mcp install` both take `--account`, and Commander gives a repeated name to the parent.
        const pinned = (flags.account ?? mcp.opts().account) as string | undefined;
        const launcher = flags.launcher as 'managed' | 'npx' | 'local' | undefined;
        const name = flags.name as string | undefined;
        const again = [
          'mcp',
          'install',
          '--client',
          String(flags.client),
          ...(name !== undefined && name !== 'resend' ? ['--name', name] : []),
          ...(pinned !== undefined ? ['--account', pinned] : []),
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
              channel: 'resend',
              client: flags.client as SupportedClient,
              name,
              account: pinned,
              launcher,
              noVerify: flags.verify === false,
              print: flags.print === true,
              force: flags.force === true,
            },
            RESEND_MCP,
          ),
          flags,
          again,
        );
        // Asked to register and did not, or registered an entry that did not start: the exit status says so.
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
        // The change `comms_server_prune` makes: a dry run is free; removing is approved as the list it shows.
        const result = await changeAt(
          context,
          serverPruneChange(
            context.core,
            env,
            { channel: 'resend', dryRun: flags.dryRun === true, includePrinted: flags.includePrinted === true },
            RESEND_MCP,
          ),
          flags,
          ['mcp', 'prune', ...(flags.includePrinted === true ? ['--include-printed'] : [])],
        );
        writeResult(result, output(), () => renderPrune(result, options.color), streams);
      }),
    );

  // The rest of the day's update check, handed on by a command before it ended (#48): hidden, and never stopped.
  program
    .command(`${UPDATE_CHECK_CHILD_COMMAND} <claimedAt>`, { hidden: true })
    .description("internal: finish the day's update check a command handed on")
    .action(
      act(async (context, _options, claimedAt: string) => {
        await runUpdateCheckChild(context.core, env, claimedAt);
      }),
    );

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(error.code)) return 0;
      const message = withoutOptionValues(error.message.replace(/^error: /, ''));
      return runCommand(
        output(),
        async () => {
          throw new CommsError('USAGE', message, { hint: usageHint(help()) });
        },
        streams,
      );
    }
    throw error;
  }
  if (!ran) {
    streams.stderr.write(`${paint(globals().color, 'dim', nothingToDo(help()))}\n`);
    return 64;
  }
  return exitCode;
}
