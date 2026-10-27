import { type AppOriginCheck, gatedChangeAtTerminal } from './change-flow.ts';
import { type OutputOptions, writeResult } from './cli-runtime.ts';
import type { ConnectionApp, ConnectionLauncher } from './connections.ts';
import type { Core } from './core.ts';
import type { CommsError } from './errors.ts';
import {
  connectionMigrateChange,
  connectionMigrateUndoChange,
  type MigrationResult,
  type MigrationUndoResult,
} from './operations/connection-migrate.ts';
import {
  type ConnectionAddResult,
  type ConnectionChangeResult,
  type ConnectionKeyResult,
  type ConnectionRemoveResult,
  type ConnectionShown,
  type ConnectionView,
  connectionAddChange,
  connectionChangeChange,
  connectionKeyReplaceChange,
  connectionList,
  connectionRemoveChange,
  connectionRenameChange,
  connectionShow,
  parsePartsSpec,
} from './operations/connections.ts';
import type { ServerInstallDeps } from './operations/servers.ts';
import { homeDirectory, shortenHome } from './paths.ts';

/**
 * `agentcomms connection …`: the person's MCP connections at a terminal (single-server design §10; the 0.35 prototype's
 * MCP connections). Each subcommand runs the operation its tool runs; what changes goes through
 * `gatedChangeAtTerminal`, as every change here does. Lives beside `cli.ts`, which imports it; nothing else may.
 */

interface ConnectionValues {
  readonly app?: string | undefined;
  readonly name?: string | undefined;
  readonly parts?: string | undefined;
  readonly folder?: string | undefined;
  readonly profile?: string | undefined;
  readonly launcher?: string | undefined;
  readonly 'no-verify'?: boolean | undefined;
  readonly client?: string | undefined;
  readonly undo?: string | undefined;
}

interface CommandContext {
  readonly env: NodeJS.ProcessEnv;
  readonly output: OutputOptions & { platform: NodeJS.Platform };
  readonly approval: {
    channel: string;
    approvalId?: string | undefined;
    env: NodeJS.ProcessEnv;
    output: OutputOptions & { platform: NodeJS.Platform };
    appOrigin?: AppOriginCheck | undefined;
  };
  readonly appApproval: string | undefined;
  readonly installDeps: ServerInstallDeps;
  readonly usage: (message: string) => CommsError;
}

const USAGE = {
  list: 'usage: connection list',
  show: 'usage: connection show [<id>]',
  add: 'usage: connection add --app <app> --name <name> [--parts <part,…>] [--folder <dir>] [--profile <dir>] [--launcher managed|npx|local]',
  change: 'usage: connection change <id> --parts <part,…>',
  rename: 'usage: connection rename <id> <name>',
  key: 'usage: connection key replace <id>',
  remove: 'usage: connection remove <id>',
  migrate: 'usage: connection migrate [--client <client>] | connection migrate --undo <id>',
};

export async function connectionCommand(
  core: Core,
  positionals: readonly string[],
  values: ConnectionValues,
  context: CommandContext,
): Promise<void> {
  const { env, output, approval, appApproval, installDeps, usage } = context;
  const [, sub, ...rest] = positionals;
  const onlyFor = (subcommand: string, allowed: readonly (keyof ConnectionValues)[]) => {
    const given = (['app', 'name', 'parts', 'folder', 'profile', 'launcher', 'no-verify'] as const).filter(
      (flag) => values[flag] !== undefined && values[flag] !== false && !allowed.includes(flag),
    );
    if (given.length > 0) throw usage(`connection ${subcommand} takes no --${given.join(', --')}`);
  };
  switch (sub) {
    case 'list': {
      if (rest.length > 0) throw usage(USAGE.list);
      onlyFor('list', []);
      writeResult(await connectionList(core, env), output, (result) => renderList(result.connections, env));
      return;
    }
    case 'show': {
      if (rest.length > 1) throw usage(USAGE.show);
      onlyFor('show', []);
      writeResult(await connectionShow(core, env, { id: rest[0] }), output, (shown) => renderShown(shown, env));
      return;
    }
    case 'add': {
      if (rest.length > 0 || values.app === undefined || values.name === undefined) throw usage(USAGE.add);
      onlyFor('add', ['app', 'name', 'parts', 'folder', 'profile', 'launcher', 'no-verify']);
      const words = ['connection', 'add', '--app', values.app, '--name', values.name];
      if (values.parts !== undefined) words.push('--parts', values.parts);
      if (values.folder !== undefined) words.push('--folder', values.folder);
      if (values.profile !== undefined) words.push('--profile', values.profile);
      if (values.launcher !== undefined) words.push('--launcher', values.launcher);
      if (values['no-verify']) words.push('--no-verify');
      const result = await gatedChangeAtTerminal(
        core,
        connectionAddChange(
          core,
          env,
          {
            app: values.app as ConnectionApp,
            name: values.name,
            ...(values.parts === undefined ? {} : { parts: parsePartsSpec(values.parts) }),
            ...(values.folder === undefined ? {} : { folder: values.folder }),
            ...(values.profile === undefined ? {} : { profile: values.profile }),
            ...(values.launcher === undefined ? {} : { launcher: values.launcher as ConnectionLauncher }),
            ...(values['no-verify'] ? { noVerify: true } : {}),
          },
          'cli',
          installDeps,
        ),
        {
          ...approval,
          rerun: words,
          appApproval,
          appReach: {
            clients: true,
            ...(values.profile === undefined
              ? {}
              : { folders: [{ what: 'the other profile’s folder', path: values.profile }] }),
          },
        },
      );
      writeResult(result, output, (added) => renderAdded(added, env));
      return;
    }
    case 'change': {
      if (rest.length !== 1 || values.parts === undefined) throw usage(USAGE.change);
      onlyFor('change', ['parts']);
      const id = rest[0] as string;
      const result = await gatedChangeAtTerminal(
        core,
        connectionChangeChange(
          core,
          env,
          // The approval it claims, either way it comes: what its preparation narrowed at once is read from it.
          { id, parts: parsePartsSpec(values.parts), approvalId: approval.approvalId ?? appApproval },
          'cli',
          installDeps,
        ),
        {
          ...approval,
          rerun: ['connection', 'change', id, '--parts', values.parts],
          appApproval,
          appReach: { clients: true },
        },
      );
      writeResult(result, output, renderChanged);
      return;
    }
    case 'rename': {
      if (rest.length !== 2) throw usage(USAGE.rename);
      onlyFor('rename', []);
      const [id, name] = rest as [string, string];
      const result = await gatedChangeAtTerminal(core, connectionRenameChange(core, env, { id, name }, 'cli'), {
        ...approval,
        rerun: ['connection', 'rename', id, name],
      });
      writeResult(
        result,
        output,
        (renamed) => `Renamed at once to “${renamed.connection.name}”. Activity uses the new name from now on.`,
      );
      return;
    }
    case 'key': {
      if (rest[0] !== 'replace' || rest.length !== 2) throw usage(USAGE.key);
      onlyFor('key replace', []);
      const id = rest[1] as string;
      const result = await gatedChangeAtTerminal(
        core,
        connectionKeyReplaceChange(core, env, { id }, 'cli', installDeps),
        {
          ...approval,
          rerun: ['connection', 'key', 'replace', id],
        },
      );
      writeResult(result, output, renderKey);
      return;
    }
    case 'migrate': {
      if (rest.length > 0) throw usage(USAGE.migrate);
      onlyFor('migrate', []);
      if (values.undo !== undefined) {
        if (values.client !== undefined) throw usage(USAGE.migrate);
        const result = await gatedChangeAtTerminal(
          core,
          connectionMigrateUndoChange(core, env, { id: values.undo }, 'cli', installDeps),
          {
            ...approval,
            rerun: ['connection', 'migrate', '--undo', values.undo],
            appApproval,
            appReach: { clients: true },
          },
        );
        writeResult(result, output, renderUndone);
        return;
      }
      const words = ['connection', 'migrate', ...(values.client === undefined ? [] : ['--client', values.client])];
      const result = await gatedChangeAtTerminal(
        core,
        connectionMigrateChange(core, env, { client: values.client }, 'cli', installDeps),
        { ...approval, rerun: words, appApproval, appReach: { clients: true } },
      );
      writeResult(result, output, renderMigrated);
      return;
    }
    case 'remove': {
      if (rest.length !== 1) throw usage(USAGE.remove);
      onlyFor('remove', []);
      const id = rest[0] as string;
      const result = await gatedChangeAtTerminal(core, connectionRemoveChange(core, env, { id }, 'cli'), {
        ...approval,
        rerun: ['connection', 'remove', id],
      });
      writeResult(result, output, renderRemoved);
      return;
    }
    default:
      throw usage(
        'usage: connection list | show [<id>] | add --app <app> --name <name> | change <id> --parts <part,…> | rename <id> <name> | key replace <id> | remove <id>',
      );
  }
}

// ── What a person reads ─────────────────────────────────────────────────────────────────────────────────────

function whereLine(view: ConnectionView, env: NodeJS.ProcessEnv): string {
  const home = homeDirectory(env);
  if (view.where === null) return '';
  const place =
    view.where.scope === 'local'
      ? `one project, ${shortenHome(view.where.folder ?? '', home)}`
      : view.app === 'manual'
        ? 'a snippet you paste'
        : 'every folder';
  const profile = view.where.configDir === null ? '' : `, profile ${shortenHome(view.where.configDir, home)}`;
  return `${place}${profile}`;
}

function viewLines(view: ConnectionView, env: NodeJS.ProcessEnv): string[] {
  if (!view.readable)
    return [
      `${view.id}  ${view.name ?? '(no name)'}  cannot be read, so it serves nothing`,
      ...view.problems.map((p) => `  ${p}`),
    ];
  const state = view.key.revoked
    ? 'cut off'
    : view.entry === null
      ? 'a snippet you paste'
      : view.entry.present === false
        ? `its entry is not in ${view.appLabel}`
        : view.entry.keyMatches === false
          ? 'its entry carries another key'
          : 'connected';
  return [
    `${view.name}  (${view.appLabel}, ${whereLine(view, env)})  ${state}`,
    `  id ${view.id}`,
    ...view.parts.map((part) => `  · ${part.text}${part.available ? '' : `: not started — ${part.why}`}`),
    `  ${view.lastUsed === null ? 'not used yet' : `last used ${view.lastUsed}`}`,
  ];
}

function renderList(views: readonly ConnectionView[], env: NodeJS.ProcessEnv): string {
  if (views.length === 0) return 'No MCP connections yet. Add one with connection add.';
  return views.map((view) => viewLines(view, env).join('\n')).join('\n\n');
}

function renderShown(shown: ConnectionShown, env: NodeJS.ProcessEnv): string {
  const running =
    shown.running.length === 0
      ? ['  nothing is running for it now']
      : shown.running.flatMap((gateway) => [
          `  running since ${gateway.startedAt}${gateway.client === null ? '' : ` for ${gateway.client.name}`}${gateway.refused === null ? '' : `, serving nothing: ${gateway.refused}`}`,
          ...gateway.parts.map(
            (part) => `    ${part.label}: ${part.state}${part.why === null ? '' : ` — ${part.why}`}`,
          ),
        ]);
  return [...viewLines(shown, env), ...running].join('\n');
}

function renderAdded(added: ConnectionAddResult, env: NodeJS.ProcessEnv): string {
  const lines = [`Added “${added.connection.name}”.`, ...viewLines(added.connection, env).slice(1)];
  if (added.verification === 'failed') lines.push(`It did not start when it was checked: ${added.verifyDetail ?? ''}`);
  if (added.snippets !== undefined) {
    lines.push('', 'The snippet, shown this once — with its key in it:', '', added.snippets.json);
  }
  lines.push('', added.next);
  return lines.join('\n');
}

function renderChanged(changed: ConnectionChangeResult): string {
  return [
    ...(changed.appliedAtOnce.length > 0 ? [`Applied at once: ${changed.appliedAtOnce.join('; ')}.`] : []),
    `“${changed.connection.name}” now has: ${changed.connection.parts.map((part) => part.text).join('; ') || 'no parts'}.`,
    changed.next,
  ].join('\n');
}

function renderKey(result: ConnectionKeyResult): string {
  return [
    'Replaced at once. The old key stopped working.',
    ...(result.snippets === undefined ? [] : ['', 'The new snippet, shown this once:', '', result.snippets.json]),
    result.next,
  ].join('\n');
}

function renderMigrated(result: MigrationResult): string {
  return [
    ...result.migrated.map(
      (each) =>
        `Moved ${each.replaced} entr${each.replaced === 1 ? 'y' : 'ies'} into the connection “${each.name}” (${each.app}).`,
    ),
    ...result.left.map((each) => `Left “${each.name}” in ${each.path}: ${each.why}.`),
    '',
    ...result.next,
  ].join('\n');
}

function renderUndone(result: MigrationUndoResult): string {
  return [
    `Undid “${result.name}”: ${result.registered.map((each) => `${each.server} as ${each.name}${each.applied ? '' : ' (not registered)'}`).join('; ')}.`,
    result.next,
  ].join('\n');
}

function renderRemoved(removed: ConnectionRemoveResult): string {
  return [
    `Removed${removed.name === null ? '' : ` “${removed.name}”`} at once.`,
    ...removed.entry.kept.map((kept) => `Its entry ${kept.name} in ${kept.path} was left: ${kept.reason}`),
    removed.next,
  ].join('\n');
}
