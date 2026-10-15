#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { approveAndWaitSentence } from './approval-handoffs.ts';
import type { PublicApprovalView } from './approval-outcome.ts';
import { renderApprovalWait } from './approval-wait-surface.ts';
import { approveChangeAtTerminal, gatedChangeAtTerminal, refuseUnclaimedApproval } from './change-flow.ts';
import type { PreparedChange } from './changes.ts';
import {
  colorEnabled,
  defaultStreams,
  type OutputOptions,
  pathOverridesFromCliOptions,
  runCommand,
  writeError,
  writeResult,
} from './cli-runtime.ts';
import { openCore } from './core.ts';
import { CommsError, EXIT_CODES } from './errors.ts';
import {
  type CliHandoffs,
  CORE_CALLER,
  cliHandoffs,
  type Handoff,
  handoffSentence,
  handoffSentenceToFill,
  handoffText,
} from './handoffs.ts';
import { installExitStatus, type Launcher, type SupportedClient } from './mcp-install.ts';
import type { NamesMigrationRow, NotApplicableRename } from './names.ts';
import { wholeNumber } from './numbers.ts';
import { MAX_WAIT_SECONDS, waitForApproval } from './operations/approval-wait.ts';
import {
  type AttachChangeKind,
  type AttachChangeResult,
  type AttachEntry,
  type AttachReport,
  attachChange,
  attachReport,
} from './operations/attach-settings.ts';
import {
  type ChangePolicyReport,
  changePolicyChange,
  changePolicyReport,
  isChangePolicy,
  refuseApprovalWithoutChange,
} from './operations/change-policy.ts';
import {
  type LabelChangeRequest,
  type LabelChangeResult,
  type LabelReport,
  labelChange,
  labelReport,
} from './operations/label.ts';
import { auditTail, corePaths, doctor, listApprovals, revokeApproval } from './operations/maintenance.ts';
import { namesDryRun, namesMigration } from './operations/names-migrate.ts';
import {
  type OrganisationView,
  type OrgChangeResult,
  type OrgRemoveResult,
  orgAddChange,
  orgList,
  orgRemoveChange,
  orgShow,
  orgUpdateChange,
} from './operations/organisations.ts';
import { migrationLeftoversError, secretsMigration } from './operations/secrets-migrate.ts';
import {
  type ChannelsReport,
  channelsAvailable,
  serverInstallChange,
  serverPruneChange,
} from './operations/servers.ts';
import { updateChange, updateCheck } from './operations/update.ts';
import {
  type UpdateAutoResult,
  type UpdateLaterResult,
  updateAutoChange,
  updateLaterChange,
} from './operations/update-settings.ts';
import { profileSourcePath, shownPath } from './organisations.ts';
import { resolvePaths } from './paths.ts';
import { renderDoctor, renderInstall, renderPrune, renderUpdate, renderUpdateCheck } from './render.ts';
import { runUpdateCheckChild, terminalUpdateHooks, UPDATE_CHECK_CHILD_COMMAND } from './update-check.ts';
import { CHANGE_CLAIM, exemptFromUpdateGate, updateGateAtTerminal } from './update-gate.ts';
import { VERSION } from './version.ts';

/**
 * `agentcomms` — the provider-neutral command: where things live, whether this machine is healthy, what was written
 * to mailboxes, which approvals exist, moving secrets between backends, the change policy, and registering the MCP
 * servers of every channel. A channel's own commands live in its own binary (`agent-gmail`, `agent-slack`, …).
 *
 * Every command here is an operation in `src/operations/` that the core MCP server's tool calls too, and every one
 * that changes something goes through `gatedChangeAtTerminal`: a person at a terminal approves there and then, and an
 * agent gets the preview and an approval id (exit 10) and runs the command again with `--approval <id>`.
 *
 * Nothing a library imports may import this file: it starts `main()` when the running script is called `cli.mjs`,
 * which is what every product's CLI is called.
 */

const HELP = `agent-communications core ${VERSION}

Usage — run these with this CLI, each as the words after its program:
  paths                         where config, state, data and downloads live
  doctor                        check this machine: Node, directories, secret store, and which MCP
                                clients start each server
  audit tail [--inbox <alias>] [--since <ISO time>] [--limit <n>]
  approvals list [--inbox <alias>] [--state <state>]
  approvals revoke <approvalId>
  approval wait <approvalId> [--wait-seconds <n>]
                                wait for an approval to be usable or finished, and say where it stands:
                                30 seconds when left out, 300 at most, 0 for its status now
  approve <approvalId>          approve a configuration change at this terminal: read it, type the code
  policy [--account <name> | --inbox <name>] [chat|confirm] [--approval <id>]
                                report or set the change policy: how a loosening is approved;
                                confirm applies at once, chat is approved first
  attach                        which files may be attached: the folders they may come from, the
                                paths they never may, and the built-in list
  attach roots add <folder> [--approval <id>]
                                let files under a folder be attached: approved first
  attach roots remove <folder>  stop attaching files from under a folder: applies at once
  attach deny add <path>        never attach files from a path: applies at once
  attach deny remove <path> [--approval <id>]
                                take one of your own deny entries away: approved first
  channels                      which declared servers exist, which are installed, and where they are registered
  org add <file> [--for-other-addresses] [--adopt <client>] [--store keychain|file] [--approval <id>]
                                add an organisation's profile — its Google client and Slack apps,
                                beside what is here: approved first
  org list                      the organisation profiles added here
  org show <organisation>       one profile: its clients, which mailboxes use them, and any drift
  org update <organisation> [--source <file>] [--for-other-addresses on|off] [--adopt <client>]
                                [--store keychain|file] [--approval <id>]
                                read a profile again and repair drift: a changed profile, a new
                                source and --for-other-addresses on are approved first
  org remove <organisation> [--approval <id>]
                                forget a profile and the clients it made: approved first
  label                         how what an agent sends is labelled — "Jo Example (agent)" — and who
                                each kind of message appears to come from on each account
  label word <word> [--approval <id>]
                                the word after your name: agent, assistant, twin, minion, bot, fake or
                                AI; approved first
  label name <name>|--clear [--approval <id>]
                                your name, for where a channel has none of its own: approved first
  label rule add <account> [--conversation <id>] [--kinds <kind,…>] --as agent|me [--approval <id>]
                                who a kind of message appears to come from: --as me sends it as you,
                                unlabelled, and is approved first; --as agent applies at once
  label rule remove <account> [--conversation <id>] [--kinds <kind,…>] --as agent|me [--approval <id>]
                                take a rule away, as it is listed: an agent rule is approved first,
                                a me rule applies at once
  label icon <account> <:emoji:>|--clear [--approval <id>]
                                the workspace emoji the app's Slack posts show: approved first
  mcp                           run the core MCP server on stdio (what an MCP client starts)
  mcp install --client <client> [--server <server>] [--name <name>] [--account <account>|--inbox <inbox>|--workspace <workspace>] [--read-only]
                                [--launcher managed|npx|local] [--force]
                                [--print] [--no-verify] [--approval <id>]
                                register the core server, or another declared server, and prove it starts
  mcp prune [--server <server>] [--dry-run] [--include-printed] [--approval <id>]
                                remove that server's managed runtimes that nothing uses
  update [--check] [--no-verify] [--approval <id>]
                                bring every registration, runtime and global package to the latest
                                release; --check only says what is behind
  update --later [--approval <id>]
                                not now: nothing stops for the update until midnight
  update --auto on|off [--approval <id>]
                                turn the daily update check on or off for this machine
  secrets migrate --to keychain|file [--approval <id>]
  names migrate [--rename <old>=<new>] [--dry-run] [--approval <id>]

A change that loosens something or cannot be taken back — policy chat, attach roots add, attach deny remove, mcp
install and prune, update, secrets and names migrate, org add, update and remove, label word, name and icon, label
rule add --as me and label rule remove --as agent — is shown before it happens. At a terminal you approve it there;
anything else gets the preview and an approval id (exit 10), and runs the command again with --approval <id> once the
person has agreed: in the chat under the \`chat\` change policy, with \`approve\` under \`confirm\`. A tightening —
policy confirm, attach roots remove, attach deny add, label rule add --as agent, label rule remove --as me — applies
at once and asks nobody, and a --dry-run changes nothing.

Once a day this machine asks npm whether a newer release is out. When one is, every command but update, doctor,
paths, approve and approvals stops first: at a terminal it asks "Update now, later today, or cancel?"; anywhere else
it exits 11 and names the commands for update and update --later. Putting it off (--later) and turning the check
off (--auto off) are changes a person approves. CI, and AGENT_COMMS_UPDATE_CHECK=off, skip it.

Options:
  --config-dir <dir>     use this configuration directory for this run
  --state-dir <dir>      use this state directory for this run
  --data-dir <dir>       use this managed-runtime data directory for this run
  --secrets-dir <dir>    use this file-secret directory for this run
  --downloads-dir <dir>  use this downloads root for this run
  --json        print the versioned JSON envelope
  --no-color    disable colour (also NO_COLOR, TERM=dumb)
  -h, --help    show this help
  -v, --version show the version

Exit codes: 0 ok · 1 unexpected · 10 approval required · 11 an update is out: update first, or put it off
            64 usage · 65 bad data · 66 not found · 69 provider unavailable · 75 transient
            77 auth or scope missing · 78 config error
`;

/** A usage error, its hint the help of this installation: `help`, located (`CliHandoffs.own(['--help'])`). */
/**
 * One line of `approvals list`: the id and the state (`corrupt` for a record that cannot be used), then what the record
 * has of these — its policy, when it expires, why it is corrupt, and that an earlier release prepared it.
 */
function approvalLine(approval: PublicApprovalView): string {
  return [
    approval.approvalId,
    approval.state.padEnd(8),
    ...(approval.claimable === true ? ['claimable'] : []),
    ...(approval.route !== undefined ? [`route ${approval.route}`] : []),
    ...(approval.expiresAt !== undefined && (approval.state === 'pending' || approval.state === 'approved')
      ? [`expires ${approval.usableUntil ?? approval.expiresAt}`]
      : []),
    ...(approval.reason !== undefined ? [`(${approval.reason})`] : []),
    ...(approval.legacy === true ? ['(prepared by an earlier release)'] : []),
  ].join('  ');
}

function usageError(message: string, help: Handoff): CommsError {
  return new CommsError('USAGE', message, { hint: handoffSentence(help, (command) => `Run ${command}.`) });
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    // Where each option and word was, so `org update --for-other-addresses on` can take the word after the flag.
    tokens: true,
    options: {
      json: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      inbox: { type: 'string' },
      account: { type: 'string' },
      workspace: { type: 'string' },
      'read-only': { type: 'boolean', default: false },
      since: { type: 'string' },
      limit: { type: 'string' },
      state: { type: 'string' },
      'wait-seconds': { type: 'string' },
      to: { type: 'string' },
      rename: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      // No longer answers anything: kept so that it is refused with what to do instead, not as an unknown option.
      yes: { type: 'boolean', default: false },
      approval: { type: 'string' },
      client: { type: 'string' },
      server: { type: 'string' },
      name: { type: 'string' },
      launcher: { type: 'string' },
      force: { type: 'boolean', default: false },
      print: { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
      'include-printed': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      later: { type: 'boolean', default: false },
      auto: { type: 'string' },
      // A flag on `org add`, and on `org update` the flag and the word after it — `on` or `off` — read from the tokens.
      'for-other-addresses': { type: 'boolean', default: false },
      adopt: { type: 'string' },
      store: { type: 'string' },
      source: { type: 'string' },
      // `label rule add|remove` and `label name|icon --clear`; refused on every other command.
      conversation: { type: 'string' },
      kinds: { type: 'string' },
      as: { type: 'string' },
      clear: { type: 'boolean', default: false },
      'config-dir': { type: 'string' },
      'state-dir': { type: 'string' },
      'data-dir': { type: 'string' },
      'secrets-dir': { type: 'string' },
      'downloads-dir': { type: 'string' },
    },
  });
}

/**
 * The words of the command line with the one after `--for-other-addresses` taken out, and that word.
 *
 * `org add` takes the flag alone; `org update` takes `on` or `off` after it. One option cannot be both a flag and a
 * string to `parseArgs`, and a string option would swallow the file in `org add --for-other-addresses ./rgc.json`. So it
 * is a flag, and the word right after it, where there is one, is read from the tokens.
 */
function forOtherAddressesWord(parsed: ReturnType<typeof parse>): { positionals: string[]; word: string | undefined } {
  const tokens = parsed.tokens ?? [];
  const at = tokens.findIndex((token) => token.kind === 'option' && token.name === 'for-other-addresses');
  const next = at === -1 ? undefined : tokens[at + 1];
  if (next?.kind !== 'positional' || (next.value !== 'on' && next.value !== 'off')) {
    return { positionals: parsed.positionals, word: undefined };
  }
  return {
    positionals: tokens.flatMap((token) => (token.kind === 'positional' && token !== next ? [token.value] : [])),
    word: next.value,
  };
}

const CLIENT_NAMES = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'vscode', 'json'];

/**
 * Whether a command takes `--approval`: one that makes a change a person approves — `policy` with a policy to set,
 * `mcp install`, `mcp prune`, `names migrate`, `secrets migrate` and `update` — where it is how the second run claims
 * that change. Every one of them is a change, so what it claims is a change approval.
 */
/** Whether a command is a wait for an approval: `approval wait <approvalId>`, a look-up past the update's stop. */
function waitsFor(command: string | undefined, sub: string | undefined): boolean {
  return command === 'approval' && sub === 'wait';
}

function takesApproval(command: string | undefined, sub: string | undefined): boolean {
  switch (command) {
    case 'policy':
    case 'attach':
      return sub !== undefined;
    case 'mcp':
      return sub === 'install' || sub === 'prune';
    case 'names':
    case 'secrets':
      return sub === 'migrate';
    case 'update':
      return true;
    case 'org':
      return sub === 'add' || sub === 'update' || sub === 'remove';
    case 'label':
      return sub !== undefined;
    default:
      return false;
  }
}

/**
 * Refuses `--approval` on a command that takes none, as USAGE.
 *
 * Parsed as one option for every command, it was carried to the update check's stop whatever the command, and the
 * stop lets a command claiming an approval through (§2): `agentcomms channels --approval <id>`, with an old "not now"
 * the person had turned down, ran past it. Over MCP the same calls are refused an `approvalId` their tools do not
 * declare, and every channel's command is refused an option it does not take, before anything runs. So is this one.
 */
function refuseApprovalNotTaken(command: string | undefined, sub: string | undefined, approvalId: unknown): void {
  if (approvalId === undefined || takesApproval(command, sub)) return;
  // Reporting the policy takes none, in the words `comms_change_policy` refuses it with.
  if (command === 'policy') refuseApprovalWithoutChange(String(approvalId));
  // The command's own words, without the program: a bare `agentcomms` is not what runs here (CUE-403).
  const typed = [command, sub].filter((word) => word !== undefined).join(' ');
  throw new CommsError('USAGE', `\`${typed}\` takes no --approval: it makes no change a person approves`, {
    hint: 'An approval goes with the change it was prepared for — policy chat|confirm, attach roots|deny add|remove, org add|update|remove, label word|name|rule|icon, mcp install, mcp prune, names migrate, secrets migrate or update — run again exactly as the preview named it. Nothing was run.',
  });
}

/**
 * Refuses `label`'s own options on any other command, as USAGE, before anything runs — as `org`'s are, and for the
 * same reason: an option a command does not read is refused rather than quietly doing nothing.
 */
function refuseLabelOptionsElsewhere(
  command: string | undefined,
  values: { conversation?: string; kinds?: string; as?: string; clear?: boolean },
  help: Handoff,
): void {
  if (command === 'label') return;
  const given = labelOptionsGiven(values);
  if (given.length === 0) return;
  throw new CommsError(
    'USAGE',
    `${given.map((flag) => `--${flag}`).join(', ')} ${given.length === 1 ? 'is an option' : 'are options'} of the label command only`,
    { hint: handoffSentence(help, (command) => `Run ${command} for what each command takes. Nothing was run.`) },
  );
}

function labelOptionsGiven(values: { conversation?: string; kinds?: string; as?: string; clear?: boolean }): string[] {
  return [
    ...(values.conversation !== undefined ? ['conversation'] : []),
    ...(values.kinds !== undefined ? ['kinds'] : []),
    ...(values.as !== undefined ? ['as'] : []),
    ...(values.clear ? ['clear'] : []),
  ];
}

/**
 * Refuses `org`'s own options on any other command, as USAGE, before anything runs.
 *
 * One parser reads every command's options, so `--store` was known to `secrets migrate` too, and taken there without
 * a word — beside `--to`, which is what that command reads. An option a command does not read is refused, as every
 * channel's command refuses one, rather than quietly doing nothing.
 */
function refuseOrgOptionsElsewhere(
  command: string | undefined,
  values: { 'for-other-addresses'?: boolean; adopt?: string; store?: string; source?: string },
  help: Handoff,
): void {
  if (command === 'org') return;
  const given = [
    ...(values['for-other-addresses'] ? ['--for-other-addresses'] : []),
    ...(values.adopt !== undefined ? ['--adopt'] : []),
    ...(values.store !== undefined ? ['--store'] : []),
    ...(values.source !== undefined ? ['--source'] : []),
  ];
  if (given.length === 0) return;
  throw new CommsError(
    'USAGE',
    `${given.join(', ')} ${given.length === 1 ? 'is an option' : 'are options'} of the org command only`,
    { hint: handoffSentence(help, (command) => `Run ${command} for what each command takes. Nothing was run.`) },
  );
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: {
    /** Starts the stdio server. Injected so a test can inspect its inputs without opening stdio. */
    startMcp?:
      | ((options: {
          core: ReturnType<typeof openCore>;
          env: NodeJS.ProcessEnv;
          platform: NodeJS.Platform;
        }) => Promise<void>)
      | undefined;
  } = {},
): Promise<number> {
  // This installation's own help, for a usage error before the folders are known: it reads none of them.
  const help = cliHandoffs({ caller: CORE_CALLER, paths: resolvePaths({ env, platform }), platform, env }).own(
    ['--help'],
    { uses: [] },
  );
  const usage = (message: string) => usageError(message, help);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    const json = argv.includes('--json');
    return writeError(usage(error instanceof Error ? error.message : String(error)), { json, color: false });
  }
  const { values, positionals } = parsed;
  const output: OutputOptions & { platform: NodeJS.Platform } = {
    json: values.json,
    color: colorEnabled(env, process.stdout, values['no-color'] ? false : undefined),
    platform,
  };
  let pathOverrides: ReturnType<typeof pathOverridesFromCliOptions>;
  try {
    pathOverrides = pathOverridesFromCliOptions(values);
  } catch (error) {
    return writeError(error, output);
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, sub, arg] = positionals;
  try {
    refuseApprovalNotTaken(command, sub, values.approval);
    refuseOrgOptionsElsewhere(command, values, help);
    refuseLabelOptionsElsewhere(command, values, help);
  } catch (error) {
    return writeError(error as CommsError, output);
  }
  const core = openCore({ env, platform, pathOverrides, caller: CORE_CALLER });
  // Opened with core's own caller, so these are always there: every command this prints is located from here.
  const handoffs = core.handoffs as CliHandoffs;
  // Every change this CLI prepares is core's own: its approval records `core` as its channel.
  const approval = { channel: 'core', approvalId: values.approval, env, output };
  /** An exit status for a command that printed its result and still did not do what was asked. */
  let softExit: number = EXIT_CODES.OK;

  // The server speaks on stdout, so nothing else may: it is run outside `runCommand`, which prints a result there.
  if (command === 'mcp' && sub === undefined) {
    if (values.json) return writeError(usage('`mcp` runs the server; it prints no result'), output);
    const startCoreStdioServer = deps.startMcp ?? (await import('./mcp/server.ts')).startCoreStdioServer;
    await startCoreStdioServer({ core, env, platform });
    return EXIT_CODES.OK;
  }

  // The rest of the day's update check, which a command handed to this child before it ended (#48): hidden, and never
  // stopped by the gate it is part of — it is run before the gate, as the server is.
  if (command === UPDATE_CHECK_CHILD_COMMAND) {
    return runCommand(output, () => runUpdateCheckChild(core, env, sub));
  }

  // The daily update check (design 2026-09-28 §3): before any command but the exempt ones, an update that is out
  // stops it — a person is asked, anything else ends with UPDATE_REQUIRED. One carrying an approval the person
  // already gave goes ahead, as the same call over MCP does: only a command that takes one carries it, and every one
  // of those claims a change.
  if (!exemptFromUpdateGate(positionals.slice(0, 2))) {
    let ended: number | null = null;
    const gated = await runCommand(output, async () => {
      ended = await updateGateAtTerminal({
        core,
        env,
        binary: 'agentcomms',
        channel: 'core',
        running: VERSION,
        output,
        streams: defaultStreams,
        // A wait only looks: it answers while an update is out, for any approval this machine can read (decision 7).
        approvals: takesApproval(command, sub) ? [values.approval] : waitsFor(command, sub) ? [arg] : [],
        approvalClaim: waitsFor(command, sub) ? { lookup: true } : CHANGE_CLAIM,
        ...terminalUpdateHooks(core, env, { channel: 'core', output, streams: defaultStreams }),
      });
    });
    if (gated !== EXIT_CODES.OK) return gated;
    if (ended !== null) return ended;
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
        const report = await doctor(core, env, { platform });
        writeResult(report, output, renderDoctor);
        if (!report.ok)
          throw new CommsError('CONFIG', 'doctor found problems', { hint: 'Apply the fixes listed above.' });
        return;
      }
      case 'audit': {
        if (sub !== 'tail') throw usage('usage: audit tail');
        // Checked as typed: `Number.parseInt` read `1e2` as 1 and `12abc` as 12.
        const limit = wholeNumber(values.limit, { name: '--limit', min: 1 });
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
          writeResult(records, output, (rs) => (rs.length ? rs.map(approvalLine).join('\n') : 'no approvals'));
          return;
        }
        if (sub === 'revoke') {
          if (!arg) throw usage('usage: approvals revoke <approvalId>');
          const record = await revokeApproval(core, arg, 'cli');
          writeResult(record, output, (r) => `${r.approvalId} is ${r.state}`);
          return;
        }
        throw usage('usage: approvals list|revoke');
      }
      case 'approval': {
        if (sub !== 'wait' || !arg || positionals.length > 3) {
          throw usage('usage: approval wait <approvalId> [--wait-seconds <n>]');
        }
        const result = await waitForApproval(core, arg, {
          waitSeconds: wholeNumber(values['wait-seconds'], { name: '--wait-seconds', min: 0, max: MAX_WAIT_SECONDS }),
          channel: null,
        });
        writeResult(result, output, renderApprovalWait);
        return;
      }
      case 'approve': {
        if (!sub || arg !== undefined) throw usage('usage: approve <approvalId>');
        const result = await approveChangeAtTerminal(core, sub, env, output);
        writeResult(result, output, (r) =>
          r.state === 'approved'
            ? 'Approved. The agent can make the change now — this command approves; it changes nothing itself.'
            : 'Cancelled. Nothing was changed.',
        );
        return;
      }
      case 'policy': {
        if (arg !== undefined) throw usage('usage: policy [--account <name> | --inbox <name>] [chat|confirm]');
        const scope = { inbox: values.inbox, account: values.account };
        if (sub === undefined) {
          // Reporting takes no --approval: refused with the rest, before the update check's stop.
          writeResult(changePolicyReport(await core.config.load(), scope, handoffs), output, renderPolicy);
          return;
        }
        if (!isChangePolicy(sub)) throw usage(`"${sub}" is not a change policy; use chat or confirm`);
        const where = values.account ? ['--account', values.account] : values.inbox ? ['--inbox', values.inbox] : [];
        const report = await gatedChangeAtTerminal(core, changePolicyChange(core, scope, sub, platform), {
          ...approval,
          rerun: ['policy', ...where, sub],
        });
        writeResult(report, output, renderPolicy);
        return;
      }
      case 'attach': {
        const [, list, action, path, ...extra] = positionals;
        if (list === undefined) {
          // Reporting takes no --approval: refused with the rest, before the update check's stop.
          writeResult(await attachReport(core, env), output, (report) => renderAttach(report, handoffs));
          return;
        }
        const kind = ATTACH_KINDS[`${list} ${action ?? ''}`];
        if (kind === undefined || path === undefined || extra.length > 0) {
          throw usage('usage: attach [roots|deny add|remove <path>] [--approval <id>]');
        }
        const result = await gatedChangeAtTerminal(core, attachChange(core, env, { kind, path }, 'cli'), {
          ...approval,
          rerun: ['attach', list, action as string, path],
        });
        writeResult(result, output, (change) => renderAttachChange(change, handoffs));
        return;
      }
      case 'org': {
        const { positionals: words, word } = forOtherAddressesWord(parsed);
        const [, , target, ...extra] = words;
        const orgOptions = { env, platform, surface: 'cli' as const };
        const flagsOf = (taken: readonly string[]) => {
          const given = (
            [
              ['for-other-addresses', values['for-other-addresses']],
              ['adopt', values.adopt !== undefined],
              ['store', values.store !== undefined],
              ['source', values.source !== undefined],
            ] as const
          )
            .filter(([, on]) => on)
            .map(([flag]) => flag);
          const wrong = given.filter((flag) => !taken.includes(flag));
          if (wrong.length > 0) {
            throw usage(
              `the ${['org', ...(sub === undefined ? [] : [sub])].join(' ')} command takes no --${wrong.join(', --')}`,
            );
          }
        };
        if (sub === 'list') {
          if (target !== undefined) throw usage('usage: org list');
          flagsOf([]);
          writeResult(await orgList(core, platform), output, (views) => renderOrgList(views, handoffs));
          return;
        }
        if (sub === 'show') {
          if (target === undefined || extra.length > 0) throw usage('usage: org show <organisation>');
          flagsOf([]);
          writeResult(await orgShow(core, target, platform), output, renderOrg);
          return;
        }
        if (sub === 'add') {
          if (target === undefined || extra.length > 0 || word !== undefined) {
            throw usage('usage: org add <file> [--for-other-addresses] [--adopt <client>] [--store keychain|file]');
          }
          flagsOf(['for-other-addresses', 'adopt', 'store']);
          // The file as it will be read, absolute: the command run again from another directory reads the same file.
          const path = profileSourcePath(target, env, undefined, handoffs);
          const repeated = rerunPath(path);
          const command = repeated === null ? ['org', 'add', '--help'] : ['org', 'add', repeated];
          if (values['for-other-addresses']) command.push('--for-other-addresses');
          if (values.adopt !== undefined) command.push('--adopt', values.adopt);
          if (values.store !== undefined) command.push('--store', values.store);
          const result = await gatedChangeAtTerminal(
            core,
            orgAddChange(
              core,
              {
                file: target,
                forOtherAddresses: values['for-other-addresses'],
                adopt: values.adopt,
                store: values.store,
                approvalId: values.approval,
              },
              orgOptions,
            ),
            {
              ...approval,
              rerun: command,
              ...(repeated === null
                ? { pendingHint: (prepared: PreparedChange) => hiddenPathApprovalHint(prepared, handoffs) }
                : {}),
            },
          );
          writeResult(result, output, renderOrgChange);
          return;
        }
        if (sub === 'update') {
          if (target === undefined || extra.length > 0 || (values['for-other-addresses'] && word === undefined)) {
            throw usage(
              'usage: org update <organisation> [--source <file>] [--for-other-addresses on|off] [--adopt <client>] [--store keychain|file]',
            );
          }
          flagsOf(['for-other-addresses', 'adopt', 'store', 'source']);
          const command = ['org', 'update', target];
          let repeatedSource = true;
          // The source as it will be read, absolute: the command run again from another directory reads the same file.
          if (values.source !== undefined) {
            const source = rerunPath(profileSourcePath(values.source, env, undefined, handoffs));
            repeatedSource = source !== null;
            if (source !== null) command.push('--source', source);
          }
          if (word !== undefined) command.push('--for-other-addresses', word);
          if (values.adopt !== undefined) command.push('--adopt', values.adopt);
          if (values.store !== undefined) command.push('--store', values.store);
          const result = await gatedChangeAtTerminal(
            core,
            orgUpdateChange(
              core,
              {
                organisation: target,
                source: values.source,
                forOtherAddresses: word,
                adopt: values.adopt,
                store: values.store,
                approvalId: values.approval,
              },
              orgOptions,
            ),
            {
              ...approval,
              rerun: repeatedSource ? command : ['org', 'update', '--help'],
              ...(!repeatedSource
                ? { pendingHint: (prepared: PreparedChange) => hiddenPathApprovalHint(prepared, handoffs) }
                : {}),
            },
          );
          writeResult(result, output, renderOrgChange);
          return;
        }
        if (sub === 'remove') {
          if (target === undefined || extra.length > 0) throw usage('usage: org remove <organisation>');
          flagsOf([]);
          const result = await gatedChangeAtTerminal(
            core,
            orgRemoveChange(core, { organisation: target }, orgOptions),
            {
              ...approval,
              rerun: ['org', 'remove', target],
            },
          );
          writeResult(result, output, renderOrgRemove);
          return;
        }
        throw usage('usage: org add|list|show|update|remove');
      }
      case 'label': {
        const [, , ...rest] = positionals;
        const taking = (taken: readonly string[]) => {
          const wrong = labelOptionsGiven(values).filter((flag) => !taken.includes(flag));
          if (wrong.length > 0) {
            throw usage(
              `the ${['label', ...positionals.slice(1, sub === 'rule' ? 3 : 2)].join(' ')} command takes no --${wrong.join(', --')}`,
            );
          }
        };
        if (sub === undefined) {
          taking([]);
          // Reporting takes no --approval: refused with the rest, before the update check's stop.
          writeResult(await labelReport(core), output, renderLabel);
          return;
        }
        let request: LabelChangeRequest;
        let rerun: string[];
        if (sub === 'word') {
          taking([]);
          const [word, ...extra] = rest;
          if (word === undefined || extra.length > 0) throw usage('usage: label word <word>');
          request = { word };
          rerun = ['label', 'word', word];
        } else if (sub === 'name') {
          taking(['clear']);
          const [name, ...extra] = rest;
          if (extra.length > 0) throw usage('usage: label name <name>|--clear — quote a name with spaces in it');
          if ((name === undefined) === !values.clear) throw usage('usage: label name <name>|--clear');
          request = { name: values.clear ? null : (name as string) };
          rerun = values.clear ? ['label', 'name', '--clear'] : ['label', 'name', name as string];
        } else if (sub === 'rule') {
          taking(['conversation', 'kinds', 'as']);
          const [action, account, ...extra] = rest;
          if ((action !== 'add' && action !== 'remove') || account === undefined || extra.length > 0) {
            throw usage(
              'usage: label rule add|remove <account> [--conversation <id>] [--kinds <kind,…>] --as agent|me',
            );
          }
          if (values.as === undefined) throw usage('say who the messages appear to come from: --as agent or --as me');
          const kinds = values.kinds?.split(',').map((kind) => kind.trim());
          const rule = {
            account,
            ...(values.conversation === undefined ? {} : { conversation: values.conversation }),
            ...(kinds === undefined ? {} : { kinds }),
            as: values.as,
          };
          request = action === 'add' ? { addRule: rule } : { removeRule: rule };
          rerun = [
            'label',
            'rule',
            action,
            account,
            ...(values.conversation === undefined ? [] : ['--conversation', values.conversation]),
            ...(values.kinds === undefined ? [] : ['--kinds', values.kinds]),
            '--as',
            values.as,
          ];
        } else if (sub === 'icon') {
          taking(['clear']);
          const [account, emoji, ...extra] = rest;
          if (account === undefined || extra.length > 0 || (emoji === undefined) === !values.clear) {
            throw usage('usage: label icon <account> <:emoji:>|--clear');
          }
          request = { icon: { account, emoji: values.clear ? null : (emoji as string) } };
          rerun = values.clear ? ['label', 'icon', account, '--clear'] : ['label', 'icon', account, emoji as string];
        } else {
          throw usage('usage: label [word|name|rule add|rule remove|icon]');
        }
        const result = await gatedChangeAtTerminal(core, labelChange(core, request, 'cli'), { ...approval, rerun });
        writeResult(result, output, renderLabelChange);
        return;
      }
      case 'channels': {
        if (sub !== undefined) throw usage('usage: channels');
        writeResult(await channelsAvailable(core, env), output, renderChannels);
        return;
      }
      case 'mcp': {
        if (sub === 'install') {
          if (!values.client) {
            throw new CommsError('USAGE', 'name the client with --client', {
              hint: handoffSentence(
                handoffs.own(['mcp', 'install', '--client', 'claude-code']),
                (example) => `For example: ${example}.`,
              ),
            });
          }
          if (!CLIENT_NAMES.includes(values.client)) {
            throw usage(`--client must be one of: ${CLIENT_NAMES.join(', ')}`);
          }
          const words = ['mcp', 'install', '--client', values.client];
          if (values.server) words.push('--server', values.server);
          if (values.name) words.push('--name', values.name);
          if (values.account) words.push('--account', values.account);
          if (values.inbox) words.push('--inbox', values.inbox);
          if (values.workspace) words.push('--workspace', values.workspace);
          if (values['read-only']) words.push('--read-only');
          if (values.launcher) words.push('--launcher', values.launcher);
          if (values.force) words.push('--force');
          if (values['no-verify']) words.push('--no-verify');
          const result = await gatedChangeAtTerminal(
            core,
            serverInstallChange(core, env, {
              channel: values.server ?? 'core',
              client: values.client as SupportedClient,
              name: values.name,
              account: values.account,
              inbox: values.inbox,
              workspace: values.workspace,
              readOnly: values['read-only'],
              launcher: values.launcher as Launcher | undefined,
              force: values.force,
              print: values.print,
              noVerify: values['no-verify'],
            }),
            { ...approval, rerun: words },
          );
          // Asked to register and did not — the client's CLI is not on PATH — or registered an entry that did not
          // start. The result is still printed, but a zero exit told a script (or an agent) that it worked.
          softExit = installExitStatus(result);
          writeResult(result, output, (r) => renderInstall(r, output.color));
          return;
        }
        if (sub === 'prune') {
          const words = ['mcp', 'prune'];
          if (values.server) words.push('--server', values.server);
          if (values['include-printed']) words.push('--include-printed');
          const result = await gatedChangeAtTerminal(
            core,
            serverPruneChange(core, env, {
              channel: values.server ?? 'core',
              dryRun: values['dry-run'],
              includePrinted: values['include-printed'],
            }),
            { ...approval, rerun: words },
          );
          writeResult(result, output, (r) => renderPrune(r, output.color));
          return;
        }
        throw usage('usage: mcp [install|prune]');
      }
      case 'update': {
        if (sub !== undefined) {
          throw usage('usage: update [--check | --later | --auto on|off] [--no-verify] [--approval <id>]');
        }
        const modes = [values.check, values.later, values.auto !== undefined].filter(Boolean).length;
        if (modes > 1 || (values['no-verify'] && (values.later || values.auto !== undefined))) {
          throw usage('--check, --later and --auto are one at a time, and --no-verify is for the update itself');
        }
        if (values.later) {
          const result = await gatedChangeAtTerminal(core, updateLaterChange(core), {
            ...approval,
            rerun: ['update', '--later'],
          });
          writeResult(result, output, renderLater);
          return;
        }
        if (values.auto !== undefined) {
          if (values.auto !== 'on' && values.auto !== 'off') throw usage('--auto takes on or off');
          const result = await gatedChangeAtTerminal(core, updateAutoChange(core, values.auto), {
            ...approval,
            rerun: ['update', '--auto', values.auto],
          });
          writeResult(result, output, renderAuto);
          return;
        }
        if (values.check) {
          if (values.approval !== undefined) {
            throw usage('--check only reads, so it takes no --approval; leave out --check to update');
          }
          writeResult(await updateCheck(core, env), output, (report) => renderUpdateCheck(report, handoffs));
          return;
        }
        const words = ['update'];
        if (values['no-verify']) words.push('--no-verify');
        const result = await gatedChangeAtTerminal(core, updateChange(core, env, { noVerify: values['no-verify'] }), {
          ...approval,
          rerun: words,
        });
        // Printed either way, but a step that did not work is not a success to a script, as for `mcp install`.
        softExit = result.ok ? EXIT_CODES.OK : EXIT_CODES.UNAVAILABLE;
        writeResult(result, output, (r) => renderUpdate(r, output.color));
        return;
      }
      case 'names': {
        if (sub !== 'migrate') {
          throw usage('usage: names migrate [--rename <old>=<new>] [--dry-run] [--approval <id>]');
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
        // A dry run claims nothing, so an approval here is refused rather than dropped: see `refuseUnclaimedApproval`.
        if (values['dry-run']) {
          refuseUnclaimedApproval(values.approval, {
            message: '--dry-run only shows the mapping, so it takes no --approval',
            hint: 'Leave out --dry-run to rename; anything without a terminal gets the preview and the approval id to run it again with.',
          });
        }
        const dry = namesDryRun(await core.config.load(), renames);
        if (dry.status === 'already-migrated') {
          /*
           * Nothing to rename is reported — unless an approval came with the command. That goes on to the change,
           * which refuses an approval on a change that needs none (`gatedChange`), as `comms_names_migrate` does in
           * the same words: reporting here dropped it, and the command had been let past the update check's stop on it.
           */
          if (values.approval === undefined) {
            writeResult(dry, output, () => 'Names are already organisation/platform.');
            return;
          }
        } else if (values['dry-run']) {
          writeResult(
            dry,
            output,
            (data) =>
              `${renderMapping(data.rows, data.notApplicable)}\n\nNothing was changed. Run the same command without --dry-run to apply it.`,
          );
          return;
        } else {
          /*
           * The mapping is shown before anything is written, whoever is running it.
           *
           * A person reads it above the question; an agent's transcript carries it — which is the only record of what
           * the old names were once the file no longer holds them. It goes to stderr so `--json` keeps its one
           * envelope on stdout.
           */
          defaultStreams.stderr.write(`${renderMapping(dry.rows, dry.notApplicable)}\n`);
        }
        const result = await gatedChangeAtTerminal(core, namesMigration(core, renames), {
          ...approval,
          rerun: ['names', 'migrate', ...renames.flatMap((rename) => ['--rename', rename])],
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
          throw usage('usage: secrets migrate --to keychain|file');
        }
        const result = await gatedChangeAtTerminal(
          core,
          secretsMigration(core, values.to, { surface: 'cli', platform }),
          {
            ...approval,
            rerun: ['secrets', 'migrate', '--to', values.to],
          },
        );
        /*
         * One document, whichever way it went.
         *
         * Switched but not tidy is reported as an error, not as a success with a footnote — and *instead of* the
         * success result, not after it: `--json` promises exactly one envelope on stdout, and printing a result and
         * then throwing puts two there.
         */
        const leftovers = migrationLeftoversError(result);
        if (leftovers) throw leftovers;
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
    for (const entry of report.looser) lines.push(`  ${handoffText(entry.tighten.command)}`);
  }
  return lines.join('\n');
}

/** The label as a person reads it: the word and the name, then each account and who its messages appear from. */
function renderLabel(report: LabelReport): string {
  const lines = [
    `Word: ${report.word}  (one of ${report.words.join(', ')})`,
    `Name: ${report.name ?? 'not set'} — used where a channel has no name of its own for you`,
  ];
  for (const ignored of report.ignored) lines.push(`Ignored: ${ignored}`);
  for (const account of report.accounts) {
    lines.push('', `${account.account} (${account.channel})`);
    if (account.note !== undefined) lines.push(`  ${account.note}`);
    for (const kind of account.kinds) {
      lines.push(`  ${kind.kind.padEnd(9)}${kind.appearsAs}${kind.rule === undefined ? '' : `  (rule ${kind.rule})`}`);
    }
    for (const conversation of account.conversations) lines.push(`  in one conversation: ${conversation}`);
    if (account.icon !== undefined) {
      lines.push(
        `  icon     ${'emoji' in account.icon ? account.icon.emoji : 'your Slack photo, until an agent emoji is set'}`,
      );
    }
  }
  const stray = report.rules.filter((rule) => !rule.matches);
  if (stray.length > 0) {
    lines.push('', 'Rules naming no account connected now — they match nothing:');
    for (const rule of stray) lines.push(`  ${rule.text}`);
  }
  return lines.join('\n');
}

function renderLabelChange(result: LabelChangeResult): string {
  return [result.note ?? (result.changed ? 'Done.' : 'Nothing was changed.'), '', renderLabel(result)].join('\n');
}

/** `attach roots add` and the rest, by their words. */
const ATTACH_KINDS: Readonly<Record<string, AttachChangeKind>> = {
  'roots add': 'rootsAdd',
  'roots remove': 'rootsRemove',
  'deny add': 'denyAdd',
  'deny remove': 'denyRemove',
};

function renderAttachEntries(entries: readonly AttachEntry[]): string[] {
  if (entries.length === 0) return ['  (none)'];
  return entries.map((entry) =>
    entry.real === null || entry.real === entry.path ? `  ${entry.path}` : `  ${entry.path}  (${entry.real})`,
  );
}

/** Exported for its test, which asks for Windows' quoting by name. */
export function renderAttach(report: AttachReport, handoffs: CliHandoffs): string {
  return [
    'Files may be attached from under:',
    ...renderAttachEntries(report.roots),
    ...(report.roots.length === 0 ? ['  — so nothing can be attached.'] : []),
    ...(report.ignored.length === 0
      ? []
      : [
          '',
          'Listed, but allowing nothing — they do not say which drive or folder they are on. To take one out, run the',
          'command shown for it:',
          // The whole command, quoted for the shell it is pasted into (`quoteCommand`): the entry as written, a space
          // at either end or nothing at all, and never a `$HOME` or a `$(…)` the shell would expand or run. On Windows a
          // command with an entry no quoting brings through — a `%USERPROFILE%`, nothing at all — is shown as words.
          ...report.ignored.map((root) => `  ${handoffText(handoffs.own(['attach', 'roots', 'remove', root]))}`),
        ]),
    '',
    'Never from, by your own entries:',
    ...renderAttachEntries(report.deny),
    '',
    'Never from, whatever the configuration says:',
    ...renderAttachEntries(report.builtIn),
    '',
    handoffSentenceToFill(
      handoffs.own(['attach', 'roots', 'add']),
      ['<folder>'],
      (command) => `To allow another folder: ${command} (you approve it first).`,
    ),
    handoffSentenceToFill(handoffs.own(['attach', 'roots', 'remove']), ['<folder>'], (remove) =>
      handoffSentenceToFill(
        handoffs.own(['attach', 'deny', 'add']),
        ['<path>'],
        (deny) => `To stop attaching from one: ${remove}; to deny a path: ${deny}.`,
      ),
    ),
  ].join('\n');
}

function renderAttachChange(result: AttachChangeResult, handoffs: CliHandoffs): string {
  const done = result.changed ? 'Done.' : 'Nothing was changed.';
  return [result.note ?? done, '', renderAttach(result, handoffs)].join('\n');
}

/**
 * A profile's path in the command an agent is told to run again: as it is, or absent when showing it would change it
 * because its name holds text that looks like a chat-template token. The hint then names only the approval option and
 * says why the path is not repeated; a made-up path or placeholder must never be presented as a command word.
 */
function rerunPath(path: string): string | null {
  return shownPath(path) === path ? path : null;
}

function hiddenPathApprovalHint(prepared: PreparedChange, handoffs: CliHandoffs): string {
  // The approval option to add, as words: the command it goes on is the one the person just ran, which is not shown.
  const carrying = `\`--approval ${prepared.approvalId}\``;
  const hidden = ' Its file path is not repeated here because it contains text this output neutralises.';
  return prepared.policy === 'confirm'
    ? approveAndWaitSentence(
        handoffs,
        'cli',
        prepared.approvalId,
        (approve, wait) =>
          `Show the person the preview. They run ${approve}${
            wait === undefined ? '' : `; learn when they have with ${wait},`
          } then run the same command again with ${carrying} added.${hidden}`,
      )
    : `Show the person the preview. Once they say yes, run the same command again with ${carrying} added.${hidden}`;
}

/** One profile at a terminal. Every string in a view that came from a profile is already neutralised and on one line. */
function renderOrg(view: OrganisationView): string {
  const lines = [
    `${view.organisation} — ${view.label}`,
    `  source       ${view.source.path}`,
    `  SHA-256      ${view.sha256} (read ${view.readAt})`,
    `  other addresses  ${view.forOtherAddresses ? (view.routesOtherAddresses ? 'on' : 'on, but there is no Google client to route them to') : 'off'}`,
  ];
  if (view.gmail === null) lines.push('  Google       none');
  else {
    lines.push(
      `  Google       ${view.gmail.active === null ? 'no active client' : `new mailboxes get "${view.gmail.active}"`}`,
    );
    for (const generation of view.gmail.generations) {
      const flags = [
        generation.ownership,
        ...(generation.active ? ['active'] : []),
        ...(generation.state === 'ok' ? [] : [generation.state]),
      ];
      lines.push(
        `    ${generation.name.padEnd(12)} ${generation.clientId}  (${flags.join(', ')}; serves ${generation.serves})${generation.mailboxes.length > 0 ? ` — ${generation.mailboxes.join(', ')}` : ''}`,
      );
    }
  }
  if (view.slack === null) lines.push('  Slack        none');
  else {
    lines.push(`  Slack        ${view.slack.workspace} (${view.slack.workspaceName}), port ${view.slack.redirectPort}`);
    for (const role of ['read', 'send'] as const) {
      const app = view.slack.apps[role];
      lines.push(
        `    ${role.padEnd(12)} ${app ? `client id ${app.clientId}${app.appId ? `, app id ${app.appId}` : ''}` : 'none'}`,
      );
    }
  }
  if (view.accounts.length > 0) lines.push(`  accounts     ${view.accounts.join(', ')}`);
  for (const drift of view.drift) lines.push(`  ! ${drift.detail}. ${drift.fix}`);
  for (const note of view.notes) lines.push(`  ${note}`);
  return lines.join('\n');
}

function renderOrgList(views: readonly OrganisationView[], handoffs: CliHandoffs): string {
  if (views.length === 0) {
    return handoffSentence(
      handoffs.own(['org', 'add', '--help']),
      (command) => `No organisation profiles have been added here. Add one with ${command}.`,
    );
  }
  return views.map(renderOrg).join('\n\n');
}

function renderOrgChange(result: OrgChangeResult): string {
  const lines = [result.changed ? 'Done.' : `Nothing to change: ${result.organisation} matches its profile.`];
  for (const line of result.applied) lines.push(`  - ${line}`);
  if (result.reported.length > 0) lines.push('', 'Left as it is:', ...result.reported.map((line) => `  - ${line}`));
  lines.push('', renderOrg(result.profile));
  return lines.join('\n');
}

function renderOrgRemove(result: OrgRemoveResult): string {
  const lines = [`Removed the organisation profile ${result.organisation}.`];
  if (result.removed.length > 0) lines.push(`Removed its clients, with their secrets: ${result.removed.join(', ')}.`);
  if (result.kept.length > 0) lines.push(`Left as they are, as clients of your own: ${result.kept.join(', ')}.`);
  if (result.secretsLeft.length > 0) {
    lines.push(
      `These secrets could not be deleted: delete them from your secret store: ${result.secretsLeft.join(', ')}.`,
    );
  }
  return lines.join('\n');
}

function renderLater(result: UpdateLaterResult): string {
  if (result.snoozedUntil === null) return 'Nothing was put off: no update has been found on this machine.';
  const what = result.latest ? `The update to ${result.latest} is` : 'The daily update check is';
  return `${what} put off until ${new Date(result.snoozedUntil).toString()}${result.changed ? '' : ' (it already was)'}: nothing stops for it until then, and the first command after asks again.`;
}

function renderAuto(result: UpdateAutoResult): string {
  const state =
    result.updateCheck === 'on'
      ? 'on: once a day this machine asks npm for a newer release, and stops until it is updated or put off'
      : 'off: nothing on this machine asks npm for a newer release, and nothing stops for one';
  return `The daily update check is ${state}${result.changed ? '' : ' (it already was)'}.`;
}

function renderChannels(report: ChannelsReport): string {
  const lines: string[] = [];
  for (const channel of report.channels) {
    const where = [
      ...channel.runtimes.map((runtime) => `runtime ${runtime.version}`),
      // Its command found on PATH, said by version: the name is the manifest's, and printed it reads as a command to run.
      ...(channel.onPath ? [`its command on PATH, ${channel.onPath.version ?? 'version unknown'}`] : []),
    ];
    lines.push(
      `${channel.label.padEnd(18)} ${channel.package}  ${channel.installed ? (where.length > 0 ? where.join(', ') : `this process, ${report.core}`) : 'not installed'}`,
    );
    for (const entry of channel.registered) {
      lines.push(
        `  registered with ${entry.client} as "${entry.name}" (${entry.launcher}${entry.version ? ` ${entry.version}` : ''}${entry.behindCore ? `, older than this core's ${report.core}` : ''})${entry.missing ? ` — ${entry.missing} is missing` : ''}`,
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
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 64;
    },
  );
}
