import { approvalWaitOf, approveAndWaitSentence } from './approval-handoffs.ts';
import type { ApprovalObject } from './approval-outcome.ts';
import { asV2 } from './approval-stored.ts';
import type { ApprovalRecord } from './approvals.ts';
import type { AuditRecord } from './audit.ts';
import { defaultStreams, paint, refuseUnlessPerson, type Streams } from './cli-runtime.ts';
import { effectiveAccountSendPolicy, standingEpochOf } from './config.ts';
import type { Core } from './core.ts';
import { CommsError, toCommsError } from './errors.ts';
import { requireHandoffs } from './handoffs.ts';
import { resolveName } from './names.ts';
import { escapeForDisplay, truncateDisplay } from './render.ts';
import { ensureSendEpochConfig, sendEpochOf } from './send-epoch.ts';
import {
  checkedContents,
  checkedLimits,
  classifyStandingChange,
  type ExactPlace,
  effectiveStanding,
  type SharedState,
  type StandingBinding,
  type StandingLimits,
  type StandingNarrowing,
  type StandingPlaces,
  replyWarningPrefix,
  standingBindingProblem,
  standingDigest,
} from './standing.ts';
import { neutralise } from './untrusted.ts';

/**
 * Preparing, showing and approving a standing approval (design 2026-10-19-standing-approvals, S8, and §8.1).
 *
 * A channel that can read the places a standing approval names — Slack, which reads each place's name, member count
 * and sharing — makes the request; this prepares it, shows it in full, and approves it at a terminal with its code.
 * Nothing here takes a typed `yes`, a client's form, or an answer carried in a call: a standing approval lets acts
 * happen with nobody asked, so it is approved the strongest way the product has, whatever the change policy (S8).
 */

/** What a channel asks for: an account, the contents the person wrote, the places as read, and the limits. */
export interface StandingRequest {
  /** The account's name, as the person gave it, and its id: both must name the same connected Slack account. */
  account: string;
  accountId: string;
  /** The account's user, as its sends are bound to (`postingAs`). */
  inboxSub: string;
  contents: { reactions?: string[]; replies?: string[] };
  places: StandingPlaces;
  limits: Partial<StandingLimits>;
  /** The standing approval this widens or narrows. */
  replaces?: string | undefined;
}

/** A standing approval prepared, waiting for its code at a terminal. */
export interface PreparedStanding {
  approvalId: string;
  summary: string;
  /** The preview to show in full (`renderStandingPreview`). */
  preview: string;
  expiresAt: string;
  /** What to do next: the person runs `approve` at their own terminal; an agent cannot. */
  next: string;
  approval: ApprovalObject;
  warnings: string[];
}

/** The first line of a preview an agent proposed (S8), in the spec's words. */
export const STANDING_AGENT_LINE = 'An agent proposed these contents and places. Check each one.';

type StandingSurface = 'cli' | 'mcp';

/** One audit line for a step of a standing approval: never a reply's text, only ids and digests. */
async function auditStanding(
  core: Core,
  entry: {
    operation: 'standing.prepare' | 'standing.approve' | 'standing.end';
    outcome: 'ok' | 'refused';
    surface?: AuditRecord['surface'] | undefined;
    inboxId?: string | undefined;
    alias?: string | undefined;
    approvalId?: string | undefined;
    ids?: AuditRecord['ids'] | undefined;
    reason?: string | undefined;
  },
): Promise<void> {
  await core.audit.append({
    inboxId: entry.inboxId ?? '',
    ...(entry.alias === undefined ? {} : { alias: entry.alias }),
    operation: entry.operation,
    outcome: entry.outcome,
    ...(entry.surface === undefined ? {} : { surface: entry.surface }),
    ...(entry.approvalId === undefined ? {} : { approvalId: entry.approvalId }),
    ...(entry.ids === undefined ? {} : { ids: entry.ids }),
    ...(entry.reason === undefined ? {} : { reason: truncateDisplay(entry.reason, 300) }),
  });
}

/** The same, for a refusal: best effort, so a refusal is never lost to a log that could not be written. */
function auditRefused(
  core: Core,
  error: unknown,
  entry: Omit<Parameters<typeof auditStanding>[1], 'outcome'>,
): Promise<void> {
  return auditStanding(core, { ...entry, outcome: 'refused', reason: toCommsError(error).message }).catch(
    () => undefined,
  );
}

/** One line about a standing approval, for a listing: what it holds and where. Not part of its digest. */
function summaryOf(account: string, contents: number, places: StandingPlaces): string {
  const where =
    places.kind === 'threads-i-am-in'
      ? 'in threads you posted in'
      : `in ${places.places.length} ${places.places.length === 1 ? 'place' : 'places'}`;
  return `acknowledge with ${contents} ${contents === 1 ? 'content' : 'contents'} ${where} on ${account}`;
}

/** What `binding` asks of the standing approval it replaces, as a narrowing of it. */
function narrowingOf(binding: StandingBinding): StandingNarrowing {
  return {
    keep: binding.contents.map((content) => content.digest),
    ...(binding.places.kind === 'exact' ? { places: binding.places.places.map((place) => place.id) } : {}),
    limits: { ...binding.limits },
  };
}

/** The standing approval `replaces` names: this account's, still in force or waiting, as it reads now. */
async function replacedRecord(core: Core, replaces: string, accountId: string): Promise<ApprovalRecord> {
  const { stored, outcome } = await core.approvals.inspect(
    replaces,
    { kind: 'standing', owner: accountId },
    { action: 'revoke' },
  );
  if (outcome.error) throw outcome.error;
  const record = asV2(stored);
  if (record === null || record.standing === undefined || (record.state !== 'approved' && record.state !== 'pending')) {
    throw new CommsError('APPROVAL_VOID', `nothing was prepared: standing approval ${replaces} has ended`, {
      hint: 'Prepare a new standing approval without --replaces: there is nothing left to replace.',
      details: { approvalId: replaces },
    });
  }
  return record;
}

/**
 * Prepares a standing approval for the person to approve at their terminal (S8), or — when it replaces one and only
 * narrows what is in force (`classifyStandingChange`) — narrows that one at once, and prepares nothing.
 *
 * The account is found by its name and must be the id the channel read (`resolveName`); its user must be the one its
 * sends are bound to. The contents and limits are checked here (`checkedContents`, `checkedLimits`), and the store
 * checks the whole binding again before writing it. The record binds the account's send epoch and the standing epoch
 * as they are now, on a version-3 configuration. Under `never` nothing can be used, so nothing is prepared.
 */
export async function prepareStanding(
  core: Core,
  request: StandingRequest,
  options: { surface: StandingSurface; proposedBy: 'agent' | 'person'; platform?: NodeJS.Platform },
): Promise<
  { status: 'narrowed'; record: ApprovalRecord } | { status: 'approval-required'; prepared: PreparedStanding }
> {
  const where = { surface: options.surface, inboxId: request.accountId, alias: request.account };
  try {
    const { config } = await ensureSendEpochConfig(core);
    const { account } = resolveName(config, 'account', request.account);
    if (account.id !== request.accountId || account.platform !== 'slack') {
      throw new CommsError(
        'NOT_FOUND',
        `nothing was prepared: "${request.account}" is not the Slack account asked for`,
        {
          hint: 'Name the workspace as it is connected now, and prepare it again.',
        },
      );
    }
    if (account.userId !== request.inboxSub) {
      throw new CommsError('BAD_DATA', 'nothing was prepared: a standing approval is made for the account’s own user', {
        hint: 'This is a bug — please report it.',
      });
    }
    if (effectiveAccountSendPolicy(config, request.account) === 'never') {
      throw new CommsError(
        'POLICY_NEVER',
        'nothing was prepared: sending is turned off for this workspace (policy: never)',
        {
          hint: 'Nothing is sent from it, with a standing approval or without one.',
        },
      );
    }
    const { contents, warnings } = checkedContents(request.contents);
    const binding: StandingBinding = {
      summary: summaryOf(request.account, contents.length, request.places),
      target: { kind: 'account', name: request.account, id: request.accountId },
      contents,
      places: request.places,
      limits: checkedLimits(request.limits),
      proposedBy: options.proposedBy,
      ...(request.replaces === undefined ? {} : { replaces: request.replaces }),
      warnings,
    };

    if (request.replaces !== undefined) {
      const replaced = await replacedRecord(core, request.replaces, request.accountId);
      const inForce = effectiveStanding(replaced.standing as StandingBinding, replaced.narrowed);
      // Only narrower, or the same: applied at once, to the one in force — nothing waits, nothing more is permitted.
      if (classifyStandingChange(inForce, binding) !== 'widens') {
        const record = await core.approvals.narrowStanding(request.replaces, request.accountId, narrowingOf(binding));
        await auditStanding(core, {
          ...where,
          operation: 'standing.prepare',
          outcome: 'ok',
          approvalId: record.approvalId,
          reason: 'narrowed at once: it permits nothing more',
        });
        return { status: 'narrowed', record };
      }
    }

    const record = await core.approvals.createStanding({
      binding,
      inboxSub: request.inboxSub,
      sendEpoch: sendEpochOf(config, request.accountId),
      standingEpoch: standingEpochOf(config),
    });
    await auditStanding(core, {
      ...where,
      operation: 'standing.prepare',
      outcome: 'ok',
      approvalId: record.approvalId,
      ids: { contents: contents.map((content) => content.digest) },
      reason: `${binding.summary}; proposed by ${options.proposedBy === 'agent' ? 'an agent' : 'the person'}`,
    });
    const next = approveAndWaitSentence(
      requireHandoffs(core, options.platform),
      options.surface,
      record.approvalId,
      (approve, wait) =>
        `A standing approval is approved only with the code typed at a terminal, whatever the change policy: ask the person to run ${approve} in their own terminal, read it and type the code it shows${
          wait === undefined ? '' : `; learn when they have with ${wait}`
        }. An agent cannot approve it, and nothing is sent until it is approved.`,
    );
    return {
      status: 'approval-required',
      prepared: {
        approvalId: record.approvalId,
        summary: binding.summary,
        preview: renderStandingPreview(record),
        expiresAt: record.expiresAt,
        next,
        approval: await core.approvals.approvalOf(record),
        warnings,
      },
    };
  } catch (error) {
    await auditRefused(core, error, { ...where, operation: 'standing.prepare' });
    throw error;
  }
}

/** A place's name as the preview shows it: neutralised, flattened and cut — it is a name someone in Slack chose. */
function shownName(name: string): string {
  return truncateDisplay(neutralise(name).text, 80);
}

/** Whether another organisation shares a place, in the preview's words. */
function sharedWords(shared: SharedState): string {
  const words =
    shared.extShared || shared.externalMembers === true
      ? 'shared with another organisation'
      : shared.pendingExtShared
        ? 'shared with another organisation (an invitation to share it is pending)'
        : 'not shared with another organisation';
  return shared.externalMembers === null ? `${words}; its members were not read one by one` : words;
}

/** One exact place: `#<name> (<id>): <n> members, <shared or not>`. */
function placeLine(place: ExactPlace): string {
  const label =
    place.name === null ? place.id : `${place.id.startsWith('D') ? '' : '#'}${shownName(place.name)} (${place.id})`;
  return `${label}: ${place.members} ${place.members === 1 ? 'member' : 'members'}, ${sharedWords(place.shared)}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The preview of a standing record, in order (S8): the agent line when an agent proposed it; what it lets the agent
 * do; each content in full, with its whole digest, then its warnings; each place by name, member count and sharing, or
 * `threads-i-am-in`; the limits and how long it lasts; and what it replaces.
 *
 * Believed only once the record's own digest reproduces from what it holds: a record whose binding is not what it is
 * bound to is refused, not shown, so no screen ever asks for a code for something other than what the code approves.
 */
export function renderStandingPreview(record: ApprovalRecord): string {
  const standing = record.standing;
  if (
    record.kind !== 'standing' ||
    standing === undefined ||
    standingBindingProblem(standing) !== null ||
    standingDigest(standing) !== record.contentDigest
  ) {
    throw new CommsError(
      'APPROVAL_VOID',
      `nothing was sent: standing approval ${record.approvalId} does not hold what it is bound to, so it is not shown`,
      {
        hint: 'It is never used. Prepare it again if it is still wanted.',
        details: { approvalId: record.approvalId },
      },
    );
  }
  const workspace = shownName(standing.target.name);
  const warned = new Set<string>();
  const contentLines = standing.contents.flatMap((content) => {
    const head =
      content.kind === 'reaction' ? `  Reaction :${content.text}:` : `  Reply "${escapeForDisplay(content.text)}"`;
    const own = standing.warnings.filter((warning) =>
      warning.startsWith(content.kind === 'reaction' ? `:${content.text}: ` : replyWarningPrefix(content.text)),
    );
    for (const warning of own) warned.add(warning);
    return [
      head,
      `    digest ${content.digest}`,
      ...own.map((warning) => `    Warning: ${content.kind === 'reply' ? escapeForDisplay(warning) : warning}`),
    ];
  });
  const others = standing.warnings.filter((warning) => !warned.has(warning));
  const places =
    standing.places.kind === 'threads-i-am-in'
      ? [`threads-i-am-in: threads in ${workspace} where you posted yourself in the last 14 days`]
      : standing.places.places.map(placeLine);
  const { perThread, perHour, perDay, expiresDays } = standing.limits;
  return [
    ...(standing.proposedBy === 'agent' ? [STANDING_AGENT_LINE] : []),
    `Standing approval for ${workspace}: your agent may acknowledge, without asking, a message that has just arrived from another person.`,
    '',
    'Contents, each named by its digest:',
    ...contentLines,
    ...(others.length > 0 ? ['', ...others.map((warning) => `Warning: ${truncateDisplay(warning, 300)}`)] : []),
    '',
    'Places:',
    ...places,
    '',
    `Limits: ${perThread} per thread, ${perHour} an hour, ${perDay} a day; it ends ${plural(expiresDays, 'day', 'days')} after you approve it.`,
    ...(standing.replaces === undefined ? [] : [`Replaces ${standing.replaces}: approving this ends it.`]),
    '',
    `approval ${record.approvalId} · approved only with the code typed at a terminal · approving it sends nothing`,
  ].join('\n');
}

/**
 * Approves a standing approval at a terminal (S8): refused to an agent and to anything without a terminal, as every
 * person's approval is; then the preview, in full, and the code. Enter cancels, and ends it. A wrong code is refused,
 * and three void it; a typed `yes` is a wrong code. Approving one that replaces another ends that one (`endStanding`).
 *
 * It approves and sends nothing. A shell agent can get past the terminal check (`script -q /dev/null`), as it can for
 * every approval: a speed bump, the design's stated limit (§4), not a boundary.
 */
export async function approveStandingAtTerminal(
  core: Core,
  approvalId: string,
  env: NodeJS.ProcessEnv,
  output: { json?: boolean; color: boolean; platform?: NodeJS.Platform },
  streams: Streams = defaultStreams,
): Promise<{ approvalId: string; state: 'approved' | 'cancelled' }> {
  const step = { operation: 'standing.approve' as const, surface: 'cli' as const, approvalId };
  try {
    const handoffs = requireHandoffs(core, output.platform);
    refuseUnlessPerson(env, streams, {
      refusedToAgent: 'only a person can approve a standing approval, not an agent',
      refusedWithoutTerminal: 'approving a standing approval needs an interactive terminal',
      command: handoffs.own(['approve', approvalId]),
      // An agent is told what learns when the person has approved it.
      wait: approvalWaitOf(handoffs, approvalId).command,
      color: output.color,
      ...(output.json === undefined ? {} : { json: output.json }),
    });
    const { stored, outcome } = await core.approvals.inspect(approvalId, { kind: 'standing' }, { action: 'approve' });
    if (outcome.error) throw outcome.error;
    const record = asV2(stored);
    if (record === null)
      throw new CommsError('APPROVAL_VOID', `nothing was sent: approval ${approvalId} cannot be read`);
    if (record.state !== 'pending') {
      throw new CommsError('USAGE', 'nothing was sent: it is approved already, and a person approves it once', {
        hint: 'Nothing more is needed: the standing approval is in force until it ends.',
        details: { approvalId, state: record.state },
      });
    }
    // Shown only once it reproduces its digest, and before any code is issued for it.
    const preview = renderStandingPreview(record);
    const challenge = await core.approvals.issueChallenge(approvalId, 'standing', output.platform);
    streams.stdout.write(`${preview}\n\n`);
    const answer = await askLine(
      streams,
      `Type ${paint(output.color, 'bold', challenge)} to approve this standing approval, or press Enter to cancel: `,
    );
    if (!answer.trim()) {
      await core.approvals.revoke(approvalId, 'cancelled at the terminal', {
        disposition: 'person',
        expect: { kind: 'standing' },
      });
      await auditStanding(core, {
        ...step,
        operation: 'standing.end',
        outcome: 'ok',
        inboxId: record.inboxId,
        reason: 'cancelled at the terminal',
      });
      return { approvalId, state: 'cancelled' };
    }
    const approved = await core.approvals.approve(
      approvalId,
      'terminal',
      { draftMessageId: record.contentDigest, contentDigest: record.contentDigest },
      answer,
      'standing',
      output.platform,
    );
    await auditStanding(core, {
      ...step,
      outcome: 'ok',
      inboxId: record.inboxId,
      reason: 'approved at a terminal, with its code',
    });
    const replaces = approved.standing?.replaces;
    if (replaces !== undefined) {
      await endStanding(core, replaces, `replaced by ${approvalId}`).catch((error: unknown) => {
        // Gone already — ended, or retained away — is what replacing it was for.
        if (!(error instanceof CommsError && error.code === 'NOT_FOUND')) throw error;
      });
    }
    return { approvalId, state: 'approved' };
  } catch (error) {
    await auditRefused(core, error, step);
    throw error;
  }
}

/**
 * Ends a standing approval at once (S8): the record revoked, then every child of it still `approved` — minted and not
 * yet claimed — revoked too, each under its own lock, never both locks at once. A child already being sent is not
 * recalled; one claimed after its parent ended was minted before. Ending one that has ended already changes nothing.
 */
export async function endStanding(core: Core, standingId: string, reason: string): Promise<ApprovalRecord> {
  const stored = await core.approvals.revoke(standingId, reason, {
    disposition: 'person',
    expect: { kind: 'standing' },
  });
  const record = asV2(stored);
  if (record === null) {
    throw new CommsError('APPROVAL_VOID', `nothing was ended: standing approval ${standingId} cannot be read`);
  }
  const children: string[] = [];
  for (const listed of await core.approvals.list({ states: ['approved'] })) {
    const child = asV2(listed);
    if (child === null || child.kind !== 'send' || child.route !== 'standing' || child.standingId !== standingId)
      continue;
    const after = asV2(
      await core.approvals.revoke(child.approvalId, reason, { disposition: 'person', expect: { kind: 'send' } }),
    );
    if (after?.state === 'revoked') children.push(child.approvalId);
  }
  await auditStanding(core, {
    operation: 'standing.end',
    outcome: 'ok',
    inboxId: record.inboxId,
    approvalId: standingId,
    ids: { standingId, children },
    reason,
  });
  return record;
}

async function askLine(streams: Streams, question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stderr as NodeJS.WritableStream,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
