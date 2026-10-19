/**
 * What the screens read of the CLI's JSON, copied field by field from the shapes it prints. Only what a screen reads
 * is here; everything else the CLI says is left in `unknown`. Each source is named, so a change there can be followed.
 */
import type { UpdateLevel } from './ipc.ts';

/** core `PublicApprovalView` (`packages/core/src/approval-outcome.ts:327`): one waiting approval, from any channel. */
export interface ApprovalView {
  approvalId: string;
  kind?: 'send' | 'change' | 'download' | 'disclosure' | 'standing' | null;
  /** The channel's word (`gmail`, `slack`…), or null for core's own changes. */
  channel?: string | null;
  state: string;
  createdAt?: string;
  expiresAt?: string;
  /** Where it stands, in words, for the states that have their own. */
  said?: string;
  /** A record an earlier release made: shown, never approved here. */
  legacy?: true;
  /** A send's recipients and subject, or a change's summary as its subject: each inside its untrusted-content envelope. */
  expect?: { to: string[]; cc: string[]; bcc: string[]; subject: string };
  /** A download's file names, enveloped. */
  files?: { names: string[]; listing?: string[] };
  /** Why a corrupt record could not be read. */
  reason?: string;
}

/** core `DoctorReport` (`packages/core/src/operations/maintenance.ts:77`). */
export interface CoreDoctorReport {
  checks: { name: string; ok: boolean; warn?: true; detail: string; fix?: string }[];
  ok: boolean;
}

/** Gmail `DoctorResult` (`packages/gmail/src/operations/doctor.ts:91`). */
export interface GmailDoctorResult {
  checks: { id: string; title: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; detail: string; fix?: string }[];
  healthy: boolean;
}

/** Slack `DoctorResult` (`packages/slack/src/operations/doctor.ts:66`). */
export interface SlackDoctorResult {
  healthy: boolean;
  checks: {
    id: string;
    title: string;
    status: 'ok' | 'unknown' | 'warn' | 'fail';
    detail: string;
    fix: string | null;
    workspace: string | null;
  }[];
}

/** Resend `DoctorResult` (`packages/resend/src/operations/doctor.ts:52`). */
export interface ResendDoctorResult {
  healthy: boolean;
  checks: { name: string; ok: boolean; detail: string; fix?: string }[];
  accounts: { name: string; checks: { name: string; ok: boolean; detail: string; fix?: string }[] }[];
}

/** WhatsApp `StatusResult` (`packages/whatsapp/src/operations/status.ts:53`), which stands as its doctor. */
export interface WhatsappStatusResult {
  accounts: {
    account: string;
    access: {
      state: 'readable' | 'missing' | 'denied' | 'waiting' | 'unreadable' | 'not-checked';
      message?: string;
      hint?: string;
    };
  }[];
  setup?: string;
}

/** The events service's `doctor` (`packages/events-daemon/src/operations/doctor.ts:41`, v1 and v2), bare JSON. */
export interface EventsDoctorReport {
  schemaVersion: 'doctor-v1' | 'doctor-v2';
  owner: { status: 'running' };
  switch: { status: 'enabled' | 'disabled'; paused: boolean; generation: number };
  lineages: {
    ruleId: string;
    ruleVersion: number;
    validation: { status: 'valid' } | { status: 'invalid'; code: string };
  }[];
}

/** core `LabelReport` (`packages/core/src/operations/label.ts:125`). */
export interface LabelReport {
  word: string;
  name: string | null;
  rules: { text: string; matches: boolean }[];
  accounts: {
    account: string;
    platform: string;
    channel: string;
    phrase: string | null;
    kinds: { kind: string; source: 'rule' | 'default'; rule?: string; appearsAs: string }[];
    conversations: string[];
    style?: 'app' | 'labelled';
    appRoute?: boolean;
    note?: string;
  }[];
  ignored: string[];
}

/** core `UpdateStatus` (plan, Task 1): where updates stand, read from local files. */
export interface UpdateStatus {
  level: UpdateLevel;
  set: UpdateLevel;
  by: string;
  cap: { level: 'every-14-days' | 'never'; organisation: string } | null;
  pausedUntil: string | null;
  lastChecked: string | null;
  latest: string | null;
  running: string;
  security: string | null;
  lastError: string | null;
  job: {
    state: 'installed' | 'not-set-up' | 'unsupported' | string;
    where: string | null;
    installedAt: string | null;
    lastRun: string | null;
    working: boolean | null;
  };
}

/** Gmail `InboxView` (`packages/gmail/src/operations/inboxes.ts:31`); `inbox list` prints an array of them. */
export interface InboxView {
  alias: string;
  email: string;
  sendPolicy: 'chat' | 'confirm' | 'never';
  sendPolicyInherited: boolean;
  changePolicy: 'chat' | 'confirm';
  changePolicyInherited: boolean;
  organisation?: string;
  health: 'ok' | 'needs-attention' | 'unknown';
}

/** Slack `WorkspaceView` (`packages/slack/src/operations/workspaces.ts:67`); `workspace list` prints an array. */
export interface WorkspaceView {
  alias: string;
  workspaceName?: string;
  mode: string;
  organisation?: string;
  profileApp?: 'read' | 'send';
}

/** Resend `AccountView` (`packages/resend/src/operations/accounts.ts:97`); `account list` prints `{ accounts }`. */
export interface ResendAccountView {
  name: string;
  mode: string;
  sendPolicy: 'chat' | 'confirm' | 'never';
  sendPolicyFrom: 'account' | 'default';
  changePolicy: 'chat' | 'confirm';
  changePolicyFrom: 'account' | 'default';
  guarantee: string;
}

/** The acts a behaviour rule names (spec 2). */
export type BehaviourAct = 'post' | 'reply' | 'reaction' | 'edit' | 'delete' | 'file' | 'send';

/** core `BehaviourReport` (spec 2, `operations/behaviour.ts`). */
export interface BehaviourReport {
  rules: { account: string; conversation?: string; acts: BehaviourAct[]; orphan: boolean }[];
  accounts: {
    account: string;
    allowed: BehaviourAct[] | 'all';
    conversations: { conversation: string; allowed: BehaviourAct[] | 'all' }[];
  }[];
}

/**
 * One standing approval (spec 3). Provisional: core's `standing list` lands in 0.23.0, and the fields here are the
 * design's (S8, S10) until it does.
 */
export interface StandingView {
  id: string;
  account: string;
  places: string[];
  expiresAt: string;
  usesToday: number;
  active: boolean;
}

/** The products that have a doctor. */
export type DoctorProduct = 'core' | 'gmail' | 'slack' | 'resend' | 'whatsapp' | 'events-daemon';

/** Every doctor's report, read into one shape. */
export interface DoctorView {
  product: DoctorProduct;
  healthy: boolean;
  checks: { title: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; detail: string; fix?: string }[];
}

type Check = DoctorView['checks'][number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A check, with a fix only when there is one. */
function check(title: string, status: Check['status'], detail: string, fix: unknown): Check {
  return typeof fix === 'string' && fix.length > 0 ? { title, status, detail, fix } : { title, status, detail };
}

function view(product: DoctorProduct, checks: Check[], healthy?: unknown): DoctorView {
  return {
    product,
    healthy:
      typeof healthy === 'boolean'
        ? healthy && !checks.some((each) => each.status === 'fail')
        : !checks.some((each) => each.status === 'fail'),
    checks,
  };
}

/** What a report that could not be read shows: one failing check, saying so. */
function unreadable(product: DoctorProduct): DoctorView {
  return {
    product,
    healthy: false,
    checks: [{ title: 'Doctor', status: 'fail', detail: 'The report could not be read.' }],
  };
}

/** Each product's doctor report, read into `DoctorView`. A report in no shape the app knows is one failing check. */
export function doctorView(product: DoctorProduct, data: unknown): DoctorView {
  if (!isRecord(data)) return unreadable(product);
  switch (product) {
    case 'core': {
      if (!Array.isArray(data.checks)) return unreadable(product);
      const checks = list(data.checks)
        .filter(isRecord)
        .map((each) =>
          check(
            textOf(each.name),
            each.ok === true ? (each.warn === true ? 'warn' : 'ok') : 'fail',
            textOf(each.detail),
            each.fix,
          ),
        );
      return view(product, checks, data.ok);
    }
    case 'gmail':
    case 'slack': {
      if (!Array.isArray(data.checks)) return unreadable(product);
      const checks = list(data.checks)
        .filter(isRecord)
        .map((each) => {
          const status = each.status === 'unknown' ? 'skipped' : each.status;
          const known = status === 'ok' || status === 'warn' || status === 'fail' || status === 'skipped';
          return check(textOf(each.title), known ? status : 'fail', textOf(each.detail), each.fix);
        });
      return view(product, checks, data.healthy);
    }
    case 'resend': {
      if (!Array.isArray(data.checks)) return unreadable(product);
      const own = (each: Record<string, unknown>, prefix: string) =>
        check(`${prefix}${textOf(each.name)}`, each.ok === true ? 'ok' : 'fail', textOf(each.detail), each.fix);
      const checks = [
        ...list(data.checks)
          .filter(isRecord)
          .map((each) => own(each, '')),
        ...list(data.accounts)
          .filter(isRecord)
          .flatMap((account) =>
            list(account.checks)
              .filter(isRecord)
              .map((each) => own(each, `${textOf(account.name)}: `)),
          ),
      ];
      return view(product, checks, data.healthy);
    }
    case 'whatsapp': {
      if (!Array.isArray(data.accounts)) return unreadable(product);
      const states: Record<string, Check['status']> = {
        readable: 'ok',
        waiting: 'warn',
        'not-checked': 'skipped',
        missing: 'fail',
        denied: 'fail',
        unreadable: 'fail',
      };
      const checks = list(data.accounts)
        .filter(isRecord)
        .map((account) => {
          const access = isRecord(account.access) ? account.access : {};
          const state = textOf(access.state);
          return check(textOf(account.account), states[state] ?? 'fail', textOf(access.message) || state, access.hint);
        });
      if (checks.length === 0) {
        checks.push(check('WhatsApp', 'skipped', 'No WhatsApp account is set up.', data.setup));
      }
      return view(product, checks);
    }
    case 'events-daemon': {
      const owner = isRecord(data.owner) ? data.owner : null;
      const power = isRecord(data.switch) ? data.switch : null;
      if (owner === null || power === null) return unreadable(product);
      const checks: Check[] = [
        check('The events service', owner.status === 'running' ? 'ok' : 'fail', textOf(owner.status), undefined),
        check(
          'Collecting events',
          power.status === 'enabled' ? (power.paused === true ? 'warn' : 'ok') : 'warn',
          power.status === 'enabled' ? (power.paused === true ? 'paused' : 'on') : 'off',
          undefined,
        ),
        ...list(data.lineages)
          .filter(isRecord)
          .map((lineage) => {
            const validation = isRecord(lineage.validation) ? lineage.validation : {};
            const valid = validation.status === 'valid';
            return check(
              `Rule ${textOf(lineage.ruleId)} v${String(lineage.ruleVersion ?? '')}`,
              valid ? 'ok' : 'fail',
              valid ? 'valid' : textOf(validation.code) || 'invalid',
              undefined,
            );
          }),
      ];
      return view(product, checks);
    }
  }
}
