import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ACT_KINDS, AGENT_LABEL_WORDS, SLACK_STYLES } from '../agent-label.ts';
import { waitCallOptions } from '../approval-wait-surface.ts';
import { changeToolResult, type GatedChange, gatedChange, refuseUnclaimedApproval } from '../change-flow.ts';
import { SERVERS } from '../channel-servers.ts';
import { accountChannels, listed, narrowingOwner } from '../channel-words.ts';
import { UPDATE_LEVELS } from '../config.ts';
import { type Core, openCore } from '../core.ts';
import { CommsError, toCommsError } from '../errors.ts';
import { CORE_CALLER, requireHandoffs } from '../handoffs.ts';
import { installFailure, SERVER_NAME_MESSAGE, SERVER_NAME_PATTERN } from '../mcp-install.ts';
import { MAX_WAIT_SECONDS, waitForApproval } from '../operations/approval-wait.ts';
import { ATTACH_CHANGE_KINDS, attachChange, attachReport } from '../operations/attach-settings.ts';
import {
  CHANGE_POLICIES,
  changePolicyChange,
  changePolicyReport,
  refuseApprovalWithoutChange,
} from '../operations/change-policy.ts';
import { LABEL_CHANGE_KINDS, type LabelChangeRequest, labelChange, labelReport } from '../operations/label.ts';
import { auditTail, corePaths, doctor, listApprovals, revokeApproval } from '../operations/maintenance.ts';
import { namesDryRun, namesMigration } from '../operations/names-migrate.ts';
import { orgAddChange, orgList, orgRemoveChange, orgShow, orgUpdateChange } from '../operations/organisations.ts';
import { migrationLeftoversError, secretsMigration } from '../operations/secrets-migrate.ts';
import {
  CLIENTS,
  channelsAvailable,
  installVerification,
  LAUNCHERS,
  serverInstallChange,
  serverPruneChange,
} from '../operations/servers.ts';
import { type UpdateDeps, updateChange, updateCheck } from '../operations/update.ts';
import { updateJobChange } from '../operations/update-job.ts';
import { updateRollbackChange } from '../operations/update-rollback.ts';
import { updateLevelChange, updatePause, updateResume } from '../operations/update-settings.ts';
import type { KeyringModule, SecretStore } from '../secrets.ts';
import { strictToolArguments } from '../tool-arguments.ts';
import { checkForUpdates } from '../update-check.ts';
import { updateToolNotice } from '../update-gate.ts';
import type { UpdateJobDeps } from '../update-job.ts';
import { stateReleaseVerifier } from '../update-provenance.ts';
import { npmRegistry } from '../update-release.ts';
import { VERSION } from '../version.ts';

/**
 * The core MCP server, `agentcomms mcp`: the generic server that installs and manages the others (design §5).
 *
 * Every tool is the operation its `agentcomms` command runs, so a command and its tool return the same data and refuse
 * the same things. Reading — paths, the doctor, the audit log, approvals, what is installed, the change policy — needs
 * nobody. Every change goes through `gatedChange`, the one flow every changing command and tool uses: the first call
 * returns the preview and an approval id, and the same tool called again with that id applies it — under `chat` once
 * the person has said yes in the conversation, under `confirm` once they have run `agentcomms approve <id>` at their own
 * terminal.
 *
 * **There is no generic "claim a change" tool, on purpose.** Each tool plans its own change from its own arguments,
 * and a claim is only honoured for the change that tool computes again at that moment. A tool that claimed whatever
 * it was handed would let an agent write any configuration change it could describe; this way the only changes
 * reachable from chat are the ones a tool here knows how to make, shown to a person before they happen.
 *
 * Approving is not here either. Under `confirm` approving means a person at a terminal (§6.3), and a tool that
 * approved would make that mean nothing.
 */

export interface CoreMcpOptions {
  core?: Core | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** The shell syntax used for commands returned by tools. */
  platform?: NodeJS.Platform | undefined;
  /** For a test: the keychain module the doctor probes, so a test never touches the real login keychain. */
  keyring?: KeyringModule | null | undefined;
  /** For a test: the stores a secrets migration reads and writes, likewise. */
  secretStores?: { source?: SecretStore; target?: SecretStore } | undefined;
  /** For a test: the running processes prune checks, or null when they cannot be listed. */
  processes?: (() => Promise<readonly string[] | null>) | undefined;
  /**
   * For a test: the registry, the global packages and the installers an update uses, so none of them is real — and
   * the clock the daily update check reads and records by.
   */
  update?: UpdateDeps | undefined;
  /**
   * For a test: the runner the background update job's commands go through — `launchctl`, `systemctl`, the Windows
   * scheduler — its user, its random minute and its clock, so that no test schedules a real job.
   */
  updateJob?: UpdateJobDeps | undefined;
}

export interface CoreMcpServer {
  readonly server: McpServer;
  connectStdio(): Promise<void>;
}

/*
 * How this server names the channels, from their manifests: a channel's tools and descriptions say what it is called
 * the moment its package declares itself, rather than when somebody remembers this file. For Gmail and Slack every
 * word is what it was (`test/wording-identity.test.ts`).
 */
const CHANNEL_LABELS_LISTED = accountChannels().map((manifest) => manifest.label);
/** The nouns and platforms of the accounts in `accounts` — Slack's workspaces, and every channel after it. */
const ACCOUNT_MAP = accountChannels().filter((manifest) => manifest.accounts?.map === 'accounts');
const MAIL = accountChannels().find((manifest) => manifest.accounts?.map === 'inboxes');
const ACCOUNT_NOUNS = listed([...new Set(ACCOUNT_MAP.map((manifest) => manifest.accounts?.noun ?? 'account'))], 'or');
const MAILBOX = MAIL?.accounts?.noun ?? 'mailbox';

/** "Gmail only: serve this one mailbox" — whose option it is, and what one of its accounts is called. */
function onlyFor(option: 'inbox' | 'workspace' | 'readOnly', what: (noun: string) => string): string {
  const owner = narrowingOwner(option);
  return `${owner?.label ?? 'no channel'} only: ${what(owner?.accounts?.noun ?? 'account')}`;
}

async function buildInstructions(core: Core): Promise<string> {
  let policy = 'chat';
  try {
    policy = (await core.config.load()).defaults.changePolicy ?? 'chat';
  } catch {
    // A config that cannot be read is for comms_doctor to report, not a reason to refuse to start.
  }
  return [
    `agent-communications core: install and manage the ${listed(CHANNEL_LABELS_LISTED, 'and')} servers, and look after this machine.`,
    '',
    'Reading needs nobody: comms_paths, comms_doctor, comms_audit_tail, comms_approvals_list, comms_approval_wait,',
    'comms_channels_available, comms_orgs_list, comms_org_show, comms_attach, comms_change_policy and comms_label',
    'with no change, and comms_update with `check`.',
    '',
    'Every change — registering, updating or pruning a server, migrating names or secrets, loosening the change',
    'policy, allowing another folder for attachments, adding, updating or removing an organisation profile',
    '(comms_org_add, comms_org_update, comms_org_remove), loosening the agent label (comms_label) — is shown to the',
    'person before it happens. The first call',
    'returns `approvalRequired` with a `preview` and an `approvalId`: show the preview in full and ask. Then call the',
    'same tool again, with the same arguments and the `approvalId`. Under the `chat` change policy the person’s yes in',
    'this conversation is the approval; under `confirm` they first run the approve command the result gives, in their',
    'own terminal — you cannot approve it for them, so say so, and learn when they have with comms_approval_wait. If',
    'they say no, call comms_approval_revoke.',
    'Tightening applies at once — even beside a change that waits: comms_org_update with forOtherAddresses "off"',
    'turns that off before its preview is returned, and the preview marks it done.',
    '',
    `The default change policy here is ${policy}.`,
    'A server registered with a client appears only after that client is restarted: say so.',
  ].join('\n');
}

export async function createCoreMcpServer(options: CoreMcpOptions = {}): Promise<CoreMcpServer> {
  const env = options.env ?? process.env;
  // Opened as core itself, so every command this server hands a person is located from this installation.
  const core = options.core ?? openCore({ env, caller: CORE_CALLER });
  const platform = options.platform ?? process.platform;
  // Core carries sigstore-js, so its checks count what a release declares once it is verified, and its updates verify
  // every release they install (a test hands in its own).
  const updateDeps: UpdateDeps = {
    ...(options.update === undefined ? { verifyRelease: stateReleaseVerifier(core.paths.stateDir) } : {}),
    ...options.update,
    platform,
  };
  const server = new McpServer(
    { name: 'agentcomms', version: VERSION },
    { instructions: await buildInstructions(core) },
  );

  /*
   * What the command prints with `--json`, as JSON: a field left undefined is left out, as it is there, and a command a
   * field holds is written out as its text (`PrintedCommand.toJSON`), as there. A tool's structured content is an
   * object, so a list the CLI prints as an array arrives here under one key — `records`, `approvals`; everything else is
   * the command's object as it is.
   */
  const reply = (data: unknown) => {
    const structured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    return { structuredContent: structured, content: [{ type: 'text' as const, text: JSON.stringify(structured) }] };
  };
  /*
   * `details` goes through: it is where a refusal's diagnosis is, and for a change still waiting it carries the
   * approval id and the preview. Nothing secret is ever put there; the CLI's `--json` envelope carries the same. As
   * JSON, so a command it holds is the text the envelope gives it too (`PrintedCommand.toJSON`).
   */
  const fail = (error: unknown) => {
    const comms: CommsError = toCommsError(error);
    const structured = JSON.parse(
      JSON.stringify({
        error: {
          code: comms.code,
          message: comms.message,
          hint: comms.hint ?? null,
          ...(comms.details !== undefined ? { details: comms.details } : {}),
        },
      }),
    ) as Record<string, unknown>;
    return {
      isError: true as const,
      structuredContent: structured,
      content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    };
  };
  // Every tool registered from here on refuses a key it does not declare, and arguments its schema rejects, as USAGE
  // in the envelope above — before its handler runs. See `strictToolArguments`. Then the update notice (design
  // 2026-10-16, U1): nothing is refused for being behind; the first result of this process that finds a newer release
  // carries one line beside it, and the check itself runs in the background, never delaying a call.
  strictToolArguments(
    server,
    fail,
    updateToolNotice({
      core,
      env,
      channel: 'core',
      running: VERSION,
      // Each says what is behind in its own words already.
      exempt: ['comms_update', 'comms_doctor', 'comms_paths'],
      refresh: () => checkForUpdates(core, env, { deps: updateDeps, now: updateDeps.now }),
      now: updateDeps.now,
    }),
    {
      // 0.18's two settings, replaced (design 2026-10-16, U2, U3): nothing is stopped any more to put off.
      comms_update: {
        later:
          'Nothing is stopped for an update any more: to hold its notice, call comms_update with `pause` (1, 7 or 14 days) — no approval needed.',
        auto: 'The daily check is now one of three levels: call comms_update with `level` — `auto`, `every-14-days` or `never`.',
      },
    },
  );
  /** One changing call: the change this tool plans, run through the one flow, returned in its one shape. */
  const change = async <T>(build: () => GatedChange<T>, approvalId: string | undefined) => {
    try {
      return reply(
        changeToolResult(await gatedChange(core, build(), { surface: 'mcp', channel: 'core', approvalId, platform })),
      );
    } catch (error) {
      return fail(error);
    }
  };
  const read = async (body: () => Promise<unknown> | unknown) => {
    try {
      return reply(await body());
    } catch (error) {
      return fail(error);
    }
  };

  const readsLocal = { readOnlyHint: true, openWorldHint: false } as const;
  const approvalArg = {
    approvalId: z
      .string()
      .optional()
      .describe(
        'leave out the first time. The approval this tool returned, once the person has agreed to its preview — in the chat under `chat`, with the approve command the result gives under `confirm`',
      ),
  };

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    'comms_paths',
    {
      title: 'Where things live',
      description: 'Where the configuration, state, data, secrets and downloads live on this machine.',
      inputSchema: {},
      annotations: readsLocal,
    },
    async () => read(() => corePaths(core)),
  );

  server.registerTool(
    'comms_doctor',
    {
      title: 'Check this machine',
      description:
        'Check this machine: Node, the directories, the configuration, account names, the secret store, managed CLI shims, and which MCP clients start each server — each check with the fix when it fails. `ok` is false when any check fails; a check with `warn` is something to look at, and leaves `ok` true.',
      inputSchema: {},
      annotations: readsLocal,
    },
    async () =>
      read(() =>
        doctor(core, env, {
          platform,
          ...(options.keyring !== undefined ? { keyring: options.keyring } : {}),
          ...(options.updateJob !== undefined ? { updateJob: options.updateJob } : {}),
        }),
      ),
  );

  server.registerTool(
    'comms_audit_tail',
    {
      title: 'Read the audit log',
      description:
        'The most recent audit records, newest last: every send, change and approval step, with the surface it came from. Filter by mailbox and time.',
      inputSchema: {
        inbox: z.string().optional().describe('only this mailbox, as `organisation/gmail`'),
        since: z.string().optional().describe('only records at or after this ISO time'),
        limit: z.number().int().positive().optional().describe('at most this many; 50 when left out'),
      },
      annotations: readsLocal,
    },
    async (args) => read(async () => ({ records: await auditTail(core, args) })),
  );

  server.registerTool(
    'comms_approvals_list',
    {
      title: 'List approvals',
      description:
        'Every approval on this machine — for sends, posts and configuration changes — with its state and when it expires. Never includes an approval code.',
      inputSchema: {
        inbox: z.string().optional().describe('only this mailbox, as `organisation/gmail`'),
        state: z
          .enum(['pending', 'approved', 'sending', 'used', 'failed', 'unknown', 'expired', 'revoked', 'corrupt'])
          .optional()
          .describe('only approvals in this state'),
      },
      annotations: readsLocal,
    },
    async (args) => read(async () => ({ approvals: await listApprovals(core, args) })),
  );

  server.registerTool(
    'comms_approval_revoke',
    {
      title: 'Revoke an approval',
      description:
        'Cancel an approval so it can never be used: a send, a post, or a configuration change the person said no to. Refusing is never the dangerous direction, so this asks nobody.',
      inputSchema: { approvalId: z.string().describe('the approval to revoke') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => read(() => revokeApproval(core, args.approvalId, 'mcp')),
  );

  server.registerTool(
    'comms_approval_wait',
    {
      title: 'Wait for an approval',
      description: `Wait for an approval — a send, a post, a change or a download’s question — to be usable or finished, and say where it stands: pending (with \`claimable\` true when a yes in the chat can use it), approved, being sent, used, failed, unknown, expired, revoked, corrupt, or answered for a question. \`waitSeconds\` is 30 when left out, ${MAX_WAIT_SECONDS} at most, and 0 for its status now. It only looks: it never approves, claims or sends. Ended still waiting, wait again — never prepare it again while it is pending or being sent.`,
      inputSchema: {
        approvalId: z.string().describe('the approval to wait for'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_SECONDS)
          .optional()
          .describe(`how long to wait: 30 when left out, ${MAX_WAIT_SECONDS} at most, 0 for the status now`),
      },
      annotations: readsLocal,
    },
    async (args, ctx) =>
      read(() =>
        waitForApproval(core, args.approvalId, {
          waitSeconds: args.waitSeconds,
          channel: null,
          ...waitCallOptions(ctx),
        }),
      ),
  );

  server.registerTool(
    'comms_channels_available',
    {
      title: 'What can be installed',
      description: `Which channel servers exist (${['core', ...CHANNEL_LABELS_LISTED].join(', ')}), which are on this machine and at which version, and which MCP clients start each — with the version an entry pins and whether a file it starts has gone. Reads files only.`,
      inputSchema: {},
      annotations: readsLocal,
    },
    async () => read(() => channelsAvailable(core, env)),
  );

  server.registerTool(
    'comms_change_policy',
    {
      title: 'The change policy',
      description: `Report or set the change policy — how a loosening is approved: \`chat\`, a yes in this conversation, or \`confirm\`, a code the person types at their own terminal — for the defaults, one ${MAILBOX}, or one ${ACCOUNT_NOUNS}. Without \`set\` it only reports. Tightening to \`confirm\` applies at once. Loosening to \`chat\` is itself a change, approved under the policy in force, \`confirm\`: the person runs the approve command the result gives, at their own terminal, before you call again with the id. A ${MAILBOX} or ${ACCOUNT_NOUNS} that sets \`chat\` itself keeps it when the default is tightened: the result then carries \`warning\` and \`looser\`, each with the call that tightens it — show the warning to the person.`,
      inputSchema: {
        inbox: z
          .string()
          .optional()
          .describe(`one ${MAILBOX}, as \`organisation/${MAIL?.channel ?? 'gmail'}\``),
        account: z
          .string()
          .optional()
          .describe(
            `one ${ACCOUNT_NOUNS}, as ${listed(
              ACCOUNT_MAP.map((manifest) => `\`organisation/${manifest.channel}\``),
              'or',
            )}`,
          ),
        set: z
          .enum(CHANGE_POLICIES as [string, ...string[]])
          .optional()
          .describe('the policy to set; leave out to report'),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      if (args.set === undefined) {
        return read(async () => {
          refuseApprovalWithoutChange(args.approvalId);
          return changePolicyReport(
            await core.config.load(),
            { inbox: args.inbox, account: args.account },
            requireHandoffs(core, platform),
          );
        });
      }
      const to = args.set as (typeof CHANGE_POLICIES)[number];
      return change(
        () => changePolicyChange(core, { inbox: args.inbox, account: args.account }, to, platform),
        args.approvalId,
      );
    },
  );

  server.registerTool(
    'comms_attach',
    {
      title: 'Which files may be attached',
      description:
        'Report or change which local files may be attached to a draft, an email or a post: the folders they may come from, the paths they never may, and the built-in list the jail always applies. With no change it only reports. Otherwise exactly one of `rootsAdd`, `rootsRemove`, `denyAdd`, `denyRemove`, a path absolute or starting with `~`. Allowing another folder, or removing a deny entry, is a change the person approves: the first call returns the preview — which says where a link leads — and an approvalId; call again with it once they agree. Removing a folder, or adding a deny entry, narrows what can be attached and applies at once. The built-in list cannot be changed.',
      inputSchema: {
        rootsAdd: z.string().optional().describe('let files under this folder be attached — approved first'),
        rootsRemove: z.string().optional().describe('stop attaching files from under this folder — at once'),
        denyAdd: z.string().optional().describe('never attach files from this path — at once'),
        denyRemove: z
          .string()
          .optional()
          .describe('take this path off your own deny entries, so files there can be attached again — approved first'),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const asked = ATTACH_CHANGE_KINDS.filter((kind) => args[kind] !== undefined);
      if (asked.length === 0) {
        return read(async () => {
          refuseUnclaimedApproval(args.approvalId, {
            message: 'with no change this only reports, so it takes no approvalId',
            hint: 'Pass the change the approval was prepared for — `rootsAdd`, `rootsRemove`, `denyAdd` or `denyRemove` — with it.',
          });
          return attachReport(core, env);
        });
      }
      if (asked.length > 1) {
        return fail(
          new CommsError('USAGE', `one change at a time: this call asks for ${asked.join(' and ')}`, {
            hint: 'Call comms_attach once for each change; each is shown, and approved when it widens what can be attached, on its own.',
          }),
        );
      }
      const [kind] = asked as [(typeof ATTACH_CHANGE_KINDS)[number]];
      return change(() => attachChange(core, env, { kind, path: String(args[kind]) }, 'mcp'), args.approvalId);
    },
  );

  // ── The agent label ──────────────────────────────────────────────────────────────────────────────────────────

  /*
   * How what an agent sends is labelled (design 2026-10-15-agent-label, L6): `agentcomms label` and this, one operation.
   * A rule's object is strict, so a misspelt key inside it is refused rather than dropped: a `conversaton` lost on the
   * way would turn a rule for one channel into one for the whole account.
   */
  const ruleArg = (what: string) =>
    z
      .strictObject({
        account: z.string().describe('the account it is for, by its name: `organisation/platform`'),
        conversation: z
          .string()
          .optional()
          .describe(
            'only here — Slack: a channel or DM id (C…, G…, D…) or a person (U…); mail: an address, or @domain. Leave out for the whole account',
          ),
        kinds: z
          .array(z.enum(ACT_KINDS as unknown as [string, ...string[]]))
          .optional()
          .describe('only these kinds of message; leave out for every kind'),
        as: z.enum(['agent', 'me']).describe('`agent`: labelled. `me`: as the person, with no label'),
      })
      .optional()
      .describe(what);

  server.registerTool(
    'comms_label',
    {
      title: 'The agent label',
      description: `Report or change how what an agent sends is labelled: the person's name and a word in parentheses — "Jo Example (agent)" — so recipients can tell the agent sent it. With no change it only reports: the word, the name, every rule, and for each account and kind of message whether it goes out labelled or as the person. Otherwise exactly one of \`word\`, \`name\`, \`addRule\`, \`removeRule\`, \`icon\`, \`style\`. A new word, name or icon, a rule \`as: "me"\`, removing an \`agent\` rule, and a Slack workspace's \`style\` set to \`labelled\` are changes the person approves: the first call returns the preview — the phrase recipients will see, or what each kind of message will now be — and an approvalId; call again with it once they agree. A rule \`as: "agent"\`, removing a \`me\` rule, or a style back to \`app\`, applies at once. Add a \`me\` rule, or choose \`labelled\`, only when the person asked for that.`,
      inputSchema: {
        word: z
          .string()
          .optional()
          .describe(`the word after the name: one of ${AGENT_LABEL_WORDS.join(', ')}, written exactly so`),
        name: z
          .string()
          .nullable()
          .optional()
          .describe('the name, for where a channel has no name of its own for the person; null clears it'),
        addRule: ruleArg('who a kind of message appears to come from, on one account'),
        removeRule: ruleArg('a rule to take away, as it is listed'),
        icon: z
          .strictObject({
            account: z.string().describe('a Slack workspace, by its name'),
            emoji: z
              .string()
              .nullable()
              .describe('the workspace emoji the app’s posts show, between colons — `:jo-agent:`; null for the photo'),
          })
          .optional()
          .describe('the icon of the agent’s Slack posts in one workspace'),
        style: z
          .strictObject({
            account: z.string().describe('a Slack workspace, by its name'),
            style: z
              .enum(SLACK_STYLES as unknown as [string, ...string[]])
              .describe(
                '`app`, the default: the app posts where it can, with Slack’s APP tag, and the person, labelled, elsewhere. `labelled`: every agent message goes out as the person, labelled in its words, even where the app could post; reactions as the person, unlabelled',
              ),
          })
          .optional()
          .describe('how an agent’s messages look in one Slack workspace'),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const asked = LABEL_CHANGE_KINDS.filter((kind) => args[kind] !== undefined);
      if (asked.length === 0) {
        return read(async () => {
          refuseUnclaimedApproval(args.approvalId, {
            message: 'with no change this only reports, so it takes no approvalId',
            hint: 'Pass the change the approval was prepared for — `word`, `name`, `addRule`, `removeRule`, `icon` or `style` — with it.',
          });
          return labelReport(core);
        });
      }
      const request = Object.fromEntries(asked.map((kind) => [kind, args[kind]])) as LabelChangeRequest;
      return change(() => labelChange(core, request, 'mcp'), args.approvalId);
    },
  );

  // ── Organisation profiles ────────────────────────────────────────────────────────────────────────────────────

  /*
   * An organisation's apps — its Google OAuth client, its Slack apps — added from the small document it provides, beside
   * whatever the person already has (design 2026-10-02). No tool here returns a client secret or a profile's bytes.
   */
  const orgOptions = {
    env,
    platform,
    surface: 'mcp' as const,
    ...(options.keyring !== undefined ? { keyring: options.keyring } : {}),
  };
  const storeArg = z
    .enum(['keychain', 'file'])
    .optional()
    .describe('where secrets are kept, only when this writes the first one here: keychain (default) or file');
  const adoptArg = z
    .string()
    .optional()
    .describe(
      'the OAuth client already registered here to use as the organisation’s, when its client id is registered under more than one name',
    );

  server.registerTool(
    'comms_orgs_list',
    {
      title: 'List organisation profiles',
      description:
        'The organisation profiles added here: each one’s label, where it was read from and its SHA-256, its Google clients (which is active, which mailboxes use each) and its Slack apps, and any drift with the call that repairs it. Never includes a client secret or the profile’s contents.',
      inputSchema: {},
      annotations: readsLocal,
    },
    async () => read(async () => ({ organisations: await orgList(core, platform) })),
  );

  server.registerTool(
    'comms_org_show',
    {
      title: 'Show an organisation profile',
      description:
        'One organisation profile: its label, source and SHA-256, its Google clients and their mailboxes, its Slack apps, and any drift from what was approved, each with the call that repairs it. Never includes a client secret or the profile’s contents.',
      inputSchema: {
        organisation: z.string().describe('the organisation, as the first half of its account names: `rgc`'),
      },
      annotations: readsLocal,
    },
    async (args) => read(() => orgShow(core, args.organisation, platform)),
  );

  server.registerTool(
    'comms_org_add',
    {
      title: 'Add an organisation profile',
      description:
        'Add an organisation’s profile — the small JSON file naming its Google OAuth client and Slack apps — so its members’ accounts can use them, beside whatever is here already. Pass the file’s path on this machine; never ask for its contents in the conversation, and never read it yourself. A change: the first call returns the preview — the organisation, the file and its SHA-256, the Google client and the name it gets or the client it uses, the Slack workspace and apps — and an approvalId; call again with it once the person agrees. If the file changes in between, the claim is refused and the change is prepared again. The client secret is never shown or returned.',
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe('where the profile file is on this machine, e.g. ~/src/rgc-agentcomms/rgc.agentcomms.json'),
        forOtherAddresses: z
          .boolean()
          .optional()
          .describe('also let this organisation’s client serve the person’s mailboxes outside it — only when they ask'),
        adopt: adoptArg,
        store: storeArg,
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      change(
        () =>
          orgAddChange(
            core,
            {
              file: args.file,
              forOtherAddresses: args.forOtherAddresses,
              adopt: args.adopt,
              store: args.store,
              approvalId: args.approvalId,
            },
            orgOptions,
          ),
        args.approvalId,
      ),
  );

  server.registerTool(
    'comms_org_update',
    {
      title: 'Update an organisation profile',
      description:
        'Read an organisation profile again from its file, apply what changed in it, and repair drift — a client of the organisation’s that was removed or changed here. A changed profile, a new `source`, and `forOtherAddresses: "on"` are a change: the first call returns the preview listing each change before → after ("secret changed" for a new client secret) and an approvalId; call again with it once the person agrees. Repairing drift, and `forOtherAddresses: "off"`, apply at once and are listed in the result.',
      inputSchema: {
        organisation: z.string().describe('the organisation, as the first half of its account names: `rgc`'),
        source: z.string().min(1).optional().describe('read the profile from this file from now on'),
        forOtherAddresses: z
          .enum(['on', 'off'])
          .optional()
          .describe(
            '`on` lets its client serve the person’s other mailboxes too (approved first); `off` applies at once',
          ),
        adopt: adoptArg,
        store: storeArg,
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      change(
        () =>
          orgUpdateChange(
            core,
            {
              organisation: args.organisation,
              source: args.source,
              forOtherAddresses: args.forOtherAddresses,
              adopt: args.adopt,
              store: args.store,
              approvalId: args.approvalId,
            },
            orgOptions,
          ),
        args.approvalId,
      ),
  );

  server.registerTool(
    'comms_org_remove',
    {
      title: 'Remove an organisation profile',
      description:
        'Forget an organisation profile, and delete the OAuth clients it made here with their secrets; clients the person registered themselves are left as they are. Refused while a mailbox signs in through one of its clients, or a client still marked as its own no longer matches it — the refusal says what to run first. A change that cannot be taken back: the first call returns the preview naming every client it removes and an approvalId.',
      inputSchema: {
        organisation: z.string().describe('the organisation, as the first half of its account names: `rgc`'),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) =>
      change(() => orgRemoveChange(core, { organisation: args.organisation }, orgOptions), args.approvalId),
  );

  // ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    'comms_server_install',
    {
      title: 'Register a server',
      description: `Register a channel’s MCP server — ${listed(
        [...accountChannels().map((manifest) => `\`${manifest.channel}\``), '`core` (this one)'],
        'or',
        { oxford: true },
      )} — with an MCP client, and prove it starts. A change: the first call returns the preview and an approvalId; call again with it once the person agrees. \`print\` only returns the entry to paste, and asks nobody. An install that registers nothing — the client’s own command cannot be found — or whose server does not start is an error, with the entry to paste in its \`details\`. The new server appears after the client is restarted — tell the person.`,
      inputSchema: {
        channel: z.enum(SERVERS as [string, ...string[]]).describe('which server'),
        client: z.enum(CLIENTS as [string, ...string[]]).describe('which MCP client to register it with'),
        // Checked here, so a client sees the rule in the schema, and again by the change itself: the name is quoted
        // in the preview the person approves, and a name that reads like a pin makes that preview lie.
        name: z
          .string()
          .regex(SERVER_NAME_PATTERN, SERVER_NAME_MESSAGE)
          .optional()
          .describe('the name the client shows; the channel’s own when left out. 1–64 of A–Z a–z 0–9 . _ -'),
        account: z
          .string()
          .optional()
          .describe(
            'a channel server that declares accounts: serve this one, named `organisation/<channel>` — the same as `inbox` for Gmail and `workspace` for Slack',
          ),
        inbox: z
          .string()
          .optional()
          .describe(onlyFor('inbox', (noun) => `serve this one ${noun}`)),
        workspace: z
          .string()
          .optional()
          .describe(onlyFor('workspace', (noun) => `serve this one ${noun}`)),
        readOnly: z
          .boolean()
          .optional()
          .describe(onlyFor('readOnly', (noun) => `leave out every tool that changes a ${noun}`)),
        launcher: z
          .enum(LAUNCHERS as [string, ...string[]])
          .optional()
          .describe('`managed` (default) installs this exact version once; `npx` fetches it on every start'),
        force: z
          .boolean()
          .optional()
          .describe('replace this server’s own earlier entry of the same name — how an upgrade reaches a client'),
        print: z.boolean().optional().describe('only return the entry to paste; write nothing'),
        noVerify: z.boolean().optional().describe('do not start the server to check the entry works'),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const install = serverInstallChange(
          core,
          env,
          {
            channel: args.channel as (typeof SERVERS)[number],
            client: args.client as (typeof CLIENTS)[number],
            name: args.name,
            account: args.account,
            inbox: args.inbox,
            workspace: args.workspace,
            readOnly: args.readOnly,
            launcher: args.launcher as (typeof LAUNCHERS)[number] | undefined,
            force: args.force,
            print: args.print,
            noVerify: args.noVerify,
          },
          undefined,
          installVerification(updateDeps, npmRegistry(env)),
        );
        const outcome = await gatedChange(core, install, {
          surface: 'mcp',
          channel: 'core',
          approvalId: args.approvalId,
          platform,
        });
        /*
         * Registered nothing although it was asked to — the client's own command was not found — or registered an
         * entry that did not start: the command ends such an install non-zero (`installExitStatus`), and here it was
         * `applied: true`, which an agent read as done and told the person to restart for a server that was never
         * registered. So it is the error it is, with the whole result — the entry to paste — in its details, as a
         * secrets migration that switched but left originals behind is below. Printing, asked for, is no error.
         */
        const failure = outcome.status === 'applied' ? installFailure(outcome.result) : null;
        return failure ? fail(failure) : reply(changeToolResult(outcome));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'comms_server_prune',
    {
      title: 'Remove unused runtimes',
      description:
        'Remove a declared server’s managed runtimes that no client config names, no printed entry names and no process runs — what upgrades leave behind. `dryRun` only lists them, and asks nobody. Removing them is a change: the first call returns the preview and an approvalId.',
      inputSchema: {
        channel: z.enum(SERVERS as [string, ...string[]]).describe('whose runtimes'),
        dryRun: z.boolean().optional().describe('only say what would be removed'),
        includePrinted: z
          .boolean()
          .optional()
          .describe(
            'also remove runtimes kept only because an entry for them was printed, once those entries are gone',
          ),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) =>
      change(
        () =>
          serverPruneChange(core, env, {
            channel: args.channel as (typeof SERVERS)[number],
            dryRun: args.dryRun,
            includePrinted: args.includePrinted,
            processes: options.processes,
          }),
        args.approvalId,
      ),
  );

  server.registerTool(
    'comms_update',
    {
      title: 'Update to the latest release',
      description: `Bring this machine to the latest published release. \`check: true\` reads the npm registry and this machine and returns what is behind — \`{ latest, behind, upToDate, unpinned, moves, unreadable }\`, \`moves\` being the registrations the next update moves onto the stable launcher — asking nobody. Without it, a change: the first call returns a preview listing every step and an approvalId — each client registration of ${listed(['core', ...CHANNEL_LABELS_LISTED], 'or')} registered again at the latest version with exactly its name, client, scope, launcher and pins; each managed runtime that needs installing; each global @agentcomms package updated — and the call again with the approvalId, once the person agrees, applies it and reports each step. A registration that starts a stable launcher is not registered again: its launcher is switched to the new release, and no client configuration is edited. Nothing behind: it says so and prepares nothing. The new servers load only after each client is restarted: tell the person, then prune the old runtimes with comms_server_prune. \`rollback: true\` switches every stable launcher back to the release before, also a change the person approves.`,
      inputSchema: {
        check: z.boolean().optional().describe('only report what is behind and what is up to date; change nothing'),
        noVerify: z.boolean().optional().describe('do not start each registered server to check that it answers'),
        level: z
          .enum(UPDATE_LEVELS)
          .optional()
          .describe(
            'how this machine updates: `auto` checks daily (and installs in the background once that is set up), `every-14-days` at most once every 14 days, `never` asks npm nothing. A level that updates less is a change the person approves: the first call returns its preview and an approvalId; one that updates more applies at once',
          ),
        pause: z
          .union([z.literal(true), z.literal(1), z.literal(7), z.literal(14)])
          .optional()
          .describe(
            'hold every update notice on this machine for 1, 7 or 14 days — `true`, or 7, when the person names no length. A plain answer: no approval. A security fix is never held',
          ),
        resume: z.literal(true).optional().describe('end a pause at once'),
        backgroundJob: z
          .enum(['on', 'off'])
          .optional()
          .describe(
            'set up or remove the per-user job that installs verified releases in the background, once a day. `on` is a change the person approves: its preview names the job file and what it runs, when it runs, what macOS shows and how to remove it. `off` applies at once',
          ),
        rollback: z
          .boolean()
          .optional()
          .describe(
            'switch every stable launcher back to the release it started before its last switch, editing no client configuration. A change the person approves: the first call returns its preview and an approvalId',
          ),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      // One mode at a time, every mode counted: only the update itself, with none of them, takes `noVerify`.
      const settings = [
        args.level !== undefined,
        args.pause !== undefined,
        args.resume === true,
        args.rollback === true,
        args.backgroundJob !== undefined,
      ];
      const modes = [args.check === true, ...settings];
      if (modes.filter(Boolean).length > 1 || (args.noVerify !== undefined && settings.some(Boolean))) {
        return fail(
          new CommsError(
            'USAGE',
            '`check`, `level`, `pause`, `resume`, `rollback` and `backgroundJob` are one at a time, and `noVerify` is for the update',
            { hint: 'Call comms_update with one of them — or none, to update.' },
          ),
        );
      }
      if (args.rollback === true) {
        return change(() => updateRollbackChange(core), args.approvalId);
      }
      if (args.backgroundJob !== undefined) {
        return change(
          () =>
            updateJobChange(core, env, args.backgroundJob as 'on' | 'off', {
              platform,
              deps: options.updateJob,
              surface: 'mcp',
            }),
          args.approvalId,
        );
      }
      if (args.level !== undefined) {
        return change(
          () => updateLevelChange(core, args.level as string, { env, platform, job: options.updateJob }),
          args.approvalId,
        );
      }
      if (args.pause !== undefined || args.resume === true) {
        return read(() => {
          // A plain answer asks nobody, so an approval here is refused rather than dropped (`refuseUnclaimedApproval`).
          refuseUnclaimedApproval(args.approvalId, {
            message: '`pause` and `resume` ask nobody, so they take no approvalId',
            hint: 'Call comms_update with `pause` or `resume` alone: either applies at once.',
          });
          return args.resume === true
            ? updateResume(core, { now: updateDeps.now })
            : updatePause(core, { days: args.pause === true ? undefined : args.pause, now: updateDeps.now });
        });
      }
      if (args.check === true) {
        return read(() => {
          if (args.approvalId !== undefined) {
            throw new CommsError('USAGE', '`check` only reads, so it takes no approvalId', {
              hint: 'Leave out `check` to update; the first call returns the preview and the approvalId to call with.',
            });
          }
          return updateCheck(core, env, updateDeps);
        });
      }
      return change(() => updateChange(core, env, { noVerify: args.noVerify }, updateDeps), args.approvalId);
    },
  );

  server.registerTool(
    'comms_names_migrate',
    {
      title: 'Rename accounts',
      description:
        'Rename every mailbox and workspace to `organisation/platform`. `dryRun` shows the mapping and changes nothing. Applying it is a change — the old names stop working — so the first call returns the preview and an approvalId; pass the same `renames` again with it.',
      inputSchema: {
        renames: z
          .array(z.string())
          .optional()
          .describe('overrides, each `old=new`; qualify a name both maps use as `inbox:old=new` or `account:old=new`'),
        dryRun: z.boolean().optional().describe('only show the mapping'),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.dryRun) {
        return read(async () => {
          // A dry run claims nothing, so an approval here is refused rather than dropped: see `refuseUnclaimedApproval`.
          refuseUnclaimedApproval(args.approvalId, {
            message: '`dryRun` only shows the mapping, so it takes no approvalId',
            hint: 'Leave out `dryRun` to rename; the first call returns the preview and the approvalId to call with.',
          });
          return namesDryRun(await core.config.load(), args.renames ?? []);
        });
      }
      return change(() => namesMigration(core, args.renames ?? []), args.approvalId);
    },
  );

  server.registerTool(
    'comms_secrets_migrate',
    {
      title: 'Move credentials',
      description:
        'Move every credential between the system keychain and files on this disk, and delete the originals. A change: out of the keychain loosens how they are kept, and the originals cannot be brought back — so the first call returns the preview and an approvalId. Never returns a credential.',
      inputSchema: {
        to: z.enum(['keychain', 'file']).describe('where credentials should be kept'),
        ...approvalArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const migration = secretsMigration(core, args.to, {
          surface: 'mcp',
          platform,
          ...(options.secretStores ? { stores: options.secretStores } : {}),
        });
        const outcome = await gatedChange(core, migration, {
          surface: 'mcp',
          channel: 'core',
          approvalId: args.approvalId,
          platform,
        });
        // Switched but not tidy is the CLI's error too, in the same words: see `migrationLeftoversError`.
        const leftovers = outcome.status === 'applied' ? migrationLeftoversError(outcome.result) : null;
        return leftovers ? fail(leftovers) : reply(changeToolResult(outcome));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return {
    server,
    /** Connects on stdio and resolves when the client disconnects, so the process does not outlive its client. */
    async connectStdio(): Promise<void> {
      const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio');
      const transport = new StdioServerTransport();
      const closed = new Promise<void>((resolve) => {
        transport.onclose = () => resolve();
        // A client that dies without closing the transport simply closes our stdin.
        process.stdin.once('end', resolve);
        process.stdin.once('close', resolve);
      });
      await server.connect(transport);
      await closed;
    },
  };
}

/**
 * Starts the stdio server. On stdio, **stdout is the protocol**: one stray `console.log` from anywhere — our code, a
 * dependency, a deprecation notice — corrupts the stream and the client drops the connection with an unhelpful parse
 * error. So the console is redirected to stderr before the server is built.
 */
export async function startCoreStdioServer(options: CoreMcpOptions = {}): Promise<void> {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  const { connectStdio } = await createCoreMcpServer(options);
  await connectStdio();
}
