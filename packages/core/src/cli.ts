#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { approveChangeAtTerminal, gatedChangeAtTerminal } from './change-flow.ts';
import {
  colorEnabled,
  defaultStreams,
  type OutputOptions,
  runCommand,
  writeError,
  writeResult,
} from './cli-runtime.ts';
import { openCore } from './core.ts';
import { CommsError, EXIT_CODES } from './errors.ts';
import { installExitStatus, type Launcher, type SupportedClient } from './mcp-install.ts';
import type { NamesMigrationRow, NotApplicableRename } from './names.ts';
import {
  type ChangePolicyReport,
  changePolicyChange,
  changePolicyReport,
  isChangePolicy,
  refuseApprovalWithoutChange,
} from './operations/change-policy.ts';
import { auditTail, corePaths, doctor, listApprovals, revokeApproval } from './operations/maintenance.ts';
import { namesDryRun, namesMigration } from './operations/names-migrate.ts';
import { secretsMigration } from './operations/secrets-migrate.ts';
import {
  type ChannelsReport,
  channelsAvailable,
  serverInstallChange,
  serverPruneChange,
} from './operations/servers.ts';
import { renderInstall, renderPrune } from './render.ts';
import { VERSION } from './version.ts';

/**
 * `agentcomms` — the provider-neutral command: where things live, whether this machine is healthy, what was written
 * to mailboxes, which approvals exist, moving secrets between backends, the change policy, and registering the MCP
 * servers of every channel. Provider commands live in their own binaries (`agent-gmail`, `agent-slack`).
 *
 * Every command here is an operation in `src/operations/` that the core MCP server's tool calls too, and every one
 * that changes something goes through `gatedChangeAtTerminal`: a person at a terminal approves there and then, and an
 * agent gets the preview and an approval id (exit 10) and runs the command again with `--approval <id>`.
 *
 * Nothing a library imports may import this file: it starts `main()` when the running script is called `cli.mjs`,
 * which is what every product's CLI is called.
 */

const HELP = `agentcomms ${VERSION} — agent-communications core

Usage:
  agentcomms paths                         where config, state, data and downloads live
  agentcomms doctor                        check this machine: Node, directories, secret store
  agentcomms audit tail [--inbox <alias>] [--since <ISO time>] [--limit <n>]
  agentcomms approvals list [--inbox <alias>] [--state <state>]
  agentcomms approvals revoke <approvalId>
  agentcomms approve <approvalId>          approve a configuration change at this terminal: read it, type the code
  agentcomms policy [--account <name> | --inbox <name>] [chat|confirm] [--approval <id>]
                                           report or set the change policy: how a loosening is approved;
                                           confirm applies at once, chat is approved first
  agentcomms channels                      which channel servers exist, which are installed, and where they are registered
  agentcomms mcp                           run the core MCP server on stdio (what an MCP client starts)
  agentcomms mcp install --client <client> [--name <name>] [--launcher managed|npx|local] [--force]
                                           [--print] [--no-verify] [--approval <id>]
                                           register the core MCP server with a client, and prove it starts
  agentcomms mcp prune [--dry-run] [--include-printed] [--approval <id>]
                                           remove the core's managed runtimes that nothing uses
  agentcomms secrets migrate --to keychain|file [--approval <id>]
  agentcomms names migrate [--rename <old>=<new>] [--dry-run] [--approval <id>]

A change that loosens something or cannot be taken back — policy chat, mcp install and prune, secrets and names
migrate — is shown before it happens. At a terminal you approve it there; anything else gets the preview and an
approval id (exit 10), and runs the command again with --approval <id> once the person has agreed: in the chat under
the \`chat\` change policy, with \`agentcomms approve\` under \`confirm\`. A tightening — policy confirm — applies at
once and asks nobody, and a --dry-run changes nothing.

Options:
  --json        print the versioned JSON envelope
  --no-color    disable colour (also NO_COLOR, TERM=dumb)
  -h, --help    show this help
  -v, --version show the version

Exit codes: 0 ok · 1 unexpected · 10 approval required · 64 usage · 65 bad data · 66 not found
            69 provider unavailable · 75 transient · 77 auth or scope missing · 78 config error
`;

function usage(message: string): CommsError {
  return new CommsError('USAGE', message, { hint: 'Run `agentcomms --help`.' });
}

/** A command line to run again, each word quoted only where a shell would need it. */
function shellCommand(words: readonly string[]): string {
  return words.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      inbox: { type: 'string' },
      account: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      state: { type: 'string' },
      to: { type: 'string' },
      rename: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      // No longer answers anything: kept so that it is refused with what to do instead, not as an unknown option.
      yes: { type: 'boolean', default: false },
      approval: { type: 'string' },
      client: { type: 'string' },
      name: { type: 'string' },
      launcher: { type: 'string' },
      force: { type: 'boolean', default: false },
      print: { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      'include-printed': { type: 'boolean', default: false },
    },
  });
}

const CLIENT_NAMES = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'vscode', 'json'];

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    const json = argv.includes('--json');
    return writeError(usage(error instanceof Error ? error.message : String(error)), { json, color: false });
  }
  const { values, positionals } = parsed;
  const output: OutputOptions = {
    json: values.json,
    color: colorEnabled(env, process.stdout, values['no-color'] ? false : undefined),
  };
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const core = openCore({ env });
  const [command, sub, arg] = positionals;
  const approval = { approvalId: values.approval, env, output };
  /** An exit status for a command that printed its result and still did not do what was asked. */
  let softExit: number = EXIT_CODES.OK;

  // The server speaks on stdout, so nothing else may: it is run outside `runCommand`, which prints a result there.
  if (command === 'mcp' && sub === undefined) {
    if (values.json) return writeError(usage('`agentcomms mcp` runs the server; it prints no result'), output);
    const { startCoreStdioServer } = await import('./mcp/server.ts');
    await startCoreStdioServer({ core, env });
    return EXIT_CODES.OK;
  }

  const code = await runCommand(output, async () => {
    switch (command) {
      case 'paths':
        writeResult(corePaths(core), output, (p) =>
          Object.entries(p)
            .map(([k, v]) => `${k.padEnd(13)} ${v}`)
            .join('\n'),
        );
        return;
      case 'doctor': {
        const report = await doctor(core);
        writeResult(report, output, (r) =>
          r.checks
            .map(
              (c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(16)} ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ''}`,
            )
            .join('\n'),
        );
        if (!report.ok)
          throw new CommsError('CONFIG', 'doctor found problems', { hint: 'Apply the fixes listed above.' });
        return;
      }
      case 'audit': {
        if (sub !== 'tail') throw usage('usage: agentcomms audit tail');
        const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
          throw usage('--limit must be a positive whole number');
        }
        const records = await auditTail(core, { inbox: values.inbox, since: values.since, limit });
        writeResult(records, output, (rs) =>
          rs.length
            ? rs
                .map(
                  (r) =>
                    `${r.at}  ${r.alias ?? r.inboxId}  ${r.operation}  ${r.outcome}${r.reason ? `  (${r.reason})` : ''}`,
                )
                .join('\n')
            : 'no audit records',
        );
        return;
      }
      case 'approvals': {
        if (sub === 'list') {
          const records = await listApprovals(core, { inbox: values.inbox, state: values.state });
          writeResult(records, output, (rs) =>
            rs.length
              ? rs.map((r) => `${r.approvalId}  ${r.state.padEnd(8)}  ${r.policy}  expires ${r.expiresAt}`).join('\n')
              : 'no approvals',
          );
          return;
        }
        if (sub === 'revoke') {
          if (!arg) throw usage('usage: agentcomms approvals revoke <approvalId>');
          const record = await revokeApproval(core, arg, 'cli');
          writeResult(record, output, (r) => `${r.approvalId} is ${r.state}`);
          return;
        }
        throw usage('usage: agentcomms approvals list|revoke');
      }
      case 'approve': {
        if (!sub || arg !== undefined) throw usage('usage: agentcomms approve <approvalId>');
        const result = await approveChangeAtTerminal(core, sub, env, output);
        writeResult(result, output, (r) =>
          r.state === 'approved'
            ? 'Approved. The agent can make the change now — this command approves; it changes nothing itself.'
            : 'Cancelled. Nothing was changed.',
        );
        return;
      }
      case 'policy': {
        if (arg !== undefined)
          throw usage('usage: agentcomms policy [--account <name> | --inbox <name>] [chat|confirm]');
        const scope = { inbox: values.inbox, account: values.account };
        if (sub === undefined) {
          refuseApprovalWithoutChange(values.approval);
          writeResult(changePolicyReport(await core.config.load(), scope), output, renderPolicy);
          return;
        }
        if (!isChangePolicy(sub)) throw usage(`"${sub}" is not a change policy; use chat or confirm`);
        const where = values.account ? ['--account', values.account] : values.inbox ? ['--inbox', values.inbox] : [];
        const report = await gatedChangeAtTerminal(core, changePolicyChange(core, scope, sub), {
          ...approval,
          command: shellCommand(['agentcomms', 'policy', ...where, sub]),
        });
        writeResult(report, output, renderPolicy);
        return;
      }
      case 'channels': {
        if (sub !== undefined) throw usage('usage: agentcomms channels');
        writeResult(await channelsAvailable(core, env), output, renderChannels);
        return;
      }
      case 'mcp': {
        if (sub === 'install') {
          if (!values.client) {
            throw new CommsError('USAGE', 'name the client with --client', {
              hint: 'For example: `agentcomms mcp install --client claude-code`.',
            });
          }
          if (!CLIENT_NAMES.includes(values.client)) {
            throw usage(`--client must be one of: ${CLIENT_NAMES.join(', ')}`);
          }
          const words = ['agentcomms', 'mcp', 'install', '--client', values.client];
          if (values.name) words.push('--name', values.name);
          if (values.launcher) words.push('--launcher', values.launcher);
          if (values.force) words.push('--force');
          if (values['no-verify']) words.push('--no-verify');
          const result = await gatedChangeAtTerminal(
            core,
            serverInstallChange(core, env, {
              channel: 'core',
              client: values.client as SupportedClient,
              name: values.name,
              launcher: values.launcher as Launcher | undefined,
              force: values.force,
              print: values.print,
              noVerify: values['no-verify'],
            }),
            { ...approval, command: shellCommand(words) },
          );
          // Asked to register and did not — the client's CLI is not on PATH — or registered an entry that did not
          // start. The result is still printed, but a zero exit told a script (or an agent) that it worked.
          softExit = installExitStatus(result);
          writeResult(result, output, (r) => renderInstall(r, output.color));
          return;
        }
        if (sub === 'prune') {
          const words = ['agentcomms', 'mcp', 'prune'];
          if (values['include-printed']) words.push('--include-printed');
          const result = await gatedChangeAtTerminal(
            core,
            serverPruneChange(core, env, {
              channel: 'core',
              dryRun: values['dry-run'],
              includePrinted: values['include-printed'],
            }),
            { ...approval, command: shellCommand(words) },
          );
          writeResult(result, output, (r) => renderPrune(r, output.color));
          return;
        }
        throw usage('usage: agentcomms mcp [install|prune]');
      }
      case 'names': {
        if (sub !== 'migrate') {
          throw usage('usage: agentcomms names migrate [--rename <old>=<new>] [--dry-run] [--approval <id>]');
        }
        if (values.yes) {
          throw new CommsError(
            'USAGE',
            '--yes no longer skips the question: renaming every account is a change a person approves',
            {
              hint: 'Run it without --yes. At a terminal you approve it there; anything else gets the preview and an approval id, and runs it again with --approval <id> once the person has agreed.',
            },
          );
        }
        const renames = values.rename ?? [];
        const dry = namesDryRun(await core.config.load(), renames);
        if (dry.status === 'already-migrated') {
          writeResult(dry, output, () => 'Names are already organisation/platform.');
          return;
        }
        if (values['dry-run']) {
          writeResult(
            dry,
            output,
            (data) =>
              `${renderMapping(data.rows, data.notApplicable)}\n\nNothing was changed. Run the same command without --dry-run to apply it.`,
          );
          return;
        }
        /*
         * The mapping is shown before anything is written, whoever is running it.
         *
         * A person reads it above the question; an agent's transcript carries it — which is the only record of what
         * the old names were once the file no longer holds them. It goes to stderr so `--json` keeps its one envelope
         * on stdout.
         */
        defaultStreams.stderr.write(`${renderMapping(dry.rows, dry.notApplicable)}\n`);
        const result = await gatedChangeAtTerminal(core, namesMigration(core, renames), {
          ...approval,
          command: shellCommand([
            'agentcomms',
            'names',
            'migrate',
            ...renames.flatMap((rename) => ['--rename', rename]),
          ]),
        });
        writeResult(result, output, (data) =>
          data.status === 'already-migrated' || !('rows' in data)
            ? 'Names are already organisation/platform.'
            : [
                `Renamed ${data.rows.length} account(s). The old names no longer work; anything that uses one is told what it is called now.`,
                ...(data.backup ? [`The configuration as it was is saved at ${data.backup}.`] : []),
              ].join('\n'),
        );
        return;
      }
      case 'secrets': {
        if (sub !== 'migrate' || (values.to !== 'keychain' && values.to !== 'file')) {
          throw usage('usage: agentcomms secrets migrate --to keychain|file');
        }
        const result = await gatedChangeAtTerminal(core, secretsMigration(core, values.to, { surface: 'cli' }), {
          ...approval,
          command: shellCommand(['agentcomms', 'secrets', 'migrate', '--to', values.to]),
        });
        /*
         * One document, whichever way it went.
         *
         * Switched but not tidy is reported as an error, not as a success with a footnote — and *instead of* the
         * success result, not after it: `--json` promises exactly one envelope on stdout, and printing a result and
         * then throwing puts two there.
         */
        if (result.leftovers.length > 0) {
          throw new CommsError(
            'CONFIG',
            `moved ${result.moved} secrets from ${result.from} to ${result.to}, but ${result.leftovers.length} original(s) could not be removed from ${result.from}`,
            {
              hint: `The new backend is in use. Delete these references from ${result.from}: ${result.leftovers.map((l) => l.ref).join(', ')}.`,
              details: { ...result },
            },
          );
        }
        writeResult(result, output, (r) =>
          r.moved === 0 && r.from === r.to
            ? `secrets already use ${r.to}`
            : `moved ${r.moved} secrets from ${r.from} to ${r.to}`,
        );
        return;
      }
      default:
        throw usage(`unknown command "${command}"`);
    }
  });
  return code === EXIT_CODES.OK ? softExit : code;
}

function renderPolicy(report: ChangePolicyReport): string {
  const where = report.name === null ? 'Default change policy' : `Change policy of ${report.name}`;
  const how =
    report.changePolicy === 'chat'
      ? 'a yes in the chat approves a loosening'
      : 'a loosening needs a code typed at a terminal';
  const lines = [
    `${where}: ${report.changePolicy} — ${how}${report.setHere === null ? ' (not set here; the default)' : ''}.`,
  ];
  for (const override of report.overrides ?? []) {
    lines.push(
      `  ${override.kind === 'inbox' ? 'mailbox  ' : 'workspace'}  ${override.name}: ${override.changePolicy}`,
    );
  }
  // Set apart from the list, with the commands: a `chat` left behind by tightening the default is the one line here
  // that says `confirm` does not cover everything.
  if (report.warning && report.looser && report.looser.length > 0) {
    lines.push('', `Warning: ${report.warning} To tighten ${report.looser.length === 1 ? 'it' : 'them'}:`);
    for (const entry of report.looser) lines.push(`  ${entry.tighten.command}`);
  }
  return lines.join('\n');
}

function renderChannels(report: ChannelsReport): string {
  const lines: string[] = [];
  for (const channel of report.channels) {
    const where = [
      ...channel.runtimes.map((runtime) => `runtime ${runtime.version}`),
      ...(channel.onPath ? [`${channel.binary} ${channel.onPath.version ?? '(version unknown)'} on PATH`] : []),
    ];
    lines.push(
      `${channel.label.padEnd(18)} ${channel.package}  ${channel.installed ? (where.length > 0 ? where.join(', ') : `this process, ${report.core}`) : 'not installed'}`,
    );
    for (const entry of channel.registered) {
      lines.push(
        `  registered with ${entry.client} as "${entry.name}" (${entry.launcher}${entry.version ? ` ${entry.version}` : ''})${entry.missing ? ` — ${entry.missing} is missing` : ''}`,
      );
    }
  }
  for (const file of report.unreadable) lines.push(`Could not read ${file.path}: ${file.reason}.`);
  return lines.join('\n');
}

/**
 * The mapping, one line per account, old name on the left — then any `--rename` that matched nothing here.
 *
 * Those are listed rather than dropped silently: one mapping is meant to run on every computer, so a source this one
 * lacks is normal, but a misspelt source looks exactly the same, and the account it meant would take its default.
 */
function renderMapping(rows: readonly NamesMigrationRow[], notApplicable: readonly NotApplicableRename[] = []): string {
  const width = Math.max(...rows.map((row) => row.from.length), 0);
  const kind = (row: NamesMigrationRow) => (row.kind === 'inbox' ? 'mailbox  ' : 'workspace');
  return [
    `${rows.length} account(s) will be renamed:`,
    '',
    ...rows.map((row) => `  ${kind(row)}  ${row.from.padEnd(width)}  →  ${row.to}`),
    ...(notApplicable.length > 0
      ? [
          '',
          `Not applicable here — nothing on this computer is called that, so ${notApplicable.length === 1 ? 'this rename changes' : 'these renames change'} nothing:`,
          '',
          ...notApplicable.map((skipped) => `  --rename ${skipped.rename}`),
        ]
      : []),
  ].join('\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[/\\])(?:cli\.(?:mjs|ts)|agentcomms)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`agentcomms: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 64;
    },
  );
}
