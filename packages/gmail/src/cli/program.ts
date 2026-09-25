import {
  agentMarker,
  CommsError,
  canPrompt,
  colorEnabled,
  EXIT_CODES,
  installExitStatus,
  type LooseningConsent,
  type OutputOptions,
  paint,
  requirePerson,
  resolveName,
  runCommand,
  type SendPolicy,
  type StoreKind,
  type Streams,
  writeResult,
} from '@agentcomms/core';
import { Command, CommanderError, Option } from 'commander';
import { TIERS } from '../auth/scopes.ts';
import { GmailContext, type GmailContextOptions } from '../context.ts';
import type { Launcher, SupportedClient } from '../mcp/install.ts';
import { listLabels, listSendAs, threadTimeline } from '../operations/analyse.ts';
import { downloadAttachments, findAttachments } from '../operations/attachments.ts';
import { clientAdd, clientList, clientRemove } from '../operations/clients.ts';
import { addConfirmClient, listConfirmClients, removeConfirmClient } from '../operations/confirm-clients.ts';
import { followUps, searchContacts } from '../operations/contacts.ts';
import { doctor } from '../operations/doctor.ts';
import { createDraft, deleteDraft, getDraft, listDrafts, replyDraft, updateDraft } from '../operations/drafts.ts';
import { exportMail } from '../operations/export.ts';
import { importLegacy } from '../operations/import-legacy.ts';
import { inboxList, inboxPolicy, inboxRemove, inboxRename, inboxShow, whoami } from '../operations/inboxes.ts';
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
import { finishSignIn, startSignIn } from '../operations/signin.ts';
import { VERSION } from '../version.ts';
import { openInBrowser } from './browser.ts';
import { askFor } from './prompt.ts';
import {
  CLIENT_KIND_LABEL,
  renderApprovals,
  renderAttachments,
  renderClientAdd,
  renderClients,
  renderContacts,
  renderDoctor,
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
} from './render.ts';

export interface CliDeps extends GmailContextOptions {
  streams?: Streams;
  /** Command used to start the detached sign-in listener; the tests point it at the source entry. */
  listenerCommand?: { command: string; args: string[] };
}

interface GlobalOptions {
  json: boolean;
  color: boolean;
  noInput: boolean;
}

type Options = Record<string, unknown>;

/**
 * The `agent-gmail` command. Both a person and an agent run it, so every command prints a readable summary by default
 * and the full result under `--json`, with the same exit codes either way (documented in `--help`).
 */
export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const streams: Streams = deps.streams ?? { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin };
  const env = deps.env ?? process.env;
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
Exit codes: 0 ok · 1 unexpected · 10 send refused or approval required · 64 usage ·
65 bad data · 66 not found · 69 provider or secret store unavailable · 75 temporary
(retry later) · 77 sign-in or permission needed · 78 configuration problem.`,
    )
    .exitOverride();

  const globals = (): GlobalOptions => {
    const options = program.opts();
    return {
      json: Boolean(options.json),
      color: colorEnabled(env, streams.stdout, options.color as boolean | undefined),
      noInput: options.input === false,
    };
  };
  const output = (): OutputOptions => ({ json: globals().json, color: globals().color });

  /** Wraps a command body so every failure becomes the documented envelope and exit code. */
  /**
   * A command that succeeded but wants a non-zero exit code — `doctor` finding something broken, where the findings
   * *are* the output and the envelope must still be the normal one. Throwing instead would print a second envelope
   * after the first, and `--json` promises exactly one document on stdout.
   */
  let softExit: number | null = null;

  const act =
    <A extends unknown[]>(body: (context: GmailContext, options: GlobalOptions, ...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      ran = true;
      softExit = null;
      const context = new GmailContext({ ...deps, env, surface: 'cli' });
      exitCode = await runCommand(output(), () => body(context, globals(), ...args), streams);
      if (exitCode === 0 && softExit !== null) exitCode = softExit;
    };

  /**
   * The body of a message, from `--text`, from `--file`, or from standard input.
   *
   * Standard input matters more than it looks: a body is prose with newlines and quotes in it, and an agent that has
   * to fit one into a shell argument will mangle it. Piping it in is the way that always works.
   */
  const bodyText = async (options: Options, behaviour: { bodyOptional?: boolean } = {}): Promise<string> => {
    if (typeof options.text === 'string') return options.text;
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
    const stdin = streams.stdin as NodeJS.ReadableStream & { isTTY?: boolean };
    // On an update, no body means "keep the one that is there" rather than an error.
    if (behaviour.bodyOptional && stdin.isTTY) return undefined as unknown as string;
    if (stdin.isTTY) {
      throw new CommsError('USAGE', 'no message body', {
        hint: 'Pass --text "…", or --file <path>, or pipe the body in on standard input.',
      });
    }
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

  /**
   * An `--expect-*` list as the caller meant it. `none` is the explicit empty list.
   *
   * Explicit, because an omitted flag and an empty one look the same on a command line, and the difference here is
   * "I know there are no Bcc recipients" versus "I did not think about Bcc" — which is the difference between a
   * check and a formality.
   */
  const expected = (value: unknown): string[] => {
    const list = (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String);
    return list.length === 1 && list[0] === 'none' ? [] : list;
  };

  /** The options every draft command shares, so `draft new` and `draft reply` take the same flags. */
  const withDraftOptions = (command: Command): Command =>
    command
      .option('--text <text>', 'the body, as plain text (the HTML part is generated from it)')
      .option('--file <path>', 'read the body from a file')
      .option('--cc <address...>', 'copy these people')
      .option('--bcc <address...>', 'blind-copy these people')
      .option('--attach <path...>', 'attach these local files')
      .option('--no-signature', 'leave the mailbox signature off')
      .option('--no-quote', 'do not quote the original (a reply only; a forward needs it)')
      .option('--profile', 'include the mailbox writing profile in the result', false);

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
  });

  // ---- clients ----------------------------------------------------------------
  const client = program.command('client').description('the Google Cloud OAuth client every inbox signs in through');
  client
    .command('add <path>')
    .description('register a Desktop OAuth client JSON downloaded from Google Cloud')
    .option('--name <name>', 'register it under this name', 'default')
    .addOption(new Option('--store <store>', 'where secrets are kept (first time only)').choices(['keychain', 'file']))
    .option('--move', 'delete the downloaded file once the secret is stored', false)
    .option('--replace', 'rotate the secret of the client already registered under this name', false)
    .option('--no-probe', 'do not check the credentials with Google first')
    .action(
      act(async (context, globalOptions, path: string, options: Options) => {
        const result = await clientAdd(context, {
          path,
          name: String(options.name ?? 'default'),
          store: options.store as StoreKind | undefined,
          move: Boolean(options.move),
          replace: Boolean(options.replace),
          noProbe: options.probe === false,
        });
        writeResult(result, output(), (data) => renderClientAdd(data, globalOptions.color), streams);
      }),
    );
  client
    .command('list')
    .description('list the registered OAuth clients')
    .action(
      act(async (context, globalOptions) => {
        writeResult(await clientList(context), output(), (data) => renderClients(data, globalOptions.color), streams);
      }),
    );
  client
    .command('remove <name>')
    .description('forget an OAuth client and its secret')
    .action(
      act(async (context, _globalOptions, name: string) => {
        writeResult(
          await clientRemove(context, name),
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
      .option('--port <number>', 'use this loopback port for the redirect', (value) => Number.parseInt(value, 10))
      .option('--no-browser', 'do not open the link, just print it')
      .option('--hd <domain>', 'restrict the account chooser to a Google Workspace domain')
      .option('--start', 'start the sign-in and return the link, to be finished later', false)
      .option('--finish <flowId>', 'finish a sign-in started earlier')
      .option('--url <url>', 'the address the browser ended up at, pasted back')
      .option('--wait <seconds>', 'how long to wait for the browser', (value) => Number.parseInt(value, 10), 60);

  const signIn = async (
    context: GmailContext,
    globalOptions: GlobalOptions,
    mode: 'add' | 'reauth',
    alias: string | undefined,
    options: Options,
  ): Promise<void> => {
    if (options.finish) {
      const result = await finishSignIn(context, {
        flowId: String(options.finish),
        onlyMode: mode,
        onlyAlias: alias,
        url: options.url ? String(options.url) : undefined,
        waitSeconds: Number(options.wait ?? 60),
      });
      writeResult(result, output(), (data) => renderSignedIn(data, globalOptions.color), streams);
      return;
    }
    if (!alias) {
      const example = (await context.config()).version === 2 ? 'acme/gmail' : 'work';
      throw new CommsError('USAGE', 'name the inbox', {
        hint: `For example: \`agent-gmail inbox ${mode} ${example} --start\`.`,
      });
    }

    // A person at a terminal can wait for the browser; an agent cannot, so its sign-in is two commands.
    const interactive =
      !options.start && canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput });
    const started = await startSignIn(context, {
      mode,
      alias,
      tier: options.tier ? String(options.tier) : undefined,
      contacts: options.contacts === undefined ? undefined : options.contacts !== false,
      client: options.client ? String(options.client) : undefined,
      email: options.email ? String(options.email) : undefined,
      hostedDomain: options.hd ? String(options.hd) : undefined,
      port: options.port === undefined ? undefined : Number(options.port),
      detached: !interactive,
      listenerCommand: deps.listenerCommand,
    });

    if (!interactive || !started.listener) {
      writeResult(started, output(), (data) => renderSignInStarted(data, mode, globalOptions.color), streams);
      return;
    }
    streams.stderr.write(`${renderSignInStarted(started, mode, globalOptions.color)}\n`);
    if (options.browser !== false) openInBrowser(started.authUrl);
    const result = await started.listener.result;
    writeResult(result, output(), (data) => renderSignedIn(data, globalOptions.color), streams);
  };

  withSignInOptions(inbox.command('add [alias]').description('connect a mailbox (opens Google in a browser)')).action(
    act(async (context, globalOptions, alias: string | undefined, options: Options) => {
      await signIn(context, globalOptions, 'add', alias, options);
    }),
  );

  withSignInOptions(
    inbox.command('reauth [alias]').description('sign in again: renew the grant, or change how much access it has'),
  ).action(
    act(async (context, globalOptions, alias: string | undefined, options: Options) => {
      await signIn(context, globalOptions, 'reauth', alias, options);
    }),
  );

  inbox
    .command('list')
    .description('list the connected mailboxes')
    .action(
      act(async (context, globalOptions) => {
        writeResult(await inboxList(context), output(), (data) => renderInboxList(data, globalOptions.color), streams);
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
    .description('how sending from this inbox must be approved')
    .requiredOption('--send <policy>', 'chat | confirm | never')
    .action(
      act(async (context, globalOptions, alias: string, options: Options) => {
        const wanted = String(options.send);
        if (wanted !== 'chat' && wanted !== 'confirm' && wanted !== 'never') {
          throw new CommsError('USAGE', `"${wanted}" is not a send policy`, { hint: 'Use chat, confirm or never.' });
        }
        const consent = await consentForLoosening(context, alias, wanted, globalOptions);
        writeResult(
          await inboxPolicy(context, alias, wanted, consent),
          output(),
          (data) => `Sending from "${data.alias}" now needs: ${data.sendPolicy} (was ${data.previous}).`,
          streams,
        );
      }),
    );

  inbox
    .command('import [source]')
    .description('copy the mailboxes set up in another Gmail MCP server (default: @artymclabin/gmail-mcp)')
    .option('--dir <path>', 'where that server keeps its files', '~/.gmail-mcp')
    .option('--name <name>', 'register its OAuth client under this name', 'imported')
    .addOption(new Option('--store <store>', 'where secrets are kept (first time only)').choices(['keychain', 'file']))
    .option('--dry-run', 'say what would be imported, and change nothing', false)
    .option(
      '--rename <old=new>',
      'import one under another name (repeatable)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(
      act(async (context, globalOptions, source: string | undefined, options: Options) => {
        if (source && source !== 'artymclabin') {
          throw new CommsError('USAGE', `"${source}" is not a source this can import from`, {
            hint: 'Only `artymclabin` (and the servers sharing its file layout) is supported: `agent-gmail inbox import`.',
          });
        }
        const result = await importLegacy(context, {
          dir: options.dir ? String(options.dir) : undefined,
          clientName: options.name ? String(options.name) : undefined,
          store: options.store as StoreKind | undefined,
          dryRun: Boolean(options.dryRun),
          renames: Array.isArray(options.rename) ? options.rename.map(String) : [],
        });
        writeResult(result, output(), (data) => renderImport(data, globalOptions.color), streams);
      }),
    );

  inbox
    .command('remove <alias>')
    .description('disconnect a mailbox')
    .option('--revoke', 'also ask Google to revoke the token (may affect other tools sharing the grant)', false)
    .action(
      act(async (context, _globalOptions, alias: string, options: Options) => {
        writeResult(
          await inboxRemove(context, alias, { revoke: Boolean(options.revoke) }),
          output(),
          (data) =>
            `Disconnected "${data.alias}" (${data.email}).\n` +
            (data.revoked
              ? 'Its token was revoked with Google.'
              : 'Its token was not revoked. To revoke it with Google: https://myaccount.google.com/connections') +
            (data.orphanedSecret
              ? `\nIts token could not be deleted from this machine: remove ${data.orphanedSecret} from the secret store${
                  data.orphanRecorded
                    ? ' (`agent-gmail doctor` lists it).'
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
    .option('--limit <number>', 'how many rows', (value) => Number.parseInt(value, 10))
    .option('--cursor <cursor>', 'continue a previous search')
    .option('--include-spam-trash', 'include spam and trash', false)
    .action(
      act(async (context, globalOptions, query: string, options: Options) => {
        const result = await search(context, {
          query,
          inboxes: options.all ? 'all' : (options.inbox as string[] | undefined),
          kind: options.messages ? 'messages' : 'threads',
          limit: options.limit === undefined ? undefined : Number(options.limit),
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
    .option('--max-chars <number>', 'how much body to return', (value) => Number.parseInt(value, 10))
    .option('--offset <number>', 'continue from this character', (value) => Number.parseInt(value, 10))
    .action(
      act(async (context, globalOptions, messageId: string, options: Options) => {
        const result = await readMessage(context, String(options.inbox), messageId, {
          includeQuoted: Boolean(options.quoted),
          maxChars: options.maxChars === undefined ? undefined : Number(options.maxChars),
          offset: options.offset === undefined ? undefined : Number(options.offset),
        });
        writeResult(result, output(), (data) => renderMessage(data, globalOptions.color), streams);
      }),
    );

  program
    .command('thread <threadId>')
    .description('read a whole conversation, oldest first')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--quoted', 'keep quoted history and signatures', false)
    .option('--max-chars <number>', 'how much of each body to return', (value) => Number.parseInt(value, 10))
    .action(
      act(async (context, globalOptions, threadId: string, options: Options) => {
        const result = await readThread(context, String(options.inbox), threadId, {
          includeQuoted: Boolean(options.quoted),
          maxChars: options.maxChars === undefined ? undefined : Number(options.maxChars),
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
    .option('--min-bytes <number>', 'at least this big', (value) => Number.parseInt(value, 10))
    .option('--max-bytes <number>', 'at most this big', (value) => Number.parseInt(value, 10))
    .option('--type <mimeType>', 'only this content type')
    .option('--query <query>', 'extra Gmail search syntax')
    .option('--limit <number>', 'how many rows', (value) => Number.parseInt(value, 10))
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await findAttachments(context, {
          inboxes: options.inbox as string[] | undefined,
          from: options.from ? String(options.from) : undefined,
          filename: options.filename ? String(options.filename) : undefined,
          after: options.after ? String(options.after) : undefined,
          before: options.before ? String(options.before) : undefined,
          minBytes: options.minBytes === undefined ? undefined : Number(options.minBytes),
          maxBytes: options.maxBytes === undefined ? undefined : Number(options.maxBytes),
          mimeType: options.type ? String(options.type) : undefined,
          query: options.query ? String(options.query) : undefined,
          limit: options.limit === undefined ? undefined : Number(options.limit),
        });
        writeResult(result, output(), (data) => renderAttachments(data, globalOptions.color), streams);
      }),
    );
  attachments
    .command('download <messageId...>')
    .description('download the attachments of one or more messages, under the downloads folder')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--part <partId>', 'one specific attachment')
    .option('--out <subpath>', 'a folder inside the downloads root')
    .option('--max-files <number>', 'stop after this many files', (value) => Number.parseInt(value, 10))
    .action(
      act(async (context, globalOptions, messageIds: string[], options: Options) => {
        const result = await downloadAttachments(
          context,
          String(options.inbox),
          messageIds.map((messageId) => ({ messageId, partId: options.part ? String(options.part) : undefined })),
          {
            out: options.out ? String(options.out) : undefined,
            maxFiles: options.maxFiles === undefined ? undefined : Number(options.maxFiles),
          },
        );
        writeResult(result, output(), (data) => renderDownloads(data, globalOptions.color), streams);
      }),
    );

  program
    .command('contacts <query>')
    .description('find someone’s address: from the address book, from people written to, and from past mail')
    .option('--inbox <alias...>', 'search these mailboxes (default: all)')
    .option('--sources <source...>', 'contacts, other-contacts, history')
    .option('--limit <number>', 'how many rows', (value) => Number.parseInt(value, 10))
    .action(
      act(async (context, globalOptions, query: string, options: Options) => {
        const result = await searchContacts(context, query, {
          inboxes: options.inbox as string[] | undefined,
          sources: options.sources as Array<'contacts' | 'other-contacts' | 'history'> | undefined,
          limit: options.limit === undefined ? undefined : Number(options.limit),
        });
        writeResult(result, output(), (data) => renderContacts(data, globalOptions.color), streams);
      }),
    );

  program
    .command('followups')
    .description('conversations waiting on somebody')
    .option('--inbox <alias...>', 'these mailboxes (default: all)')
    .addOption(new Option('--direction <who>', 'who is being waited on').choices(['them', 'me']))
    .option('--older-than <days>', 'only threads quiet for this long', (value) => Number.parseInt(value, 10))
    .option('--lookback <days>', 'how far back to look', (value) => Number.parseInt(value, 10))
    .option('--limit <number>', 'how many rows', (value) => Number.parseInt(value, 10))
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await followUps(context, {
          inboxes: options.inbox as string[] | undefined,
          direction: options.direction as 'them' | 'me' | undefined,
          olderThanDays: options.olderThan === undefined ? undefined : Number(options.olderThan),
          lookbackDays: options.lookback === undefined ? undefined : Number(options.lookback),
          limit: options.limit === undefined ? undefined : Number(options.limit),
        });
        writeResult(result, output(), (data) => renderFollowUps(data, globalOptions.color), streams);
      }),
    );

  program
    .command('export <id>')
    .description('write a message or a thread to a file, to read without filling the conversation')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--thread', 'export the whole conversation', false)
    .addOption(new Option('--format <format>', 'md, json or eml').choices(['md', 'json', 'eml']))
    .option('--out <subpath>', 'a folder inside the downloads root')
    .option('--quoted', 'keep quoted history', false)
    .action(
      act(async (context, _globalOptions, id: string, options: Options) => {
        const result = await exportMail(context, String(options.inbox), id, {
          thread: Boolean(options.thread),
          format: options.format as 'md' | 'json' | 'eml' | undefined,
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
    .addOption(new Option('--mode <mode>', 'how to answer').choices(['reply', 'reply_all', 'forward']))
    .option('--to <address...>', 'who it goes to (a forward needs this; a reply computes it)')
    .action(
      act(async (context, globalOptions, messageId: string, options: Options) => {
        const result = await replyDraft(context, String(options.inbox), messageId, {
          ...(await draftInput(options)),
          mode: options.mode as 'reply' | 'reply_all' | 'forward' | undefined,
          quote: options.quote !== false,
        });
        writeResult(result, output(), (data) => renderDraft(data, globalOptions.color), streams);
      }),
    );

  draft
    .command('list')
    .description('the drafts in a mailbox')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .option('--limit <number>', 'how many rows', (value) => Number.parseInt(value, 10))
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await listDrafts(
          context,
          String(options.inbox),
          options.limit === undefined ? undefined : Number(options.limit),
        );
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
      .description('change a draft — the body, files and headers you do not restate are kept'),
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
    .action(
      act(async (context, globalOptions, draftId: string, options: Options) => {
        const result = await prepareSend(context, String(options.inbox), draftId);
        writeResult(result, output(), (data) => renderSendPreparation(data, globalOptions.color), streams);
      }),
    );

  send
    .command('execute <draftId>')
    .description('send it — only with an approval, and only to the recipients that approval names')
    .requiredOption('--inbox <alias>', 'which mailbox')
    .requiredOption('--approval <id>', 'the approval from `send prepare`')
    .requiredOption('--expect-to <address...>', 'who you believe this goes to; `none` for nobody')
    .requiredOption('--expect-subject <subject>', 'the subject you believe it has; `none` for an empty one')
    .option('--expect-cc <address...>', 'who you believe is copied; `none` for nobody', ['none'])
    .option('--expect-bcc <address...>', 'who you believe is blind-copied; `none` for nobody', ['none'])
    .action(
      act(async (context, globalOptions, draftId: string, options: Options) => {
        const result = await executeSend(context, String(options.inbox), {
          draftId,
          approvalId: String(options.approval),
          expect: {
            to: expected(options.expectTo),
            cc: expected(options.expectCc),
            bcc: expected(options.expectBcc),
            subject: String(options.expectSubject) === 'none' ? '' : String(options.expectSubject),
          },
        });
        writeResult(result, output(), (data) => renderSent(data, globalOptions.color), streams);
      }),
    );

  send
    .command('list')
    .description('approvals waiting, and what each one is for')
    .option('--inbox <alias>', 'only this mailbox')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const result = await listApprovals(context, { inbox: options.inbox ? String(options.inbox) : undefined });
        writeResult(result, output(), (data) => renderApprovals(data, globalOptions.color), streams);
      }),
    );

  send
    .command('cancel <approvalId>')
    .description('cancel an approval — refusing to send is never the dangerous direction')
    .action(
      act(async (context, _globalOptions, approvalId: string) => {
        const result = await revokeApproval(context, approvalId);
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
    .description('approve a send at this terminal: read the message, then type the code back')
    .action(
      act(async (context, globalOptions, approvalId: string) => {
        // The one command an agent may not run for the user. A shell agent can defeat this — `script -q /dev/null`
        // makes any command see a terminal — and SECURITY.md says so. It is a speed bump against the ordinary case,
        // not a boundary; the boundary for an agent with a shell is the `never` policy and sending from Gmail.
        const marker = agentMarker(env);
        if (marker) {
          throw new CommsError('APPROVAL_REQUIRED', 'only a person can approve a send, not an agent', {
            hint: `Ask the user to run \`agent-gmail approve ${approvalId}\` in their own terminal.`,
            details: { marker },
          });
        }
        if (!canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput })) {
          throw new CommsError('APPROVAL_REQUIRED', 'approving a send needs an interactive terminal', {
            hint: `Run \`agent-gmail approve ${approvalId}\` directly in a terminal, or send the draft from Gmail.`,
          });
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

  // Which clients may put an approval form in front of a person. Empty by default and fail-closed: `clientInfo.name`
  // is self-reported, so a name gets here only after a probe a human answered, and only from a terminal.
  const confirmClients = program
    .command('confirm-clients')
    .description('MCP clients whose approval forms are trusted to reach you');

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
    .description('trust a client that has just passed the probe')
    .action(
      act(async (context, globalOptions, name: string) => {
        await requirePerson(env, streams, {
          refusedToAgent: 'only a person can decide which clients they trust',
          refusedWithoutTerminal: 'this needs an interactive terminal',
          command: `agent-gmail confirm-clients add ${name}`,
          prompt:
            `This lets "${name}" ask you to approve a send in its own window, instead of in a terminal.\n` +
            'Only say yes if you just answered its probe form yourself.',
          color: globalOptions.color,
          json: globalOptions.json,
          noInput: globalOptions.noInput,
        });
        const clients = await addConfirmClient(context, name, {
          kind: 'loosening-consent',
          paths: ['defaults.confirm.elicitationClients'],
        });
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
        writeResult(result, output(), (data) => renderModify(data, globalOptions.color), streams);
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
                    { hint: 'Pipe in the `undo` array from `agent-gmail organise … --json`.' },
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
                    { hint: 'Pass the file `agent-gmail organise … --json` wrote, or pipe it in on stdin.' },
                  );
                }
                return content.text;
              })();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new CommsError('BAD_DATA', 'that is not the undo from an organise result', {
            hint: 'Pipe in the `undo` array from `agent-gmail organise … --json`.',
          });
        }
        // The envelope or the array itself, because both are things a person plausibly pipes in.
        const entries = Array.isArray(parsed)
          ? parsed
          : ((parsed as { data?: { undo?: unknown } })?.data?.undo ?? (parsed as { undo?: unknown })?.undo);
        if (!Array.isArray(entries)) {
          throw new CommsError('BAD_DATA', 'that JSON has no undo array in it', {
            hint: 'Pipe in the `undo` array from `agent-gmail organise … --json`.',
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
      act(async (_context, _globalOptions, options: Options) => {
        ran = true;
        const { startStdioServer } = await import('../mcp/stdio-entry.ts');
        // Returns when the client disconnects.
        await startStdioServer({
          ...deps,
          env,
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
    .option('--name <name>', 'the name the client will show', 'gmail')
    .option('--inbox <alias>', 'serve only this mailbox')
    .option('--read-only', 'leave out every tool that changes the mailbox', false)
    .addOption(new Option('--launcher <launcher>', 'how the server is started').choices(['managed', 'npx', 'local']))
    .option('--no-verify', 'do not start the server to check the entry works')
    .option('--force', "replace this server's own earlier entry — this is how you upgrade", false)
    .option('--print', 'only print what would be written', false)
    .action(
      act(async (context, globalOptions, options: Options) => {
        if (!options.client) {
          throw new CommsError('USAGE', 'name the client with --client', {
            hint: 'For example: `agent-gmail mcp install --client claude-code`.',
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
        const { mcpInstall } = await import('../mcp/install.ts');
        const result = await mcpInstall(context, {
          client: options.client as SupportedClient,
          name: String(options.name ?? 'gmail'),
          inbox: pinned ? String(pinned) : undefined,
          /*
           * The same, for `--read-only`, which the `--inbox` fix above missed: `mcp install --read-only`
           * registered a server with every tool that trashes, labels and drafts, and doctor's repair — which keeps
           * `--read-only` precisely so a narrowed server stays narrow — lost it the same way.
           */
          readOnly: Boolean(options.readOnly || mcp.opts().readOnly),
          launcher: options.launcher as Launcher | undefined,
          noVerify: options.verify === false,
          apply: options.print !== true,
          force: Boolean(options.force),
        });
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
    .action(
      act(async (context, globalOptions, options: Options) => {
        const { mcpPrune } = await import('../mcp/install.ts');
        const result = await mcpPrune(context, {
          dryRun: options.dryRun === true,
          includePrinted: options.includePrinted === true,
        });
        writeResult(result, output(), (data) => renderPrune(data, globalOptions.color), streams);
      }),
    );

  program
    .command('setup')
    .description('set this up from nothing: the Google client, a mailbox, and the agent connection')
    .option('--client-json <path>', 'the OAuth client JSON, if you already have it')
    .option('--inbox <alias>', 'the name to connect the first mailbox under')
    .option('--email <address>', 'the address that mailbox must turn out to be')
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
    .addOption(new Option('--store <store>', 'where secrets are kept (first time only)').choices(['keychain', 'file']))
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
    .option('--no-tui', 'plain one-line prompts instead of lists and fields')
    .option('--no-browser', 'print the links instead of opening them')
    .action(
      act(async (context, globalOptions, options: Options) => {
        const { setupState, CONSOLE_STEPS } = await import('../operations/setup.ts');
        const out = streams.stderr;
        const bold = (text: string) => paint(globalOptions.color, 'bold', text);
        const dim = (text: string) => paint(globalOptions.color, 'dim', text);

        const { interactionFor, askText, askChoice, askYesNo } = await import('./tui.ts');
        const mode = interactionFor({
          streams,
          env,
          json: Boolean(globalOptions.json),
          noInput: Boolean(globalOptions.noInput),
          noTui: options.tui === false,
          canPrompt: canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput }),
        });
        let state = await setupState(context);

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
          let blocked: { step: string; needs: string; hint?: string } | null = null;
          let handoff: { authUrl: string; finish: string } | null = null;

          if (state.next === 'client') {
            const path = options.clientJson ? String(options.clientJson) : '';
            if (path) {
              const { clientAdd } = await import('../operations/clients.ts');
              const added = await clientAdd(context, {
                path,
                name: 'desktop',
                ...(options.store ? { store: String(options.store) as 'keychain' | 'file' } : {}),
                ...(options.move === true ? { move: true } : {}),
              });
              did.push(
                `registered the OAuth client as "${added.name}" (secret in the ${added.store} store)` +
                  (added.sourceRemoved ? ', and removed the downloaded file' : ''),
              );
              // Scanned, not skipped: this `state` is folded into the report below, and the report lists what is
              // in the downloads directory.
              state = await setupState(context);
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
          if (!blocked && (state.next === 'inbox' || options.inbox)) {
            const alias = options.inbox ? String(options.inbox) : '';
            if (alias) {
              const { startSignIn } = await import('../operations/signin.ts');
              const started = await startSignIn(context, {
                mode: 'add',
                alias,
                ...(options.email ? { email: String(options.email) } : {}),
                detached: true,
                ...(deps.listenerCommand ? { listenerCommand: deps.listenerCommand } : {}),
              });
              handoff = {
                authUrl: started.authUrl,
                finish: `agent-gmail inbox add --finish ${started.flowId} --wait 120`,
              };
              did.push(`started a sign-in for "${alias}"`);
              blocked = {
                step: 'inbox',
                needs: 'the link opened and approved in a browser',
                hint: 'This command does not open browsers or grant consent. Give the user the link, then run the finish command.',
              };
            } else {
              blocked = { step: 'inbox', needs: '--inbox <alias> [--email <address>]' };
            }
          }

          if (!blocked && (state.next === 'mcp' || options.mcpClient)) {
            const which = options.mcpClient ? String(options.mcpClient) : '';
            if (which) {
              const { mcpInstall } = await import('../mcp/install.ts');
              // `force` removes an existing entry before adding its replacement. Doing that silently, from a
              // headless run, would take somebody's working server away on the strength of a flag they passed for
              // a different reason — so it needs asking for, exactly as `mcp install` makes you ask.
              const result = await mcpInstall(context, {
                client: which as SupportedClient,
                apply: true,
                force: options.replaceServer === true,
                ...(options.launcher ? { launcher: String(options.launcher) as 'managed' | 'npx' | 'local' } : {}),
              });
              // Only what happened. Reporting "registered" for an install that did not apply, or that failed its
              // own start-up check, is the kind of claim the `did` list exists to make impossible.
              if (result.applied && result.verified) did.push(`registered the server with ${which}`);
              else
                blocked = {
                  step: 'mcp',
                  needs: result.applied ? 'a server that starts' : 'a client this can write to',
                  ...(result.verifyDetail ? { hint: result.verifyDetail } : {}),
                };
              state = await setupState(context);
            } else {
              blocked = { step: 'mcp', needs: '--mcp-client <client>' };
            }
          }

          const report = { ...state, did, blocked, handoff };
          const nameExample = (await context.config()).version === 2 ? 'acme/gmail' : 'work';
          writeResult(
            report,
            output(),
            () => renderSetupPlan({ ...report, nameExample }, CONSOLE_STEPS, globalOptions.color),
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
        let addAnother = Boolean(options.inbox);
        let addMcp = Boolean(options.mcpClient);
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
          if (choice === 'restart') walkConsole = true;
          out.write('\n');
        } else {
          out.write(`${bold('Setting up agent-gmail')}\n\n`);
        }

        // ── 1. The Google client ──────────────────────────────────────────────────────────────────────────────
        if (walkConsole) {
          out.write(
            'Gmail only accepts calls from an OAuth client registered to a Google Cloud project, and it has to be\n' +
              'yours — there is no shared one to borrow. This is once per person, and one client covers every\n' +
              'mailbox you connect and everyone you share it with.\n\n',
          );
          for (const [index, step] of CONSOLE_STEPS.entries()) {
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
          }
        }

        if (state.next === 'client') {
          let path = options.clientJson ? String(options.clientJson) : '';
          const candidates = state.candidates;
          if (!path && candidates.length > 0) {
            const usable = candidates.find((candidate) => candidate.kind === 'desktop');
            const picked = await askChoice(mode, streams, {
              message: 'Which client file?',
              choices: [
                ...candidates.map((candidate) => ({
                  value: candidate.path,
                  label: candidate.path.split('/').pop() ?? candidate.path,
                  hint: `${CLIENT_KIND_LABEL[candidate.kind] ?? candidate.kind} · downloaded ${new Date(candidate.modifiedAt).toLocaleString()}`,
                })),
                { value: '', label: 'Somewhere else…', hint: 'type a path' },
              ],
              ...(usable ? { initial: usable.path } : {}),
            });
            path = picked;
          }
          while (!path) {
            path = await askText(mode, streams, {
              message: 'Path to the downloaded client JSON',
              placeholder: '~/Downloads/client_secret_….json',
            });
          }

          const { clientAdd } = await import('../operations/clients.ts');
          const added = await clientAdd(context, {
            path,
            name: 'desktop',
            ...(options.store ? { store: String(options.store) as 'keychain' | 'file' } : {}),
            ...(options.move === true ? { move: true } : {}),
          });
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
          state = await setupState(context, { scanDownloads: false });
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

          const { startSignIn } = await import('../operations/signin.ts');
          const started = await startSignIn(context, {
            mode: 'add',
            alias,
            ...(email ? { email } : {}),
            detached: false,
            ...(deps.listenerCommand ? { listenerCommand: deps.listenerCommand } : {}),
          });
          out.write(`\n${renderSignInStarted(started, 'add', globalOptions.color)}\n`);
          if (options.browser !== false) openInBrowser(started.authUrl);
          if (started.listener) {
            const signedIn = await started.listener.result;
            out.write(`\n${renderSignedIn(signedIn, globalOptions.color)}\n\n`);
          }
          state = await setupState(context, { scanDownloads: false });
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
            const { mcpInstall } = await import('../mcp/install.ts');
            const result = await mcpInstall(context, {
              client: which as SupportedClient,
              apply: true,
              force: options.replaceServer === true,
              ...(options.launcher ? { launcher: String(options.launcher) as 'managed' | 'npx' | 'local' } : {}),
            });
            out.write(`\n${renderInstall(result, globalOptions.color)}\n`);
          }
        }

        const final = await setupState(context, { scanDownloads: false });
        const [first] = final.inboxes;
        out.write(`\n${bold('Done.')} ${final.inboxes.length} mailbox(es): ${final.inboxes.join(', ')}\n`);
        // A name to copy, or no line at all. The old fallback printed `--inbox work`, which is not a name a config
        // made today will accept and was never a name this machine had.
        if (first) out.write(`${dim(`Try: agent-gmail search "newer_than:7d" --inbox ${first}`)}\n`);
        out.write(
          `${dim(`${first ? 'Add another' : 'Add one'} with: agent-gmail inbox add <organisation>/gmail --email <address>`)}\n`,
        );
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

  /** Loosening a safety setting needs a person at a terminal typing a challenge; tightening never does. */
  const consentForLoosening = async (
    context: GmailContext,
    alias: string,
    wanted: SendPolicy,
    globalOptions: GlobalOptions,
  ): Promise<LooseningConsent | undefined> => {
    const rank: Record<SendPolicy, number> = { chat: 0, confirm: 1, never: 2 };
    const config = await context.config();
    // Resolved, so a former name is refused with its replacement here rather than silently measured against the
    // default — which would skip the consent a loosening of the renamed mailbox needs.
    const current = resolveName(config, 'inbox', alias).inbox.sendPolicy ?? config.defaults.sendPolicy;
    if (rank[wanted] >= rank[current]) return undefined;
    await requirePerson(env, streams, {
      refusedToAgent: 'only a person can make sending easier, not an agent',
      refusedWithoutTerminal: 'making sending easier needs an interactive terminal',
      command: `agent-gmail inbox policy ${alias} --send ${wanted}`,
      prompt: `This makes sending from "${alias}" easier (${current} → ${wanted}).`,
      color: globalOptions.color,
      json: globalOptions.json,
      noInput: globalOptions.noInput,
    });
    return { kind: 'loosening-consent', paths: [`inboxes.${alias}.sendPolicy`] };
  };

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
            hint: 'Run `agent-gmail --help` to see the commands.',
          });
        },
        streams,
      );
    }
    throw error;
  }
  if (!ran) {
    streams.stderr.write(`${paint(globals().color, 'dim', 'Nothing to do. Try `agent-gmail --help`.')}\n`);
    return 64;
  }
  return exitCode;
}
