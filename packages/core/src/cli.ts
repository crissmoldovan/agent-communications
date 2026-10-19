#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { approveAndWaitSentence } from './approval-handoffs.ts';
import type { PublicApprovalView } from './approval-outcome.ts';
import { kindOf } from './approval-stored.ts';
import { renderApprovalWait } from './approval-wait-surface.ts';
import type { BehaviourAct } from './behaviour.ts';
import { approveChangeAtTerminal, gatedChangeAtTerminal, refuseUnclaimedApproval } from './change-flow.ts';
import type { PreparedChange } from './changes.ts';
import {
  colorEnabled,
  defaultStreams,
  type OutputOptions,
  pathOverridesFromCliOptions,
  runCommand,
  type Streams,
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
import { APPROVAL_ID_PATTERN } from './ids.ts';
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
  type BehaviourChangeRequest,
  type BehaviourChangeResult,
  type BehaviourReport,
  behaviourChange,
  behaviourReport,
} from './operations/behaviour.ts';
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
import { type ProfileInitResult, type ProfileView, profileInit, profileView } from './operations/profile.ts';
import { migrationLeftoversError, secretsMigration } from './operations/secrets-migrate.ts';
import {
  type ChannelsReport,
  channelsAvailable,
  installVerification,
  serverInstallChange,
  serverPruneChange,
} from './operations/servers.ts';
import { type UpdateDeps, updateChange, updateCheck } from './operations/update.ts';
import { type UpdateJobResult, updateJobChange } from './operations/update-job.ts';
import { type UpdateRollbackResult, updateRollbackChange } from './operations/update-rollback.ts';
import {
  type UpdateLevelResult,
  type UpdatePauseResult,
  type UpdateResumeResult,
  updateLevelChange,
  updatePause,
  updateResume,
} from './operations/update-settings.ts';
import { profileSourcePath, shownPath, shownText } from './organisations.ts';
import { resolvePaths } from './paths.ts';
import { renderDoctor, renderInstall, renderPrune, renderUpdate, renderUpdateCheck } from './render.ts';
import { approveStandingAtTerminal } from './standing-flow.ts';
import {
  type BackgroundDeps,
  type BackgroundOutcome,
  type BackgroundRunResult,
  runBackgroundUpdate,
} from './update-background.ts';
import { runUpdateCheckChild, terminalUpdateHooks, UPDATE_CHECK_CHILD_COMMAND } from './update-check.ts';
import { exemptFromUpdateNotice, updateNoticeAtTerminal } from './update-gate.ts';
import type { UpdateJobDeps } from './update-job.ts';
import { stateReleaseVerifier } from './update-provenance.ts';
import { npmRegistry } from './update-release.ts';
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
                                source, a looser update cap and --for-other-addresses on are
                                approved first; a tighter cap applies at once
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
  label style <account> app|labelled [--approval <id>]
                                how an agent's Slack messages look there: app, the default, posts as the
                                app with Slack's APP tag where it can; labelled posts every one as you,
                                labelled in its words, and is approved first; app applies at once
  behaviour                     what an agent may do: every rule, and what each account allows, across it
                                and in each conversation a rule names
  behaviour allow <account> <act,…|none> [--conversation <id>] [--approval <id>]
                                let an agent start only these acts there — post, reply, reaction, edit,
                                delete, file, send — or none: one that allows more is approved first,
                                one that only narrows applies at once
  behaviour clear <account> [--conversation <id>] [--approval <id>]
                                take a rule away, so the wider one holds there: approved first when that
                                allows more
  profile [<account>] [--conversation <id>…]
                                the writing profile an agent reads before it writes there: the files it
                                joins, in order, and which are written; --conversation repeats, one per
                                mail recipient and its @domain, or a DM's D… and the person's U…
  profile init [<account>] [--conversation <id>]
                                start the missing profile file for that place from a starter, and print
                                its path; never overwrites one, and no tool can do it for an agent
  mcp                           run the core MCP server on stdio (what an MCP client starts)
  mcp install --client <client> [--server <server>] [--name <name>] [--account <account>|--inbox <inbox>|--workspace <workspace>] [--read-only]
                                [--launcher managed|npx|local] [--force]
                                [--print] [--no-verify] [--approval <id>]
                                register the core server, or another declared server, and prove it starts
  mcp prune [--server <server>] [--dry-run] [--include-printed] [--approval <id>]
                                remove the managed runtimes that nothing uses: every managed server's,
                                listed by server, or with --server that one's
  update [--check] [--no-verify] [--approval <id>]
                                bring every registration, runtime and global package to the latest
                                release; --check only says what is behind
  update --level auto|every-14-days|never [--approval <id>]
                                how this machine updates: a level that updates less is approved
                                first; one that updates more applies at once
  update --pause [1|7|14]       hold every update notice on this machine for that many days (7);
                                asks nobody, and never holds a security fix
  update --resume               end a pause at once
  update --rollback [--approval <id>]
                                switch every stable launcher back to the release before; edits no client config
  update --background-job on|off [--approval <id>]
                                set up the per-user job that installs verified releases in the
                                background, approved first; off removes it at once
  update --background [--dry-run]
                                one background run, as the job starts it: a verified release past its
                                hold, installed, checked and switched to; --dry-run says what it would
                                do and why, and changes nothing
  secrets migrate --to keychain|file [--approval <id>]
  names migrate [--rename <old>=<new>] [--dry-run] [--approval <id>]

A change that loosens something or cannot be taken back — policy chat, attach roots add, attach deny remove, mcp
install and prune, update, secrets and names migrate, org add, update and remove, label word, name and icon, label
rule add --as me, label rule remove --as agent and label style labelled — is shown before it happens. At a terminal
you approve it there; anything else gets the preview and an approval id (exit 10), and runs the command again with
--approval <id> once the person has agreed: in the chat under the \`chat\` change policy, with \`approve\` under
\`confirm\`. A tightening — policy confirm, attach roots remove, attach deny add, label rule add --as agent, label rule
remove --as me, label style app — applies at once and asks nobody, and a --dry-run changes nothing. What an agent
may do is the same: behaviour allow or clear is shown first when it lets an agent do more anywhere, and applies at
once when it only narrows.

On auto, the default, this machine asks npm once a day whether a newer release is out; on every-14-days, at most
once every 14 days; on never, not at all. When one is out, a command says so in one line on stderr, at most once a
day for the machine, and runs; nothing is stopped for being behind. CI, AGENT_COMMS_UPDATE_CHECK=off and
AGENT_COMMS_UPDATES=never switch it all off for one process.

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

Exit codes: 0 ok · 1 unexpected, or a profile that needs a later release · 10 approval required
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
      level: { type: 'string' },
      pause: { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      // Retired with the stop (design 2026-10-16): kept so that each is refused with what replaced it.
      later: { type: 'boolean', default: false },
      auto: { type: 'string' },
      rollback: { type: 'boolean', default: false },
      'background-job': { type: 'string' },
      background: { type: 'boolean', default: false },
      // A flag on `org add`, and on `org update` the flag and the word after it — `on` or `off` — read from the tokens.
      'for-other-addresses': { type: 'boolean', default: false },
      adopt: { type: 'string' },
      store: { type: 'string' },
      source: { type: 'string' },
      // `label rule add|remove` and `label name|icon --clear`; refused on every other command but those that share it
      // (`LABEL_OPTIONS_SHARED`): `behaviour`, and `profile`, which takes it repeated, read from the tokens.
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
    case 'behaviour':
      return sub !== undefined;
    default:
      return false;
  }
}

/**
 * Refuses `--approval` on a command that takes none, as USAGE.
 *
 * Parsed as one option for every command, it was once carried to the update check's stop whatever the command, and
 * the stop let a command claiming an approval through: `agentcomms channels --approval <id>`, with an old "not now"
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
    hint: 'An approval goes with the change it was prepared for — policy chat|confirm, attach roots|deny add|remove, org add|update|remove, label word|name|rule|icon|style, behaviour allow|clear, mcp install, mcp prune, names migrate, secrets migrate or update — run again exactly as the preview named it. Nothing was run.',
  });
}

/**
 * The other commands that take one of `label`'s options, and which: `behaviour` names a rule's place as it does, and
 * `profile` the places a message goes to — `--conversation` repeated, read from the tokens (`conversationsGiven`).
 */
const LABEL_OPTIONS_SHARED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  behaviour: ['conversation'],
  profile: ['conversation'],
});

/**
 * Refuses `label`'s own options on any other command, as USAGE, before anything runs — as `org`'s are, and for the
 * same reason: an option a command does not read is refused rather than quietly doing nothing. Those another command
 * shares (`LABEL_OPTIONS_SHARED`) are refused there only by that command's own words.
 */
function refuseLabelOptionsElsewhere(
  command: string | undefined,
  values: { conversation?: string; kinds?: string; as?: string; clear?: boolean },
  help: Handoff,
): void {
  if (command === 'label') return;
  const shared =
    command !== undefined && Object.hasOwn(LABEL_OPTIONS_SHARED, command) ? LABEL_OPTIONS_SHARED[command] : [];
  const given = labelOptionsGiven(values).filter((flag) => !shared?.includes(flag));
  if (given.length === 0) return;
  const owners = (flag: string) => [
    'label',
    ...Object.entries(LABEL_OPTIONS_SHARED)
      .filter(([, flags]) => flags.includes(flag))
      .map(([owner]) => owner),
  ];
  const commands = [...new Set(given.flatMap(owners))];
  const named = commands.length === 1 ? commands[0] : `${commands.slice(0, -1).join(', ')} and ${commands.at(-1)}`;
  throw new CommsError(
    'USAGE',
    `${given.map((flag) => `--${flag}`).join(', ')} ${given.length === 1 ? 'is an option' : 'are options'} of the ${named} ${commands.length === 1 ? 'command' : 'commands'} only`,
    { hint: handoffSentence(help, (command) => `Run ${command} for what each command takes. Nothing was run.`) },
  );
}

/**
 * Every `--conversation` given, in order. `parseArgs` keeps only the last of an option that is not `multiple`, and
 * `label` takes one; `profile` takes several — one per mail recipient — so they are read from the tokens.
 */
function conversationsGiven(parsed: ReturnType<typeof parse>): string[] {
  return (parsed.tokens ?? []).flatMap((token) =>
    token.kind === 'option' && token.name === 'conversation' && token.value !== undefined ? [token.value] : [],
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
    /**
     * The runner the background update job's commands go through, its user, its random minute and its clock: injected
     * so a test never loads, schedules or removes a real job.
     */
    updateJob?: UpdateJobDeps | undefined;
    /** What one background run reads and runs — registry, attestations, installer, self-check, clock — for a test. */
    updateBackground?: BackgroundDeps | undefined;
    /** What `update` and `update --check` read and run — the registry, the verifier, the installers — for a test. */
    update?: UpdateDeps | undefined;
    /** The terminal `approve` asks at: the process's own unless a test brings one. */
    streams?: Streams | undefined;
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
  // given the notice it is part of — it is run before the notice, as the server is.
  if (command === UPDATE_CHECK_CHILD_COMMAND) {
    return runCommand(output, () =>
      runUpdateCheckChild(core, env, sub, { verifyRelease: stateReleaseVerifier(core.paths.stateDir) }),
    );
  }

  // The update notice (design 2026-10-16, U1): before any command but the exempt ones, the day's check, waited for
  // about three seconds at most, and — when a newer release is out and no command here said so today — one line on
  // stderr. It never stops the command.
  if (!exemptFromUpdateNotice(positionals.slice(0, 2))) {
    await updateNoticeAtTerminal({
      core,
      env,
      channel: 'core',
      running: VERSION,
      output,
      streams: defaultStreams,
      ...terminalUpdateHooks(core, env, { verifyRelease: stateReleaseVerifier(core.paths.stateDir) }),
    });
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
        const report = await doctor(core, env, {
          platform,
          ...(deps.updateJob === undefined ? {} : { updateJob: deps.updateJob }),
        });
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
        const streams = deps.streams ?? defaultStreams;
        // A standing approval is approved with its own preview and code (design 2026-10-19-standing-approvals, S8);
        // anything else here is a change, as it always was. Decided by the record's kind, read and trusted only from
        // a record whose binding verifies; each approval then refuses an id of the other kind as not found.
        const stored = APPROVAL_ID_PATTERN.test(sub) ? await core.approvals.get(sub).catch(() => null) : null;
        if (kindOf(stored) === 'standing') {
          const standing = await approveStandingAtTerminal(core, sub, env, output, streams);
          writeResult(standing, output, (r) =>
            r.state === 'approved'
              ? 'Approved. The standing approval is in force: your agent may now acknowledge, within it, without asking. End it at any time with the standing commands.'
              : 'Cancelled. Nothing was approved, and the standing approval is ended.',
          );
          return;
        }
        const result = await approveChangeAtTerminal(core, sub, env, output, streams);
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
        } else if (sub === 'style') {
          taking([]);
          const [account, style, ...extra] = rest;
          if (account === undefined || style === undefined || extra.length > 0) {
            throw usage('usage: label style <account> app|labelled');
          }
          request = { style: { account, style } };
          rerun = ['label', 'style', account, style];
        } else {
          throw usage('usage: label [word|name|rule add|rule remove|icon|style]');
        }
        const result = await gatedChangeAtTerminal(core, labelChange(core, request, 'cli'), { ...approval, rerun });
        writeResult(result, output, renderLabelChange);
        return;
      }
      case 'behaviour': {
        // label's other options were refused before anything ran (`refuseLabelOptionsElsewhere`): only --conversation.
        const [, , account, acts, ...extra] = positionals;
        if (sub === undefined) {
          if (values.conversation !== undefined) throw usage('the behaviour command takes no --conversation');
          // Reporting takes no --approval: refused with the rest, before the update check's stop.
          writeResult(await behaviourReport(core), output, renderBehaviour);
          return;
        }
        const where = values.conversation === undefined ? [] : ['--conversation', values.conversation];
        const place = {
          account: account as string,
          ...(values.conversation === undefined ? {} : { conversation: values.conversation }),
        };
        let request: BehaviourChangeRequest;
        let rerun: string[];
        if (sub === 'allow') {
          if (account === undefined || acts === undefined || extra.length > 0) {
            throw usage('usage: behaviour allow <account> <act,…|none> [--conversation <id>]');
          }
          // Checked by the operation, as the tool's are: an act it does not know is refused there, in its words.
          const listed = acts === 'none' ? [] : acts.split(',').map((act) => act.trim());
          request = { setRule: { ...place, acts: listed as BehaviourAct[] } };
          rerun = ['behaviour', 'allow', account, acts, ...where];
        } else if (sub === 'clear') {
          if (account === undefined || acts !== undefined) {
            throw usage('usage: behaviour clear <account> [--conversation <id>]');
          }
          request = { removeRule: place };
          rerun = ['behaviour', 'clear', account, ...where];
        } else {
          throw usage('usage: behaviour [allow|clear]');
        }
        const result = await gatedChangeAtTerminal(core, behaviourChange(core, request, 'cli'), { ...approval, rerun });
        writeResult(result, output, renderBehaviourChange);
        return;
      }
      case 'profile': {
        const conversations = conversationsGiven(parsed);
        if (sub === 'init') {
          const [, , account, ...extra] = positionals;
          if (extra.length > 0 || conversations.length > 1) {
            throw usage('usage: profile init [<account>] [--conversation <id>] — one file at a time');
          }
          writeResult(await profileInit(core, { account, conversation: conversations[0] }), output, renderProfileInit);
          return;
        }
        const [, account, ...extra] = positionals;
        if (extra.length > 0) throw usage('usage: profile [<account>] [--conversation <id>…]');
        const view = await profileView(core, {
          account,
          conversations: conversations.length === 0 ? undefined : conversations,
        });
        writeResult(view, output, (shown) => renderProfile(shown, handoffs, account));
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
            serverInstallChange(
              core,
              env,
              {
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
              },
              undefined,
              installVerification(deps.update ?? coreUpdateDeps(core), npmRegistry(env)),
            ),
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
              // No server named: every managed server's runtimes, as an update leaves them behind.
              channel: values.server,
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
        if (values.later) {
          throw new CommsError('USAGE', '--later no longer exists: nothing is stopped for an update any more', {
            hint: 'To hold the update notice, use --pause [1|7|14] — it asks nobody — and --resume to end it.',
          });
        }
        if (values.auto !== undefined) {
          throw new CommsError('USAGE', '--auto no longer exists: the daily check is now one of three levels', {
            hint: 'Use --level auto, --level every-14-days or --level never.',
          });
        }
        // `--pause` takes the days after it as a word of its own: `update --pause 14`.
        const days = values.pause ? sub : undefined;
        if ((sub !== undefined && !values.pause) || positionals.length > 2) {
          throw usage(
            'usage: update [--check | --level <level> | --pause [1|7|14] | --resume | --rollback | --background-job on|off | --background [--dry-run]] [--no-verify] [--approval <id>]',
          );
        }
        const job = values['background-job'];
        // One mode at a time, every mode counted: only the update itself, with none of them, takes --no-verify.
        const settings = [
          values.level !== undefined,
          values.pause,
          values.resume,
          values.rollback,
          job !== undefined,
          values.background,
        ];
        const modes = [values.check, ...settings].filter(Boolean).length;
        if (modes > 1 || (values['no-verify'] && settings.some(Boolean))) {
          throw usage(
            '--check, --level, --pause, --resume, --rollback, --background-job and --background are one at a time, and --no-verify is for the update itself',
          );
        }
        if (values['dry-run'] && !values.background) {
          throw usage(
            '--dry-run is for --background; the update itself shows every step and asks before it changes anything',
          );
        }
        if (values.background) {
          // The job's own run: it prepares no change, so there is nothing for an approval to be for.
          if (values.approval !== undefined) throw usage('--background approves nothing, so it takes no --approval');
          const result = await runBackgroundUpdate(
            core,
            env,
            { dryRun: values['dry-run'] },
            {
              platform,
              ...(deps.updateJob === undefined ? {} : { job: deps.updateJob }),
              ...deps.updateBackground,
            },
          );
          softExit = backgroundExit(result.outcome);
          writeResult(result, output, renderBackground);
          return;
        }
        if (values.rollback) {
          const result = await gatedChangeAtTerminal(core, updateRollbackChange(core), {
            ...approval,
            rerun: ['update', '--rollback'],
          });
          // A launcher that did not go back is not a success to a script, as for the update it undoes.
          softExit = result.ok ? EXIT_CODES.OK : EXIT_CODES.UNAVAILABLE;
          writeResult(result, output, renderRollback);
          return;
        }
        if (job !== undefined) {
          if (job !== 'on' && job !== 'off') throw usage('--background-job takes on or off');
          const result = await gatedChangeAtTerminal(
            core,
            updateJobChange(core, env, job, { platform, deps: deps.updateJob, surface: 'cli' }),
            { ...approval, rerun: ['update', '--background-job', job] },
          );
          writeResult(result, output, renderUpdateJob);
          return;
        }
        if (values.level !== undefined) {
          const result = await gatedChangeAtTerminal(
            core,
            updateLevelChange(core, values.level, { env, platform, job: deps.updateJob }),
            { ...approval, rerun: ['update', '--level', values.level] },
          );
          writeResult(result, output, renderLevel);
          return;
        }
        if (values.pause || values.resume) {
          refuseUnclaimedApproval(values.approval, {
            message: '--pause and --resume ask nobody, so they take no --approval',
            hint: 'Run it without --approval: it applies at once.',
          });
          if (values.resume) {
            writeResult(await updateResume(core), output, renderResume);
            return;
          }
          if (days !== undefined && !/^\d+$/.test(days)) throw usage('--pause takes 1, 7 or 14 days');
          const result = await updatePause(core, { days: days === undefined ? undefined : Number(days) });
          writeResult(result, output, renderPause);
          return;
        }
        if (values.check) {
          if (values.approval !== undefined) {
            throw usage('--check only reads, so it takes no --approval; leave out --check to update');
          }
          writeResult(await updateCheck(core, env, deps.update ?? coreUpdateDeps(core)), output, (report) =>
            renderUpdateCheck(report, handoffs),
          );
          return;
        }
        const words = ['update'];
        if (values['no-verify']) words.push('--no-verify');
        const result = await gatedChangeAtTerminal(
          core,
          updateChange(core, env, { noVerify: values['no-verify'] }, deps.update ?? coreUpdateDeps(core)),
          {
            ...approval,
            rerun: words,
          },
        );
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
    if (account.style !== undefined) {
      lines.push(
        account.style === 'labelled'
          ? '  style    labelled — every agent message goes out as you, labelled in its words; reactions as you, unlabelled'
          : account.appRoute === false
            ? '  style    app — but its app cannot post from this machine, so every agent message goes out as you, labelled in its words; reactions as you, unlabelled'
            : '  style    app — the app posts where it can, with Slack’s APP tag; elsewhere as you, labelled',
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

/** What a level allows, as a person reads it: everything where no rule holds, nothing for an empty list. */
function allowedText(allowed: readonly string[] | 'all'): string {
  return allowed === 'all' ? 'everything (no rule)' : allowed.length === 0 ? 'nothing' : allowed.join(', ');
}

/**
 * What an agent may do, as a person reads it: each account and what it allows, then what holds by name or not at all.
 * A rule's account there is the file's own words, which a hand edit may have made anything: shown made safe.
 */
function renderBehaviour(report: BehaviourReport): string {
  const lines: string[] = [];
  if (report.rules.length === 0 && report.unreadable.length === 0) {
    lines.push('No rules: an agent may start any act, and each one still waits for your yes.');
  }
  for (const account of report.accounts) {
    lines.push('', account.account, `  ${allowedText(account.allowed)}`);
    for (const { conversation, allowed } of account.conversations) {
      lines.push(`  in ${conversation}: ${allowedText(allowed)}`);
    }
  }
  const orphans = report.rules.filter((rule) => rule.orphan);
  if (orphans.length > 0) {
    lines.push('', 'Rules whose account is not connected now — each still holds, by name:');
    for (const rule of orphans) {
      const account = shownText(rule.account, 64);
      const place = rule.conversation === undefined ? account : `${account} in ${rule.conversation}`;
      lines.push(`  ${place}: ${allowedText(rule.acts)}`);
    }
  }
  if (report.unreadable.length > 0) {
    lines.push('', 'Rules this release cannot read — each holds its account to nothing until it is corrected:');
    for (const entry of report.unreadable) {
      lines.push(`  ${entry.account === null ? 'every account' : shownText(entry.account, 64)}: ${entry.reason}`);
    }
  }
  return lines.join('\n').replace(/^\n/, '');
}

function renderBehaviourChange(result: BehaviourChangeResult): string {
  return [result.note ?? (result.changed ? 'Done.' : 'Nothing was changed.'), '', renderBehaviour(result)].join('\n');
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

/**
 * `profile`: the profile as an agent is handed it, then which files it read and which it would read once written,
 * and the command that starts one.
 */
function renderProfile(view: ProfileView, handoffs: CliHandoffs, account: string | undefined): string {
  const read = view.sections.map((section) => (section.source === 'built-in' ? '(built in)' : section.source));
  const missing = view.candidates.filter((path) => !view.sections.some((section) => section.source === path));
  return [
    view.text,
    '',
    'Read, in this order — each refines the ones before it:',
    ...read.map((source) => `  ${source}`),
    ...(missing.length === 0
      ? []
      : [
          '',
          'Not written yet, or empty:',
          ...missing.map((path) => `  ${path}`),
          '',
          handoffSentence(handoffs.own(['profile', 'init', ...(account === undefined ? [] : [account])]), (command) =>
            account === undefined
              ? `To start your own from a starter: ${command}; name an account for its own file.`
              : `To start this account's from a starter: ${command}; add --conversation <id> for one conversation's.`,
          ),
        ]),
  ].join('\n');
}

function renderProfileInit(result: ProfileInitResult): string {
  return result.created
    ? `Started ${result.path} from the starter: change each line to say how you write there.`
    : `${result.path} is already there, and was left as it is: edit it to say how you write there.`;
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
    // Named only when the organisation names one: members paste its bot token with Slack's `workspace bot`.
    if (view.slack.apps.agent) lines.push(`    ${'agent'.padEnd(12)} app id ${view.slack.apps.agent.appId}`);
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
  // What the profile's own notes say below — an extension not applied here — is said there once, not here as well.
  const below = new Set(result.profile.notes);
  const reported = result.reported.filter((line) => !below.has(line));
  if (reported.length > 0) lines.push('', 'Left as it is:', ...reported.map((line) => `  - ${line}`));
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

function renderLevel(result: UpdateLevelResult): string {
  const words = {
    auto: 'auto: a check every day, and installs in the background once that is set up',
    'every-14-days': 'every-14-days: a check at most once every 14 days, and installs only with your yes',
    never: 'never: nothing on this machine asks npm for a newer release; update by hand',
  } as const;
  const capped = result.cappedAt
    ? ` ${result.cappedAt.organisation}'s profile caps it at ${result.cappedAt.level}, so that is how it updates while the cap stands.`
    : '';
  return `This machine updates ${words[result.level]}${result.changed ? '' : ' (it already did)'}.${capped}`;
}

function renderPause(result: UpdatePauseResult): string {
  const lines = [
    `Update notices are paused until ${new Date(result.pausedUntil).toString()} (${result.days} day${result.days === 1 ? '' : 's'}). A security fix is not held.`,
  ];
  if (result.security !== null) lines.push(`A security fix is out now (${result.security}): update soon.`);
  return lines.join('\n');
}

function renderResume(result: UpdateResumeResult): string {
  return result.resumed ? 'The pause is over: update notices are back.' : 'Nothing was paused.';
}

function renderRollback(result: UpdateRollbackResult): string {
  const lines: string[] = [];
  for (const step of result.steps) {
    lines.push(
      step.outcome === 'switched'
        ? `Switched the stable launcher ${step.launcher} back from ${step.from ?? 'its runtime'} to ${step.to ?? step.runtime}: no client configuration was changed.`
        : `Could not switch the stable launcher ${step.launcher} back: ${step.detail ?? 'no reason given'}`,
    );
  }
  if (result.status === 'nothing') lines.push('Nothing was changed: no stable launcher here has a release before.');
  for (const left of result.left) lines.push(`Left as it is: ${left.launcher}: ${left.reason}.`);
  if (result.next) lines.push('', result.next);
  if (result.holdFailed) {
    lines.push(
      `The background update run was not told to hold this release back (${result.holdFailed}): its next run may install it again.`,
    );
  }
  return lines.join('\n');
}

/** Core's update deps: its own verifier, since core carries sigstore-js; the rest the update's defaults. */
function coreUpdateDeps(core: { paths: { stateDir: string } }): UpdateDeps {
  return { verifyRelease: stateReleaseVerifier(core.paths.stateDir) };
}

/** A run that could not do its work is not a success to the job's log; one with nothing to do yet is. */
function backgroundExit(outcome: BackgroundOutcome): number {
  if (outcome === 'refused') return EXIT_CODES.CONFIG;
  if (outcome === 'failed' || outcome === 'unavailable') return EXIT_CODES.UNAVAILABLE;
  if (outcome === 'busy') return EXIT_CODES.TRANSIENT;
  return EXIT_CODES.OK;
}

function renderBackground(result: BackgroundRunResult): string {
  const lines = [
    `${result.dryRun ? 'Dry run: ' : ''}${result.outcome}: ${result.reason}.`,
    `Runs ${result.current ?? 'nothing known'}; the registry's latest is ${result.latest ?? 'not known'}.`,
  ];
  if (result.release) {
    const { release } = result;
    lines.push(
      `${release.version} came out ${release.publishedAt ?? 'at a time the registry does not give'}${release.security ? ', a security fix' : ''}; it may install ${release.holdHours} hours after, at ${release.installableAt ?? 'a time not known'}.`,
    );
  }
  for (const item of result.packages) {
    const done = [
      item.provenance
        ? `provenance verified: ${item.provenance.identity}, issued by ${item.provenance.issuer}, built on a ${item.provenance.runner} runner from ${item.provenance.repository} at ${item.provenance.ref}, SHA-512 ${item.provenance.sha512.slice(0, 16)}…${item.provenance.logIndex === null ? '' : `, transparency-log entry ${item.provenance.logIndex}`}`
        : '',
      item.installed ? 'installed' : '',
      item.checked ? 'checked' : '',
      item.switched ? 'switched to' : '',
    ].filter(Boolean);
    lines.push(
      `- ${item.package} ${item.from ?? 'no release'} → ${item.to}: ${done.join('; ') || 'nothing done'}${item.detail ? ` (${item.detail})` : ''}`,
    );
  }
  for (const gone of result.pruned) lines.push(`- removed the unused runtime ${gone.version} at ${gone.path}`);
  if (result.jobRemoved) lines.push('The background update job was removed.');
  if (result.notice)
    lines.push(
      '',
      `${result.dryRun ? 'The next session would be told' : 'The next session is told'}: ${result.notice}`,
    );
  if (result.dryRun) lines.push('', 'Nothing was changed: this was a dry run.');
  return lines.join('\n');
}

function renderUpdateJob(result: UpdateJobResult): string {
  if (result.backgroundJob === 'on') {
    const remove = result.remove === undefined ? '' : `\nTo remove it: ${result.remove}`;
    return result.changed
      ? `The background update job is set up: ${result.where} runs ${result.command.join(' ')}, ${result.schedule}.${remove}`
      : `The background update job is already set up: ${result.where}, ${result.schedule}.${remove}`;
  }
  const left =
    result.foreign === undefined
      ? ''
      : ` ${result.foreign.where} was left as it is: this installation did not write it (${result.foreign.reason}).`;
  return `${result.changed ? `The background update job is removed (${result.where}).` : 'There is no background update job of this installation to remove.'}${left}`;
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
