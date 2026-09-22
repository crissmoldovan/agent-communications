import {
  type AccountConfig,
  type Config,
  type ConfigStore,
  type ConfigV1,
  type ConfigV2,
  configFingerprint,
  type FormerNames,
  type InboxConfig,
  isValidAlias,
  RESERVED_ALIASES,
} from './config.ts';
import { CommsError } from './errors.ts';
import { nameShapeProblem } from './name-grammar.ts';

/**
 * Every lookup of an account by name, and every check that a name may be taken, goes through here.
 *
 * Two versions of the config name accounts differently (see `name-grammar.ts`), and version 2 remembers the names it
 * replaced. A caller that indexed `config.inboxes[name]` itself would know neither: it would apply version 1's rules
 * to a version-2 file, and answer "no such inbox" to somebody using a name that was renamed an hour ago, instead of
 * telling them what it is called now.
 */

export type NameKind = 'inbox' | 'account';

const MAP = { inbox: 'inboxes', account: 'accounts' } as const;

/**
 * An own property only.
 *
 * A name is user input and the maps are plain objects, so `config.inboxes.constructor` is a function — and a lookup
 * of an inbox called `constructor`, which version 1 allows, found it.
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

type NotFound = () => CommsError;

/**
 * The account a name refers to, or a refusal that says why there is none.
 *
 * A name that was replaced is refused with its replacement — `NOT_FOUND`, the current name in the hint and in
 * `details`. It is never followed: D3 chose refusal over aliases, so nothing runs under a name that no longer exists,
 * and whoever typed it learns the new one.
 *
 * `notFound` supplies the plain "no such thing" error, so each package keeps its own wording and hint.
 */
export function resolveName(
  config: Config,
  kind: 'inbox',
  name: string,
  notFound?: NotFound,
): { alias: string; inbox: InboxConfig };
export function resolveName(
  config: Config,
  kind: 'account',
  name: string,
  notFound?: NotFound,
): { alias: string; account: AccountConfig };
export function resolveName(
  config: Config,
  kind: NameKind,
  name: string,
  notFound?: NotFound,
): { alias: string; inbox: InboxConfig } | { alias: string; account: AccountConfig } {
  if (kind === 'inbox') {
    const inbox = own(config.inboxes, name);
    if (inbox) return { alias: name, inbox };
  } else {
    const account = own(config.accounts, name);
    if (account) return { alias: name, account };
  }
  const renamed = formerNameRefusal(config, kind, name);
  if (renamed) throw renamed;
  throw notFound?.() ?? defaultNotFound(config, kind, name);
}

function defaultNotFound(config: Config, kind: NameKind, name: string): CommsError {
  if (kind === 'inbox') {
    const known = Object.keys(config.inboxes);
    return new CommsError('NOT_FOUND', `no inbox called "${name}"`, {
      hint: known.length
        ? `Known inboxes: ${known.join(', ')}.`
        : 'No inboxes yet: add one with `agent-gmail inbox add`.',
    });
  }
  return new CommsError('NOT_FOUND', `no account called "${name}"`);
}

/** The name an account has now, found by its immutable id. */
export function findById(config: Config, kind: 'inbox', id: string): { alias: string; inbox: InboxConfig } | null;
export function findById(config: Config, kind: 'account', id: string): { alias: string; account: AccountConfig } | null;
export function findById(
  config: Config,
  kind: NameKind,
  id: string,
): { alias: string; inbox: InboxConfig } | { alias: string; account: AccountConfig } | null {
  if (kind === 'inbox') {
    for (const [alias, inbox] of Object.entries(config.inboxes)) if (inbox.id === id) return { alias, inbox };
  } else {
    for (const [alias, account] of Object.entries(config.accounts)) if (account.id === id) return { alias, account };
  }
  return null;
}

/**
 * The refusal for a former name, or null when `name` is not one.
 *
 * The replacement is looked up by id rather than read from the record, so a chain of renames ends at the name the
 * account has today — and an account removed since its rename is said to be gone, rather than pointing somebody at a
 * name that now belongs to nothing.
 */
export function formerNameRefusal(config: Config, kind: NameKind, name: string): CommsError | null {
  if (config.version !== 2) return null;
  const former = own(config.formerNames[MAP[kind]], name);
  if (!former) return null;
  const current = kind === 'inbox' ? findById(config, 'inbox', former.id) : findById(config, 'account', former.id);
  if (!current) {
    return new CommsError('NOT_FOUND', `"${name}" was renamed to "${former.name}", which has since been removed`, {
      details: { formerName: name, id: former.id },
    });
  }
  return new CommsError('NOT_FOUND', `"${name}" was renamed to "${current.alias}"`, {
    hint: `Use "${current.alias}".`,
    details: { formerName: name, currentName: current.alias, id: former.id },
  });
}

/** Looks up an inbox by name, or fails with the list of known names — or with what a former name is called now. */
export function requireInbox(config: Config, alias: string): InboxConfig {
  return resolveName(config, 'inbox', alias).inbox;
}

export type NameCheck = { ok: true } | { ok: false; error: CommsError };

/**
 * Whether `name` may be given to a new or renamed account of this kind and platform.
 *
 * Each version keeps its own rule, because version 1's differ by kind today and must not change under a file an
 * older release also writes: a mailbox name need only be free among mailboxes, a workspace name among both. Version
 * 2 is stricter and the same for both: the grammar, the platform, free in both maps, and never a former name of
 * either kind.
 *
 * A check, not a reservation. Callers repeat it inside the config write, where the schema enforces the same rules
 * again for version 2, because anything can happen between asking and writing.
 */
export function nameAvailable(config: Config, kind: NameKind, name: string, platform: string): NameCheck {
  const refuse = (error: CommsError): NameCheck => ({ ok: false, error });
  if (config.version === 1) {
    if (RESERVED_ALIASES.has(name)) {
      return refuse(new CommsError('USAGE', `"${name}" is reserved`, { hint: 'Choose another name.' }));
    }
    if (!isValidAlias(name)) {
      return refuse(
        new CommsError('USAGE', `"${name}" is not a usable name`, {
          hint: 'Lower-case letters, digits and dashes, up to 32 characters, not starting with a dash.',
        }),
      );
    }
    const taken =
      kind === 'inbox' ? own(config.inboxes, name) : (own(config.inboxes, name) ?? own(config.accounts, name));
    if (taken)
      return refuse(new CommsError('CONFIG', `"${name}" is already connected`, { hint: 'Choose another name.' }));
    return { ok: true };
  }

  const problem = nameShapeProblem(name, platform);
  if (problem) return refuse(new CommsError('USAGE', problem));
  if (own(config.inboxes, name) || own(config.accounts, name)) {
    return refuse(new CommsError('CONFIG', `"${name}" is already connected`, { hint: 'Choose another name.' }));
  }
  for (const map of ['inboxes', 'accounts'] as const) {
    const former = own(config.formerNames[map], name);
    if (former) {
      return refuse(
        new CommsError('CONFIG', `"${name}" was the name of another account and cannot be used again`, {
          hint: 'A former name keeps pointing people at the account that had it. Choose another name.',
          details: { formerName: name, id: former.id },
        }),
      );
    }
  }
  return { ok: true };
}

/**
 * `config` with one account renamed — and, in version 2, the old name recorded for good.
 *
 * Earlier records for the same account are pointed at the new name too, so `cue` → `cue/gmail` → `cue/gmail-main`
 * leaves `cue` naming `cue/gmail-main`, never another former name. The caller has checked `to` with
 * `nameAvailable`; the schema checks it again when this is written.
 */
export function renameEntry<C extends Config>(config: C, kind: NameKind, from: string, to: string): C {
  const map = MAP[kind];
  const entries: Record<string, { id: string }> = config[map];
  const row = own(entries, from);
  if (!row) throw new CommsError('NOT_FOUND', `no ${kind} called "${from}"`);
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (key !== from) renamed[key] = value;
  renamed[to] = row;
  if (config.version === 1) return { ...config, [map]: renamed };
  const records: FormerNames[typeof map] = {};
  for (const [key, record] of Object.entries(config.formerNames[map])) {
    // Spread, so a field a newer release added to the record survives this one rewriting it.
    records[key] = record.id === row.id ? { ...record, name: to, id: row.id } : record;
  }
  records[from] = { name: to, id: row.id };
  return { ...config, [map]: renamed, formerNames: { ...config.formerNames, [map]: records } };
}

/**
 * `config` with every former name that pointed at `fromId` pointed at `toId` instead.
 *
 * For a re-authorisation that mints a new id for the same account — Slack's does, so the new credential can be staged
 * beside the old one. Without this, the account's old names would point at an id that no longer exists and be
 * reported as belonging to a removed account while it is still connected. Called in the same config write that
 * replaces the id; `ConfigStore.update` allows exactly this change and no other to a former name's id.
 */
export function retargetFormerNames<C extends Config>(config: C, kind: NameKind, fromId: string, toId: string): C {
  if (config.version !== 2) return config;
  const map = MAP[kind];
  const records: FormerNames[typeof map] = {};
  for (const [key, record] of Object.entries(config.formerNames[map])) {
    records[key] = record.id === fromId ? { ...record, id: toId } : record;
  }
  return { ...config, formerNames: { ...config.formerNames, [map]: records } };
}

export interface NamesMigrationRow {
  kind: NameKind;
  from: string;
  to: string;
  id: string;
  platform: string;
}

export type NamesMigrationPlan =
  | { status: 'already-migrated' }
  | { status: 'ready'; fingerprint: string; rows: NamesMigrationRow[] };

/**
 * What the migration would do to `config`, or a refusal listing every problem at once.
 *
 * Each account's default is `<old name>/<platform>`; `renames` overrides one, as `source=name`, where the source may
 * be qualified — `inbox:work=…`, `account:work=…` — and must be when version 1 has the same word in both maps. Every
 * problem is collected before anything is refused, so a person fixes them in one pass instead of one per run; and a
 * plan with a problem is never partly applied.
 *
 * The fingerprint is of the whole configuration this was computed from. `migrateNames` refuses to apply the plan to
 * anything else.
 */
export function planNamesMigration(config: Config, renames: readonly string[] = []): NamesMigrationPlan {
  if (config.version === 2) return { status: 'already-migrated' };
  const problems: string[] = [];
  const overrides = new Map<string, string>();

  for (const rename of renames) {
    const at = rename.indexOf('=');
    if (at <= 0 || at === rename.length - 1) {
      problems.push(`"${rename}" is not source=name`);
      continue;
    }
    const source = rename.slice(0, at);
    const target = rename.slice(at + 1);
    const qualified = /^(inbox|account):(.+)$/.exec(source);
    let key: string;
    if (qualified) {
      const [, kind = '', name = ''] = qualified;
      const exists = kind === 'inbox' ? own(config.inboxes, name) : own(config.accounts, name);
      if (!exists) {
        problems.push(`there is no ${kind} called "${name}"`);
        continue;
      }
      key = `${kind}:${name}`;
    } else {
      const inbox = own(config.inboxes, source);
      const account = own(config.accounts, source);
      if (inbox && account) {
        problems.push(
          `"${source}" names both a mailbox and an account — say which: inbox:${source}=… or account:${source}=…`,
        );
        continue;
      }
      if (!inbox && !account) {
        problems.push(`there is nothing called "${source}"`);
        continue;
      }
      key = `${inbox ? 'inbox' : 'account'}:${source}`;
    }
    if (overrides.has(key)) {
      problems.push(`"${source}" is renamed more than once`);
      continue;
    }
    overrides.set(key, target);
  }

  const rows: NamesMigrationRow[] = [];
  const add = (kind: NameKind, from: string, id: string, platform: string) => {
    const override = overrides.get(`${kind}:${from}`);
    const to = override ?? `${from}/${platform}`;
    const problem = nameShapeProblem(to, platform);
    if (problem) {
      problems.push(
        override === undefined
          ? `"${from}" would become "${to}", which cannot be used (${problem}) — choose one with --rename ${kind}:${from}=<name>`
          : problem,
      );
    }
    rows.push({ kind, from, to, id, platform });
  };
  for (const [alias, inbox] of Object.entries(config.inboxes)) add('inbox', alias, inbox.id, inbox.provider);
  for (const [alias, account] of Object.entries(config.accounts)) add('account', alias, account.id, account.platform);

  const byTarget = new Map<string, NamesMigrationRow[]>();
  for (const row of rows) byTarget.set(row.to, [...(byTarget.get(row.to) ?? []), row]);
  for (const [target, sharing] of byTarget) {
    if (sharing.length > 1) {
      problems.push(`"${target}" would name ${sharing.map((row) => `${row.kind} "${row.from}"`).join(' and ')}`);
    }
  }

  if (problems.length > 0) {
    throw new CommsError(
      'USAGE',
      `the names cannot be migrated as asked: ${problems.length === 1 ? problems[0] : `${problems.length} problems`}`,
      { hint: problems.map((problem) => `- ${problem}`).join('\n'), details: { problems } },
    );
  }
  rows.sort((a, b) => (a.kind === b.kind ? a.from.localeCompare(b.from) : a.kind === 'inbox' ? -1 : 1));
  return { status: 'ready', fingerprint: configFingerprint(config), rows };
}

/** Version 2 from version 1 and a plan made from it: every key renamed, every old name recorded. Nothing else. */
export function applyNamesMigration(config: ConfigV1, rows: readonly NamesMigrationRow[]): ConfigV2 {
  const target = new Map(rows.map((row) => [`${row.kind}:${row.from}`, row.to]));
  const rename = <T extends { id: string }>(kind: NameKind, entries: Record<string, T>) => {
    const renamed: Record<string, T> = {};
    const former: Record<string, { name: string; id: string }> = {};
    for (const [alias, row] of Object.entries(entries)) {
      const to = target.get(`${kind}:${alias}`);
      if (to === undefined) throw new CommsError('CONFIG', `the plan does not say what "${alias}" becomes`);
      renamed[to] = row;
      former[alias] = { name: to, id: row.id };
    }
    return { renamed, former };
  };
  const inboxes = rename('inbox', config.inboxes);
  const accounts = rename('account', config.accounts);
  return {
    ...config,
    version: 2,
    inboxes: inboxes.renamed,
    accounts: accounts.renamed,
    formerNames: { inboxes: inboxes.former, accounts: accounts.former },
  };
}

/**
 * Applies a plan, under both locks, to exactly the configuration it was made from.
 *
 * See `ConfigStore.migrateNames` for what is checked inside the locks.
 */
export function migrateNames(
  store: ConfigStore,
  plan: Extract<NamesMigrationPlan, { status: 'ready' }>,
): Promise<{ status: 'migrated' | 'already-migrated'; config: ConfigV2 }> {
  return store.migrateNames(plan.fingerprint, (current) => applyNamesMigration(current, plan.rows));
}
