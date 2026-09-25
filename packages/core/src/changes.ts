import {
  type ApprovalRecord,
  approvalKind,
  type ChangeBinding,
  type ChangeTarget,
  changeDigest,
  stricterPolicy,
} from './approvals.ts';
import type { AuditRecord } from './audit.ts';
import {
  type ChangePolicy,
  type Config,
  classifyChange,
  defaultChangePolicy,
  type Loosening,
  type LooseningConsent,
  type SettingValue,
} from './config.ts';
import type { Core } from './core.ts';
import { CommsError, toCommsError } from './errors.ts';
import { lookupName, resolveName } from './names.ts';
import { truncateDisplay } from './render.ts';

/**
 * Change approvals: how a loosening of the configuration, or an act that cannot be taken back, is agreed to by a
 * person from either surface — a chat with an agent, or a terminal.
 *
 * The shape is a send's, over a change instead of a message. A product computes the change without writing it and
 * calls `prepareChange`, which stores an approval bound to exactly that change and returns the preview to show. The
 * person agrees — in the conversation under the `chat` change policy, or by `agentcomms approve <id>` and a typed
 * code under `confirm`. The product computes the change again and calls `claimChange`, which proves it is the same
 * change and returns the `LooseningConsent` that `ConfigStore.update` demands. Nothing here writes the configuration:
 * `ConfigStore.update` stays the one place a loosening is refused or let through, and a claimed approval is only a
 * second source of the consent it already requires.
 *
 * The policy that decides is the one in force *before* the change, read from the file by the core rather than taken
 * from the caller. Otherwise moving `changePolicy` from `confirm` to `chat` would be approved under the `chat` it
 * was asking for.
 */

export type ChangeSurface = NonNullable<AuditRecord['surface']>;

/** A change as its caller computes it: once to prepare it, and again, from the configuration then, to apply it. */
export interface ChangeSpec {
  /** The inbox the change is about, by its current name — or the one it connects. */
  inbox?: string | undefined;
  /** The account the change is about, likewise. Neither, for a change to the whole configuration. */
  account?: string | undefined;
  before: Config;
  after: Config;
  /**
   * What it does outside the configuration, one plain sentence each: "signs in to Slack and stores a token that can
   * post", "removes 3 unused runtimes". A change with effects and no loosened setting is how an act that cannot be
   * taken back — removing an account, migrating secrets or names, pruning — asks for the same approval.
   */
  effects?: readonly string[] | undefined;
}

export interface ChangeRequest extends ChangeSpec {
  /** One line about the change, in the person's terms: "Let rgc/slack post". Shown in the preview. */
  summary: string;
}

export interface ChangeOptions {
  /** Where the call came from, for the audit trail. */
  surface: ChangeSurface;
}

export interface PreparedChange {
  approvalId: string;
  /** The change policy that decides how this is approved. */
  policy: ChangePolicy;
  summary: string;
  loosened: Loosening[];
  effects: string[];
  /** What the person reads before agreeing. */
  preview: string;
  expiresAt: string;
  /** What to do next, in words an agent can follow: ask and claim, or the command the person runs. */
  next: string;
}

export interface ChangeApprovalPrompt {
  approvalId: string;
  preview: string;
  /** The code to type back. Never stored; only its hash is. */
  challenge: string;
}

/**
 * The change policy that governs a change, as `config` stands: the strictest of the policies over everything the change
 * touches.
 *
 * The inbox or account it is about, and every inbox or account whose setting it loosens, each by its own policy or
 * the default — and the default itself for a setting of the whole configuration, or for an account the change
 * connects, which has no policy of its own until it exists. The strictest, because a change that loosens two things
 * is approved the way the more careful of them asks.
 *
 * Accounts are found by id, the one measured on the before side, so a rename in the same change cannot move a
 * loosening out from under the policy that was meant to govern it.
 */
export function governingChangePolicy(
  config: Config,
  change: Pick<ChangeBinding, 'target' | 'loosened'>,
): ChangePolicy {
  const byId = (id: string | undefined): ChangePolicy => {
    const entry =
      id === undefined
        ? undefined
        : (Object.values(config.inboxes).find((inbox) => inbox.id === id) ??
          Object.values(config.accounts).find((account) => account.id === id));
    return entry?.changePolicy ?? defaultChangePolicy(config);
  };
  // A setting of the whole configuration carries no id, and so is governed by the default — as is a new account.
  const governing = [byId(change.target?.id), ...change.loosened.map((loosening) => byId(loosening.id))];
  return governing.includes('confirm') ? 'confirm' : 'chat';
}

/**
 * What a change is about: the inbox or account by the id it has before the change, or by name alone when this change
 * connects it.
 *
 * A name in neither side is refused — through `resolveName`, so a former name is answered with the one it has now.
 */
function targetOf(spec: ChangeSpec): ChangeTarget | null {
  if (spec.inbox !== undefined && spec.account !== undefined) {
    throw new CommsError('USAGE', 'a change is about one inbox or one account, not both');
  }
  if (spec.inbox !== undefined) {
    const name = spec.inbox;
    const existing = lookupName(spec.before, 'inbox', name);
    if (existing) return { kind: 'inbox', name, id: existing.id };
    if (lookupName(spec.after, 'inbox', name)) return { kind: 'inbox', name };
    resolveName(spec.before, 'inbox', name);
  }
  if (spec.account !== undefined) {
    const name = spec.account;
    const existing = lookupName(spec.before, 'account', name);
    if (existing) return { kind: 'account', name, id: existing.id };
    if (lookupName(spec.after, 'account', name)) return { kind: 'account', name };
    resolveName(spec.before, 'account', name);
  }
  return null;
}

/** The change a spec describes, as an approval binds it. */
function bindChange(spec: ChangeSpec, summary: string): ChangeBinding {
  const target = targetOf(spec);
  const effects = (spec.effects ?? []).map((effect) => effect.trim());
  if (effects.some((effect) => effect === '')) {
    throw new CommsError('USAGE', 'an effect of a change has to say what it does', {
      hint: 'Pass each effect as one plain sentence, or leave it out.',
    });
  }
  return { summary, target, loosened: classifyChange(spec.before, spec.after).changes, effects };
}

/**
 * Prepares a change for a person to approve, and writes nothing to the configuration.
 *
 * Refused when there is nothing to approve — no loosened setting and no effect — because asking a person to agree to
 * a change that needs nobody's agreement teaches them to agree without reading. Tightening is always allowed; apply it.
 */
export async function prepareChange(
  core: Core,
  request: ChangeRequest,
  options: ChangeOptions,
): Promise<PreparedChange> {
  const summary = request.summary.trim();
  let binding: ChangeBinding | undefined;
  let policy: ChangePolicy | undefined;
  try {
    if (summary === '') {
      throw new CommsError('USAGE', 'a change needs a summary: one line saying what it does, for the person to read');
    }
    binding = bindChange(request, summary);
    if (binding.loosened.length === 0 && binding.effects.length === 0) {
      throw new CommsError('USAGE', 'nothing to approve: this change loosens no safety setting and does nothing else', {
        hint: 'Apply it directly. Tightening, and a change that loosens nothing, need nobody’s approval.',
      });
    }
    policy = governingChangePolicy(await core.config.load(), binding);
    const record = await core.approvals.createChange({ change: binding, policy });
    await auditChange(core, {
      operation: 'change.prepare',
      outcome: 'ok',
      surface: options.surface,
      approvalId: record.approvalId,
      target: binding.target,
      policy,
      paths: binding.loosened.map((loosening) => loosening.path),
      reason: summary,
    });
    return {
      approvalId: record.approvalId,
      policy,
      summary,
      loosened: binding.loosened,
      effects: binding.effects,
      preview: renderChangePreview({ ...record, change: binding }),
      expiresAt: record.expiresAt,
      next: nextStep(record.approvalId, policy),
    };
  } catch (error) {
    await auditRefusal(core, 'change.prepare', error, {
      surface: options.surface,
      target: binding?.target ?? null,
      policy,
    });
    throw error;
  }
}

/**
 * Claims an approved change, once, and returns the consent that lets `ConfigStore.update` write it.
 *
 * `expect` is the change as the caller computes it now, from the configuration as it is now. It must be the change
 * that was prepared — the same settings, moving between the same values, on the same account, with the same effects
 * — or the approval is voided and the change has to be prepared again. The consent carries those values, so the write
 * that follows is refused too if the configuration moves between this claim and it.
 *
 * Under `chat` the agent claims after the person said yes. Under `confirm` a person must have approved it at a
 * terminal first; until then this is refused and the approval stays as it was.
 */
export async function claimChange(
  core: Core,
  approvalId: string,
  expect: ChangeSpec,
  options: ChangeOptions,
): Promise<LooseningConsent> {
  let binding: ChangeBinding | undefined;
  let policy: ChangePolicy | undefined;
  try {
    // The summary is not bound — the settings and the effects are — so none is needed to claim.
    binding = bindChange(expect, '');
    policy = governingChangePolicy(await core.config.load(), binding);
    const record = await core.approvals.claimForChange(approvalId, { change: binding, policy });
    const decided = stricterPolicy(policy, record.requiredPolicy) === 'chat' ? 'chat' : 'confirm';
    await auditChange(core, {
      operation: 'change.claim',
      outcome: 'ok',
      surface: options.surface,
      approvalId,
      target: binding.target,
      policy: decided,
      paths: binding.loosened.map((loosening) => loosening.path),
      reason: decided === 'confirm' ? 'approved at a terminal' : 'approved in chat',
    });
    // `binding.loosened` digests to what the record holds — the claim refused otherwise — so these are exactly the
    // loosenings the person approved.
    return {
      kind: 'loosening-consent',
      paths: binding.loosened.map((loosening) => loosening.path),
      changes: binding.loosened,
    };
  } catch (error) {
    await auditRefusal(core, 'change.claim', error, {
      surface: options.surface,
      approvalId,
      target: binding?.target ?? null,
      policy,
    });
    throw error;
  }
}

/** A change approval, checked to be one and to describe the change its digest binds. */
async function changeRecord(core: Core, approvalId: string): Promise<ApprovalRecord & { change: ChangeBinding }> {
  const record = await core.approvals.get(approvalId);
  if (!record) {
    throw new CommsError('NOT_FOUND', `no approval ${approvalId}`, {
      hint: 'Prepare the change again; an approval expires ten minutes after it is made.',
    });
  }
  if (approvalKind(record) !== 'change') {
    throw new CommsError('USAGE', `approval ${approvalId} is for a send, not a configuration change`, {
      hint: 'Approve it with the command that prepared it: `agent-gmail approve` or `agent-slack approve`.',
    });
  }
  /*
   * What is shown is rendered from the record, and only believed once it reproduces the record's own digest — so the
   * lines a person reads are the change the approval permits, not a description that happens to sit beside it.
   */
  if (!record.change || changeDigest(record.change) !== record.digest) {
    throw new CommsError('BAD_DATA', 'this approval does not describe the change it is bound to', {
      hint: 'Nothing was approved. Prepare the change again.',
      details: { approvalId },
    });
  }
  return record as ApprovalRecord & { change: ChangeBinding };
}

/**
 * Shows a change to a person at a terminal, and issues the code that binds this screen to this approval.
 *
 * The caller has already refused agents and anything without a terminal; this is the part that reads the record.
 */
export async function beginChangeApproval(
  core: Core,
  approvalId: string,
  options: ChangeOptions,
): Promise<ChangeApprovalPrompt> {
  let record: (ApprovalRecord & { change: ChangeBinding }) | undefined;
  try {
    record = await changeRecord(core, approvalId);
    const challenge = await core.approvals.issueChallenge(approvalId, 'change');
    return { approvalId, preview: renderChangePreview(record), challenge };
  } catch (error) {
    await auditRefusal(core, 'change.approve', error, {
      surface: options.surface,
      approvalId,
      target: record?.change.target ?? null,
      policy: record ? changePolicyOf(record) : undefined,
    });
    throw error;
  }
}

/** Records the approval, if the code typed back is the one shown. */
export async function finishChangeApproval(
  core: Core,
  approvalId: string,
  answer: string,
  options: ChangeOptions,
): Promise<ApprovalRecord> {
  let record: (ApprovalRecord & { change: ChangeBinding }) | undefined;
  try {
    record = await changeRecord(core, approvalId);
    const digest = changeDigest(record.change);
    const approved = await core.approvals.approve(
      approvalId,
      'terminal',
      { draftMessageId: digest, digest },
      answer,
      'change',
    );
    await auditChange(core, {
      operation: 'change.approve',
      outcome: 'ok',
      surface: options.surface,
      approvalId,
      target: record.change.target,
      policy: changePolicyOf(record),
      paths: record.change.loosened.map((loosening) => loosening.path),
      reason: 'approved at a terminal',
    });
    return approved;
  } catch (error) {
    await auditRefusal(core, 'change.approve', error, {
      surface: options.surface,
      approvalId,
      target: record?.change.target ?? null,
      policy: record ? changePolicyOf(record) : undefined,
    });
    throw error;
  }
}

/**
 * Records that a person was refused the chance to approve a change at all — an agent ran the command, or there was no
 * terminal — before anything touched the approval.
 *
 * Best effort, and it never throws: the refusal the caller is about to report matters more than this line, and the
 * id it names may not be an approval.
 */
export async function recordChangeApprovalRefused(
  core: Core,
  approvalId: string,
  error: unknown,
  options: ChangeOptions,
): Promise<void> {
  const record = await core.approvals.get(approvalId).catch(() => null);
  const change = record && approvalKind(record) === 'change' ? record.change : undefined;
  await auditRefusal(core, 'change.approve', error, {
    surface: options.surface,
    approvalId,
    target: change?.target ?? null,
    policy: record && change ? changePolicyOf(record) : undefined,
  });
}

/** Cancels a change approval. Refusing a change is never the dangerous direction, so this asks nobody. */
export async function revokeChange(
  core: Core,
  approvalId: string,
  reason: string,
  options: ChangeOptions,
): Promise<ApprovalRecord> {
  const record = await core.approvals.revoke(approvalId, reason);
  await auditChange(core, {
    operation: 'change.revoke',
    outcome: 'ok',
    surface: options.surface,
    approvalId,
    target: record.change?.target ?? null,
    policy: changePolicyOf(record),
    reason,
  });
  return record;
}

function changePolicyOf(record: Pick<ApprovalRecord, 'requiredPolicy'>): ChangePolicy {
  return record.requiredPolicy === 'chat' ? 'chat' : 'confirm';
}

function nextStep(approvalId: string, policy: ChangePolicy): string {
  return policy === 'chat'
    ? `Show this preview to the user and ask. If they say yes, claim approval ${approvalId} and apply the change; if not, revoke it.`
    : `The change policy is confirm: ask the user to run \`agentcomms approve ${approvalId}\` in their own terminal and type the code it shows. Then claim approval ${approvalId} and apply the change.`;
}

interface ChangeAuditEntry {
  operation: string;
  outcome: 'ok' | 'refused';
  surface: ChangeSurface;
  approvalId?: string | undefined;
  target: ChangeTarget | null;
  policy?: ChangePolicy | undefined;
  paths?: readonly string[] | undefined;
  reason?: string | undefined;
}

/**
 * One line per step of a change approval: who asked, from which surface, under which policy, and how it ended.
 *
 * Machine-wide changes carry no inbox, as the secret-store migration's lines do not. The summary and any refusal are
 * kept short, so a line is small enough to be appended atomically.
 */
async function auditChange(core: Core, entry: ChangeAuditEntry): Promise<void> {
  await core.audit.append({
    inboxId: entry.target?.id ?? '',
    ...(entry.target ? { alias: entry.target.name } : {}),
    operation: entry.operation,
    outcome: entry.outcome,
    surface: entry.surface,
    ...(entry.approvalId ? { approvalId: entry.approvalId } : {}),
    ...(entry.policy ? { policy: entry.policy } : {}),
    ...(entry.paths && entry.paths.length > 0 ? { ids: { paths: [...entry.paths] } } : {}),
    ...(entry.reason ? { reason: truncateDisplay(entry.reason, 300) } : {}),
  });
}

/** A refusal, recorded best effort: the refusal itself is what the caller must see, not a failure to log it. */
async function auditRefusal(
  core: Core,
  operation: string,
  error: unknown,
  entry: Omit<ChangeAuditEntry, 'operation' | 'outcome' | 'reason'>,
): Promise<void> {
  await auditChange(core, { ...entry, operation, outcome: 'refused', reason: toCommsError(error).message }).catch(
    () => undefined,
  );
}

/** What a setting is called in a preview, for the settings people change; anything else is shown by its path. */
const SETTING_LABELS: Readonly<Record<string, string>> = {
  sendPolicy: 'send policy',
  changePolicy: 'change policy',
  mode: 'mode',
  internalDomains: 'internal domains',
  'defaults.sendPolicy': 'default send policy',
  'defaults.changePolicy': 'default change policy',
  'defaults.riskEscalation': 'risk escalation',
  'defaults.sendCaps': 'send limits',
  'defaults.attachRoots': 'folders attachments may come from',
  'defaults.attachDeny': 'files attachments may never come from',
  'defaults.downloadsDir': 'downloads folder',
  'defaults.confirm.elicitationClients': 'clients trusted to ask for a send approval',
  'secrets.store': 'where credentials are kept',
};

/** What the loosening means for the person, in their terms. */
function meaning(field: string, after: SettingValue): string {
  switch (field) {
    case 'sendPolicy':
    case 'defaults.sendPolicy':
      return after === 'chat'
        ? 'a yes in the chat will be enough to send'
        : 'sending will be possible, with a code typed at a terminal';
    case 'changePolicy':
    case 'defaults.changePolicy':
      return 'a yes in the chat will be enough to loosen its settings';
    case 'mode':
      return 'it will be able to send, not only read';
    case 'internalDomains':
      return 'mail to these domains will count as internal, and will not be flagged';
    case 'defaults.riskEscalation':
      return 'a risky send will no longer be raised to a code at a terminal';
    case 'defaults.sendCaps':
      return 'more sends will be allowed in an hour or a day';
    case 'defaults.attachRoots':
      return 'files under these folders can be attached';
    case 'defaults.attachDeny':
      return 'files the removed entries protected can be attached';
    case 'defaults.downloadsDir':
      return 'files from other people will be saved here';
    case 'defaults.confirm.elicitationClients':
      return 'these clients may ask you to approve a send in their own window';
    case 'secrets.store':
      return 'credentials will move out of the system keychain into files on this disk';
    default:
      return '';
  }
}

function shown(value: SettingValue): string {
  if (value === null) return 'not set';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key} ${String(entry)}`)
      .join(', ');
  }
  return String(value);
}

/** One loosening as a line a person reads: what, from, to, and what that means. */
function describeLoosening(loosening: Loosening): string {
  const scoped = /^(inboxes|accounts)\.([^.]+)\.(.+)$/.exec(loosening.path);
  const field = scoped ? (scoped[3] ?? '') : loosening.path;
  const label = SETTING_LABELS[field] ?? field;
  const what = scoped
    ? `${scoped[2]} ${label}${loosening.id === undefined ? ' (connected by this change)' : ''}`
    : label;
  const words = meaning(field, loosening.after);
  const line = `${what}: ${shown(loosening.before)} → ${shown(loosening.after)}${words ? ` — ${words}` : ''}`;
  // Every part is escaped and cut to one line: an effect or a value can be whatever a caller passed, and this is
  // printed at the terminal of the person about to type a code — the one place a control sequence would do most harm.
  return truncateDisplay(line, 300);
}

/**
 * The change as a person reads it before agreeing: what it is for, every setting it loosens from → to in words, and
 * what it does outside the configuration.
 */
export function renderChangePreview(
  record: Pick<ApprovalRecord, 'approvalId' | 'requiredPolicy'> & { change: ChangeBinding },
): string {
  const { change } = record;
  const how = changePolicyOf(record) === 'chat' ? 'a yes in the chat' : 'a code typed at a terminal';
  const target = change.target;
  const about =
    target === null
      ? 'the whole configuration'
      : `${target.kind} ${target.name}${target.id === undefined ? ', which this change connects' : ''}`;
  return [
    [
      'CHANGE PREVIEW',
      `approval ${record.approvalId}`,
      `approved by ${how}`,
      'nothing has been changed — approving does not change it',
    ].join(' · '),
    truncateDisplay(change.summary, 200),
    `For: ${truncateDisplay(about, 200)}`,
    '',
    ...(change.loosened.length > 0
      ? ['It loosens:', ...change.loosened.map((loosening) => `  ${describeLoosening(loosening)}`)]
      : ['It loosens no safety setting.']),
    ...(change.effects.length > 0
      ? ['', 'It also:', ...change.effects.map((effect) => `  - ${truncateDisplay(effect, 300)}`)]
      : []),
  ].join('\n');
}
