/**
 * A bridge for tests: every command answers from fixtures — recorded CLI JSON, or fake data written by hand — and
 * every call is recorded. Nothing is run, opened or copied, and no test reaches Tauri, a CLI, the network or a home.
 */
import type { AppEvents, Bridge, Call, CliResult, Folders, Installation, Product } from '../ipc.ts';
import { PRODUCTS } from '../ipc.ts';
import accountsGmail from './fixtures/accounts-gmail.populated.json';
import accountsResend from './fixtures/accounts-resend.populated.json';
import accountsSlack from './fixtures/accounts-slack.populated.json';
import approvalsPending from './fixtures/approvals-pending.populated.json';
import behaviour from './fixtures/behaviour.json';
import doctorCore from './fixtures/doctor-core.json';
import doctorEvents from './fixtures/doctor-events-daemon.json';
import doctorGmail from './fixtures/doctor-gmail.json';
import doctorResend from './fixtures/doctor-resend.json';
import doctorSlack from './fixtures/doctor-slack.json';
import doctorWhatsapp from './fixtures/doctor-whatsapp.json';
import layaDisabled from './fixtures/events-judge-model-status.disabled.json';
import eventsStatus from './fixtures/events-status.running.json';
import label from './fixtures/label.populated.json';
import standingList from './fixtures/standing-list.json';
import updateStatus from './fixtures/update-status.json';

/** The folders of an example machine: nobody's. */
export const EXAMPLE_FOLDERS: Folders = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

/** Core's launcher in the example folders, which the app would run. */
export const LAUNCHER = { launcher: `${EXAMPLE_FOLDERS.dataDir}/launch/core`, launcherProblem: null };

/** An installation with every product, at 0.24.0. */
export const EXAMPLE_INSTALLATION: Installation = {
  installed: true,
  version: '0.24.0',
  present: [...PRODUCTS],
  folders: EXAMPLE_FOLDERS,
  problem: null,
};

/**
 * A fixture's answer for a call: its data, or a function of the call that gives it. For `version` it is the version
 * itself, or a function of the call (and so of its product), and every product is at `EXAMPLE_INSTALLATION`'s without one.
 */
export type Fixture = unknown | ((call: Call) => unknown);

/** What each call kind answers by default: the populated fixtures, a doctor and an account list per product. */
export const FIXTURES: Partial<Record<Call['kind'], Fixture>> = {
  approvalsPending,
  approvalRevoke: { approvalId: 'revoked', state: 'revoked' },
  updateStatus,
  updatePause: updateStatus,
  updateResume: updateStatus,
  label,
  behaviour,
  standingList,
  eventsStatus,
  eventsJudgeModelStatus: layaDisabled,
  eventsJudgeKindDisable: { kind: 'laya', disabled: true, pointer: 'removed', pendingActivationsCancelled: 0 },
  doctor: (call: Call) =>
    ({
      core: doctorCore,
      gmail: doctorGmail,
      slack: doctorSlack,
      resend: doctorResend,
      whatsapp: doctorWhatsapp,
      'events-daemon': doctorEvents,
    })[(call as Extract<Call, { kind: 'doctor' }>).product],
  accounts: (call: Call) =>
    ({ gmail: accountsGmail, slack: accountsSlack, resend: accountsResend })[
      (call as Extract<Call, { kind: 'accounts' }>).product
    ],
};

/** An `ok` result carrying `data`. */
export function ok(data: unknown, exit = 0): CliResult {
  return { status: 'ok', exit, data };
}

/** A `failed` result, as a CLI error envelope reads. */
export function failed(code: string, message: string, hint: string | null = null, exit = 1): CliResult {
  return { status: 'failed', exit, code, message, hint };
}

export interface FakeBridge extends Bridge {
  /** Every command called, in order, with its argument. */
  calls: { command: keyof Bridge; args: unknown }[];
  /** Delivers an app event to every handler listening for it, as Rust's `emit` would. */
  emit<E extends keyof AppEvents>(event: E, payload: AppEvents[E]): void;
}

/**
 * A bridge that answers from `fixtures` (over `FIXTURES`), with any command replaced by `handlers`. A call kind with
 * no fixture fails with `APP_NOT_BUILT`, so a test notices a call it did not expect.
 */
export function createFakeBridge(
  handlers: Partial<Bridge> = {},
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
): FakeBridge {
  const calls: FakeBridge['calls'] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const answers = { ...FIXTURES, ...fixtures };
  const record = (command: keyof Bridge, args: unknown) => calls.push({ command, args });

  const defaults: Omit<Bridge, 'on'> = {
    async installation() {
      return EXAMPLE_INSTALLATION;
    },
    async cli(call) {
      if (call.kind === 'version') {
        const version = answers.version;
        const given = typeof version === 'function' ? (version as (call: Call) => unknown)(call) : version;
        return {
          status: 'version',
          version: typeof given === 'string' ? given : (EXAMPLE_INSTALLATION.version ?? '0.24.0'),
        };
      }
      const fixture = answers[call.kind];
      if (fixture === undefined) return failed('APP_NOT_BUILT', `no fixture answers ${call.kind}`);
      return ok(typeof fixture === 'function' ? (fixture as (call: Call) => unknown)(call) : fixture);
    },
    async openInTerminal(command) {
      return { outcome: 'opened', via: 'Terminal', revoked: command.kind === 'change' ? true : null };
    },
    async revokePreview(approvalId) {
      return ok({ approvalId, state: 'revoked' });
    },
    async copyText() {},
    async openLink() {},
    async openProfile({ account }) {
      return { path: `${EXAMPLE_FOLDERS.configDir}/compose/${account ?? 'user'}.md`, created: true };
    },
    async getSettings() {
      return { folders: {}, resolved: EXAMPLE_FOLDERS, ...LAUNCHER, loginItem: false, loginItemAvailable: true };
    },
    async setFolders(folders) {
      return { folders, resolved: EXAMPLE_FOLDERS, ...LAUNCHER, loginItem: false, loginItemAvailable: true };
    },
    async setLoginItem(on) {
      return { folders: {}, resolved: EXAMPLE_FOLDERS, ...LAUNCHER, loginItem: on, loginItemAvailable: true };
    },
    async updaterState() {
      return {
        on: false,
        status: 'off',
        version: null,
        message: 'Updates for this app are off: this copy was built without the updater key.',
      };
    },
    async checkForUpdates() {
      return {
        on: false,
        status: 'off',
        version: null,
        message: 'Updates for this app are off: this copy was built without the updater key.',
      };
    },
    async installUpdate() {},
    async takeDeepLink() {
      return null;
    },
  };

  const bridge = { calls } as FakeBridge;
  for (const command of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const implementation = (handlers[command] ?? defaults[command]) as (argument?: unknown) => Promise<unknown>;
    (bridge as unknown as Record<string, unknown>)[command] = (argument?: unknown) => {
      record(command, argument);
      return implementation(argument);
    };
  }
  bridge.on = async (event, handler) => {
    const set = listeners.get(event) ?? new Set();
    listeners.set(event, set);
    const listener = handler as (payload: unknown) => void;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  bridge.emit = (event, payload) => {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  };
  return bridge;
}

/** The kinds of every `cli` call made, in order. */
export function cliKinds(bridge: FakeBridge): Call['kind'][] {
  return bridge.calls.filter((call) => call.command === 'cli').map((call) => (call.args as Call).kind);
}

/** The products a recorded list of `doctor` calls ran. */
export function doctorsRun(bridge: FakeBridge): Product[] {
  return bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === 'doctor')
    .map((call) => (call.args as Extract<Call, { kind: 'doctor' }>).product);
}
