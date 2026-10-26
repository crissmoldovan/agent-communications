/**
 * Every type that crosses IPC, as the Rust side defines it (`src-tauri/src/ipc.rs`, `allowlist.rs`, `paths.rs`,
 * `launchers.rs`), and the bridge the screens call it through. Names are camelCase on the wire, as serde writes them.
 * The UI holds no command of its own: it names a `Call`, and Rust builds the words.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/*
 * The event service's types, commands and events are Task 2's (plan 2026-10-25-desktop-0270, Task 2's Interfaces), in
 * its names: `event_service.rs` and `ipc.rs` define them, and the window only shows and asks.
 */

/** The six products a launcher starts (`launchers.rs`). */
export type Product = 'core' | 'gmail' | 'slack' | 'resend' | 'whatsapp' | 'events-daemon';

/** Every product, in the order the app lists them. */
export const PRODUCTS: readonly Product[] = ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'];

/** The four folders every call pins. */
export interface Folders {
  configDir: string;
  stateDir: string;
  dataDir: string;
  secretsDir: string;
}

/** The folders Settings may name; each unset one is left to the environment and the defaults. */
export interface FolderOverrides {
  configDir?: string | null;
  stateDir?: string | null;
  dataDir?: string | null;
}

export type UpdateLevel = 'auto' | 'every-14-days' | 'never';

/** The products with accounts to list. */
export type AccountsProduct = 'gmail' | 'slack' | 'resend';

/**
 * The judge kinds the app turns on (in the terminal) and off by name: TypeSafe's hosted Jev and a local model server
 * (`allowlist.rs`, `EndpointJudgeKind`). Laya's calls take no kind.
 */
export type EndpointJudgeKind = 'typesafe' | 'local-endpoint';

/**
 * The AI providers whose keys Jev uses (0.32.0, `allowlist.rs`, `AiProvider`): TypeSafe itself, and OpenRouter, which
 * serves TypeSafe's Jev. Settings → AI providers lists them in this order; Jev's setup offers OpenRouter first.
 */
export const AI_PROVIDERS = ['typesafe', 'openrouter'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * Every provider whose key the event service keeps (0.33.0, `allowlist.rs`, `KeyProvider`): Jev's two, Anthropic, which
 * Analyse may run on, and Linear, whose personal API key Settings → Integrations connects. A key goes only through
 * `providerKeySet`, on stdin.
 */
export const KEY_PROVIDERS = ['typesafe', 'openrouter', 'anthropic', 'linear'] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

/** The providers Analyse's model runs on (0.33.0, `rule_editor.rs`, `AnalyseProvider`), each on the person's own key. */
export const ANALYSE_PROVIDERS = ['openrouter', 'anthropic'] as const;
export type AnalyseProvider = (typeof ANALYSE_PROVIDERS)[number];

/** What Settings → Integrations shows (0.33.0, `rule_editor.rs`, `Integration`): Linear, and agent sessions. */
export type Integration = 'linear' | 'agent-sessions';

/** A rule or target document the rule editor wrote, as JSON: Rust checks its shape again and hands it over on stdin. */
export type JsonDocument = Record<string, unknown>;

/**
 * An approval that no longer waits, as Approvals → Recent reads it (`allowlist.rs`, `FinishedApprovalState`): one list
 * for each. Closed: never `pending` (Waiting's), `sending` or `corrupt`.
 */
export type FinishedApprovalState = 'approved' | 'used' | 'failed' | 'unknown' | 'expired' | 'revoked';

/** Every finished state, in the order Recent asks for them. */
export const FINISHED_APPROVAL_STATES: readonly FinishedApprovalState[] = [
  'approved',
  'used',
  'failed',
  'unknown',
  'expired',
  'revoked',
];

/** What an activity line did, as `activity show --kind` takes it (`allowlist.rs`, `ActivityKind`). */
export type ActivityKind = 'read' | 'write' | 'told' | 'approval';

/** How an activity line ended, as `activity show --outcome` takes it (`allowlist.rs`, `ActivityOutcome`). */
export type ActivityOutcome = 'ok' | 'refused' | 'failed';

/**
 * The channels `activity show --channel` takes (`allowlist.rs`, `ActivityChannel`): core, the four built in, and
 * `events`, the event service's delivery lines.
 */
export const ACTIVITY_CHANNELS = ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events'] as const;
export type ActivityChannel = (typeof ACTIVITY_CHANNELS)[number];

/**
 * How far back the Activity screen reads (`allowlist.rs`, `ActivitySince`): 7 or 30 days, or today — the start of the
 * person's day, in whole seconds since the epoch, which Rust checks and writes as an ISO time. The Queue screen's lane
 * picker reads the last 24 hours (0.31.0).
 */
export type ActivitySince = '24h' | '7d' | '30d' | { today: number };

/**
 * Which of the queue's items `queue list --state` reads (`allowlist.rs`, `QueueState`): one tab's, or all of them.
 * Closed.
 */
export type QueueState = 'open' | 'done' | 'dismissed' | 'all';

/** The channels a queue item comes from, as `queue list --channel` takes them (`allowlist.rs`, `QueueChannel`). */
export const QUEUE_CHANNELS = ['gmail', 'slack', 'resend', 'whatsapp'] as const;
export type QueueChannel = (typeof QUEUE_CHANNELS)[number];

/**
 * The apps Connections adds a server to or takes one from (0.32.0, `connections.rs`, `McpClient`): core's clients, less
 * `json`, which prints an entry rather than registering one. In core's order.
 */
export const MCP_CLIENTS = ['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'vscode'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** The servers core registers (`connections.rs`, `McpServer`): its own, the four channels and the event service's. */
export const MCP_SERVERS = ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events'] as const;
export type McpServer = (typeof MCP_SERVERS)[number];

/** `activity show` (0.29.0): one session's timeline, each filter a closed word or a checked name. */
export type ActivityShowCall = {
  kind: 'activityShow';
  session: string;
  since: ActivitySince;
  activityKind?: ActivityKind;
  channel?: ActivityChannel;
  account?: string;
  outcome?: ActivityOutcome;
};

/** `queue list` (0.30.0): one state's items, the rule a checked id, the channel a closed word, the limit 1 to 200. */
export type QueueListCall = {
  kind: 'queueList';
  state: QueueState;
  rule?: string;
  channel?: QueueChannel;
  since?: ActivitySince;
  limit?: number;
};

/**
 * Every call the app may make: the allow-list, row by row (`allowlist.rs`). Arguments are checked in Rust. Each row is
 * one line, the calls of more than one line named above it, and Laya's two calls end it: E2's frozen boundary reads the
 * union up to the first line that ends in `;`, and anchors on its disable as that line.
 */
export type Call =
  | { kind: 'version'; product: Product }
  | { kind: 'approvalsPending' }
  | { kind: 'approvalRevoke'; approvalId: string }
  | { kind: 'updateStatus' }
  | { kind: 'updatePause'; days: 1 | 7 | 14 }
  | { kind: 'updateResume' }
  | { kind: 'updateLevel'; level: UpdateLevel }
  | { kind: 'updateRollback' }
  | { kind: 'updateBackgroundJob'; on: boolean }
  | { kind: 'doctor'; product: Product }
  | { kind: 'accounts'; product: AccountsProduct }
  | { kind: 'label' }
  | { kind: 'behaviour' }
  | { kind: 'behaviourAllow'; account: string; acts: string; conversation?: string }
  | { kind: 'behaviourClear'; account: string; conversation?: string }
  | { kind: 'profileView'; account: string }
  | { kind: 'profileInit'; account?: string; conversation?: string }
  | { kind: 'standingList' }
  | { kind: 'standingRevoke'; id: string }
  | { kind: 'standingOff' }
  | { kind: 'eventsStatus' }
  | { kind: 'eventsPause' }
  | { kind: 'eventsResume' }
  | { kind: 'eventsRules' }
  | { kind: 'eventsDeliveries' }
  | { kind: 'judgeKindsList' }
  | { kind: 'judgesList' }
  | { kind: 'judgeKindDisable'; judgeKind: EndpointJudgeKind }
  | { kind: 'approvalsFinished'; state: FinishedApprovalState }
  | { kind: 'activitySessions'; since: ActivitySince }
  | ActivityShowCall
  // The event service's queue (0.30.0): its items and its counts, read; done, dismiss, reopen and clear, which change
  // only the person's own list, applied by the app itself (DA10). The item is `qi_` and 26 of Crockford's letters.
  | QueueListCall
  | { kind: 'queueCounts' }
  | { kind: 'queueDone'; itemId: string }
  | { kind: 'queueDismiss'; itemId: string }
  | { kind: 'queueReopen'; itemId: string }
  | { kind: 'queueClear' }
  // The event service's lanes (0.31.0): the lanes, read; and unbind, a tightening the app applies itself (DA10). The
  // lane is 1 to 40 of `[a-z0-9-]`. Binding is never a call: the person binds at a terminal (`laneBind` below).
  | { kind: 'laneList' }
  | { kind: 'laneUnbind'; lane: string }
  // The event service's rules and deliveries (0.32.0): one rule's versions, read; Turn off and Remove, tightenings the
  // app applies itself (DA10). One delivery and its dry-run record, read; Try now and Stop trying, applied the same way.
  // A rule is a checked rule id; a delivery a word of letters, digits, `_` and `-`. Switching a rule on is never a call.
  | { kind: 'eventsRuleShow'; ruleId: string }
  | { kind: 'eventsRuleDisable'; ruleId: string }
  | { kind: 'eventsRuleRemove'; ruleId: string }
  | { kind: 'eventsDeliveryShow'; deliveryId: string }
  | { kind: 'eventsDryrunShow'; deliveryId: string }
  | { kind: 'eventsDeliveryRetry'; deliveryId: string }
  | { kind: 'eventsDeliveryDrop'; deliveryId: string }
  // Judge setup and AI provider keys (0.32.0): the list, a key's removal, and the person's own setup, applied by the CLI
  // itself. A key is never a call's: `providerKeySet` below hands it to the CLI on stdin.
  | { kind: 'providerList' }
  | { kind: 'providerKeyRemove'; provider: KeyProvider }
  | { kind: 'judgeSetup'; judgeKind: EndpointJudgeKind; provider?: AiProvider; url?: string; model?: string }
  // Connections (0.32.0): core's channels, read; adding one server to one app, prepared, then approved by the person in
  // the app with `mcpInstallApproved`, only for the approval the app prepared for that install (DA10's note of
  // 2026-10-26), and taking one away, a tightening core applies at once.
  | { kind: 'channels' }
  | { kind: 'mcpInstall'; client: McpClient; server: McpServer }
  | { kind: 'mcpUninstall'; client: McpClient; server: McpServer }
  | { kind: 'mcpInstallApproved'; client: McpClient; server: McpServer; approvalId: string }
  // The Messages screen (0.32.0, spec §3.6): the event service's messages and one message, and core's activity by
  // message, each the person's read. Times are whole milliseconds, a page's `before` a time or the cursor the last page
  // gave, the event 32 hex digits, each id a Gmail message's or a Slack `<channel>/<ts>`, all checked in Rust.
  | { kind: 'eventsMessagesList'; since: number; before?: number | string; limit?: number }
  | { kind: 'eventsMessageShow'; eventId: string }
  | { kind: 'activityItems'; since: number; ids?: string[] }
  // The rule editor (0.33.0, design 2026-10-26-rules-that-act-0330 §3.1–§3.5): target versions, read; each target and the
  // rule the person wrote, handed to the CLI on stdin; the activation prepared, its preview read without a challenge,
  // and approved only by the person's press, for that digest; Analyse, of the rule or the draft; Settings → Integrations.
  | { kind: 'eventsTargetsList' }
  | { kind: 'eventsTargetAdd'; document: JsonDocument }
  | { kind: 'eventsTargetUpdate'; document: JsonDocument }
  | { kind: 'eventsRuleCreate'; document: JsonDocument }
  | { kind: 'eventsRuleUpdate'; document: JsonDocument }
  | { kind: 'eventsRuleEnable'; ruleId: string; version: number }
  | { kind: 'eventsApprovalView'; approvalId: string; digest: string }
  | { kind: 'eventsRuleApprove'; approvalId: string; digest: string }
  | { kind: 'eventsRuleAnalyse'; ruleId: string; draft?: JsonDocument; provider?: AnalyseProvider }
  | { kind: 'integrationShow'; integration: Integration }
  | { kind: 'integrationSetAgentSessions'; relayHome: string }
  // Laya's two calls stay last: E2's frozen static boundary reads the list as ending with its disable.
  | { kind: 'eventsJudgeModelStatus' }
  | { kind: 'eventsJudgeKindDisable' };

/** What one CLI call came to (`runner::parse_output`). */
export type CliResult =
  | { status: 'ok'; exit: number; data: unknown }
  | { status: 'approvalPending'; approvalId: string; preview: string; expiresAt: string | null }
  | { status: 'failed'; exit: number; code: string; message: string; hint: string | null }
  | { status: 'version'; version: string };

/** What the app found of agent-communications on this machine. */
export interface Installation {
  installed: boolean;
  version: string | null;
  present: Product[];
  folders: Folders;
  problem: string | null;
  /**
   * The person's home folder, as core reads it, or null (or left out) when it could not be read: a folder inside it is
   * shown with the home as `~` (0.31.0's Lanes).
   */
  home?: string | null;
}

export type AppErrorCode =
  | 'APP_REFUSED'
  | 'APP_NOT_INSTALLED'
  | 'APP_NO_NODE'
  | 'APP_NOT_BUILT'
  | 'APP_IO'
  | 'APP_TIMEOUT'
  | 'APP_UNSAFE_LAUNCHER';

/** A failure of the app's own: what a command's promise rejects with. */
export interface AppError {
  code: AppErrorCode;
  message: string;
}

/** What the terminal is opened with (DA6, DA10). */
export type TerminalCommand =
  | { kind: 'approve'; product: Product; approvalId: string }
  | { kind: 'change'; call: Call; revoke: string }
  | { kind: 'signIn'; product: Product; account: string; again: boolean }
  /** Laya's enablement, in the terminal only: its preview and approval happen there, never in the app (E2 Task 11). */
  | { kind: 'eventsJudgeKindEnable' }
  /** Turning on Jev or a local model server, in the terminal only, as Laya's enablement (0.27.1). */
  | { kind: 'judgeKindEnable'; judgeKind: EndpointJudgeKind }
  /**
   * Binding a lane to an agent window, which only the person does, at a terminal (0.31.0, B1): `lane bind <lane>
   * --window <id>`, the window an activity key or a Claude Code session id. The app never runs it.
   */
  | { kind: 'laneBind'; lane: string; window: string };

export type CopyReason = 'noTerminal' | 'noSafeLine';

/** What opening the terminal came to. */
export type TerminalOutcome =
  | { outcome: 'opened'; via: string; revoked: boolean | null }
  | { outcome: 'copied'; reason: CopyReason; revoked: boolean | null };

export interface ProfileOpened {
  path: string;
  created: boolean;
}

export interface AppSettings {
  folders: FolderOverrides;
  resolved: Folders;
  /** `<data>/launch/core`, as the resolved data folder names it: the program every call starts. */
  launcher: string;
  /** Why the app would not run it — it is not there, or it is on a share or open to other users — or null. */
  launcherProblem: string | null;
  /** Whether the app starts at login, or null when macOS did not answer in time. */
  loginItem: boolean | null;
  loginItemAvailable: boolean;
}

export interface DeepLinkTarget {
  approvalId: string;
}

export type UpdaterStatus = 'off' | 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error';

export interface UpdaterState {
  on: boolean;
  status: UpdaterStatus;
  version: string | null;
  message: string | null;
}

/** Where the event service the app runs stands (`event_service.rs`, `EventServiceStatus`). */
export type EventServiceStatus = 'unavailable' | 'stopped' | 'starting' | 'running' | 'stopping' | 'gaveUp';

/** Whether the service the app starts may read WhatsApp's database (D6): only asked when a WhatsApp account exists. */
export type FullDiskAccess = 'granted' | 'missing' | 'not-needed';

/** The event service as the app runs it (D2, D4, D5, D6, P1), from its supervisor. */
export interface EventServiceState {
  /** False on Windows, where the service does not run (B1-G). */
  available: boolean;
  /** The switch: whether the person wants it running. */
  wanted: boolean;
  status: EventServiceStatus;
  /** Who started the one running: the app, or a terminal (an adopted one). */
  startedBy: 'app' | 'terminal' | null;
  /** When the running one started, as an ISO time. */
  since: string | null;
  /** The running one's version, from the launcher's `.current` when it started. */
  version: string | null;
  /** The version installed now, when it differs from the running one's. */
  newerVersion: string | null;
  restarts: number;
  lastRestartAt: string | null;
  /** When a clean stop the app did not ask for turned the switch off (D4). */
  stoppedFromOutsideAt: string | null;
  /** The last lines of the service's log, only when the app gave up restarting it. */
  logTail: string[];
  /** Whether the first automatic start waits for the person's answer (P1). */
  firstStartQuestion: boolean;
  fullDiskAccess: FullDiskAccess;
}

/**
 * Which build of the app this is (0.32.0, `build_info.rs`): a release, or the local test build, whose identifier ends
 * in `.test`. `commit` (the short commit, then the branch pointing at it, if one does) and `builtAt` (an ISO time) are
 * what `local-test-release.sh` compiled in, and null in any other build.
 */
export interface AppBuild {
  identifier: string;
  isTest: boolean;
  commit: string | null;
  builtAt: string | null;
}

/** The events Rust emits to the window, and what each carries. */
export interface AppEvents {
  'deep-link': DeepLinkTarget;
  'window-visibility': { visible: boolean };
  updater: UpdaterState;
  'data-changed': null;
  /** The event service's state, whenever it changes. */
  'event-service:changed': EventServiceState;
  /** Quit was pressed, and the window is asked whether to keep the event service running (P3). */
  'quit-requested': null;
}

/** The twenty-three commands, one method each, named in camelCase, and a way to hear the app's events. */
export interface Bridge {
  installation(): Promise<Installation>;
  cli(call: Call): Promise<CliResult>;
  openInTerminal(command: TerminalCommand): Promise<TerminalOutcome>;
  /**
   * Revokes the pending approval of one of the app's own previews, when it is cancelled or left behind: only one Rust
   * recorded for a change the app prepared. Core's answer comes back as it is.
   */
  revokePreview(approvalId: string): Promise<CliResult>;
  copyText(text: string): Promise<void>;
  openLink(url: string): Promise<void>;
  openProfile(target: { account?: string; conversation?: string }): Promise<ProfileOpened>;
  getSettings(): Promise<AppSettings>;
  setFolders(folders: FolderOverrides): Promise<AppSettings>;
  setLoginItem(on: boolean): Promise<AppSettings>;
  updaterState(): Promise<UpdaterState>;
  checkForUpdates(): Promise<UpdaterState>;
  installUpdate(): Promise<void>;
  takeDeepLink(): Promise<DeepLinkTarget | null>;
  eventServiceState(): Promise<EventServiceState>;
  /**
   * The switch: on starts the service (or adopts a running one), off stops it through the events CLI's stop. Each
   * answers at once, with what the supervisor recorded: on is `starting` until the watchdog has it running.
   */
  setEventService(on: boolean): Promise<EventServiceState>;
  /** Try again, after the app gave up restarting it. */
  eventServiceRetry(): Promise<EventServiceState>;
  /** Restart it on the version installed now. */
  restartEventService(): Promise<EventServiceState>;
  answerFirstStart(start: boolean): Promise<EventServiceState>;
  /** Opens System Settings at Full Disk Access. */
  openFullDiskAccess(): Promise<void>;
  /** The answer to the quit question; the app then quits. */
  answerQuit(keep: boolean, remember: boolean): Promise<void>;
  /**
   * Stores an AI provider's key (0.32.0), or Linear's (0.33.0): Rust hands it to the events CLI's `provider key set` on
   * stdin, never in argv, and keeps it only for that call. The window clears its field once this is called, and never
   * keeps the key.
   */
  providerKeySet(provider: KeyProvider, key: string): Promise<CliResult>;
  /** Which build this is: a release, or the local test build (0.32.0). */
  appBuild(): Promise<AppBuild>;
  /** Calls `handler` with each `event`'s payload until the returned function is called. */
  on<E extends keyof AppEvents>(event: E, handler: (payload: AppEvents[E]) => void): Promise<() => void>;
}

/** The bridge to the app's Rust side. Arguments are named as each command's Rust parameters are. */
export const tauriBridge: Bridge = {
  installation: () => invoke('installation'),
  cli: (call) => invoke('cli', { call }),
  openInTerminal: (command) => invoke('open_in_terminal', { command }),
  revokePreview: (approvalId) => invoke('revoke_preview', { approvalId }),
  copyText: (text) => invoke('copy_text', { text }),
  openLink: (url) => invoke('open_link', { url }),
  openProfile: ({ account, conversation }) =>
    invoke('open_profile', { account: account ?? null, conversation: conversation ?? null }),
  getSettings: () => invoke('get_settings'),
  setFolders: (folders) => invoke('set_folders', { folders }),
  setLoginItem: (on) => invoke('set_login_item', { on }),
  updaterState: () => invoke('updater_state'),
  checkForUpdates: () => invoke('check_for_updates'),
  installUpdate: () => invoke('install_update'),
  takeDeepLink: () => invoke('take_deep_link'),
  eventServiceState: () => invoke('event_service_state'),
  setEventService: (on) => invoke('set_event_service', { on }),
  eventServiceRetry: () => invoke('event_service_retry'),
  restartEventService: () => invoke('restart_event_service'),
  answerFirstStart: (start) => invoke('answer_first_start', { start }),
  openFullDiskAccess: () => invoke('open_full_disk_access'),
  answerQuit: (keep, remember) => invoke('answer_quit', { keep, remember }),
  providerKeySet: (provider, key) => invoke('provider_key_set', { provider, key }),
  appBuild: () => invoke('app_build'),
  on: (event, handler) => listen(event, (message) => handler(message.payload as never)),
};

/** The acts a rule allows, as the CLI takes them: a comma list, or `none` when the list is empty. */
export function formatActs(acts: readonly string[]): string {
  return acts.length === 0 ? 'none' : acts.join(',');
}

/** A rejected command's error, as text for a person: the app's own `AppError`, or whatever the invoke threw. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}
