/**
 * A bridge for tests: every command answers from fixtures — recorded CLI JSON, or fake data written by hand — and
 * every call is recorded. Nothing is run, opened or copied, and no test reaches Tauri, a CLI, the network or a home.
 */
import judgesContract from '../../../../packages/events-daemon/test/fixtures/judges/desktop-contract-judges-v1.json';
import type {
  AppBuild,
  AppEvents,
  Bridge,
  Call,
  CliResult,
  EventServiceState,
  Folders,
  Installation,
  Product,
  WorkflowPositions,
} from '../ipc.ts';
import { PRODUCTS } from '../ipc.ts';
import accountsGmail from './fixtures/accounts-gmail.populated.json';
import accountsResend from './fixtures/accounts-resend.populated.json';
import accountsSlack from './fixtures/accounts-slack.populated.json';
import activitySessions from './fixtures/activity-sessions.json';
import activitySessionsRecent from './fixtures/activity-sessions-recent.json';
import activityShow from './fixtures/activity-show.json';
import activityShowDaemon from './fixtures/activity-show-daemon.json';
import approvalsFinished from './fixtures/approvals-finished.json';
import approvalsPending from './fixtures/approvals-pending.populated.json';
import behaviour from './fixtures/behaviour.json';
import doctorCore from './fixtures/doctor-core.json';
import doctorEvents from './fixtures/doctor-events-daemon.json';
import doctorGmail from './fixtures/doctor-gmail.json';
import doctorResend from './fixtures/doctor-resend.json';
import doctorSlack from './fixtures/doctor-slack.json';
import doctorWhatsapp from './fixtures/doctor-whatsapp.json';
import layaDisabled from './fixtures/events-judge-model-status.disabled.json';
import ruleShowV032 from './fixtures/events-rule-show.v032.json';
import eventsStatus from './fixtures/events-status.running.json';
import label from './fixtures/label.populated.json';
import laneList from './fixtures/lane-list.json';
import projectScan from './fixtures/project-scan.v036.json';
import projectsList from './fixtures/projects-list.v036.json';
import queueCounts from './fixtures/queue-counts.json';
import queueDismissed from './fixtures/queue-list-dismissed.json';
import queueDone from './fixtures/queue-list-done.json';
import queueOpen from './fixtures/queue-list-open.json';
import runShow from './fixtures/run-show.v036.json';
import runsList from './fixtures/runs-list.v036.json';
import standingList from './fixtures/standing-list.json';
import subscribersList from './fixtures/subscribers-list.v036.json';
import updateStatus from './fixtures/update-status.json';
import workflowCheck from './fixtures/workflow-check.v036.json';
import workflowDescribe from './fixtures/workflow-describe.v036.json';
import workflowEventsList from './fixtures/workflow-events-list.v036.json';
import workflowTestFlow from './fixtures/workflow-test-flow.v036.json';

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
  home: '/example/home',
};

/** The event service running, started by the app at 0.27.0: what every test sees unless it says otherwise. */
const SERVICE_RUNNING: EventServiceState = {
  available: true,
  wanted: true,
  status: 'running',
  startedBy: 'app',
  since: '2026-10-25T09:00:00.000Z',
  version: '0.27.0',
  newerVersion: null,
  restarts: 0,
  lastRestartAt: null,
  stoppedFromOutsideAt: null,
  logTail: [],
  firstStartQuestion: false,
  fullDiskAccess: 'not-needed',
};

/** A release build, as every test sees the app unless it says otherwise (0.32.0, `app_build`). */
export const RELEASE_BUILD: AppBuild = {
  identifier: 'com.cueplusplus.agentcomms',
  isTest: false,
  commit: null,
  builtAt: null,
};

/** Nothing running: what each state that is not running clears. */
const NOT_RUNNING = { status: 'stopped', startedBy: null, since: null, version: null } as const;

/** The event service's supervisor in each state the window shows (plan, Task 2's `EventServiceState`). */
export const EVENT_SERVICE = {
  running: SERVICE_RUNNING,
  starting: { ...SERVICE_RUNNING, status: 'starting', since: null, version: null },
  /** Switched off in the app. */
  stopped: { ...SERVICE_RUNNING, ...NOT_RUNNING, wanted: false },
  /** Switched off, and the supervisor's watchdog not done stopping it yet. */
  stopping: { ...SERVICE_RUNNING, ...NOT_RUNNING, wanted: false, status: 'stopping' },
  /** A clean stop the app did not ask for, at a terminal or through the events tools: the switch turned off (D4). */
  stoppedFromOutside: {
    ...SERVICE_RUNNING,
    ...NOT_RUNNING,
    wanted: false,
    stoppedFromOutsideAt: '2026-10-25T10:04:00.000Z',
  },
  /** One started from a terminal, which went away: not the app's to restart (D4). */
  terminalGone: { ...SERVICE_RUNNING, ...NOT_RUNNING },
  /** Five failed starts in ten minutes, with the last lines of its log, one of them hostile. */
  gaveUp: {
    ...SERVICE_RUNNING,
    ...NOT_RUNNING,
    status: 'gaveUp',
    restarts: 4,
    lastRestartAt: '2026-10-25T10:09:30.000Z',
    logTail: [
      '2026-10-25T10:09:31.000Z events: opening the event database',
      'Error: Cannot find module /example/home/.local/share/agent-communications/runtime/owner.mjs',
      '<img src=x onerror=alert(1)>',
    ],
  },
  /** One adopted from a terminal, older than the version installed now (D5). */
  olderAdopted: { ...SERVICE_RUNNING, startedBy: 'terminal', version: '0.26.2', newerVersion: '0.27.0' },
  /** The first automatic start, on a Mac where the service has run before (P1). */
  firstStart: { ...SERVICE_RUNNING, ...NOT_RUNNING, firstStartQuestion: true },
  /** A WhatsApp account, and no Full Disk Access for the app (D6). */
  fullDiskAccessMissing: { ...SERVICE_RUNNING, fullDiskAccess: 'missing' },
  /** Windows, where the service does not run (B1-G). */
  windows: { ...SERVICE_RUNNING, ...NOT_RUNNING, available: false, wanted: false, status: 'unavailable' },
} satisfies Record<string, EventServiceState>;

/**
 * A fixture's answer for a call: its data, or a function of the call that gives it. For `version` it is the version
 * itself, or a function of the call (and so of its product), and every product is at `EXAMPLE_INSTALLATION`'s without one.
 */
export type Fixture = unknown | ((call: Call) => unknown);

/**
 * The events service's judge kinds and judges as the owner's own Mac answers them: Jev and a local model server off,
 * Laya not offered, and no judge yet (the daemon's `fresh` vector, `desktop-contract-judges-v1.json`).
 */
const JUDGES_FRESH = (
  judgesContract as { vectors: { name: string; kinds: unknown[]; judges: unknown[] }[] }
).vectors.find((vector) => vector.name === 'fresh');

/** A `workflow check` that finds a cycle, for a test that wants problems: the default answer finds none. */
export const WORKFLOW_CHECK_PROBLEMS = workflowCheck;

/** What a subscription `subscriber enable` prepared answers: the approval and the digest it binds, as `rule enable`'s. */
export const SUBSCRIPTION_PREPARED = {
  intentId: 'act_0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  approvalId: 'ap_0123456789ABCDEFGHJKMNPQRS',
  binding: {
    digest: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
    activationKind: 'subscription',
    versions: [{ kind: 'subscriber', id: 'events-dashboard', version: 2 }],
  },
  kind: 'subscription',
  status: 'pending',
};

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
  judgeKindsList: JUDGES_FRESH?.kinds,
  judgesList: JUDGES_FRESH?.judges,
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
  // Approvals → Recent (0.29.0): each finished state's list, from one fixture of every state.
  approvalsFinished: (call: Call) =>
    approvalsFinished.filter(
      (approval) => approval.state === (call as Extract<Call, { kind: 'approvalsFinished' }>).state,
    ),
  // The activity log (0.29.0), recorded from core's CLI over fake lines: an agent window's session and the event
  // service's. Any other session is answered with the window's, as a fixture cannot fail; a test that needs core's
  // NOT_FOUND gives its own `cli`.
  activitySessions,
  activityShow: (call: Call) =>
    (call as Extract<Call, { kind: 'activityShow' }>).session === activityShowDaemon.session.key
      ? activityShowDaemon
      : activityShow,
  // The action queue (0.30.0), from fixtures written to the contract until the event service's own output replaces
  // them. Its calls run only where the events service's version is 0.30.0 or later, which no test has unless it says so.
  queueList: (call: Call) => queueListAnswer(call),
  queueCounts,
  queueDone: queueChangeAnswer,
  queueDismiss: queueChangeAnswer,
  queueReopen: queueChangeAnswer,
  queueClear: { cleared: 3 },
  // The event service's lanes (0.31.0), from fixtures written to the contract (design 2026-10-25-routing §6) until the
  // event service's own output replaces them. Their calls run only where its version is 0.31.0 or later.
  laneList,
  laneUnbind: (call: Call) => ({ lane: (call as Extract<Call, { kind: 'laneUnbind' }>).lane, unbound: true }),
  // Workflows (0.36.0, plan I6), from fixtures written by hand to the contract until the event service's own output
  // replaces them. Their calls run only where its version is 0.36.0 or later, which no test has unless it says so.
  ...workflowAnswers(),
};

/**
 * Each workflow call's answer (0.36.0): runs, one run, a cancel, a check, a try, one version, projects, a scan, Describe
 * it, the catalogue, and subscribers, each answered as the contract's shapes are.
 */
export function workflowAnswers(): Partial<Record<Call['kind'], Fixture>> {
  type Of<K extends Call['kind']> = Extract<Call, { kind: K }>;
  const project = projectsList.projects[0];
  return {
    eventsRuleCheck: { ok: true, problems: [] },
    eventsRuleShowVersion: (call: Call) => {
      const { ruleId, version } = call as Of<'eventsRuleShowVersion'>;
      const versions = (ruleShowV032 as Record<string, { document: { version: number } }[]>)[ruleId] ?? [];
      return versions.filter((entry) => entry.document.version === version);
    },
    eventsRuleTestFlow: workflowTestFlow,
    eventsRunsList: (call: Call) => {
      const { ruleId, state } = call as Of<'eventsRunsList'>;
      return {
        runs: runsList.runs.filter(
          (run) => (ruleId === undefined || run.ruleId === ruleId) && (state === undefined || run.state === state),
        ),
      };
    },
    eventsRunShow: (call: Call) => ({ ...runShow, runId: (call as Of<'eventsRunShow'>).runId }),
    eventsRunCancel: (call: Call) => {
      const { runId, interrupt } = call as Of<'eventsRunCancel'>;
      return { runId, state: 'cancelled', cancelledDeliveries: 1, cancelledEvents: 0, interrupted: interrupt };
    },
    eventsProjectsList: projectsList,
    eventsProjectShow: (call: Call) =>
      projectsList.projects.find((each) => each.projectId === (call as Of<'eventsProjectShow'>).projectId) ?? project,
    eventsProjectAdd: (call: Call) => ({ ...project, ...(call as Of<'eventsProjectAdd'>).document }),
    eventsProjectUpdate: (call: Call) => ({ ...project, ...(call as Of<'eventsProjectUpdate'>).document }),
    eventsProjectRemove: (call: Call) => ({ projectId: (call as Of<'eventsProjectRemove'>).projectId, removed: true }),
    eventsProjectScan: projectScan,
    eventsWorkflowDescribe: workflowDescribe,
    eventsWorkflowEventsList: workflowEventsList,
    eventsSubscribersList: subscribersList,
    eventsSubscriberAdd: (call: Call) => subscriberStored((call as Of<'eventsSubscriberAdd'>).document),
    eventsSubscriberUpdate: (call: Call) => subscriberStored((call as Of<'eventsSubscriberUpdate'>).document),
    eventsSubscriberRemove: (call: Call) => ({
      subscriberId: (call as Of<'eventsSubscriberRemove'>).subscriberId,
      removed: true,
    }),
    eventsSubscriberEnable: SUBSCRIPTION_PREPARED,
    eventsSubscriberApprove: (call: Call) => ({
      approvalId: (call as Of<'eventsSubscriberApprove'>).approvalId,
      status: 'approved',
      activated: true,
    }),
  };
}

/** What `subscriber add|update` answers: the version it stored, inert until a subscription is approved. */
function subscriberStored(document: Record<string, unknown>) {
  return {
    id: `subscriber:${String(document.subscriberId)}@${String(document.version)}`,
    kind: 'subscriber',
    objectId: document.subscriberId,
    version: document.version,
    document,
    digest: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1',
    state: null,
  };
}

/** An installation with every product at 0.29.0, the first core with the activity log. */
export const ACTIVITY_INSTALLATION: Installation = { ...EXAMPLE_INSTALLATION, version: '0.29.0' };

/** Every product at 0.30.0, the first events service with the action queue: core's version, and each `--version`. */
export const QUEUE_INSTALLATION: Installation = { ...EXAMPLE_INSTALLATION, version: '0.30.0' };

/** Every product at 0.31.0, the first events service with lanes. */
export const LANES_INSTALLATION: Installation = { ...EXAMPLE_INSTALLATION, version: '0.31.0' };

/** `lane list`: `david`, bound to a window in `~/work/acme-site`, and `billing`, bound to none. */
export const LANE_LIST = laneList;

/**
 * `activity sessions --since 24h`: two agent windows grouped as one each — one in `~/work/billing-tool`, and the one
 * `david` is bound to — then the event service and a command, which are not.
 */
export const RECENT_SESSIONS = activitySessionsRecent;

/**
 * Lanes that keep what is done to them, as the event service does: unbind ends a lane's binding, and the list answers
 * from what is left. Each call of this starts again from the fixture.
 */
export function fakeLanes(): Partial<Record<Call['kind'], Fixture>> {
  const lanes: { name: string; binding: unknown }[] = JSON.parse(JSON.stringify(LANE_LIST.lanes));
  return {
    laneList: () => ({ lanes: JSON.parse(JSON.stringify(lanes)) }),
    laneUnbind: (call: Call) => {
      const { lane } = call as Extract<Call, { kind: 'laneUnbind' }>;
      const found = lanes.find((each) => each.name === lane);
      if (found !== undefined) found.binding = null;
      return { lane, unbound: true };
    },
  };
}

/** The queue's lists, by the state each holds (written from the contract, design 2026-10-25-action-queue §8). */
export const QUEUE_LISTS = { open: queueOpen, done: queueDone, dismissed: queueDismissed } as const;

/** The queue's counts, as the lists above hold them. */
export const QUEUE_COUNTS = queueCounts;

type QueueListCall = Extract<Call, { kind: 'queueList' }>;

/**
 * `queue list` from the fixtures, as the event service would answer it: the state's items (every state's for `all`),
 * newest first, only those of the rule and the channel asked for, and at most the limit, with `more` past it.
 */
export function queueListAnswer(
  call: Call,
  lists: Record<'open' | 'done' | 'dismissed', { items: unknown[] }> = QUEUE_LISTS,
) {
  const { state, rule, channel, limit } = call as QueueListCall;
  const pool =
    state === 'all' ? [...lists.open.items, ...lists.done.items, ...lists.dismissed.items] : lists[state].items;
  const items = (pool as { arrivedAt: string; rule: { id: string }; channel: string }[])
    .filter(
      (item) => (rule === undefined || item.rule.id === rule) && (channel === undefined || item.channel === channel),
    )
    .sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt));
  const shown = limit === undefined ? items : items.slice(0, limit);
  return { items: shown, more: shown.length < items.length };
}

/**
 * A queue that keeps what is done to it, as the event service does: done, dismiss and reopen move an item between the
 * lists, clear purges the done and dismissed, and the lists and counts answer from what is left. Each call of this
 * starts again from the fixtures.
 */
export function fakeQueue(): Partial<Record<Call['kind'], Fixture>> {
  type Item = (typeof QUEUE_LISTS.open.items)[number];
  let items: Item[] = JSON.parse(
    JSON.stringify([...QUEUE_LISTS.open.items, ...QUEUE_LISTS.done.items, ...QUEUE_LISTS.dismissed.items]),
  );
  const inState = (state: string) => ({ items: items.filter((item) => item.state === state) });
  const count = (state: string) => items.filter((item) => item.state === state).length;
  const change = (call: Call) => {
    const answer = queueChangeAnswer(call);
    const item = items.find((each) => each.id === answer.item.id);
    if (item !== undefined) {
      item.state = answer.item.state;
      item.stateAt = answer.item.stateAt;
    }
    return answer;
  };
  return {
    queueList: (call: Call) =>
      queueListAnswer(call, { open: inState('open'), done: inState('done'), dismissed: inState('dismissed') }),
    queueCounts: () => ({
      open: count('open'),
      done: count('done'),
      dismissed: count('dismissed'),
      byRule: QUEUE_COUNTS.byRule.map((rule) => ({
        ...rule,
        open: items.filter((item) => item.state === 'open' && item.rule.id === rule.ruleId).length,
      })),
    }),
    queueDone: change,
    queueDismiss: change,
    queueReopen: change,
    queueClear: () => {
      const before = items.length;
      items = items.filter((item) => item.state === 'open');
      return { cleared: before - items.length };
    },
  };
}

/** What `queue done|dismiss|reopen` answers: the item's id and its new state, at a fixed moment. */
export function queueChangeAnswer(call: Call) {
  const { kind, itemId } = call as Extract<Call, { kind: 'queueDone' | 'queueDismiss' | 'queueReopen' }>;
  const state = kind === 'queueDone' ? 'done' : kind === 'queueDismiss' ? 'dismissed' : 'open';
  return { item: { id: itemId, state, stateAt: '2026-10-25T10:00:00.000Z' } };
}

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
  // Where the designer kept each workflow's boxes, as Rust's `positions.rs` would: in memory, for this bridge only.
  const kept = new Map<string, WorkflowPositions>();
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
    async eventServiceState() {
      return EVENT_SERVICE.running;
    },
    async setEventService(on) {
      return on ? EVENT_SERVICE.running : EVENT_SERVICE.stopped;
    },
    async eventServiceRetry() {
      return EVENT_SERVICE.starting;
    },
    async restartEventService() {
      return EVENT_SERVICE.starting;
    },
    async answerFirstStart(start) {
      return start ? EVENT_SERVICE.starting : EVENT_SERVICE.stopped;
    },
    async openFullDiskAccess() {},
    async answerQuit() {},
    async providerKeySet(provider) {
      return ok({ provider, hasKey: true, judges: 0 });
    },
    async appBuild() {
      return RELEASE_BUILD;
    },
    async workflowPositions(ruleId) {
      return JSON.parse(JSON.stringify(kept.get(ruleId) ?? {}));
    },
    async setWorkflowPositions(ruleId, positions) {
      if (Object.keys(positions).length === 0) kept.delete(ruleId);
      else kept.set(ruleId, JSON.parse(JSON.stringify(positions)));
    },
  };

  const bridge = { calls } as FakeBridge;
  for (const command of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const implementation = (handlers[command] ?? defaults[command]) as (...args: unknown[]) => Promise<unknown>;
    // A command of one argument is recorded with that argument; one of more, with the list of them.
    (bridge as unknown as Record<string, unknown>)[command] = (...args: unknown[]) => {
      record(command, args.length > 1 ? args : args[0]);
      return implementation(...args);
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
