import type { GatedChange } from '../change-flow.ts';
import type { ChangeRequest, ChangeSurface } from '../changes.ts';
import { SERVERS, serverFacts, serverLabel } from '../channel-servers.ts';
import type { Config } from '../config.ts';
import {
  type ConnectionApp,
  type ConnectionLauncher,
  type ConnectionPart,
  type ConnectionRecord,
  connectionById,
  connectionKeyHash,
  newConnectionId,
  newConnectionKey,
  partFacts,
  partText,
  readConnections,
  withConnection,
} from '../connections.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { type RegisteredServer, scanRegisteredServers } from '../mcp-clients.ts';
import {
  connectionOfEntry,
  type InstallContext,
  isProductServer,
  type Launcher,
  recordedClientConfigs,
  removeConnectionEntry,
  removeEntries,
  type SupportedClient,
} from '../mcp-install.ts';
import { lookupName } from '../names.ts';
import { homeDirectory, shortenHome } from '../paths.ts';
import { launcherOf, registrationPathPins } from '../registrations.ts';
import { type ServerInstallDeps, type ServerInstallResult, serverInstallChange } from './servers.ts';

/**
 * Moving an app's separate Agent Comms entries into one connection, when the person asks (single-server design D16,
 * §9.1, §9.4): `connection migrate` and `comms_connection_migrate`. Never run by `update` or the background job.
 *
 * It groups this machine's entries of ours, at user scope, by app and config file, and plans one connection per group
 * that reaches exactly what those entries reached — their servers, each entry's pin and read-only, their launcher —
 * adding nothing: a migration that widened anything would be a loosening hidden in a tidy-up. Left alone, and named in
 * the preview: a second entry of one server in a group, entries pinned to another config folder, one project's
 * entries, entries that already are a connection's, and everything that is not ours. Applied group by group: the
 * record, then its entry, which takes core's name and place, started and checked, and only then the group's other
 * entries removed, each saved first; a group whose entry does not start is put back as it was, and stops the rest.
 * `connection migrate --undo <id>` registers each part again as an entry of its own, under the name it had, and takes
 * the connection out.
 */

const CLIENT_APP: Readonly<Record<string, Exclude<ConnectionApp, 'manual'>>> = Object.freeze({
  'claude-code': 'claude-code',
  'claude-desktop': 'claude-desktop',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini',
  vscode: 'vscode',
});

const APP_NAMES: Readonly<Record<Exclude<ConnectionApp, 'manual'>, string>> = Object.freeze({
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  vscode: 'VS Code',
});

/** One group's plan: the connection it becomes, and the entries it replaces. */
export interface MigrationGroup {
  readonly app: Exclude<ConnectionApp, 'manual'>;
  readonly client: SupportedClient;
  readonly path: string;
  readonly name: string;
  readonly launcher: ConnectionLauncher;
  readonly parts: readonly ConnectionPart[];
  /** The entries it replaces, by server and name. */
  readonly entries: readonly { readonly server: string; readonly name: string }[];
  /** The connection's entry's name: core's own entry's, which it takes the place of, or `agentcomms` where it is free. */
  readonly entryName: string;
}

/** What a migration leaves as it is, and why, as its preview names it. */
export interface MigrationLeft {
  readonly client: string;
  readonly name: string;
  readonly path: string;
  readonly why: string;
}

export interface MigrationPlan {
  readonly groups: readonly MigrationGroup[];
  readonly left: readonly MigrationLeft[];
}

export interface MigrationResult {
  readonly migrated: readonly {
    readonly id: string;
    readonly name: string;
    readonly app: string;
    readonly replaced: number;
    readonly backups: readonly string[];
  }[];
  readonly left: readonly MigrationLeft[];
  /** What the person is told (§9.4): where the tools appear, the permission rules, and a restart. */
  readonly next: readonly string[];
}

/** The server an entry of ours starts, or undefined for one that is not ours. */
function serverOf(entry: RegisteredServer): string | undefined {
  return SERVERS.find((server) => isProductServer(entry, serverFacts(server)));
}

/** The plan, from what this machine has registered now. Exported for `connection migrate --dry-run` and its tests. */
export async function migrationPlan(
  core: Core,
  env: NodeJS.ProcessEnv,
  config: Config,
  only?: string,
): Promise<{ plan: MigrationPlan; scanned: RegisteredServer[] }> {
  const recorded = await recordedClientConfigs(core.paths.dataDir);
  if (recorded === null)
    throw new CommsError(
      'CONFIG',
      'the record of where entries were registered could not be read, so nothing was migrated',
    );
  const scan = await scanRegisteredServers(env, process.platform, recorded);
  // As a prune stops: an app config that cannot be read hides what it registers, so nothing is concluded from it.
  if (scan.unreadable.length > 0) {
    const files = scan.unreadable.map((file) => `${file.path} (${file.reason})`).join('; ');
    throw new CommsError('CONFIG', `${files} could not be read, so nothing was migrated`, {
      hint: 'Fix the file, then migrate again.',
    });
  }
  const left: MigrationLeft[] = [];
  const groups = new Map<
    string,
    { client: string; path: string; entries: { server: string; entry: RegisteredServer }[] }
  >();
  const { configDir } = core.paths;
  for (const entry of scan.servers) {
    const server = serverOf(entry);
    if (server === undefined) continue;
    if (only !== undefined && entry.client !== only) continue;
    const say = (why: string) => left.push({ client: entry.client, name: entry.name, path: entry.path, why });
    if (connectionOfEntry(entry.args) !== null) continue;
    if (!(entry.client in CLIENT_APP)) {
      say('it is not in an app a connection is made for');
      continue;
    }
    if (entry.scope === 'project') {
      say('it is one project’s own entry: connections replace user-scope entries in this release');
      continue;
    }
    const pins = registrationPathPins(entry.args);
    if (pins.configDir !== undefined && pins.configDir !== configDir) {
      say(`it is pinned to another configuration folder, ${pins.configDir}`);
      continue;
    }
    const key = `${entry.client}\0${entry.path}`;
    const group = groups.get(key) ?? { client: entry.client, path: entry.path, entries: [] };
    if (group.entries.some((held) => held.server === server)) {
      say(
        `a connection holds one ${serverLabel(server)}, and "${group.entries.find((held) => held.server === server)?.entry.name}" is it`,
      );
      continue;
    }
    group.entries.push({ server, entry });
    groups.set(key, group);
  }
  const taken = new Set(
    readConnections(config).connections.map((read) =>
      (read.readable ? read.record.name : (read.name ?? '')).toLowerCase(),
    ),
  );
  const planned: MigrationGroup[] = [];
  for (const group of groups.values()) {
    const app = CLIENT_APP[group.client] as Exclude<ConnectionApp, 'manual'>;
    const parts: ConnectionPart[] = [];
    const launchers = new Set<Launcher | 'other'>();
    for (const { server, entry } of group.entries) {
      const facts = serverFacts(server);
      const narrowing = facts.narrowingOf(entry.args);
      const part = partFacts(server);
      launchers.add(launcherOf(entry, facts));
      const alias = part?.pin === undefined ? undefined : narrowing[part.pin];
      let pin: ConnectionPart['pin'];
      if (alias !== undefined) {
        const found =
          part?.accounts === 'inboxes' ? lookupName(config, 'inbox', alias) : lookupName(config, 'account', alias);
        if (found === undefined) {
          // A pin to an account that is gone is never read as no pin: the entry is left as it is.
          left.push({
            client: entry.client,
            name: entry.name,
            path: entry.path,
            why: `the account it is pinned to, ${alias}, is not connected here`,
          });
          continue;
        }
        pin = { id: found.id, alias };
      }
      parts.push({ server, ...(pin === undefined ? {} : { pin }), ...(narrowing.readOnly ? { readOnly: true } : {}) });
    }
    if (parts.length === 0) continue;
    const kept = group.entries.filter(({ server }) => parts.some((part) => part.server === server));
    const launcher: ConnectionLauncher =
      launchers.size === 1 && launchers.has('npx')
        ? 'npx'
        : launchers.size === 1 && launchers.has('local')
          ? 'local'
          : 'managed';
    let name = APP_NAMES[app];
    for (let index = 2; taken.has(name.toLowerCase()); index += 1) name = `${APP_NAMES[app]} ${index}`;
    taken.add(name.toLowerCase());
    // Core's own entry's name, whose place it takes; otherwise `agentcomms`, or the first free name after it.
    const core = kept.find(({ server }) => server === 'core');
    const used = new Set(
      scan.servers
        .filter((entry) => entry.client === group.client && entry.path === group.path && entry.scope !== 'project')
        .map((entry) => entry.name),
    );
    const base = serverFacts('core').defaultServerName;
    let entryName = core?.entry.name ?? base;
    for (let index = 2; core === undefined && used.has(entryName); index += 1) entryName = `${base}-${index}`;
    planned.push({
      app,
      client: group.client as SupportedClient,
      path: group.path,
      name,
      launcher,
      parts,
      entries: kept.map(({ server, entry }) => ({ server, name: entry.name })),
      entryName,
    });
  }
  return { plan: { groups: planned, left }, scanned: scan.servers };
}

const NEXT = [
  'The tools appear under the one Agent Comms entry: mcp__agentcomms__… in Claude Code.',
  'Permission rules that allowed mcp__gmail__… and the like need allowing again as mcp__agentcomms__….',
  'Restart the app once to use the connection.',
];

/** The migration, as a change (§9.1): approved first, its effects every entry it writes and removes. */
export function connectionMigrateChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: { client?: string | undefined },
  surface: ChangeSurface,
  deps: ServerInstallDeps = {},
): GatedChange<MigrationResult> {
  let planned:
    | { plan: MigrationPlan; records: ConnectionRecord[]; keys: string[]; scanned: RegisteredServer[] }
    | undefined;
  return {
    plan: async (config): Promise<ChangeRequest> => {
      const { plan, scanned } = await migrationPlan(core, env, config, request.client);
      if (plan.groups.length === 0) {
        throw new CommsError(
          'USAGE',
          'nothing to migrate: no app here has entries of Agent Comms that one connection could hold',
          {
            hint:
              plan.left.length > 0
                ? `Left as they are: ${plan.left.map((each) => `${each.name} in ${each.path} (${each.why})`).join('; ')}.`
                : 'Add a connection instead.',
          },
        );
      }
      const now = new Date().toISOString();
      const keys = plan.groups.map(() => newConnectionKey());
      const records: ConnectionRecord[] = plan.groups.map((group, index) => ({
        id: newConnectionId(),
        name: group.name,
        app: group.app,
        where: { scope: 'user', folder: null, configDir: null },
        entry: { name: group.entryName, path: group.path },
        launcher: group.launcher,
        parts: group.parts,
        keyHash: connectionKeyHash(keys[index] as string),
        keyIssuedAt: now,
        createdAt: now,
        revokedAt: null,
        migratedFrom: { at: now, entries: group.entries, backups: [] },
      }));
      let after: Config = config;
      for (const record of records) after = { ...after, connections: withConnection(after, { put: record }) } as Config;
      const home = homeDirectory(env);
      const effects: string[] = [];
      for (const group of plan.groups) {
        effects.push(
          `moves ${group.entries.map((entry) => `"${entry.name}"`).join(', ')} in ${shortenHome(group.path, home)} into one connection, "${group.name}": one entry, "${group.entryName}", that starts ${group.parts.map((part) => partText(part.server, { pin: part.pin ?? null, readOnly: part.readOnly === true })).join('; ')}; each entry it removes is saved first`,
        );
      }
      for (const each of plan.left)
        effects.push(`leaves "${each.name}" in ${shortenHome(each.path, home)} as it is: ${each.why}`);
      effects.push(...NEXT.map((line) => line.charAt(0).toLowerCase() + line.slice(1).replace(/\.$/, '')));
      planned = { plan, records, keys, scanned };
      return {
        before: config,
        after,
        effects,
        summary: `Move ${plan.groups.length === 1 ? `${APP_NAMES[plan.groups[0]?.app ?? 'claude-code']}'s entries` : `${plan.groups.length} apps' entries`} of Agent Comms into one connection each`,
      };
    },
    apply: async (consent): Promise<MigrationResult> => {
      if (planned === undefined) throw new CommsError('UNEXPECTED', 'the migration was applied before it was planned');
      const { plan, records, keys, scanned } = planned;
      const migrated: MigrationResult['migrated'][number][] = [];
      // Every record at once, with the one consent the person gave: each group then registers, or takes its own out.
      await core.config.update(
        (config) => {
          let next: Config = config;
          for (const record of records)
            next = { ...next, connections: withConnection(next, { put: record }) } as Config;
          return next;
        },
        consent === undefined ? {} : { consent },
      );
      for (const [index, group] of plan.groups.entries()) {
        const record = records[index] as ConnectionRecord;
        const key = keys[index] as string;
        const context: InstallContext = { env, core };
        const coreEntry = group.entries.find((entry) => entry.server === 'core');
        const gateway = serverInstallChange(
          core,
          env,
          {
            channel: 'core',
            client: group.client,
            name: group.entryName,
            launcher: group.launcher,
            connection: {
              id: record.id,
              name: record.name,
              key,
              scope: 'user',
              ...(coreEntry === undefined ? {} : { replaceCore: true }),
            },
          },
          undefined,
          deps,
        );
        let installed: ServerInstallResult | undefined;
        let failure: unknown;
        try {
          installed = await gateway.apply(undefined, await gateway.plan(await core.config.load()));
          if (!installed.applied || installed.verification === 'failed') {
            failure = new CommsError(
              'PROVIDER_UNAVAILABLE',
              `the connection "${record.name}" did not start: ${installed.notApplied ?? installed.verifyDetail ?? 'it was not registered'}`,
            );
          }
        } catch (error) {
          failure = error;
        }
        if (failure !== undefined) {
          // Put back as it was: the connection's entry out, core's own entry in again, the record cut off. The rest stop.
          await removeConnectionEntry(context, group.client, { name: group.entryName, connection: record.id }).catch(
            () => undefined,
          );
          // Core's own entry again, only where the connection's took its place; one that was never replaced is there.
          const replaced = installed?.applied === true;
          if (coreEntry !== undefined && replaced) {
            try {
              const restore = serverInstallChange(
                core,
                env,
                {
                  channel: 'core',
                  client: group.client,
                  name: coreEntry.name,
                  launcher: group.launcher,
                  noVerify: true,
                },
                undefined,
                deps,
              );
              await restore.apply(undefined, await restore.plan(await core.config.load()));
            } catch {
              // Said by the failure below; its entry was saved first, in the backup the install wrote.
            }
          }
          await core.config.update((config) => {
            let next: Config = config;
            for (const each of records.slice(index)) {
              const read = connectionById(next, each.id);
              if (read?.readable)
                next = {
                  ...next,
                  connections: withConnection(next, { put: { ...read.record, revokedAt: new Date().toISOString() } }),
                } as Config;
            }
            return next;
          });
          throw failure;
        }
        // Only now the group's other entries go, each saved first.
        const removals = group.entries.filter((entry) => entry.server !== 'core');
        const backups: string[] = [];
        for (const removal of removals) {
          const found = scanned.filter(
            (entry) =>
              entry.client === group.client &&
              entry.path === group.path &&
              entry.name === removal.name &&
              entry.scope !== 'project',
          );
          const done = await removeEntries(context, group.client, found, serverFacts(removal.server));
          if (done.backupPath !== undefined) backups.push(done.backupPath);
        }
        if (installed?.backupPath !== undefined) backups.push(installed.backupPath);
        await core.config.update((config) => {
          const read = connectionById(config, record.id);
          if (read === undefined || !read.readable) return config;
          return {
            ...config,
            connections: withConnection(config, {
              put: { ...read.record, migratedFrom: { at: record.createdAt, entries: group.entries, backups } },
            }),
          } as Config;
        });
        await core.audit.append({
          inboxId: '',
          operation: 'connection.migrate',
          outcome: 'ok',
          surface,
          connection: record.id,
          reason: `${group.client}: ${group.entries.length} entries into one`,
        });
        migrated.push({ id: record.id, name: record.name, app: group.app, replaced: group.entries.length, backups });
      }
      return { migrated, left: plan.left, next: NEXT };
    },
  };
}

export interface MigrationUndoResult {
  readonly id: string;
  readonly name: string;
  readonly registered: readonly { readonly server: string; readonly name: string; readonly applied: boolean }[];
  readonly next: string;
}

/**
 * `connection migrate --undo <id>` (§9.1, step 6): each part registered again as an entry of its own — under the name
 * it had, with its pin and read-only — the connection's entry taken out, and the connection removed. It reaches what
 * the connection reached, as separate entries; registering them is approved first, as every registration is.
 */
export function connectionMigrateUndoChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: { id: string },
  surface: ChangeSurface,
  deps: ServerInstallDeps = {},
): GatedChange<MigrationUndoResult> {
  let record: ConnectionRecord | undefined;
  return {
    plan: (config): ChangeRequest => {
      const read = connectionById(config, request.id);
      if (read === undefined) throw new CommsError('NOT_FOUND', `no connection here has the id ${request.id}`);
      if (!read.readable)
        throw new CommsError('CONFIG', `connection ${request.id} could not be read, so it cannot be undone`);
      if (read.record.app === 'manual') throw new CommsError('USAGE', 'a Manual connection came from no migration');
      record = read.record;
      const names = new Map((read.record.migratedFrom?.entries ?? []).map((entry) => [entry.server, entry.name]));
      return {
        before: config,
        after: { ...config, connections: withConnection(config, { remove: request.id }) } as Config,
        effects: [
          ...read.record.parts.map(
            (part) =>
              `registers the ${serverLabel(part.server)} MCP server with ${read.record.app} as "${names.get(part.server) ?? serverFacts(part.server).defaultServerName}"${part.pin === undefined ? '' : `, pinned to ${part.pin.alias}`}${part.readOnly ? ', read-only' : ''}`,
          ),
          `takes the connection "${read.record.name}" and its entry out of ${read.record.app}`,
        ],
        summary: `Undo the connection "${read.record.name}": its parts as entries of their own again`,
      };
    },
    apply: async (): Promise<MigrationUndoResult> => {
      if (record === undefined) throw new CommsError('UNEXPECTED', 'the undo was applied before it was planned');
      const held = record;
      const client = CLIENT_APP[held.app] as SupportedClient;
      const names = new Map((held.migratedFrom?.entries ?? []).map((entry) => [entry.server, entry.name]));
      // The connection's entry first: core's own takes its name back.
      if (held.entry !== null) {
        await removeConnectionEntry({ env, core }, client, { name: held.entry.name, connection: held.id });
      }
      await core.config.update(
        (config) => ({ ...config, connections: withConnection(config, { remove: held.id }) }) as Config,
      );
      const registered: MigrationUndoResult['registered'][number][] = [];
      for (const part of held.parts) {
        const facts = partFacts(part.server);
        const pin = part.pin === undefined || facts?.pin === undefined ? {} : { [facts.pin]: part.pin.alias };
        const install = serverInstallChange(
          core,
          env,
          {
            channel: part.server,
            client,
            name: names.get(part.server) ?? serverFacts(part.server).defaultServerName,
            launcher: held.launcher,
            ...pin,
            ...(part.readOnly ? { readOnly: true } : {}),
            noVerify: true,
          },
          undefined,
          deps,
        );
        const done = await install.apply(undefined, await install.plan(await core.config.load()));
        registered.push({ server: part.server, name: done.name, applied: done.applied });
      }
      await core.audit.append({
        inboxId: '',
        operation: 'connection.migrate.undo',
        outcome: 'ok',
        surface,
        connection: held.id,
        reason: `${held.app}: ${registered.length} entries of their own`,
      });
      return {
        id: held.id,
        name: held.name,
        registered,
        next: `Restart ${APP_NAMES[held.app as Exclude<ConnectionApp, 'manual'>]} to use its entries again.`,
      };
    },
  };
}
