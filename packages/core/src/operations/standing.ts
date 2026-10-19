import { approvalNotFound, NEVER_NOTICE } from '../approval-outcome.ts';
import { asV2 } from '../approval-stored.ts';
import type { ApprovalRecord } from '../approvals.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError, toCommsError } from '../errors.ts';
import { handoffSentence, requireHandoffs } from '../handoffs.ts';
import { findById } from '../names.ts';
import { truncateDisplay } from '../render.ts';
import {
  effectiveStanding,
  raiseStandingEpoch,
  STANDING_DAY_MS,
  STANDING_LIMITS,
  type StandingAct,
  type StandingBinding,
  type StandingContent,
  type StandingLimits,
  type StandingNarrowing,
  type StandingPlaces,
  standingDays,
} from '../standing.ts';
import { endStanding } from '../standing-flow.ts';
import type { AckOutcome, AckUse } from '../standing-ledger.ts';

/**
 * Reporting, narrowing and ending standing approvals (design 2026-10-19-standing-approvals, S8, S10, and §8.1–8.2):
 * `agentcomms standing list|narrow|revoke|off` and `comms_standing`, one operation each way.
 *
 * Reading asks nobody. Every change here only takes away, so each applies at once and asks nobody either: a narrowing
 * keeps fewer contents or places, lowers a limit or ends it sooner, and refuses anything that would allow more; a
 * revoke ends one, its unused children with it; `off` ends every one, by raising the standing epoch every record and
 * every child is bound to. Creating or widening one reads Slack, so it is Slack's (`standing add`), approved only with
 * the code typed at a terminal.
 */

/** One act under a standing approval, as the acknowledgement ledger recorded it, and what became of it. */
export interface StandingActView {
  at: string;
  act: StandingAct;
  contentDigest: string;
  channel: string;
  ts: string;
  /** What the act came to, or `pending` while nothing is recorded: under way, or its process stopped first. */
  outcome: AckOutcome['outcome'] | 'pending';
  /** The acknowledged message's permalink, where one was recorded. */
  link?: string;
}

/** A standing approval as the person reads it: what is in force now, its uses and its last acts. */
export interface StandingView {
  id: string;
  /** The workspace, by the name it has now, or the one it was made under if it is gone. */
  workspace: string;
  /** `pending` until a person approves it at a terminal; `active` while it may be used; `ended` ever after. */
  state: 'pending' | 'active' | 'ended';
  /** As in force: after any narrowing. */
  contents: StandingContent[];
  places: StandingPlaces;
  limits: StandingLimits;
  /** When an active one ends; null while it waits — it lasts its days from its approval — and once it has ended. */
  expiresAt: string | null;
  /** Why an ended one ended, in the store's words. */
  reason?: string;
  /** Its uses in the last day: what its `perDay` counts. */
  usesToday: number;
  /** Its last acts, at most 10, newest first. */
  lastActs: StandingActView[];
}

export interface StandingReport {
  approvals: StandingView[];
}

/** One change at a time: narrow one, revoke one, or end every one. */
export type StandingChangeRequest =
  | { narrow: { id: string } & StandingNarrowing }
  | { revoke: { id: string } }
  | { off: true };

/** The surface a change came from, for its audit line. */
export interface StandingChangeOptions {
  surface?: 'cli' | 'mcp' | undefined;
}

export const STANDING_CHANGE_KINDS: readonly ['narrow', 'revoke', 'off'] = Object.freeze([
  'narrow',
  'revoke',
  'off',
] as const);

const LAST_ACTS = 10;
const LIMIT_NAMES = Object.keys(STANDING_LIMITS) as (keyof StandingLimits)[];

/** The name an account has now, by its id; the name it was made under when it is gone. */
function workspaceOf(config: Config, binding: StandingBinding): string {
  return findById(config, 'account', binding.target.id)?.alias ?? binding.target.name;
}

/** When an approved standing approval ends: its approval and its days, as narrowed. */
function endOf(record: ApprovalRecord, binding: StandingBinding): string {
  return new Date(
    Date.parse(record.approvedAt as string) + standingDays(binding, record.narrowed) * STANDING_DAY_MS,
  ).toISOString();
}

/** One standing approval's acts, newest first, each with the last outcome recorded for its child. */
function actsOf(standingId: string, entries: (AckUse | AckOutcome)[]): AckUse[] {
  return entries.filter((entry): entry is AckUse => entry.kind === 'use' && entry.standingId === standingId);
}

function actView(use: AckUse, entries: (AckUse | AckOutcome)[]): StandingActView {
  const outcome = entries.findLast(
    (entry): entry is AckOutcome => entry.kind === 'outcome' && entry.childId === use.childId,
  );
  return {
    at: use.at,
    act: use.act,
    contentDigest: use.contentDigest,
    channel: use.channel,
    ts: use.ts,
    outcome: outcome?.outcome ?? 'pending',
    ...(outcome?.link === undefined ? {} : { link: outcome.link }),
  };
}

/**
 * Every standing approval on this machine, as it stands now (S10): each one's contents, each named by its digest, its
 * places and limits as in force, when it ends, its uses in the last day and its last 10 acts with what became of each.
 *
 * Each record is looked at under its lock and classified against the live configuration (`inspectAll`), so one ended
 * by the standing epoch, by `never`, by its account's removal or by its days reads as ended here before anything has
 * written that down. A record this release cannot read is not one — the doctor counts those. It only reads.
 */
export async function standingReport(core: Core): Promise<StandingReport> {
  const config = await core.config.load();
  const listed = await core.approvals.inspectAll();
  const now = core.acks.now().getTime();
  const ledgers = new Map<string, (AckUse | AckOutcome)[]>();
  const approvals: StandingView[] = [];
  for (const { stored, outcome } of listed) {
    const record = asV2(stored);
    if (record === null || record.kind !== 'standing' || record.standing === undefined) continue;
    const binding = record.standing;
    const inForce = effectiveStanding(binding, record.narrowed);
    // `never` ends a send's standing approvals (S8); a look shows it so before any use writes it down.
    const never = outcome.reason === NEVER_NOTICE;
    const state: StandingView['state'] =
      outcome.state === 'pending' && !never
        ? 'pending'
        : outcome.state === 'approved' && !never && record.approvedAt !== undefined
          ? 'active'
          : 'ended';
    const accountId = binding.target.id;
    let entries = ledgers.get(accountId);
    if (entries === undefined) {
      entries = await core.acks.entries(accountId);
      ledgers.set(accountId, entries);
    }
    const acts = actsOf(record.approvalId, entries);
    const reason = outcome.reason ?? record.reason;
    approvals.push({
      id: record.approvalId,
      workspace: workspaceOf(config, binding),
      state,
      contents: inForce.contents.map((content) => ({ ...content })),
      places: inForce.places,
      limits: { ...inForce.limits },
      expiresAt: state === 'active' ? endOf(record, binding) : null,
      ...(state === 'ended' && reason !== undefined ? { reason } : {}),
      usesToday: acts.filter((use) => Date.parse(use.at) > now - STANDING_DAY_MS).length,
      lastActs: acts
        .slice(-LAST_ACTS)
        .reverse()
        .map((use) => actView(use, entries)),
    });
  }
  return { approvals };
}

/** The refusal of a narrowing that would allow more, naming the Slack command that prepares a replacement. */
async function widens(core: Core, record: ApprovalRecord, what: string, workspace: string): Promise<CommsError> {
  const id = record.approvalId;
  // Another product's command: found among the servers this machine's clients start, or said in words.
  const handoffs = await requireHandoffs(core).registered();
  const add = handoffs.of('slack', ['standing', 'add', '--workspace', workspace, '--replaces', id]);
  const said = (how: string) =>
    `A narrowing only takes away. To allow more, prepare a new standing approval that replaces this one, holding everything it should allow: ${how}, or slack_standing_add with \`replaces\`. The person approves it at their own terminal, with its code. Nothing was changed.`;
  return new CommsError('USAGE', `nothing was narrowed: ${what} would widen standing approval ${id}, not narrow it`, {
    hint: handoffSentence(add, said, {
      instead: said(`Slack's standing add with --workspace ${workspace} --replaces ${id}`),
    }),
    details: { reason: 'widens', approvalId: id },
  });
}

/** Why `narrowing` would widen what `inForce` permits, or null: checked before the store's own check, for the words. */
function wideningOf(inForce: StandingBinding, narrowing: StandingNarrowing): string | null {
  const held = new Set(inForce.contents.map((content) => content.digest));
  if (narrowing.keep?.some((digest) => !held.has(digest))) return 'keeping a content it does not hold';
  if (narrowing.places !== undefined && inForce.places.kind === 'exact') {
    const places = new Set(inForce.places.places.map((place) => place.id));
    if (narrowing.places.some((id) => !places.has(id))) return 'keeping a place it does not cover';
  }
  for (const name of LIMIT_NAMES) {
    const value = narrowing.limits?.[name];
    if (value !== undefined && value > inForce.limits[name]) {
      return name === 'expiresDays' ? 'ending it later' : `raising ${name} to ${value}`;
    }
  }
  return null;
}

/** The narrowing asked for, as the store takes it: only what was given. USAGE when nothing was, or a limit is no number. */
function narrowingAsked(narrow: { id: string } & StandingNarrowing): StandingNarrowing {
  const limits: Partial<StandingLimits> = {};
  for (const name of LIMIT_NAMES) {
    const value = narrow.limits?.[name];
    if (value === undefined) continue;
    const { min } = STANDING_LIMITS[name];
    if (!Number.isSafeInteger(value) || value < min) {
      throw new CommsError('USAGE', `nothing was narrowed: ${name} is a whole number of at least ${min}`, {
        hint: 'A narrowing lowers a limit, or ends it sooner: give a whole number no higher than it is now.',
      });
    }
    limits[name] = value;
  }
  const narrowing: StandingNarrowing = {
    ...(narrow.keep === undefined ? {} : { keep: [...narrow.keep] }),
    ...(narrow.places === undefined ? {} : { places: [...narrow.places] }),
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
  };
  if (Object.keys(narrowing).length === 0) {
    throw new CommsError('USAGE', 'nothing was narrowed: say what to keep, or which limit to lower', {
      hint: 'Give the contents to keep by digest, the places to keep, a lower per-thread, per-hour or per-day limit, or fewer days. To end it altogether, revoke it.',
    });
  }
  return narrowing;
}

/** The standing record `id` names, as it reads now, or the one NOT_FOUND for anything else. */
async function standingRecord(core: Core, id: string): Promise<ApprovalRecord> {
  const record = asV2(await core.approvals.get(id));
  if (record === null || record.kind !== 'standing' || record.standing === undefined) {
    throw approvalNotFound(id, 'standing');
  }
  return record;
}

async function narrow(
  core: Core,
  request: { id: string } & StandingNarrowing,
  options: StandingChangeOptions,
): Promise<void> {
  const record = await standingRecord(core, request.id);
  const binding = record.standing as StandingBinding;
  const narrowing = narrowingAsked(request);
  const workspace = workspaceOf(await core.config.load(), binding);
  if (narrowing.places !== undefined && binding.places.kind !== 'exact') {
    throw new CommsError('USAGE', 'nothing was narrowed: threads-i-am-in names no places to keep', {
      hint: 'Narrow its contents or limits, or revoke it.',
    });
  }
  const what = wideningOf(effectiveStanding(binding, record.narrowed), narrowing);
  if (what !== null) throw await widens(core, record, what, workspace);
  let narrowed: ApprovalRecord;
  try {
    // Under the record's lock the store checks it again, against what is in force there (`narrowedFurther`).
    narrowed = await core.approvals.narrowStanding(record.approvalId, record.inboxId, narrowing);
  } catch (error) {
    if (error instanceof CommsError && error.code === 'USAGE' && error.details?.reason === 'widens') {
      throw await widens(core, record, 'this', workspace);
    }
    throw error;
  }
  await core.audit.append({
    inboxId: record.inboxId,
    alias: workspace,
    operation: 'standing.narrow',
    outcome: 'ok',
    ...(options.surface === undefined ? {} : { surface: options.surface }),
    approvalId: record.approvalId,
    ids: {
      ...(narrowed.narrowed?.keep === undefined ? {} : { keep: narrowed.narrowed.keep }),
      ...(narrowed.narrowed?.places === undefined ? {} : { places: narrowed.narrowed.places }),
    },
    reason: 'narrowed at once: it permits nothing more',
  });
}

/**
 * Ends every standing approval at once (S8): the standing epoch raised first — the one write that ends them all,
 * pending and approved, and every unused child, whatever any record says — and then each still live on disk revoked
 * there too, with its unused children (`endStanding`), so a configuration taken back by hand revives none of them.
 */
async function off(core: Core, options: StandingChangeOptions): Promise<void> {
  const standingEpoch = await raiseStandingEpoch(core);
  await core.audit.append({
    inboxId: '',
    operation: 'standing.off',
    outcome: 'ok',
    ...(options.surface === undefined ? {} : { surface: options.surface }),
    ids: { standingEpoch: String(standingEpoch) },
    reason: 'every standing approval ended at once',
  });
  for (const stored of await core.approvals.list({ states: ['pending', 'approved'] })) {
    const record = asV2(stored);
    if (record === null || record.kind !== 'standing') continue;
    await endStanding(core, record.approvalId, 'ended with every standing approval (standing off)').catch(
      // Ended already, by the epoch: one that could not be written down as well is said in the audit, not refused.
      (error: unknown) =>
        core.audit
          .append({
            inboxId: record.inboxId,
            operation: 'standing.end',
            outcome: 'failed',
            approvalId: record.approvalId,
            reason: truncateDisplay(
              `ended by the standing epoch, but not written down: ${toCommsError(error).message}`,
              300,
            ),
          })
          .catch(() => undefined),
    );
  }
}

/**
 * One change to the standing approvals (S8), applied at once, asking nobody — each only takes away — and then the
 * report as it reads after it:
 *
 *  - `narrow`: keep fewer contents (by digest) or exact places, lower a limit, or end it sooner. Anything that would
 *    allow more is USAGE, naming Slack's `standing add --replaces`, which prepares one for a code at a terminal.
 *  - `revoke`: end one at once, and every unused child of it (`endStanding`).
 *  - `off`: end every one at once (`raiseStandingEpoch`).
 */
export async function standingChange(
  core: Core,
  request: StandingChangeRequest,
  options: StandingChangeOptions = {},
): Promise<StandingReport> {
  const asked = STANDING_CHANGE_KINDS.filter(
    (kind) => (request as Partial<Record<(typeof STANDING_CHANGE_KINDS)[number], unknown>>)[kind] !== undefined,
  );
  if (asked.length !== 1) {
    throw new CommsError('USAGE', 'one change at a time: narrow, revoke or off', {
      hint: 'Ask for one of them; each applies at once. With none, it only reports.',
    });
  }
  if ('narrow' in request && request.narrow !== undefined) await narrow(core, request.narrow, options);
  // Only a standing approval: a child or another kind is the one NOT_FOUND, as one nobody prepared is.
  else if ('revoke' in request && request.revoke !== undefined) {
    await endStanding(core, request.revoke.id, 'revoked by the person');
  } else if ('off' in request && request.off === true) await off(core, options);
  else throw new CommsError('USAGE', '`off` is true, or left out');
  return standingReport(core);
}
