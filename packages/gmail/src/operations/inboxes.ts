import { join } from 'node:path';
import {
  appendPrivateLine,
  type ChangePolicy,
  CommsError,
  defaultChangePolicy,
  effectiveSendPolicy,
  findById,
  type GatedChange,
  type InboxRuntimeState,
  keepAndReport,
  type LooseningConsent,
  RESERVED_ALIASES,
  renameEntry,
  requireInbox,
  type SendPolicy,
  withCredentialsLock,
  writeOutcome,
} from '@agentcomms/core';
import { revokeToken } from '../auth/oauth.ts';
import { type Capability, capabilitiesOf, tierOf } from '../auth/scopes.ts';
import type { GmailContext } from '../context.ts';
import { requireNewInboxName } from './inbox-names.ts';

export interface InboxView {
  alias: string;
  id: string;
  email: string;
  tier: string;
  capabilities: Capability[];
  contacts: boolean;
  sendPolicy: SendPolicy;
  /** True when the policy comes from `defaults`, not from the inbox itself. */
  sendPolicyInherited: boolean;
  /** How a loosening of this mailbox's settings is approved: a yes in the chat, or a code typed at a terminal. */
  changePolicy: ChangePolicy;
  /** True when that comes from `defaults`, not from the inbox itself. */
  changePolicyInherited: boolean;
  client: string;
  identity: 'oidc' | 'legacy';
  createdAt: string;
  lastRefreshOkAt?: string | undefined;
  lastUsedAt?: string | undefined;
  health: 'ok' | 'needs-attention' | 'unknown';
  lastError?: InboxRuntimeState['lastError'];
}

function health(state: InboxRuntimeState): InboxView['health'] {
  if (state.lastError) return 'needs-attention';
  return state.lastRefreshOkAt ? 'ok' : 'unknown';
}

export async function inboxList(context: GmailContext): Promise<InboxView[]> {
  const config = await context.config();
  const views: InboxView[] = [];
  for (const [alias, inbox] of Object.entries(config.inboxes)) {
    const state = await context.core.states.get(inbox.id);
    views.push({
      alias,
      id: inbox.id,
      email: inbox.email,
      tier: tierOf(inbox.grantedScopes) ?? inbox.tier,
      capabilities: [...capabilitiesOf(inbox.grantedScopes)],
      contacts: inbox.contacts,
      sendPolicy: effectiveSendPolicy(config, alias),
      sendPolicyInherited: inbox.sendPolicy === undefined,
      changePolicy: inbox.changePolicy ?? defaultChangePolicy(config),
      changePolicyInherited: inbox.changePolicy === undefined,
      client: inbox.client,
      identity: inbox.identity,
      createdAt: inbox.createdAt,
      lastRefreshOkAt: state.lastRefreshOkAt,
      lastUsedAt: state.lastUsedAt,
      health: health(state),
      lastError: state.lastError,
    });
  }
  return views.sort((a, b) => a.alias.localeCompare(b.alias));
}

export async function inboxShow(
  context: GmailContext,
  alias: string,
): Promise<InboxView & { grantedScopes: string[]; internalDomains: string[] }> {
  const { inbox } = await context.inbox(alias);
  const views = await inboxList(context);
  // By id: `inboxList` reads the config again, and a rename in between would pair this row with another's view.
  const view = views.find((candidate) => candidate.id === inbox.id);
  if (!view) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
  return { ...view, grantedScopes: inbox.grantedScopes, internalDomains: inbox.internalDomains };
}

export async function inboxRename(
  context: GmailContext,
  from: string,
  to: string,
): Promise<{ from: string; to: string; id: string }> {
  const { inbox } = await context.inbox(from);
  if (RESERVED_ALIASES.has(to)) {
    throw new CommsError('USAGE', `"${to}" is reserved: it means every inbox`, { hint: 'Choose another name.' });
  }
  requireNewInboxName(await context.config(), to, 'Choose another name.');
  await context.core.config.update((current) => {
    // By id, and the target checked again, under the lock: a rename is a write like any other, and the file may have
    // moved since it was read. In version 2 `renameEntry` also records the old name, for good.
    const now = findById(current, 'inbox', inbox.id);
    if (!now) throw new CommsError('NOT_FOUND', `no inbox called "${from}"`);
    requireNewInboxName(current, to, 'Choose another name.');
    return renameEntry(current, 'inbox', now.alias, to);
  });
  context.forgetTransports();
  await context.core.audit.append({
    inboxId: inbox.id,
    alias: to,
    operation: 'inbox.rename',
    outcome: 'ok',
    surface: context.surface,
    reason: `was ${from}`,
  });
  return { from, to, id: inbox.id };
}

const SEND_POLICIES: readonly SendPolicy[] = ['chat', 'confirm', 'never'];
const CHANGE_POLICIES: readonly ChangePolicy[] = ['chat', 'confirm'];

/** A send policy as somebody typed it, or the refusal naming the three there are. */
export function parseSendPolicy(value: string): SendPolicy {
  if ((SEND_POLICIES as readonly string[]).includes(value)) return value as SendPolicy;
  throw new CommsError('USAGE', `"${value}" is not a send policy`, { hint: 'Use chat, confirm or never.' });
}

/** A change policy as somebody typed it, or the refusal naming the two there are. */
export function parseChangePolicy(value: string): ChangePolicy {
  if ((CHANGE_POLICIES as readonly string[]).includes(value)) return value as ChangePolicy;
  throw new CommsError('USAGE', `"${value}" is not a change policy`, { hint: 'Use chat or confirm.' });
}

/** The policies a caller asked to set on a mailbox, as typed. Either, or both. */
export interface PolicyRequest {
  sendPolicy?: string | undefined;
  changePolicy?: string | undefined;
}

/** The same, checked. */
export interface InboxPolicies {
  sendPolicy?: SendPolicy | undefined;
  changePolicy?: ChangePolicy | undefined;
}

export interface InboxPolicyResult {
  alias: string;
  /** How sending from it is approved now, whether set on the mailbox or inherited. */
  sendPolicy: SendPolicy;
  /** …and before this call. */
  previous: SendPolicy;
  /** How a loosening of its settings is approved now, whether set on the mailbox or inherited. */
  changePolicy: ChangePolicy;
  /** …and before this call. */
  previousChangePolicy: ChangePolicy;
}

/**
 * The policies asked for, or the refusal: each has to be one of its values, and at least one has to be named.
 *
 * Checked before anything is read, so a word that is not a policy is refused the same way on both surfaces whatever
 * the mailbox — and before a change approval could be prepared for it.
 */
export function parsePolicies(request: PolicyRequest): InboxPolicies {
  const sendPolicy = request.sendPolicy === undefined ? undefined : parseSendPolicy(request.sendPolicy);
  const changePolicy = request.changePolicy === undefined ? undefined : parseChangePolicy(request.changePolicy);
  if (sendPolicy === undefined && changePolicy === undefined) {
    throw new CommsError('USAGE', 'name a policy to set: how sending is approved, how changes are approved, or both', {
      hint: 'At a terminal: --send chat|confirm|never, --change chat|confirm. Over MCP: sendPolicy, changePolicy.',
    });
  }
  return { ...(sendPolicy ? { sendPolicy } : {}), ...(changePolicy ? { changePolicy } : {}) };
}

/**
 * Setting how a mailbox's sends and changes are approved, as one change both surfaces run through core's flow.
 *
 * The plan is the mailbox as it would be with the policies set, so core's classifier — the one `ConfigStore.update`
 * enforces with — decides which direction is a loosening. Nothing here decides it a second time: tightening loosens
 * nothing and is applied at once, and a loosening is prepared for a person to approve and claimed on the next call.
 * The change policy governs itself, so moving a mailbox off `confirm` is approved under `confirm`, at a terminal.
 */
export function inboxPolicyChange(
  context: GmailContext,
  alias: string,
  request: PolicyRequest,
): GatedChange<InboxPolicyResult> {
  const wanted = parsePolicies(request);
  return {
    plan: (config) => {
      // By its name now: a former name is refused with the one it has, rather than measured against the default.
      const inbox = requireInbox(config, alias);
      const after = { ...config, inboxes: { ...config.inboxes, [alias]: { ...inbox, ...wanted } } };
      const parts = [
        ...(wanted.sendPolicy ? [`sends approved by ${wanted.sendPolicy}`] : []),
        ...(wanted.changePolicy ? [`changes to its settings approved by ${wanted.changePolicy}`] : []),
      ];
      return { inbox: alias, before: config, after, summary: `${alias}: ${parts.join('; ')}` };
    },
    apply: (consent) => inboxPolicy(context, alias, wanted, consent),
  };
}

/**
 * Sets how sending from one inbox, and loosening its settings, must be approved.
 *
 * Tightening is always allowed. A loosening is refused by the config store unless `consent` covers it — the consent a
 * claimed change approval yields (`inboxPolicyChange`). There is no second check here: the store is the one place a
 * loosening is let through or refused, whichever surface asked, and a caller that forgot to ask is refused there.
 */
export async function inboxPolicy(
  context: GmailContext,
  alias: string,
  wanted: InboxPolicies,
  consent?: LooseningConsent,
): Promise<InboxPolicyResult> {
  const { inbox } = await context.inbox(alias);
  let result: InboxPolicyResult | undefined;
  await context.core.config.update(
    (current) => {
      const now = findById(current, 'inbox', inbox.id);
      if (!now) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
      // Measured under the lock, against the policies as they are now, so what is reported as `previous` is what
      // this write replaced rather than what a read a moment earlier saw.
      const next = { ...now.inbox, ...wanted };
      result = {
        alias: now.alias,
        sendPolicy: next.sendPolicy ?? current.defaults.sendPolicy,
        previous: now.inbox.sendPolicy ?? current.defaults.sendPolicy,
        changePolicy: next.changePolicy ?? defaultChangePolicy(current),
        previousChangePolicy: now.inbox.changePolicy ?? defaultChangePolicy(current),
      };
      return { ...current, inboxes: { ...current.inboxes, [now.alias]: next } };
    },
    consent ? { consent } : {},
  );
  if (!result) throw new CommsError('UNEXPECTED', 'the policy was written without being measured');
  await context.core.audit.append({
    inboxId: inbox.id,
    alias: result.alias,
    operation: 'inbox.policy',
    outcome: 'ok',
    surface: context.surface,
    reason: [
      ...(wanted.sendPolicy ? [`send ${result.previous} → ${result.sendPolicy}`] : []),
      ...(wanted.changePolicy ? [`change ${result.previousChangePolicy} → ${result.changePolicy}`] : []),
    ].join('; '),
  });
  return result;
}

export interface InboxRemoveResult {
  alias: string;
  id: string;
  email: string;
  revoked: boolean;
  /** Set when the stored token could not be deleted. */
  orphanedSecret?: string | undefined;
  /** Whether that token was recorded for `doctor` to report. Recording can fail too, and then nothing will list it. */
  orphanRecorded?: boolean | undefined;
}

/**
 * Removing a mailbox, as one change both surfaces run through core's flow.
 *
 * It loosens no setting, so what makes it need approval is its effects: a mailbox removed takes its token with it,
 * and connecting it again means Google's consent screen again. The effects name the mailbox by address, so the
 * person reads which account goes rather than a name that may mean something else to them.
 *
 * The approval binds the mailbox by id (core's target), and so does the removal: `apply` passes the id the plan saw,
 * and `inboxRemove` refuses if the name has come to mean another mailbox in between.
 */
export function inboxRemoveChange(
  context: GmailContext,
  alias: string,
  options: { revoke?: boolean | undefined } = {},
): GatedChange<InboxRemoveResult> {
  let planned: string | undefined;
  return {
    plan: (config) => {
      const inbox = requireInbox(config, alias);
      planned = inbox.id;
      const { [alias]: _removed, ...inboxes } = config.inboxes;
      const after = { ...config, inboxes };
      return {
        inbox: alias,
        before: config,
        after,
        summary: `Remove the mailbox ${alias}`,
        effects: [
          `disconnects ${alias} (${inbox.email}) and deletes its token from this machine; connecting it again means signing in to Google again`,
          ...(options.revoke
            ? [
                'asks Google to revoke that token, which can end the grant for every other tool signed in through the same client',
              ]
            : []),
        ],
      };
    },
    apply: () => inboxRemove(context, alias, { revoke: options.revoke === true, expectedId: planned }),
  };
}

/**
 * Disconnects an inbox. The registry row goes first, so a server that is mid-call stops serving it immediately; the
 * token is deleted afterwards. Revocation is opt-in, because revoking one token can invalidate the whole
 * account-and-client grant, including other tools that share it.
 *
 * `expectedId` is the mailbox an approval was given for. A name is only a label, so between that approval and this
 * call it can come to mean another mailbox — removed and connected again under the same name — and that one is not
 * the one the person agreed to remove.
 */
export async function inboxRemove(
  context: GmailContext,
  alias: string,
  options: { revoke?: boolean; expectedId?: string | undefined } = {},
): Promise<InboxRemoveResult> {
  const { inbox: named } = await context.inbox(alias);
  if (options.expectedId !== undefined && named.id !== options.expectedId) {
    throw new CommsError('CONFIG', `"${alias}" is no longer the mailbox this removal was approved for`, {
      hint: 'Nothing was removed. Prepare the removal again, and read the preview before approving it.',
      details: { alias, expectedId: options.expectedId, id: named.id },
    });
  }

  /*
   * Under the credentials lock, from the read to the secret deletion.
   *
   * This read a name, deleted `inboxes[name]` by key and then deleted the secret, holding no credentials lock. A
   * migration renaming every key in between left the deletion removing nothing and the secret deleted from under an
   * account that stayed configured; `secrets migrate` could interleave the same way. Held, neither can land in
   * between, and the row is found by its immutable id rather than by the name the command was given.
   */
  const removed = await withCredentialsLock(context.core.paths.configDir, async () => {
    const found = findById(await context.config(), 'inbox', named.id);
    if (!found) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
    const { inbox } = found;
    const secrets = await context.core.secrets();
    const refreshToken = options.revoke ? await secrets.get(inbox.secretRef) : null;

    try {
      await context.core.config.update((current) => {
        const now = findById(current, 'inbox', inbox.id);
        if (!now) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
        const inboxes = { ...current.inboxes };
        delete inboxes[now.alias];
        return { ...current, inboxes };
      });
    } catch (error) {
      /*
       * The row goes first and the secret second — the other order leaves a configured account with no credential.
       * But a rejected write may have committed (see `writeOutcome`), and skipping the deletion then strands a live
       * token that nothing records. So: look. Row gone, the write is in — carry on. Row still there, nothing was
       * written — say so. Unreadable — keep the token, and record it as unconfirmed, because `doctor` must not advise
       * deleting a credential whose mailbox may still be connected.
       */
      const gone = await writeOutcome(async () => findById(await context.config(), 'inbox', inbox.id) === null);
      if (gone === 'absent') throw error;
      if (gone === 'unknown') {
        await recordOrphan(context, { secretRef: inbox.secretRef, alias: found.alias, inboxId: inbox.id }, error, true);
        throw keepAndReport(error, inbox.secretRef, 'Run `agent-gmail inbox list`.');
      }
    }
    context.forgetTransports();

    let orphanedSecret: string | undefined;
    let orphanRecorded: boolean | undefined;
    try {
      await secrets.delete(inbox.secretRef);
    } catch (error) {
      // The row is already gone, so the inbox is disconnected either way; but a token still sitting in the keychain
      // is worth saying out loud rather than forgetting, so `doctor` can report it and the user can remove it.
      orphanedSecret = inbox.secretRef;
      orphanRecorded = await recordOrphan(
        context,
        { secretRef: inbox.secretRef, alias: found.alias, inboxId: inbox.id },
        error,
        false,
      );
    }
    return { name: found.alias, inbox, refreshToken, orphanedSecret, orphanRecorded };
  });

  // Revocation is a call to Google, so it runs after the lock is released: nothing should wait on a network round
  // trip to touch stored credentials. The token was read under the lock; the row is gone whatever this does.
  let revoked = false;
  if (options.revoke && removed.refreshToken) {
    try {
      await revokeToken(context.endpoints, removed.refreshToken);
      revoked = true;
    } catch {
      // Revocation is best effort: the row is already gone, and the user is told to check their Google account.
    }
  }

  await context.core.states.update(removed.inbox.id, { lastError: undefined });
  await context.core.audit.append({
    inboxId: removed.inbox.id,
    alias: removed.name,
    operation: 'inbox.remove',
    outcome: 'ok',
    surface: context.surface,
    reason: `${revoked ? 'token revoked' : 'token not revoked'}; ${
      removed.orphanedSecret ? `local token could not be deleted (${removed.orphanedSecret})` : 'local token deleted'
    }`,
  });
  return {
    alias: removed.name,
    id: removed.inbox.id,
    email: removed.inbox.email,
    revoked,
    orphanedSecret: removed.orphanedSecret,
    orphanRecorded: removed.orphanRecorded,
  };
}

/**
 * One line in the orphaned-secrets file `doctor` reads.
 *
 * `unconfirmed` marks a token kept because nobody could tell whether its mailbox was removed. `doctor` re-checks every
 * line against the config anyway, and only advises deleting a reference nothing still holds.
 */
async function recordOrphan(
  context: GmailContext,
  entry: { secretRef: string; alias: string; inboxId: string },
  error: unknown,
  unconfirmed: boolean,
): Promise<boolean> {
  try {
    await appendPrivateLine(
      orphanedSecretsPath(context),
      JSON.stringify({
        at: context.now().toISOString(),
        ...entry,
        ...(unconfirmed ? { unconfirmed: true } : {}),
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function orphanedSecretsPath(context: GmailContext): string {
  return join(context.core.paths.stateDir, 'orphaned-secrets.jsonl');
}

export interface WhoamiResult {
  alias: string;
  email: string;
  /** What Gmail says, which is the authority when it differs from the stored address. */
  profileEmail: string;
  matches: boolean;
  tier: string;
  capabilities: Capability[];
  sendPolicy: SendPolicy;
  messagesTotal: number;
  threadsTotal: number;
}

export async function whoami(context: GmailContext, alias: string): Promise<WhoamiResult> {
  const config = await context.config();
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  const profile = await transport.getProfile();
  await context.core.states.update(resolved.inbox.id, { lastUsedAt: context.now().toISOString() });
  return {
    alias,
    email: resolved.inbox.email,
    profileEmail: profile.emailAddress,
    matches: profile.emailAddress.toLowerCase() === resolved.inbox.email.toLowerCase(),
    tier: tierOf(resolved.inbox.grantedScopes) ?? resolved.inbox.tier,
    capabilities: [...capabilitiesOf(resolved.inbox.grantedScopes)],
    sendPolicy: effectiveSendPolicy(config, alias),
    messagesTotal: profile.messagesTotal,
    threadsTotal: profile.threadsTotal,
  };
}
