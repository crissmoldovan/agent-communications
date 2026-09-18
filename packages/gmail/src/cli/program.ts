import {
  agentMarker,
  CommsError,
  canPrompt,
  colorEnabled,
  type LooseningConsent,
  type OutputOptions,
  paint,
  runCommand,
  type SendPolicy,
  type StoreKind,
  type Streams,
  writeResult,
} from '@cloudpixel/comms-core';
import { Command, CommanderError, Option } from 'commander';
import { TIERS } from '../auth/scopes.ts';
import { GmailContext, type GmailContextOptions } from '../context.ts';
import type { Launcher, SupportedClient } from '../mcp/install.ts';
import { listLabels, listSendAs, threadTimeline } from '../operations/analyse.ts';
import { clientAdd, clientList, clientRemove } from '../operations/clients.ts';
import { doctor } from '../operations/doctor.ts';
import { importLegacy } from '../operations/import-legacy.ts';
import { inboxList, inboxPolicy, inboxRemove, inboxRename, inboxShow, whoami } from '../operations/inboxes.ts';
import { runOauthListener } from '../operations/oauth-listen.ts';
import { readMessage, readThread } from '../operations/read.ts';
import { search } from '../operations/search.ts';
import { finishSignIn, startSignIn } from '../operations/signin.ts';
import { VERSION } from '../version.ts';
import { openInBrowser } from './browser.ts';
import { askChallenge } from './prompt.ts';
import {
  renderClientAdd,
  renderClients,
  renderDoctor,
  renderImport,
  renderInboxList,
  renderInboxShow,
  renderInstall,
  renderLabels,
  renderMessage,
  renderSearch,
  renderSendAs,
  renderSignedIn,
  renderSignInStarted,
  renderThread,
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
  const act =
    <A extends unknown[]>(body: (context: GmailContext, options: GlobalOptions, ...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      ran = true;
      const context = new GmailContext({ ...deps, env, surface: 'cli' });
      exitCode = await runCommand(output(), () => body(context, globals(), ...args), streams);
    };

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
      .option('--no-contacts', 'do not ask for contacts access')
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
        url: options.url ? String(options.url) : undefined,
        waitSeconds: Number(options.wait ?? 60),
      });
      writeResult(result, output(), (data) => renderSignedIn(data, globalOptions.color), streams);
      return;
    }
    if (!alias) {
      throw new CommsError('USAGE', 'name the inbox', {
        hint: `For example: \`agent-gmail inbox ${mode} work --start\`.`,
      });
    }

    // A person at a terminal can wait for the browser; an agent cannot, so its sign-in is two commands.
    const interactive =
      !options.start && canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput });
    const started = await startSignIn(context, {
      mode,
      alias,
      tier: options.tier ? String(options.tier) : undefined,
      contacts: options.contacts !== false,
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
              : 'Its token was deleted from this machine. To revoke it with Google: https://myaccount.google.com/connections'),
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
    .option('--read-only', 'register only the tools that cannot change anything', false)
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
    .option('--read-only', 'register only the tools that cannot change anything', false)
    .addOption(new Option('--launcher <launcher>', 'how the server is started').choices(['managed', 'npx', 'local']))
    .option('--no-verify', 'do not start the server to check the entry works')
    .option('--print', 'only print what would be written', false)
    .action(
      act(async (context, globalOptions, options: Options) => {
        if (!options.client) {
          throw new CommsError('USAGE', 'name the client with --client', {
            hint: 'For example: `agent-gmail mcp-install --client claude-code`.',
          });
        }
        const { mcpInstall } = await import('../mcp/install.ts');
        const result = await mcpInstall(context, {
          client: options.client as SupportedClient,
          name: String(options.name ?? 'gmail'),
          inbox: options.inbox ? String(options.inbox) : undefined,
          readOnly: Boolean(options.readOnly),
          launcher: options.launcher as Launcher | undefined,
          noVerify: options.verify === false,
          apply: options.print !== true,
        });
        writeResult(result, output(), (data) => renderInstall(data, globalOptions.color), streams);
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
        // A failing check is a finding, not a crash: the envelope stays ok and the checks carry the detail.
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
    const current = config.inboxes[alias]?.sendPolicy ?? config.defaults.sendPolicy;
    if (rank[wanted] >= rank[current]) return undefined;
    const marker = agentMarker(env);
    if (marker) {
      throw new CommsError('LOOSENING_REFUSED', 'only a person can make sending easier, not an agent', {
        hint: `Ask the user to run \`agent-gmail inbox policy ${alias} --send ${wanted}\` in their own terminal.`,
        details: { marker },
      });
    }
    if (!canPrompt(env, streams, { json: globalOptions.json, noInput: globalOptions.noInput })) {
      throw new CommsError('LOOSENING_REFUSED', 'making sending easier needs an interactive terminal', {
        hint: `Run \`agent-gmail inbox policy ${alias} --send ${wanted}\` directly in a terminal.`,
      });
    }
    await askChallenge(streams, {
      prompt: `This makes sending from "${alias}" easier (${current} → ${wanted}).`,
      color: globalOptions.color,
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
