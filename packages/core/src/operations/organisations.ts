import { asLegacy, asV2, kindOf, stateOf } from '../approval-stored.ts';
import type { GatedChange } from '../change-flow.ts';
import { type ChangeRequest, type ChangeSurface, revokeChange } from '../changes.ts';
import { inlineCommand } from '../cli-runtime.ts';
import {
  type ClientConfig,
  type Config,
  committedSecretsStore,
  hasNames,
  type LooseningConsent,
  namingOf,
  type OrganisationGeneration,
  type OrganisationRecord,
  parseConfig,
  type StoreKind,
} from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError, toCommsError } from '../errors.ts';
import {
  type CliHandoffs,
  type Handoff,
  handoffSentence,
  handoffSentenceToFill,
  isCommand,
  requireHandoffs,
} from '../handoffs.ts';
import { withCredentialsLock } from '../lock.ts';
import { organisationProblem } from '../name-grammar.ts';
import { chooseSecretStore, clientSecretRef, gmailClientRow, writeSecretWithRestore } from '../oauth-client-records.ts';
import {
  accountsOfOrganisation,
  activeGeneration,
  type GenerationState,
  generationState,
  mailboxesOn,
  type OrganisationDrift,
  organisationDrift,
  organisationsOf,
  own,
  type ProfileFile,
  pathDigest,
  profileSourcePath,
  readProfileFile,
  recordOf,
  resolveGmailGeneration,
  servesText,
  shownPath,
  shownText,
  slackRecordFrom,
  strayMarkedRows,
  unmanagedSlackAccounts,
  withEach,
} from '../organisations.ts';
import { writeOutcome } from '../reconcile.ts';
import type { KeyringModule, SecretStore } from '../secrets.ts';

/**
 * `agentcomms org add | list | show | update | remove` and `comms_org_add`, `comms_orgs_list`, `comms_org_show`,
 * `comms_org_update`, `comms_org_remove` — one operation each, both surfaces (design 2026-10-02 §D5, §D8, §D9).
 *
 * Adding, updating and removing a profile are changes through the one change flow (`gatedChange`): the first call
 * returns a preview whose effects are deterministic lines derived from the normalised profile — every value a person
 * should check, and never the client secret ("client secret: included", "secret changed") — and the call that brings
 * the approval back plans again from the file read again, so a profile that changed in between is another change and
 * refused. What applies is one transaction under the credentials lock: at most one secret, written by the
 * snapshot-and-restore procedure (`writeSecretWithRestore`), and one configuration update holding the client rows and
 * the `organisations` record, made only if nothing it was planned from moved meanwhile.
 *
 * An update that only repairs drift — bringing the configuration back to what was already approved — applies at once
 * and asks nobody, as does turning `--for-other-addresses` off; any change to the profile's contents, a new source, or
 * turning it on is approved first (§D8).
 */

export interface OrgOptions {
  env: NodeJS.ProcessEnv;
  /** The shell every command in a result or refusal is quoted for. */
  platform: NodeJS.Platform;
  surface: ChangeSurface;
  /** Where a relative path is resolved from: the working directory of the command, by default. */
  cwd?: string | undefined;
  /** For a test: the keychain module probed when the keychain is chosen, so a test never touches the real one. */
  keyring?: KeyringModule | null | undefined;
  now?: (() => Date) | undefined;
}

export interface OrgAddRequest {
  /** The profile file, as typed: absolute, relative to the working directory, or from `~`. */
  file: string;
  /**
   * The exact file a delegating channel already classified. Internal to that delegation: it prevents a path or
   * symlink swap from making the channel validate one profile and this operation plan another.
   */
  loadedProfile?: ProfileFile | undefined;
  /** Let the organisation's client serve the member's addresses outside it too (§D6). Off unless asked. */
  forOtherAddresses?: boolean | undefined;
  /** The client row to adopt when this profile's client id is registered here more than once. */
  adopt?: string | undefined;
  /** Where secrets go, the first time any is stored: `keychain` or `file`. */
  store?: string | undefined;
  /** The approval this call claims, when it claims one: read only to say so plainly when the profile changed since. */
  approvalId?: string | undefined;
}

export interface OrgUpdateRequest {
  organisation: string;
  /** Read the profile from this file from now on. */
  source?: string | undefined;
  forOtherAddresses?: string | undefined;
  adopt?: string | undefined;
  store?: string | undefined;
  approvalId?: string | undefined;
}

export interface OrgRemoveRequest {
  organisation: string;
}

export interface GenerationView {
  name: string;
  clientId: string;
  projectId: string | null;
  ownership: 'owned' | 'adopted';
  serves: string;
  addedAt: string;
  active: boolean;
  state: GenerationState;
  mailboxes: string[];
}

/** One profile as `org list`, `org show` and every change's result show it: never its secret, never its bytes. */
export interface OrganisationView {
  organisation: string;
  label: string;
  source: { kind: string; path: string };
  sha256: string;
  readAt: string;
  addedAt: string;
  forOtherAddresses: boolean;
  /** False while `forOtherAddresses` is on with no active generation: it routes nothing until there is one. */
  routesOtherAddresses: boolean;
  gmail: { active: string | null; generations: GenerationView[] } | null;
  slack: {
    workspace: string;
    workspaceName: string;
    redirectPort: number;
    apps: { read: SlackAppView | null; send: SlackAppView | null; agent: AgentAppView | null };
  } | null;
  /** Accounts connected through this organisation's apps. */
  accounts: string[];
  drift: OrganisationDrift[];
  notes: string[];
}

export interface SlackAppView {
  clientId: string;
  appId: string | null;
}

/** The organisation's agent app, by its id: members paste its bot token with Slack's `workspace bot` (CUE-493). */
export interface AgentAppView {
  appId: string;
}

export interface OrgChangeResult {
  organisation: string;
  /** False when nothing needed writing. */
  changed: boolean;
  /** What was done, one line each: what changed, what was repaired. */
  applied: string[];
  /** What was found and not changed: earlier clients that cannot be rebuilt, clients that are the person's own. */
  reported: string[];
  gmail: { action: GmailAction | null; client: string | null };
  /** The store a client secret was written to, when one was. */
  store: StoreKind | null;
  profile: OrganisationView;
}

export interface OrgRemoveResult {
  organisation: string;
  /** The client rows the profile made, removed with their secrets. */
  removed: string[];
  /** Rows left as they are: adopted ones, and ones no longer marked as the profile's. */
  kept: string[];
  /** Secrets that could not be deleted from the store, by reference: delete them by hand. */
  secretsLeft: string[];
}

type GmailAction = 'created' | 'adopted' | 'reactivated' | 'kept' | 'removed';

/** The two stores there are, from a word somebody typed. */
function storeWord(value: string | undefined): StoreKind | undefined {
  if (value === undefined) return undefined;
  if (value === 'keychain' || value === 'file') return value;
  throw new CommsError('USAGE', `"${shownText(value, 40)}" is not a secret store`, { hint: 'One of: keychain, file.' });
}

function onOff(value: string | undefined): 'on' | 'off' | undefined {
  if (value === undefined) return undefined;
  if (value === 'on' || value === 'off') return value;
  throw new CommsError('USAGE', '--for-other-addresses takes on or off', {
    hint: '`on` lets this organisation’s client serve your addresses outside it too, and is approved first; `off` applies at once.',
  });
}

/** An organisation word a person typed to find a record — held to the grammar, whatever its length. */
function organisationArgument(value: unknown): string {
  const word = typeof value === 'string' ? value : '';
  const problem = organisationProblem(word);
  if (problem !== null) throw new CommsError('USAGE', shownText(problem, 200));
  return word;
}

function requireRecord(config: Config, organisation: string, handoffs: CliHandoffs): OrganisationRecord {
  const record = recordOf(config, organisation);
  if (!record) {
    const known = Object.keys(organisationsOf(config));
    throw new CommsError('NOT_FOUND', `no organisation profile called "${organisation}" has been added here`, {
      hint:
        known.length > 0
          ? `Added here: ${known.join(', ')}.`
          : handoffSentence(
              handoffs.core(['org', 'add', '--help'], { uses: [] }),
              (command) => `Add one with ${command}.`,
              {
                instead: 'Add one with comms_org_add from a chat.',
              },
            ),
    });
  }
  return record;
}

/**
 * The commands an organisation's operation names: core's own, located from whatever is printing (CUE-403), and —
 * read only when a line needs one — Gmail's and Slack's, found among the servers registered with this machine's MCP
 * clients. Reading the registrations costs a scan of every client's configuration, so it is put off until a line names
 * another product, and done once.
 */
interface OrgHandoffs {
  readonly handoffs: CliHandoffs;
  /** The same handoffs, able to find another product's command. */
  crossProduct(): Promise<CliHandoffs>;
}

/**
 * How to put things right once the store can be written to, as the clause that ends the secret writer's sentence:
 * `org update`, located — or the tool, with why there is no command in brackets after it.
 */
function restoreClause(update: Handoff): string {
  return isCommand(update)
    ? `run ${inlineCommand(update)} once the store can be written to.`
    : `call comms_org_update from a chat once the store can be written to (${update.message.replace(/\.$/, '')}).`;
}

/** Slack's command with these words, for each account: found among the servers registered here. */
async function slackFor(
  commands: OrgHandoffs,
  accounts: readonly string[],
  words: readonly string[],
): Promise<Handoff[]> {
  const handoffs = await commands.crossProduct();
  return accounts.map((name) => handoffs.of('slack', [...words, name]));
}

function orgHandoffs(core: Core, platform: NodeJS.Platform): OrgHandoffs {
  const handoffs = requireHandoffs(core, platform);
  let registered: Promise<CliHandoffs> | undefined;
  return {
    handoffs,
    crossProduct: () => {
      registered ??= handoffs.registered();
      return registered;
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Everything a profile's change is planned from, in one string: which store holds secrets, every client row, every
 * organisation's record, each account's workspace and provenance, and which client each mailbox uses.
 *
 * Compared under the credentials lock with what it was when the change was planned, and again inside the config
 * store's own lock: a client registered, a mailbox connected, another profile added in between is a different
 * configuration, and the change made from the old one is refused rather than written over it.
 */
function inputsOf(config: Config): string {
  return canonical({
    // How it names its accounts, not its version: the version-3 conversion renames nothing a profile plans from.
    naming: namingOf(config),
    store: committedSecretsStore(config),
    clients: config.clients,
    organisations: organisationsOf(config),
    accounts: Object.fromEntries(
      Object.entries(config.accounts).map(([name, account]) => [
        name,
        {
          platform: account.platform,
          workspace: account.workspace,
          organisation: (account as { organisation?: unknown }).organisation ?? null,
        },
      ]),
    ),
    mailboxes: Object.fromEntries(Object.entries(config.inboxes).map(([name, inbox]) => [name, inbox.client])),
  });
}

function changedWhileRunning(): CommsError {
  return new CommsError('TRANSIENT', 'the configuration changed while this ran, so nothing was changed', {
    hint: 'Run it again to see the change as things stand now.',
  });
}

/**
 * The one line a preview names a profile's source by: the path as it is shown, the SHA-256 of the path as it is read,
 * and the SHA-256 of the bytes that were read. An approval binds the line, so it binds the exact path and the exact
 * bytes; the path's display is escaped for the person, and the digest beside it is what escaping cannot blur.
 */
function sourceLine(file: ProfileFile): string {
  return `reads it from ${shownPath(file.path)} (path SHA-256 ${pathDigest(file.path)}), profile SHA-256 ${file.sha256}`;
}

const PROFILE_SHA = /, profile SHA-256 ([0-9a-f]{64})$/;

/**
 * The plain refusal for a claim whose profile changed since it was approved (§D5): "prepare it again".
 *
 * The approval's own digest is what refuses it — the SHA-256 is one of its effect lines — but the refusal that digest
 * gives says only that "what it does outside the configuration is not what was approved". So before the claim, the
 * approval's source line is read, and a different SHA-256 is refused in words that say which thing changed, with the
 * approval revoked as the claim would have revoked it.
 */
async function refuseChangedProfile(
  core: Core,
  approvalId: string | undefined,
  file: ProfileFile,
  surface: ChangeSurface,
): Promise<void> {
  if (approvalId === undefined) return;
  // A version-2 change, or one an earlier release prepared (read from what it stored), still waiting to be used.
  const stored = await core.approvals.get(approvalId).catch(() => null);
  const record = kindOf(stored) === 'change' ? (asV2(stored) ?? asLegacy(stored)) : null;
  if (stored === null || record === null) return;
  const state = stateOf(stored);
  if (state !== 'pending' && state !== 'approved') return;
  const line = record.change?.effects.find(
    (effect) => effect.startsWith('reads it from ') && effect.includes(`(path SHA-256 ${pathDigest(file.path)})`),
  );
  const approved = line === undefined ? undefined : PROFILE_SHA.exec(line)?.[1];
  if (approved === undefined || approved === file.sha256) return;
  const reason = 'the profile changed since it was approved';
  await revokeChange(core, approvalId, reason, { surface, disposition: 'integrity' }).catch(() => undefined);
  throw new CommsError('APPROVAL_VOID', `nothing was changed: ${reason}; prepare it again`, {
    hint: 'Run the same command without the approval to see the profile as it is now, and show the new preview.',
    details: { approvalId },
  });
}

// ── Planning a profile into the configuration ────────────────────────────────────────────────────────────────────

interface PlanInput {
  mode: 'add' | 'update';
  organisation: string;
  file: ProfileFile;
  sourceGiven: boolean;
  forOtherAddresses: 'on' | 'off' | undefined;
  adopt: string | undefined;
  now: string;
  /** The commands its lines and refusals name. */
  commands: OrgHandoffs;
  /** The secret held under a reference now, in the store the configuration uses; null when none is stored. */
  readSecret: (ref: string) => Promise<string | null>;
}

interface ProfilePlan {
  organisation: string;
  next: OrganisationRecord;
  /** Client rows written whole: an owned generation's row, made, rebuilt, or given its new project id. */
  rows: Record<string, ClientConfig>;
  /** Client rows whose `organisation` mark is cleared: they stay, as the person's own. */
  unmark: string[];
  /** The one owned client secret written, if any: always the active generation's. */
  secret: { name: string; ref: string } | null;
  /** What needs a person's approval, before → after. */
  changes: string[];
  /** What applies at once whatever else does: `--for-other-addresses off`. */
  immediate: string[];
  /** Drift brought back to what was approved. */
  repairs: string[];
  reports: string[];
  needsApproval: boolean;
  gmail: { action: GmailAction | null; client: string | null };
}

/**
 * What a re-marked row's line adds when its project id goes back to the generation's: nothing when the row already has
 * it. Marking a row again writes the recorded project too (see the unmarked repairs in `planProfile`), and a repair the
 * line does not name is one the person was not told about.
 */
function projectPutBack(row: ClientConfig, generation: Pick<OrganisationGeneration, 'projectId'>): string {
  if ((row.projectId ?? null) === (generation.projectId ?? null)) return '';
  return `, and puts back its Google Cloud project, ${recorded(generation.projectId)} (the row had ${recorded(row.projectId)})`;
}

/**
 * A value read back from the configuration, as a line shows it: neutralised and on one line, or `none`.
 *
 * Only the profile itself passes the strict grammar. A client row's project id is whatever the client file said —
 * `client add` takes any `project_id` string, line breaks and chat-template tokens included — and the record is a file
 * an older release or a hand can write. So anything a line takes from either, rather than from the profile just read,
 * is shown as every other untrusted string is.
 */
function recorded(value: string | undefined): string {
  return value === undefined ? 'none' : shownText(value, 120);
}

/** A generation as a preview names it: `332…googleusercontent.com ("rgc-1")`. */
function named(generation: Pick<OrganisationGeneration, 'name' | 'clientId'>): string {
  return `${recorded(generation.clientId)} ("${generation.name}")`;
}

function sameServes(a: OrganisationGeneration['serves'], b: OrganisationGeneration['serves']): boolean {
  return canonical(a) === canonical(b);
}

/**
 * The profile, planned into this configuration: the record it leaves, the rows it writes and unmarks, the one secret it
 * writes, and every line a person reads about it. Pure but for reading the secret store, so the plan made for a
 * preview and the plan made for its claim are the same plan whenever nothing moved.
 */
async function planProfile(config: Config, input: PlanInput): Promise<ProfilePlan> {
  const { file, now } = input;
  const { profile } = file;
  const { handoffs } = input.commands;
  if (!hasNames(config)) {
    throw new CommsError('CONFIG', 'an organisation profile needs the configuration’s organisation/platform names', {
      hint: handoffSentence(
        handoffs.core(['names', 'migrate']),
        (command) => `Run ${command} (comms_names_migrate from a chat) first, then add the profile again.`,
        { instead: 'Call comms_names_migrate from a chat first, then add the profile again.' },
      ),
    });
  }
  const organisation = input.organisation;
  const displayedPath = shownPath(file.path);
  const commandPath = displayedPath === file.path ? file.path : null;
  const previous =
    input.mode === 'update' ? requireRecord(config, organisation, handoffs) : recordOf(config, organisation);
  if (input.mode === 'add' && previous) {
    throw new CommsError('CONFIG', `the organisation profile "${organisation}" has already been added here`, {
      hint:
        commandPath === null
          ? handoffSentence(
              handoffs.core(['org', 'update', organisation]),
              (command) =>
                `To read it again, run ${command}; the source file shown here is ${displayedPath}. Its path is not repeated in a command because it contains text this output neutralises.`,
              {
                instead: `To read it again, call comms_org_update from a chat; the source file shown here is ${displayedPath}.`,
              },
            )
          : // The file as `--source` of a whole command, never `--source <file>` on its own: an option is not a command.
            handoffSentence(
              handoffs.core(['org', 'update', organisation]),
              (again) =>
                handoffSentence(
                  handoffs.core(['org', 'update', organisation, '--source', commandPath]),
                  (fromFile) =>
                    `To read it again, run ${again}; to read it from this file from now on, run ${fromFile}.`,
                ),
              { instead: 'To read it again, call comms_org_update from a chat, with this file as its source.' },
            ),
    });
  }
  if (profile.organisation !== organisation) {
    throw new CommsError(
      'CONFIG',
      `this profile is for the organisation "${profile.organisation}", not "${organisation}"`,
      {
        hint:
          commandPath === null
            ? `It is a different profile. Its file shown here is ${displayedPath}. Its path is not repeated in a command because it contains text this output neutralises.`
            : handoffSentence(
                handoffs.core(['org', 'add', commandPath]),
                (command) => `It is a different profile: add it with ${command}.`,
                { instead: 'It is a different profile: add it with comms_org_add from a chat.' },
              ),
      },
    );
  }

  const changes: string[] = [];
  const immediate: string[] = [];
  const repairs: string[] = [];
  const reports: string[] = [];
  const rows: Record<string, ClientConfig> = {};
  const unmark = new Set<string>();
  let secret: ProfilePlan['secret'] = null;
  const generations: OrganisationGeneration[] = structuredClone(previous?.gmail?.generations ?? []);
  const before = activeGeneration(previous);
  let active: string | null = previous?.gmail?.active ?? null;
  let gmail: ProfilePlan['gmail'] = { action: null, client: null };
  const shaChanged = previous === undefined || previous.sha256 !== file.sha256;

  // ── Gmail: which generation the profile's client is, and what its row needs ──
  const pg = profile.gmail;
  if (!pg && input.adopt !== undefined) {
    throw new CommsError('USAGE', '--adopt does not apply: this profile names no Google client', {
      hint: 'Leave out --adopt.',
    });
  }
  if (!pg) {
    if (before) {
      changes.push(
        `Google client: ${named(before)} → none: new mailboxes no longer get it, and mailboxes already on it keep working`,
      );
      gmail = { action: 'removed', client: null };
    }
    active = null;
  } else {
    const resolution = resolveGmailGeneration(config, organisation, pg.clientId, { adopt: input.adopt });
    let target: OrganisationGeneration;
    if (resolution.kind === 'reactivate') {
      target = generations.find(
        (generation) => generation.name === resolution.generation.name,
      ) as OrganisationGeneration;
      if (before?.name === target.name) gmail = { action: 'kept', client: target.name };
      else {
        gmail = { action: 'reactivated', client: target.name };
        changes.push(
          `Google client: ${before ? named(before) : 'none'} → ${named(target)}, an earlier client of ${organisation}, made active again (Google Cloud project ${pg.projectId ?? 'none named'}), for ${servesText(pg.serves)}`,
        );
      }
    } else {
      const fresh = (name: string, ownership: 'owned' | 'adopted'): OrganisationGeneration => ({
        name,
        clientId: pg.clientId,
        ...(pg.projectId === undefined ? {} : { projectId: pg.projectId }),
        ownership,
        serves: structuredClone(pg.serves),
        addedAt: now,
      });
      const name = resolution.kind === 'adopt' ? resolution.client : resolution.name;
      target = fresh(name, resolution.kind === 'adopt' ? 'adopted' : 'owned');
      // A name an earlier generation of this organisation used is taken over, not listed twice: only an adopted row
      // the person replaced and is now adopted again can arrive here.
      const stale = generations.findIndex((generation) => generation.name === name);
      if (stale === -1) generations.push(target);
      else generations[stale] = target;
      gmail = { action: resolution.kind === 'adopt' ? 'adopted' : 'created', client: name };
      /*
       * The name it gets, or the client it uses — what the person checks. An add has named the client on the line
       * before; an update says what it moves from.
       */
      const adopted = `the OAuth client "${name}", already registered here with that client id: its row and its secret are left as they are`;
      if (input.mode === 'add') {
        changes.push(
          resolution.kind === 'adopt'
            ? `uses ${adopted}`
            : `registers the Google client as the OAuth client "${name}", owned by this profile`,
        );
      } else {
        // The same bytes with the active client no longer usable: finding or registering it again is a repair (§D8),
        // which the rule below makes it.
        const project = pg.projectId ? ` (Google Cloud project ${pg.projectId})` : '';
        changes.push(
          `Google client: ${before ? named(before) : 'none'} → ${pg.clientId}${project}, for ${servesText(pg.serves)}, ${
            resolution.kind === 'adopt'
              ? adopted
              : `registered as the OAuth client "${name}", owned by this profile; client secret: included`
          }`,
        );
      }
    }
    if (resolution.kind === 'reactivate') {
      /*
       * The profile's metadata applies to the generation it selects, whatever that generation's history: the active
       * one, or an earlier one made active again (A → B → A, or Gmail removed and re-added). A reactivated generation
       * still holds the `serves` and project it had when it was last active, and routing new mailboxes by those would
       * route them by a statement the organisation has since withdrawn. Each difference is a line of its own, before
       * → after, so the person approves the values that will be used.
       */
      if (!sameServes(target.serves, pg.serves)) {
        changes.push(`who "${target.name}" serves: ${servesText(target.serves)} → ${servesText(pg.serves)}`);
        target.serves = structuredClone(pg.serves);
      }
      if ((target.projectId ?? null) !== (pg.projectId ?? null)) {
        changes.push(
          `Google Cloud project of "${target.name}": ${recorded(target.projectId)} → ${pg.projectId ?? 'none'}`,
        );
        if (pg.projectId === undefined) delete target.projectId;
        else target.projectId = pg.projectId;
        if (target.ownership === 'adopted') {
          reports.push(`"${target.name}" is a client you registered yourself, so its own project id is left as it is`);
        }
      }
    }
    if (target.ownership === 'owned') {
      /*
       * The active owned generation's row, as the profile says it should be. The resolver only reactivates an owned
       * generation whose name is free or holds this organisation's row of that client (`generationUsable`), and only
       * creates one under a free name, so the row here is missing, this organisation's, or about to be made.
       */
      const row = own(config.clients, target.name);
      const wanted = gmailClientRow({ ...target, addedAt: row?.addedAt ?? target.addedAt, organisation });
      const write = (repair?: string): void => {
        rows[target.name] = wanted;
        secret = { name: target.name, ref: clientSecretRef(target.name) };
        if (repair !== undefined) repairs.push(repair);
      };
      if (gmail.action === 'created') write();
      else if (!row) write(`recreates "${target.name}" from the profile: its client row had gone`);
      else if (row.organisation === undefined && row.clientId === target.clientId) {
        // Unmarked (`generationState`): the same client, its mark dropped by an older release's `client add
        // --replace`. Marked again; the secret is then held to the profile's by the check below, as for any owned row.
        rows[target.name] = wanted;
        // Every repair is listed (§D8): the row is written with the generation's project, so a project the older
        // release's write left out or changed is put back — and the line says so, not only that the mark was.
        repairs.push(
          `marks "${target.name}" as ${organisation}'s again: an older release had dropped the mark${projectPutBack(row, target)}`,
        );
      } else if (row.provider !== 'gmail' || row.secretRef !== clientSecretRef(target.name)) {
        // Row (b): rebuilt by snapshot and restore, since a secret reference that is not the canonical one says
        // nothing about what the canonical reference holds now.
        write(`rewrites "${target.name}" from the profile: its row had been changed`);
      } else if ((row.projectId ?? null) !== (target.projectId ?? null)) {
        // The profile's new project id, carried to the row with it (§D8) — or a row whose project somebody changed,
        // which is row (b) again.
        // Measured against the selected generation as the record held it before this plan — the active one, or the
        // earlier one being made active again — since the line above already gave the generation the profile's value.
        const recorded = resolution.kind === 'reactivate' ? resolution.generation.projectId : undefined;
        const followsProfile = resolution.kind === 'reactivate' && (row.projectId ?? null) === (recorded ?? null);
        if (followsProfile) rows[target.name] = wanted;
        else write(`rewrites "${target.name}" from the profile: its project id had been changed`);
      }
      if (secret === null) {
        // The row is the profile's; is its secret? A new secret in the profile is a rotation (§D8), by snapshot and
        // restore under the same reference; one the store no longer holds is a repair.
        const stored = await input.readSecret(clientSecretRef(target.name));
        if (stored !== pg.clientSecret) {
          secret = { name: target.name, ref: clientSecretRef(target.name) };
          rows[target.name] = wanted;
          if (shaChanged && stored !== null) changes.push(`client secret of "${target.name}": secret changed`);
          else repairs.push(`writes the profile's client secret to "${target.name}" again: the store did not hold it`);
        }
      }
    } else if (shaChanged || gmail.action === 'reactivated' || gmail.action === 'adopted') {
      /*
       * An adopted client's secret is the person's, and no `org` command changes it (§D4) — but whenever a changed
       * profile selects one, or one becomes the client new mailboxes get, whether its secret is the profile's is said.
       * This was asked only of the generation already active, and only of a secret that was there: A → B → A made an
       * adopted client active again with a rotated secret, or none at all, and said nothing, so the first sign-in
       * through it was the first anybody heard. A secret that is not stored is a mismatch like any other.
       */
      const row = own(config.clients, target.name);
      const stored = row ? await input.readSecret(row.secretRef) : null;
      /*
       * Gmail's `client add`, whole, with the client file for the person to fill in — never its options on their own,
       * which are not a command. Found among the servers registered here; with none, the tool and why (CUE-403).
       */
      const fix = async () =>
        handoffSentenceToFill(
          (await input.commands.crossProduct()).of('gmail', ['client', 'add', '--name', target.name, '--replace']),
          ['<client-file>'],
          (command) => `to use the profile's, register it again from its Google client file with ${command}`,
          {
            instead:
              "to use the profile's, register it again from its Google client file with gmail_client_add from a chat.",
          },
        );
      if (stored === null) {
        reports.push(
          `"${target.name}", which you registered yourself, has no secret stored on this machine; ${await fix()}`,
        );
      } else if (stored !== pg.clientSecret) {
        reports.push(
          `the profile carries another secret for "${target.name}", which you registered yourself and which is left as it is; ${await fix()}`,
        );
      }
    }
    active = target.name;
  }

  // ── Every other generation, and marks nothing explains: rows (c), (d), (e) ──
  for (const generation of generations) {
    if (generation.name === active || Object.hasOwn(rows, generation.name)) continue;
    const state = generationState(config, organisation, generation);
    if (generation.ownership === 'owned' && state === 'unmarked') {
      /*
       * An earlier client's mark, dropped by an older release: marked again, and its secret left as the person's store
       * has it — the profile holds only the current client's secret.
       *
       * The project id goes back to the generation's too. `client add --replace` writes the row from whatever file it
       * was given, and one without `project_id` leaves none; marked again with that, the row would read as altered on
       * the next update (row (e)), lose its mark, read as unmarked on the one after, and so on for ever. The project is
       * the client's own, recorded on the generation, and putting it back touches nothing a sign-in uses.
       */
      const row = own(config.clients, generation.name) as ClientConfig;
      rows[generation.name] = {
        ...row,
        projectId: generation.projectId,
        organisation,
      } as ClientConfig;
      repairs.push(
        `marks "${generation.name}", an earlier client of ${organisation}, as ${organisation}'s again${projectPutBack(row, generation)}`,
      );
      continue;
    }
    if (generation.ownership === 'owned' && (state === 'replaced' || state === 'altered')) {
      unmark.add(generation.name);
      repairs.push(
        state === 'replaced'
          ? `"${generation.name}", an earlier client of ${organisation}, now holds another client, so it is no longer marked as ${organisation}'s: it stays, as a client of your own`
          : `"${generation.name}", an earlier client of ${organisation}, was changed, so it is no longer managed: it stays, as a client of your own`,
      );
    } else if (state !== 'ok') {
      const users = mailboxesOn(config, generation.name);
      const gmail = active !== null && users.length > 0 ? await input.commands.crossProduct() : null;
      const move =
        active !== null && gmail !== null
          ? `; move ${users.join(', ')} onto "${active}" ${withEach(
              users.map((mailbox) => gmail.of('gmail', ['inbox', 'reauth', mailbox, '--client', active])),
              'gmail_inbox_reauth',
            )}`
          : '';
      reports.push(
        generation.ownership === 'adopted'
          ? `"${generation.name}", which you registered and ${organisation} used, no longer holds the client ${recorded(generation.clientId)}${move}`
          : state === 'missing'
            ? `"${generation.name}", an earlier client of ${organisation}, has gone and cannot be rebuilt without its old client file${move}`
            : `the name "${generation.name}", an earlier client of ${organisation}, now holds a client that is not ${organisation}'s${move}`,
      );
    }
  }
  for (const name of strayMarkedRows(config, organisation)) {
    if (Object.hasOwn(rows, name)) continue;
    unmark.add(name);
    repairs.push(`"${name}" was marked as ${organisation}'s without being one of its clients, so the mark is cleared`);
  }

  // ── Slack ──
  const ps = profile.slack;
  const rs = previous?.slack;
  const provenance = accountsOfOrganisation(config, organisation);
  let slack: OrganisationRecord['slack'];
  let agentChange: string | null = null;
  let agentRepair: string | null = null;
  if (ps) {
    if (input.mode === 'add') {
      /*
       * Reported, not refused. Somebody who connected the organisation's workspace through an app of their own — every
       * early member did, before profiles existed — would otherwise have to disconnect Slack to add the profile at all,
       * which takes away the one thing they had working to gain nothing yet. The account is left exactly as it is: it
       * carries no provenance, so nothing here treats it as the profile's, and the profile's apps are for accounts
       * connected from it.
       */
      const unmanaged = unmanagedSlackAccounts(config, organisation, ps.workspace);
      if (unmanaged.length > 0) {
        reports.push(
          `${unmanaged.join(', ')} ${unmanaged.length === 1 ? 'is' : 'are'} connected to this workspace through an app of your own, and ${unmanaged.length === 1 ? 'stays' : 'stay'} as ${unmanaged.length === 1 ? 'it is' : 'they are'}: the profile's apps are for accounts connected from it`,
        );
      }
    }
    if (rs && rs.workspace !== ps.workspace && provenance.length > 0) {
      throw new CommsError(
        'CONFIG',
        `the profile moves to another Slack workspace, and ${provenance.join(', ')} ${provenance.length === 1 ? 'is' : 'are'} connected through its apps`,
        {
          hint: `Remove them ${withEach(
            await slackFor(input.commands, provenance, ['workspace', 'remove']),
            'slack_workspace_remove',
          )} first, then run the update again.`,
        },
      );
    }
    slack = { ...(rs ?? {}), ...slackRecordFrom(ps, rs) };
    // The agent app, from the file beside the profile (CUE-493): recorded beside the other two, never one of them.
    if (file.agentApp) slack.apps.agent = { appId: file.agentApp.appId, sha256: file.agentApp.sha256 };
    if (input.mode === 'update') {
      /*
       * Its own file and its own SHA-256, so its own judgement: another file — a new one, a changed one, one gone — is
       * a change of what the organisation says, and approved first, even with the profile's bytes unchanged; the same
       * file with the record saying otherwise is drift, put back at once. Said after the profile's own drift is
       * sorted below, which would otherwise count every line as a repair whenever the profile's bytes are the same.
       */
      const agentWas = rs?.apps.agent;
      const agentNow = file.agentApp;
      const appText = (app: { appId: string } | undefined) => (app ? `app id ${recorded(app.appId)}` : 'none');
      if ((agentWas?.sha256 ?? null) !== (agentNow?.sha256 ?? null)) {
        agentChange = `Slack agent app: ${appText(agentWas)} → ${appText(agentNow)}${
          agentNow
            ? `, read from ${shownPath(agentNow.path)} (path SHA-256 ${pathDigest(agentNow.path)}), agent app SHA-256 ${agentNow.sha256}`
            : ''
        }`;
      } else if (agentWas && agentNow && agentWas.appId !== agentNow.appId) {
        agentRepair = `the agent app recorded for ${organisation} was changed here, to ${recorded(agentWas.appId)}; it is ${agentNow.appId} again, as its file says`;
      }
      if (!rs) {
        changes.push(
          `Slack: none → workspace ${ps.workspace} (${shownText(ps.workspaceName, 80)}), signing in on port ${ps.redirectPort}`,
        );
      } else {
        if (rs.workspace !== ps.workspace) changes.push(`Slack workspace: ${recorded(rs.workspace)} → ${ps.workspace}`);
        if (rs.workspaceName !== ps.workspaceName) {
          changes.push(`Slack workspace name: ${shownText(rs.workspaceName, 80)} → ${shownText(ps.workspaceName, 80)}`);
        }
        if (rs.redirectPort !== ps.redirectPort)
          changes.push(`Slack sign-in port: ${rs.redirectPort} → ${ps.redirectPort}`);
      }
      for (const role of ['read', 'send'] as const) {
        const was = rs?.apps[role];
        const now = ps.apps[role];
        const appText = (app: { clientId: string; appId?: string | undefined } | undefined) =>
          app ? `client id ${recorded(app.clientId)}${app.appId ? `, app id ${recorded(app.appId)}` : ''}` : 'none';
        if (
          canonical(was ? { clientId: was.clientId, appId: was.appId } : null) ===
          canonical(now ? { clientId: now.clientId, appId: now.appId } : null)
        ) {
          continue;
        }
        if (was && now && was.clientId === now.clientId && now.appId === undefined) continue;
        changes.push(`Slack ${role} app: ${appText(was)} → ${appText(now)}`);
        const on = provenance.filter((name) => own(config.accounts, name)?.profileApp === role);
        const affected = on.filter((name) => {
          const account = own(config.accounts, name);
          if (!account || !now) return true;
          return account.oauthClientId !== now.clientId || (now.appId !== undefined && account.appId !== now.appId);
        });
        if (
          affected.length > 0 &&
          was &&
          (!now || now.clientId !== was.clientId || (now.appId !== undefined && now.appId !== was.appId))
        ) {
          const on = (words: readonly string[], tool: string) =>
            slackFor(input.commands, affected, words).then((handoffs) => withEach(handoffs, tool));
          reports.push(
            now
              ? `${affected.join(', ')} ${affected.length === 1 ? 'is' : 'are'} on the old ${role} app: sign ${affected.length === 1 ? 'it' : 'them'} in through the new one ${await on(['workspace', 'reauth'], 'slack_workspace_reauth')}`
              : `${affected.join(', ')} ${affected.length === 1 ? 'is' : 'are'} on the ${role} app the profile no longer lists: move to the other app ${await on(['workspace', 'mode'], 'slack_mode_set')}, or remove ${await on(['workspace', 'remove'], 'slack_workspace_remove')}`,
          );
        }
      }
    }
  } else if (rs) {
    changes.push('Slack: removed — accounts connected through its apps keep working, and are no longer listed');
    if (provenance.length > 0)
      reports.push(
        `${provenance.join(', ')} ${provenance.length === 1 ? 'was' : 'were'} connected through the profile's Slack apps, which it no longer lists`,
      );
  }

  // ── The rest of the record ──
  if (previous && previous.label !== profile.label) {
    changes.push(`label: ${shownText(previous.label, 64)} → ${shownText(profile.label, 64)}`);
  }
  let forOtherAddresses = previous?.forOtherAddresses ?? false;
  let turningOn = false;
  if (input.forOtherAddresses === 'on' && !forOtherAddresses) {
    turningOn = true;
    forOtherAddresses = true;
  } else if (input.forOtherAddresses === 'off' && forOtherAddresses) {
    forOtherAddresses = false;
    immediate.push('for other addresses: on → off');
  }
  if (forOtherAddresses && active === null) {
    if (turningOn) {
      throw new CommsError(
        'CONFIG',
        `${organisation}'s profile names no Google client, so it cannot serve other addresses`,
        {
          hint: 'Leave out --for-other-addresses, or ask the organisation for a profile that names its Google client.',
        },
      );
    }
    reports.push('for other addresses is on, but routes nothing until the profile names a Google client again');
  }
  if (input.mode === 'update' && !shaChanged && !input.sourceGiven) {
    /*
     * The same bytes from the same place: whatever differs between the profile and the record is drift — a record
     * edited by an older release or by hand — and bringing it back to the profile is bringing it back to what was
     * approved. A repair, then, applied at once (§D8), not a change asking again.
     */
    repairs.unshift(...changes.splice(0));
  }
  if (agentChange) changes.push(agentChange);
  if (agentRepair) repairs.push(agentRepair);
  if (turningOn && input.mode === 'update') {
    changes.push(`for other addresses: off → on — ${organisation}'s client may also serve your mailboxes outside it`);
  }
  if (input.mode === 'update') {
    if (input.sourceGiven)
      changes.push(`source: ${previous ? shownPath(previous.source.path) : 'none'} → ${shownPath(file.path)}`);
    if (shaChanged) changes.push(`profile SHA-256: ${previous?.sha256 ?? 'none'} → ${file.sha256}`);
  }

  const next: OrganisationRecord = {
    ...(previous ?? {}),
    label: profile.label,
    source: { kind: 'file', path: file.path },
    sha256: file.sha256,
    readAt: now,
    addedAt: previous?.addedAt ?? now,
    forOtherAddresses,
  };
  if (pg || generations.length > 0) next.gmail = { ...(previous?.gmail ?? {}), active, generations };
  else delete next.gmail;
  if (slack) next.slack = slack;
  else delete next.slack;

  return {
    organisation,
    next,
    rows,
    unmark: [...unmark].sort(),
    secret,
    changes,
    immediate,
    repairs,
    reports,
    needsApproval: input.mode === 'add' || input.sourceGiven || shaChanged || turningOn || agentChange !== null,
    gmail,
  };
}

/** The configuration with a plan made in it, and nothing else. */
function withPlan(config: Config, plan: ProfilePlan, store: StoreKind | null): Config {
  const next = structuredClone(config);
  if (!hasNames(next))
    throw new CommsError('UNEXPECTED', 'an organisation profile was planned into a version-1 configuration');
  next.organisations = { ...(next.organisations ?? {}), [plan.organisation]: structuredClone(plan.next) };
  for (const [name, row] of Object.entries(plan.rows)) next.clients[name] = structuredClone(row);
  for (const name of plan.unmark) {
    const row = own(next.clients, name);
    if (row) delete row.organisation;
  }
  if (plan.secret && store) next.secrets = { store };
  return next;
}

/** Whether nothing in the plan writes anything. */
function writesNothing(plan: ProfilePlan): boolean {
  return (
    plan.changes.length === 0 &&
    plan.immediate.length === 0 &&
    plan.repairs.length === 0 &&
    plan.unmark.length === 0 &&
    Object.keys(plan.rows).length === 0 &&
    plan.secret === null
  );
}

interface Planned {
  plan: ProfilePlan;
  file: ProfileFile;
  inputs: string;
  store: StoreKind | null;
  now: string;
  /** Whether this call turned `forOtherAddresses` off before planning: written already, and reported with the rest. */
  narrowed: boolean;
}

/**
 * The shared body of `org add` and `org update`: plan from the file read now, choose a store only when a secret will
 * be written, and apply under the credentials lock exactly what was planned — or nothing, when anything it was planned
 * from has moved.
 */
function profileChange(
  core: Core,
  options: OrgOptions,
  spec: {
    mode: 'add' | 'update';
    /** The organisation to update; for an add, the profile's own. */
    organisation?: string | undefined;
    path: (config: Config) => string;
    /** Exact bytes already loaded by a delegating surface; otherwise this operation reads `path` itself. */
    file?: ProfileFile | undefined;
    sourceGiven: boolean;
    forOtherAddresses: 'on' | 'off' | undefined;
    adopt: string | undefined;
    store: StoreKind | undefined;
    approvalId: string | undefined;
  },
): GatedChange<OrgChangeResult> {
  let planned: Planned | null = null;
  const commands = orgHandoffs(core, options.platform);
  /*
   * Whether this change turned `forOtherAddresses` off on an earlier call of its own — the call at a terminal that
   * prepared what it now claims. The claim plans from a record that is off already, and must still bind, and report,
   * what the preparation did.
   */
  let narrowedEarlier = false;
  /*
   * The store a planned secret goes to — chosen only when an owned secret will be written — and the refusal of a
   * `--store` with nothing to write. A store chosen for the first time is a setting the person sees, even on a repair.
   */
  const storeFor = async (config: Config, profilePlan: ProfilePlan): Promise<StoreKind | null> => {
    if (profilePlan.secret) {
      const chosen = await chooseSecretStore(config, spec.store, {
        keyring: options.keyring,
        handoffs: commands.handoffs,
      });
      if (chosen.choosing) profilePlan.needsApproval = true;
      return chosen.store;
    }
    if (spec.store !== undefined) {
      throw new CommsError('USAGE', '--store does not apply: this writes no client secret', {
        hint: 'A store is chosen only when a client secret is written here — never for a Slack-only profile, an adopted client, or an update that writes none. Leave out --store.',
      });
    }
    return null;
  };
  const plan = async (config: Config, file: ProfileFile, now: string): Promise<ProfilePlan> => {
    // Opened only when a stored secret is asked for: a plan that writes a new client reads nothing from the store.
    const committed = committedSecretsStore(config);
    return planProfile(config, {
      mode: spec.mode,
      organisation: spec.organisation ?? file.profile.organisation,
      file,
      sourceGiven: spec.sourceGiven,
      forOtherAddresses: spec.forOtherAddresses,
      adopt: spec.adopt,
      now,
      commands,
      readSecret: async (ref) => (committed === null ? null : (await core.secrets(committed)).get(ref)),
    });
  };
  return {
    plan: async (given): Promise<ChangeRequest> => {
      let config = given;
      /*
       * A narrowing applies at once, whatever else the call asks for and whatever becomes of it (§D8). So
       * `--for-other-addresses off` is written first, on its own, under the credentials lock — before the profile is
       * read, checked or planned, and before a secret store is chosen or opened. Done after them, an unreadable or
       * invalid profile, or a store that could not be opened, refused the call with the organisation's client still
       * serving the person's other addresses; done with the plan, it waited for whatever approval the rest needed.
       * The rest is then planned from what the narrowing left, and refused or approved as before.
       */
      let narrowedNow = false;
      if (spec.mode === 'update' && spec.forOtherAddresses === 'off' && spec.organisation !== undefined) {
        const outcome = await narrowAtOnce(core, options, spec.organisation);
        config = outcome.config;
        narrowedNow = outcome.changed;
      }
      /*
       * A narrowing done while an approval was prepared belongs to that approval's story: the preview says it was
       * done, and the result of the claim lists it, as every change is listed. The claim plans from a record already
       * off, so it learns of it from the preparation — this change's own earlier call at a terminal, or, from a chat
       * where each call builds the change afresh, the approval it claims, which carries the line.
       */
      const narrowedBefore =
        spec.mode === 'update' &&
        spec.forOtherAddresses === 'off' &&
        (narrowedEarlier || (await approvalRecordsNarrowing(core, spec.approvalId)));
      narrowedEarlier ||= narrowedNow;
      const narrowed = narrowedNow || narrowedBefore;
      const file = spec.file ?? (await readProfileFile(spec.path(config)));
      await refuseChangedProfile(core, spec.approvalId, file, options.surface);
      const now = (options.now?.() ?? new Date()).toISOString();
      const profilePlan = await plan(config, file, now);
      const store = await storeFor(config, profilePlan);
      planned = { plan: profilePlan, file, inputs: inputsOf(config), store, now, narrowed };
      const { organisation } = profilePlan;
      const label = shownText(file.profile.label, 64);
      const effects = profilePlan.needsApproval ? previewLines(spec.mode, profilePlan, file, store) : [];
      return {
        before: config,
        after: withPlan(config, profilePlan, store),
        summary:
          spec.mode === 'add'
            ? `Add the organisation profile "${organisation}" (${label}): its apps beside what you have`
            : `Update the organisation profile "${organisation}" (${label})${narrowed ? '; for other addresses was turned off at once' : ''}`,
        effects,
        ...(narrowed && profilePlan.needsApproval ? { doneAtOnce: [NARROWED_WHEN_PREPARED] } : {}),
      };
    },
    apply: async (consent) => {
      if (planned === null)
        throw new CommsError('UNEXPECTED', 'the organisation profile was applied before it was planned');
      return applyProfile(core, options, spec.mode, planned, consent, commands);
    },
  };
}

/**
 * What a narrowing done as the approval was prepared is recorded as, in the approval's `doneAtOnce` — not among its
 * effects, which are what approving does and can carry a profile's text. The claim, which plans from a record already
 * off, finds it there and lists it in its result.
 */
const NARROWED_WHEN_PREPARED = 'for other addresses: on → off';

/** Whether the approval being claimed was prepared by a call that narrowed: its `doneAtOnce` says so. */
async function approvalRecordsNarrowing(core: Core, approvalId: string | undefined): Promise<boolean> {
  if (approvalId === undefined) return false;
  // Only a valid version-2 change says what it did at once.
  const record = asV2(await core.approvals.get(approvalId).catch(() => null));
  return record?.kind === 'change' && record.change?.doneAtOnce?.includes(NARROWED_WHEN_PREPARED) === true;
}

/**
 * `--for-other-addresses off`, written on its own under the credentials lock: the configuration it leaves, which the
 * rest of the call is planned from, and whether it changed anything. Nothing else of the record moves; a record that is
 * off already, or none at all, is left alone, and what is refused about it is the rest of the call's to say.
 */
async function narrowAtOnce(
  core: Core,
  options: OrgOptions,
  organisation: string,
): Promise<{ config: Config; changed: boolean }> {
  return withCredentialsLock(core.paths.configDir, async () => {
    let changed = false;
    const written = await core.config.update((current) => {
      const record = recordOf(current, organisation);
      if (!hasNames(current) || !record?.forOtherAddresses) return current;
      changed = true;
      return {
        ...current,
        organisations: { ...organisationsOf(current), [organisation]: { ...record, forOtherAddresses: false } },
      };
    });
    if (changed) {
      await core.audit.append({
        inboxId: '',
        operation: 'org.update',
        outcome: 'ok',
        surface: options.surface,
        reason: `${organisation}: for other addresses off`,
      });
    }
    return { config: written, changed };
  });
}

/**
 * The preview's lines: deterministic, derived from the normalised profile and the plan, never the secret. An approval
 * binds them, so the claim's plan has to produce exactly these, or it is another change.
 */
function previewLines(mode: 'add' | 'update', plan: ProfilePlan, file: ProfileFile, store: StoreKind | null): string[] {
  const { profile } = file;
  const lines = [
    `${mode === 'add' ? 'adds' : 'updates'} the organisation profile "${plan.organisation}" (${shownText(profile.label, 64)})`,
    sourceLine(file),
  ];
  if (mode === 'add') {
    const pg = profile.gmail;
    if (pg) {
      lines.push(
        `Google client ${pg.clientId}${pg.projectId ? `, Google Cloud project ${pg.projectId}` : ', no project named'}, for ${servesText(pg.serves)}; client secret: included`,
      );
    } else lines.push('no Google client');
    const ps = profile.slack;
    if (ps) {
      lines.push(
        `Slack workspace ${ps.workspace} (${shownText(ps.workspaceName, 80)}), signing in on port ${ps.redirectPort}`,
      );
      for (const role of ['read', 'send'] as const) {
        const app = ps.apps[role];
        lines.push(
          app
            ? `Slack ${role} app: client id ${app.clientId}${app.appId ? `, app id ${app.appId}` : ''}`
            : `no Slack ${role} app`,
        );
      }
      // Only when the organisation names one, so a profile without it is previewed exactly as before.
      const agent = file.agentApp;
      if (agent) {
        lines.push(
          `Slack agent app: app id ${agent.appId}, read from ${shownPath(agent.path)} (path SHA-256 ${pathDigest(agent.path)}), agent app SHA-256 ${agent.sha256}`,
        );
      }
    } else lines.push('no Slack apps');
    lines.push(
      plan.next.forOtherAddresses
        ? `for other addresses: on — ${plan.organisation}'s client may also serve your mailboxes outside it`
        : `for other addresses: off — ${plan.organisation}'s client serves only its own addresses`,
    );
  }
  lines.push(...plan.changes, ...plan.immediate, ...plan.repairs.map((repair) => `repairs: ${repair}`));
  if (plan.secret && store)
    lines.push(`keeps the client secret of "${plan.secret.name}" in the ${store} store on this machine`);
  return lines;
}

async function applyProfile(
  core: Core,
  options: OrgOptions,
  mode: 'add' | 'update',
  planned: Planned,
  consent: LooseningConsent | undefined,
  commands: OrgHandoffs,
): Promise<OrgChangeResult> {
  const { handoffs } = commands;
  const { plan, file, store } = planned;
  const { organisation } = plan;
  const narrowing = planned.narrowed ? ['for other addresses: on → off'] : [];
  const done = async (changed: boolean): Promise<OrgChangeResult> => {
    if (changed) {
      await core.audit.append({
        inboxId: '',
        operation: mode === 'add' ? 'org.add' : 'org.update',
        outcome: 'ok',
        surface: options.surface,
        reason: organisation,
      });
    }
    const after = await core.config.load();
    return {
      organisation,
      changed: changed || planned.narrowed,
      applied: [...narrowing, ...plan.changes, ...plan.immediate, ...plan.repairs],
      reported: plan.reports,
      gmail: plan.gmail,
      store: plan.secret ? store : null,
      profile: viewOf(after, organisation, await viewHandoffs(commands, after, [organisation])),
    };
  };
  if (mode === 'update' && writesNothing(plan)) return done(false);

  return withCredentialsLock(core.paths.configDir, async () => {
    const fresh = await core.config.load();
    // The store was chosen before the lock; `secrets migrate` holds it too, and may have finished in between. Said in
    // its own words before anything else is compared.
    if (store !== null && (committedSecretsStore(fresh) ?? store) !== store) {
      throw new CommsError('TRANSIENT', 'the secret store was changed while this ran, so nothing was changed', {
        hint: 'Run it again: it keeps the client secret where the configuration keeps everything else now.',
      });
    }
    if (inputsOf(fresh) !== planned.inputs) throw changedWhileRunning();
    const write = async (refuse: (refused: boolean) => void = () => undefined): Promise<void> => {
      await core.config.update(
        (current) => {
          refuse(true);
          // Inside the store's own lock: whatever wrote in the moment between the check above and this is caught here.
          if (inputsOf(current) !== planned.inputs) throw changedWhileRunning();
          refuse(false);
          return withPlan(current, plan, store);
        },
        consent ? { consent } : {},
      );
    };
    /*
     * Whether a write that rejected is in anyway (`writeOutcome`): everything this plan changes, compared whole with
     * what it was meant to leave — the record, every row it writes or unmarks, and the store it records when it writes
     * a secret. Comparing a few fields — the SHA-256, when it was read, the rows written — answered "yes" for a write
     * that left the record's `forOtherAddresses` or an unmarked row as they were, and reported a change as made that
     * was not. What it was meant to leave goes through the schema first, as the written file did.
     */
    const touched = [...Object.keys(plan.rows), ...plan.unmark];
    const stateOf = (config: Config): string =>
      canonical({
        record: recordOf(config, organisation) ?? null,
        rows: Object.fromEntries(touched.map((name) => [name, own(config.clients, name) ?? null])),
        store: plan.secret ? (config.secrets?.store ?? null) : null,
      });
    const expected = stateOf(parseConfig(JSON.stringify(withPlan(fresh, plan, store))));
    const landed = async (): Promise<boolean> => stateOf(await core.config.load()) === expected;
    if (plan.secret && store) {
      const profileSecret = file.profile.gmail?.clientSecret;
      if (profileSecret === undefined)
        throw new CommsError('UNEXPECTED', 'a client secret was planned with no Google client');
      await writeSecretWithRestore({
        secrets: await core.secrets(store),
        secretRef: plan.secret.ref,
        secret: profileSecret,
        commit: write,
        landed,
        howToCheck: handoffSentence(handoffs.core(['org', 'show', organisation]), (command) => `Run ${command}.`, {
          instead: 'Call comms_org_show from a chat.',
        }),
        restoreHint: restoreClause(handoffs.core(['org', 'update', organisation])),
      });
    } else {
      try {
        await write();
      } catch (error) {
        // A rejected write may have committed (see `writeOutcome`): it reports success only when it is there.
        if ((await writeOutcome(landed)) !== 'present') throw error;
      }
    }
    return done(true);
  });
}

// ── The five operations ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * `agentcomms org add <file>` and `comms_org_add`: adding an organisation's profile, as one approved change (§D5).
 *
 * Refused on a version-1 configuration, for a profile that is not valid, for an organisation already added (`org
 * update` is the way), and for an ambiguous adoption. An account of the organisation already connected to its Slack
 * workspace through an app of the person's own is reported, and left exactly as it is.
 */
export function orgAddChange(core: Core, request: OrgAddRequest, options: OrgOptions): GatedChange<OrgChangeResult> {
  // Checked before anything is read, so a word that is no store is refused before any approval is prepared.
  const store = storeWord(request.store);
  const path = profileSourcePath(request.file, options.env, options.cwd, requireHandoffs(core, options.platform));
  if (request.loadedProfile !== undefined && request.loadedProfile.path !== path) {
    throw new CommsError('UNEXPECTED', 'the loaded organisation profile does not match the file being added');
  }
  return profileChange(core, options, {
    mode: 'add',
    path: () => path,
    ...(request.loadedProfile ? { file: request.loadedProfile } : {}),
    sourceGiven: true,
    forOtherAddresses: request.forOtherAddresses === true ? 'on' : undefined,
    adopt: request.adopt,
    store,
    approvalId: request.approvalId,
  });
}

/**
 * `agentcomms org update <organisation>` and `comms_org_update`: reading a profile again, applying what changed in it,
 * and reconciling the record with the configuration — even when the bytes are the same, since drift does not change a
 * profile's hash (§D8).
 */
export function orgUpdateChange(
  core: Core,
  request: OrgUpdateRequest,
  options: OrgOptions,
): GatedChange<OrgChangeResult> {
  const organisation = organisationArgument(request.organisation);
  const store = storeWord(request.store);
  const forOtherAddresses = onOff(request.forOtherAddresses);
  const given =
    request.source === undefined
      ? undefined
      : profileSourcePath(request.source, options.env, options.cwd, requireHandoffs(core, options.platform));
  return profileChange(core, options, {
    mode: 'update',
    organisation,
    path: (config) => {
      if (given !== undefined) return given;
      const record = requireRecord(config, organisation, requireHandoffs(core, options.platform));
      if (record.source.kind !== 'file') {
        throw new CommsError('CONFIG', `"${organisation}" was added from a source this release cannot read`, {
          hint: 'Update agent-communications, or give the profile’s file with --source <file>.',
        });
      }
      return record.source.path;
    },
    sourceGiven: given !== undefined,
    forOtherAddresses,
    adopt: request.adopt,
    store,
    approvalId: request.approvalId,
  });
}

interface RemovalPlan {
  organisation: string;
  record: OrganisationRecord;
  remove: { name: string; clientId: string }[];
  kept: string[];
}

/**
 * What removing a profile removes (§D8): the record, and each owned generation's row that is still the generation's —
 * with its secret. Refused while anything uses one of its clients or its apps, and while a row still carries its mark
 * without matching its generation: left without a record, such a row would be one no command could change.
 */
async function planRemoval(config: Config, organisation: string, commands: OrgHandoffs): Promise<RemovalPlan> {
  const { handoffs } = commands;
  const record = requireRecord(config, organisation, handoffs);
  const generations = record.gmail?.generations ?? [];
  const states = generations.map((generation) => ({
    generation,
    state: generationState(config, organisation, generation),
  }));
  const used = states
    .filter(({ state }) => state === 'ok')
    .flatMap(({ generation }) =>
      mailboxesOn(config, generation.name).map((mailbox) => `${mailbox} (on "${generation.name}")`),
    );
  if (used.length > 0) {
    // Gmail's help for moving a mailbox, never a command with a mailbox to fill in: which one is for the person.
    const help = (await commands.crossProduct()).of('gmail', ['inbox', 'reauth', '--help'], { uses: [] });
    const see = isCommand(help) ? `; see ${inlineCommand(help)}` : ` ${withEach([help], 'gmail_inbox_reauth')}`;
    throw new CommsError('CONFIG', `mailboxes still sign in through ${organisation}'s clients: ${used.join(', ')}`, {
      hint: `Move each onto another client${see}, or remove it, then remove the profile.`,
    });
  }
  const accounts = accountsOfOrganisation(config, organisation);
  if (accounts.length > 0) {
    throw new CommsError('CONFIG', `accounts are connected through ${organisation}'s apps: ${accounts.join(', ')}`, {
      hint: `Remove them ${withEach(
        await slackFor(commands, accounts, ['workspace', 'remove']),
        'slack_workspace_remove',
      )} first, then remove the profile.`,
    });
  }
  const mismatched = [
    ...states
      .filter(
        ({ generation, state }) => generation.ownership === 'owned' && (state === 'replaced' || state === 'altered'),
      )
      .map(({ generation }) => generation.name),
    ...strayMarkedRows(config, organisation),
  ].sort();
  if (mismatched.length > 0) {
    throw new CommsError(
      'CONFIG',
      `${mismatched.map((name) => `"${name}"`).join(', ')} ${mismatched.length === 1 ? 'is' : 'are'} still marked as ${organisation}'s but no longer match ${mismatched.length === 1 ? 'its' : 'their'} client`,
      {
        hint: `Nothing was removed. ${handoffSentence(
          handoffs.core(['org', 'update', organisation]),
          (command) =>
            `Run ${command} first: it repairs the client or clears the mark, and then the profile can be removed.`,
          {
            instead:
              'Call comms_org_update from a chat first: it repairs the client or clears the mark, and then the profile can be removed.',
          },
        )}`,
      },
    );
  }
  const remove = states
    .filter(({ generation, state }) => generation.ownership === 'owned' && state === 'ok')
    .map(({ generation }) => ({ name: generation.name, clientId: generation.clientId }));
  const kept = generations
    .filter((generation) => !remove.some((row) => row.name === generation.name) && own(config.clients, generation.name))
    .map((generation) => generation.name)
    .sort();
  return { organisation, record, remove, kept };
}

function withoutProfile(config: Config, removal: RemovalPlan): Config {
  const next = structuredClone(config);
  if (!hasNames(next)) return next;
  const organisations = { ...(next.organisations ?? {}) };
  delete organisations[removal.organisation];
  if (Object.keys(organisations).length > 0) next.organisations = organisations;
  else delete next.organisations;
  for (const { name } of removal.remove) delete next.clients[name];
  return next;
}

/**
 * `agentcomms org remove <organisation>` and `comms_org_remove`: forgetting a profile and the clients it made (§D8).
 * The approval is bound to the stored SHA-256 and to exactly the rows it removes; the final checks, the config write
 * and the secret deletions all happen under the credentials lock, as `client remove` does. Adopted rows are never
 * touched.
 */
export function orgRemoveChange(
  core: Core,
  request: OrgRemoveRequest,
  options: OrgOptions,
): GatedChange<OrgRemoveResult> {
  const organisation = organisationArgument(request.organisation);
  let planned: { removal: RemovalPlan; inputs: string } | null = null;
  const commands = orgHandoffs(core, options.platform);
  return {
    plan: async (config) => {
      const removal = await planRemoval(config, organisation, commands);
      planned = { removal, inputs: inputsOf(config) };
      const { record } = removal;
      return {
        before: config,
        after: withoutProfile(config, removal),
        summary: `Remove the organisation profile "${organisation}" (${shownText(record.label, 64)}) and the clients it made`,
        effects: [
          `forgets the organisation profile "${organisation}" (${shownText(record.label, 64)}), read from ${shownPath(record.source.path)}, profile SHA-256 ${record.sha256}`,
          ...removal.remove.map(
            ({ name, clientId }) =>
              `removes the OAuth client "${name}" (${recorded(clientId)}), which this profile made, and deletes its secret from this machine`,
          ),
          ...removal.kept.map((name) => `leaves "${name}" as it is: it is a client of your own`),
          ...(record.slack ? [`forgets its Slack apps in the workspace ${recorded(record.slack.workspace)}`] : []),
        ],
      };
    },
    apply: async () => {
      if (planned === null)
        throw new CommsError('UNEXPECTED', 'the organisation profile was removed before it was planned');
      const { removal, inputs } = planned;
      return withCredentialsLock(core.paths.configDir, async () => {
        // The final check of identity and use, under the lock: a mailbox connected or a row changed since the plan is
        // another configuration, and nothing is removed from it.
        if (inputsOf(await core.config.load()) !== inputs) throw changedWhileRunning();
        /*
         * The store is opened before anything is removed. Opened after the config write, a store that could not be
         * opened — a keychain module missing, a locked keychain — threw with the rows already gone and their secrets
         * still stored, and the result that names what is left behind was never returned. Refused here, nothing has
         * changed; once open, each deletion that fails is named in `secretsLeft`.
         */
        let secrets: SecretStore | null = null;
        if (removal.remove.length > 0) {
          try {
            secrets = await core.secrets();
          } catch (error) {
            const base = toCommsError(error);
            throw new CommsError(
              base.code,
              `the secret store could not be opened, so nothing was removed: ${base.message}`,
              {
                hint:
                  base.hint ??
                  handoffSentence(
                    commands.handoffs.core(['doctor']),
                    (command) => `Run ${command} to see what is wrong with the secret store, then run this again.`,
                    { instead: 'Call comms_doctor from a chat to see what is wrong with the secret store.' },
                  ),
                cause: error,
              },
            );
          }
        }
        try {
          await core.config.update((current) => {
            if (inputsOf(current) !== inputs) throw changedWhileRunning();
            return withoutProfile(current, removal);
          });
        } catch (error) {
          const gone = await writeOutcome(async () => {
            const now = await core.config.load();
            return (
              recordOf(now, organisation) === undefined && removal.remove.every(({ name }) => !own(now.clients, name))
            );
          });
          if (gone !== 'present') throw error;
        }
        const secretsLeft: string[] = [];
        for (const { name } of removal.remove) {
          try {
            if (secrets === null) throw new Error('no secret store');
            await secrets.delete(clientSecretRef(name));
          } catch {
            secretsLeft.push(clientSecretRef(name));
          }
        }
        await core.audit.append({
          inboxId: '',
          operation: 'org.remove',
          outcome: 'ok',
          surface: options.surface,
          reason: organisation,
        });
        return { organisation, removed: removal.remove.map(({ name }) => name), kept: removal.kept, secretsLeft };
      });
    },
  };
}

/**
 * Every profile added here, as `org show` shows each. Reads only — the registrations too, once, when a profile has
 * drifted: a drift's fix can name Gmail's command, which is found among them (CUE-403).
 */
export async function orgList(core: Core, platform: NodeJS.Platform): Promise<OrganisationView[]> {
  const config = await core.config.load();
  const organisations = Object.keys(organisationsOf(config)).sort();
  const handoffs = await viewHandoffs(orgHandoffs(core, platform), config, organisations);
  return organisations.map((organisation) => viewOf(config, organisation, handoffs));
}

/** One profile: its record, its generations and their mailboxes, its Slack apps, and any drift. Reads only. */
export async function orgShow(core: Core, organisation: string, platform: NodeJS.Platform): Promise<OrganisationView> {
  const word = organisationArgument(organisation);
  const config = await core.config.load();
  const commands = orgHandoffs(core, platform);
  requireRecord(config, word, commands.handoffs);
  return viewOf(config, word, await viewHandoffs(commands, config, [word]));
}

/**
 * The handoffs a view is made with: core's own, and able to find Gmail's only when one of these profiles has drifted —
 * the one case a view names another product's command — so a view of profiles in order reads no registrations.
 */
async function viewHandoffs(
  commands: OrgHandoffs,
  config: Config,
  organisations: readonly string[],
): Promise<CliHandoffs> {
  const drifted = organisations.some(
    (organisation) => organisationDrift(config, organisation, commands.handoffs).length > 0,
  );
  return drifted ? commands.crossProduct() : commands.handoffs;
}

/** A record as it is shown: every string that came from a profile neutralised and on one line. */
export function viewOf(config: Config, organisation: string, handoffs: CliHandoffs): OrganisationView {
  const record = requireRecord(config, organisation, handoffs);
  const active = activeGeneration(record);
  const app = (role: 'read' | 'send'): SlackAppView | null => {
    const value = record.slack?.apps[role];
    return value
      ? { clientId: shownText(value.clientId, 64), appId: value.appId ? shownText(value.appId, 64) : null }
      : null;
  };
  const notes: string[] = [];
  if (record.forOtherAddresses && !active) {
    notes.push('For other addresses is on, but routes nothing until the profile names a Google client again.');
  }
  return {
    organisation,
    label: shownText(record.label, 64),
    source: { kind: shownText(record.source.kind, 20), path: shownPath(record.source.path) },
    sha256: record.sha256,
    readAt: record.readAt,
    addedAt: record.addedAt,
    forOtherAddresses: record.forOtherAddresses,
    routesOtherAddresses: record.forOtherAddresses && active !== undefined,
    gmail: record.gmail
      ? {
          active: record.gmail.active,
          generations: record.gmail.generations.map((generation) => ({
            name: generation.name,
            clientId: shownText(generation.clientId, 120),
            projectId: generation.projectId === undefined ? null : shownText(generation.projectId, 40),
            ownership: generation.ownership,
            serves: servesText(generation.serves),
            addedAt: generation.addedAt,
            active: generation === active,
            state: generationState(config, organisation, generation),
            mailboxes: mailboxesOn(config, generation.name),
          })),
        }
      : null,
    slack: record.slack
      ? {
          workspace: shownText(record.slack.workspace, 40),
          workspaceName: shownText(record.slack.workspaceName, 80),
          redirectPort: record.slack.redirectPort,
          apps: {
            read: app('read'),
            send: app('send'),
            agent: record.slack.apps.agent ? { appId: shownText(record.slack.apps.agent.appId, 64) } : null,
          },
        }
      : null,
    accounts: accountsOfOrganisation(config, organisation),
    drift: organisationDrift(config, organisation, handoffs),
    notes,
  };
}
