/**
 * Every type that crosses IPC, as the Rust side defines it (`src-tauri/src/ipc.rs`, `allowlist.rs`, `paths.rs`,
 * `launchers.rs`), and the bridge the screens call it through. Names are camelCase on the wire, as serde writes them.
 * The UI holds no command of its own: it names a `Call`, and Rust builds the words.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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

/** Every call the app may make: the allow-list, row by row (`allowlist.rs`). Arguments are checked in Rust. */
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
  | { kind: 'eventsDeliveries' };

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
  | { kind: 'signIn'; product: Product; account: string; again: boolean };

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
  loginItem: boolean;
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

/** The events Rust emits to the window, and what each carries. */
export interface AppEvents {
  'deep-link': DeepLinkTarget;
  'window-visibility': { visible: boolean };
  updater: UpdaterState;
  'data-changed': null;
}

/** The thirteen commands, one method each, named in camelCase, and a way to hear the app's events. */
export interface Bridge {
  installation(): Promise<Installation>;
  cli(call: Call): Promise<CliResult>;
  openInTerminal(command: TerminalCommand): Promise<TerminalOutcome>;
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
  /** Calls `handler` with each `event`'s payload until the returned function is called. */
  on<E extends keyof AppEvents>(event: E, handler: (payload: AppEvents[E]) => void): Promise<() => void>;
}

/** The bridge to the app's Rust side. Arguments are named as each command's Rust parameters are. */
export const tauriBridge: Bridge = {
  installation: () => invoke('installation'),
  cli: (call) => invoke('cli', { call }),
  openInTerminal: (command) => invoke('open_in_terminal', { command }),
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
