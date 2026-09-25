import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { changeToolResult, type GatedChange, gatedChange } from '../change-flow.ts';
import { CHANNELS } from '../channel-servers.ts';
import { type Core, openCore } from '../core.ts';
import { type CommsError, toCommsError } from '../errors.ts';
import { SERVER_NAME_MESSAGE, SERVER_NAME_PATTERN } from '../mcp-install.ts';
import {
  CHANGE_POLICIES,
  changePolicyChange,
  changePolicyReport,
  refuseApprovalWithoutChange,
} from '../operations/change-policy.ts';
import { auditTail, corePaths, doctor, listApprovals, revokeApproval } from '../operations/maintenance.ts';
import { namesDryRun, namesMigration } from '../operations/names-migrate.ts';
import { secretsMigration } from '../operations/secrets-migrate.ts';
import {
  CLIENTS,
  channelsAvailable,
  LAUNCHERS,
  serverInstallChange,
  serverPruneChange,
} from '../operations/servers.ts';
import type { KeyringModule, SecretStore } from '../secrets.ts';
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
  /** For a test: the keychain module the doctor probes, so a test never touches the real login keychain. */
  keyring?: KeyringModule | null | undefined;
  /** For a test: the stores a secrets migration reads and writes, likewise. */
  secretStores?: { source?: SecretStore; target?: SecretStore } | undefined;
  /** For a test: the running processes prune checks, or null when they cannot be listed. */
  processes?: (() => Promise<readonly string[] | null>) | undefined;
}

export interface CoreMcpServer {
  readonly server: McpServer;
  connectStdio(): Promise<void>;
}

async function buildInstructions(core: Core): Promise<string> {
  let policy = 'chat';
  try {
    policy = (await core.config.load()).defaults.changePolicy ?? 'chat';
  } catch {
    // A config that cannot be read is for comms_doctor to report, not a reason to refuse to start.
  }
  return [
    'agent-communications core: install and manage the Gmail and Slack servers, and look after this machine.',
    '',
    'Reading needs nobody: comms_paths, comms_doctor, comms_audit_tail, comms_approvals_list,',
    'comms_channels_available, and comms_change_policy without `set`.',
    '',
    'Every change — registering or pruning a server, migrating names or secrets, loosening the change policy — is',
    'shown to the person before it happens. The first call returns `approvalRequired` with a `preview` and an',
    '`approvalId`: show the preview in full and ask. Then call the same tool again, with the same arguments and the',
    '`approvalId`. Under the `chat` change policy the person’s yes in this conversation is the approval; under',
    '`confirm` they run `agentcomms approve <approvalId>` in their own terminal first — you cannot approve it for them,',
    'so say so and wait. If they say no, call comms_approval_revoke. Tightening applies at once.',
    '',
    `The default change policy here is ${policy}.`,
    'A server registered with a client appears only after that client is restarted: say so.',
  ].join('\n');
}

export async function createCoreMcpServer(options: CoreMcpOptions = {}): Promise<CoreMcpServer> {
  const env = options.env ?? process.env;
  const core = options.core ?? openCore({ env });
  const server = new McpServer(
    { name: 'agentcomms', version: VERSION },
    { instructions: await buildInstructions(core) },
  );

  /*
   * What the command prints with `--json`, as JSON: a field left undefined is left out, as it is there. A tool's
   * structured content is an object, so a list the CLI prints as an array arrives here under one key — `records`,
   * `approvals`; everything else is the command's object as it is.
   */
  const reply = (data: unknown) => {
    const structured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    return { structuredContent: structured, content: [{ type: 'text' as const, text: JSON.stringify(structured) }] };
  };
  /*
   * `details` goes through: it is where a refusal's diagnosis is, and for a change still waiting it carries the
   * approval id and the preview. Nothing secret is ever put there; the CLI's `--json` envelope carries the same.
   */
  const fail = (error: unknown) => {
    const comms: CommsError = toCommsError(error);
    const structured = {
      error: {
        code: comms.code,
        message: comms.message,
        hint: comms.hint ?? null,
        ...(comms.details !== undefined ? { details: comms.details } : {}),
      },
    };
    return {
      isError: true as const,
      structuredContent: structured,
      content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    };
  };
  /** One changing call: the change this tool plans, run through the one flow, returned in its one shape. */
  const change = async <T>(build: () => GatedChange<T>, approvalId: string | undefined) => {
    try {
      return reply(changeToolResult(await gatedChange(core, build(), { surface: 'mcp', approvalId })));
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
        'leave out the first time. The approval this tool returned, once the person has agreed to its preview — in the chat under `chat`, with `agentcomms approve` under `confirm`',
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
        'Check this machine: Node, the directories, the configuration, account names, and the secret store — each check with the fix when it fails. `ok` is false when any check fails.',
      inputSchema: {},
      annotations: readsLocal,
    },
    async () => read(() => doctor(core, options.keyring !== undefined ? { keyring: options.keyring } : {})),
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
          .enum(['pending', 'approved', 'sending', 'used', 'failed', 'unknown', 'expired', 'revoked'])
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
    'comms_channels_available',
    {
      title: 'What can be installed',
      description:
        'Which channel servers exist (core, Gmail, Slack), which are on this machine and at which version, and which MCP clients start each — with the version an entry pins and whether a file it starts has gone. Reads files only.',
      inputSchema: {},
      annotations: readsLocal,
    },
    async () => read(() => channelsAvailable(core, env)),
  );

  server.registerTool(
    'comms_change_policy',
    {
      title: 'The change policy',
      description:
        'Report or set the change policy — how a loosening is approved: `chat`, a yes in this conversation, or `confirm`, a code the person types at their own terminal — for the defaults, one mailbox, or one workspace. Without `set` it only reports. Tightening to `confirm` applies at once. Loosening to `chat` is itself a change, approved under the policy in force, `confirm`: the person runs `agentcomms approve <approvalId>` before you call again with the id. A mailbox or workspace that sets `chat` itself keeps it when the default is tightened: the result then carries `warning` and `looser`, each with the call that tightens it — show the warning to the person.',
      inputSchema: {
        inbox: z.string().optional().describe('one mailbox, as `organisation/gmail`'),
        account: z.string().optional().describe('one workspace, as `organisation/slack`'),
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
          return changePolicyReport(await core.config.load(), { inbox: args.inbox, account: args.account });
        });
      }
      const to = args.set as (typeof CHANGE_POLICIES)[number];
      return change(() => changePolicyChange(core, { inbox: args.inbox, account: args.account }, to), args.approvalId);
    },
  );

  // ── Changing ─────────────────────────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    'comms_server_install',
    {
      title: 'Register a server',
      description:
        'Register a channel’s MCP server — `gmail`, `slack`, or `core` (this one) — with an MCP client, and prove it starts. A change: the first call returns the preview and an approvalId; call again with it once the person agrees. `print` only returns the entry to paste, and asks nobody. The new server appears after the client is restarted — tell the person.',
      inputSchema: {
        channel: z.enum(CHANNELS as [string, ...string[]]).describe('which server'),
        client: z.enum(CLIENTS as [string, ...string[]]).describe('which MCP client to register it with'),
        // Checked here, so a client sees the rule in the schema, and again by the change itself: the name is quoted
        // in the preview the person approves, and a name that reads like a pin makes that preview lie.
        name: z
          .string()
          .regex(SERVER_NAME_PATTERN, SERVER_NAME_MESSAGE)
          .optional()
          .describe('the name the client shows; the channel’s own when left out. 1–64 of A–Z a–z 0–9 . _ -'),
        inbox: z.string().optional().describe('Gmail only: serve this one mailbox'),
        workspace: z.string().optional().describe('Slack only: serve this one workspace'),
        readOnly: z.boolean().optional().describe('Gmail only: leave out every tool that changes a mailbox'),
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
    async (args) =>
      change(
        () =>
          serverInstallChange(core, env, {
            channel: args.channel as (typeof CHANNELS)[number],
            client: args.client as (typeof CLIENTS)[number],
            name: args.name,
            inbox: args.inbox,
            workspace: args.workspace,
            readOnly: args.readOnly,
            launcher: args.launcher as (typeof LAUNCHERS)[number] | undefined,
            force: args.force,
            print: args.print,
            noVerify: args.noVerify,
          }),
        args.approvalId,
      ),
  );

  server.registerTool(
    'comms_server_prune',
    {
      title: 'Remove unused runtimes',
      description:
        'Remove a channel’s managed runtimes that no client config names, no printed entry names and no process runs — what upgrades leave behind. `dryRun` only lists them, and asks nobody. Removing them is a change: the first call returns the preview and an approvalId.',
      inputSchema: {
        channel: z.enum(CHANNELS as [string, ...string[]]).describe('whose runtimes'),
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
            channel: args.channel as (typeof CHANNELS)[number],
            dryRun: args.dryRun,
            includePrinted: args.includePrinted,
            processes: options.processes,
          }),
        args.approvalId,
      ),
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
      if (args.dryRun) return read(async () => namesDryRun(await core.config.load(), args.renames ?? []));
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
    async (args) =>
      change(
        () =>
          secretsMigration(core, args.to, {
            surface: 'mcp',
            ...(options.secretStores ? { stores: options.secretStores } : {}),
          }),
        args.approvalId,
      ),
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
