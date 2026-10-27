import { type AppOriginCheck, gatedChangeAtTerminal } from '../change-flow.ts';
import type { OutputOptions } from '../cli-runtime.ts';
import { writeResult } from '../cli-runtime.ts';
import type { Core } from '../core.ts';
import type { CommsError } from '../errors.ts';
import { wholeNumber } from '../numbers.ts';
import {
  type SearchDeleteResult,
  type SearchPersonView,
  type SearchQueryResult,
  type SearchSettingsRequest,
  type SearchSettingsResult,
  type SearchStatus,
  searchDeleteEverything,
  searchIndex,
  searchLabel,
  searchLink,
  searchPeople,
  searchPerson,
  searchQuery,
  searchRebuild,
  searchSettingsChange,
  searchShow,
  searchStatus,
  searchUnlink,
} from '../operations/search.ts';
import type { IndexRunResult, SearchDeps } from './indexer.ts';

/**
 * `agentcomms search …` (design 2026-10-26-local-search §8): the person's commands for Search on this machine. Each is
 * an operation in `operations/search.ts`, the same one the desktop app's allow-listed call runs; none has an MCP tool
 * (each is an exception row in `capabilities.json`). The refusals — inside an MCP server, under an agent's marker — are
 * the operations' own, so no surface can forget them.
 */

/** The options only `search` reads. `--account`, `--since`, `--limit` and `--channel` are shared with others. */
export const SEARCH_OPTIONS: readonly ['person', 'until', 'budget', 'direction', 'all', 'confirm'] = Object.freeze([
  'person',
  'until',
  'budget',
  'direction',
  'all',
  'confirm',
] as const);

export const SEARCH_USAGE: string =
  'usage: search status|query|people|person|show|index|rebuild|link|unlink|label|on|off|accounts add|remove|model set|none|delete';

export interface SearchCommandValues {
  readonly person?: string | undefined;
  readonly until?: string | undefined;
  readonly budget?: string | undefined;
  readonly direction?: string | undefined;
  readonly all?: boolean | undefined;
  readonly confirm?: boolean | undefined;
  readonly since?: string | undefined;
  readonly limit?: string | undefined;
  readonly channel?: string | undefined;
  readonly account?: string | undefined;
}

export interface SearchCommandContext {
  readonly core: Core;
  /** Every positional word, `search` first. */
  readonly positionals: readonly string[];
  readonly values: SearchCommandValues;
  /** Every `--account` given, in order: `query` takes several. */
  readonly accounts: readonly string[];
  readonly output: OutputOptions & { platform: NodeJS.Platform };
  readonly env: NodeJS.ProcessEnv;
  readonly approval: {
    channel: string;
    approvalId: string | undefined;
    env: NodeJS.ProcessEnv;
    output: OutputOptions & { platform: NodeJS.Platform };
    appOrigin?: AppOriginCheck | undefined;
  };
  readonly appApproval: string | undefined;
  readonly usage: (message: string) => CommsError;
  readonly deps?: SearchDeps | undefined;
}

/** Runs one `search` command and writes its result. */
export async function runSearchCommand(context: SearchCommandContext): Promise<void> {
  const { core, positionals, values, output, env, usage } = context;
  const [, sub, ...words] = positionals;
  const options = { env, ...(context.deps === undefined ? {} : { deps: context.deps }) };
  const given = (
    [
      ['person', values.person],
      ['until', values.until],
      ['budget', values.budget],
      ['direction', values.direction],
      ['all', values.all === true ? true : undefined],
      ['confirm', values.confirm === true ? true : undefined],
      ['since', values.since],
      ['limit', values.limit],
      ['channel', values.channel],
      ['account', context.accounts.length > 0 ? context.accounts : undefined],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([flag]) => flag);
  const taking = (taken: readonly string[]) => {
    const wrong = given.filter((flag) => !taken.includes(flag));
    if (wrong.length > 0) throw usage(`the search ${sub ?? ''} command takes no --${wrong.join(', --')}`);
  };
  const limit = (max: number) => wholeNumber(values.limit, { name: '--limit', min: 1, max });
  const budget = () => wholeNumber(values.budget, { name: '--budget', min: 0, max: 600 });
  const change = async (request: SearchSettingsRequest, rerun: readonly string[]) => {
    const result = await gatedChangeAtTerminal(core, searchSettingsChange(core, request, 'cli', options), {
      ...context.approval,
      rerun: ['search', ...rerun],
      ...(context.appApproval === undefined ? {} : { appApproval: context.appApproval }),
    });
    writeResult(result, output, renderSettingsChange);
  };
  switch (sub) {
    case 'status': {
      if (words.length > 0) throw usage('usage: search status');
      taking([]);
      writeResult(await searchStatus(core, options), output, renderStatus);
      return;
    }
    case 'query': {
      taking(['person', 'account', 'channel', 'since', 'until', 'direction', 'limit']);
      if (words.length === 0) {
        throw usage(
          'usage: search query <words…> [--person <id>] [--account <name>]… [--channel gmail|slack] [--since <when>] [--until <when>] [--direction in|out|any] [--limit <n>]',
        );
      }
      const result = await searchQuery(
        core,
        {
          text: words.join(' '),
          ...(values.person === undefined ? {} : { person: values.person }),
          ...(context.accounts.length === 0 ? {} : { accounts: context.accounts }),
          ...(values.channel === undefined ? {} : { channel: values.channel }),
          ...(values.since === undefined ? {} : { since: values.since }),
          ...(values.until === undefined ? {} : { until: values.until }),
          ...(values.direction === undefined ? {} : { direction: values.direction }),
          ...(values.limit === undefined ? {} : { limit: limit(50) }),
        },
        options,
      );
      writeResult(result, output, renderQuery);
      return;
    }
    case 'people': {
      if (words.length > 0) throw usage('usage: search people [--since <when>]');
      taking(['since']);
      writeResult(
        await searchPeople(core, values.since === undefined ? {} : { since: values.since }, options),
        output,
        (result) => renderPeople(result.people),
      );
      return;
    }
    case 'person': {
      if (words.length !== 1) throw usage('usage: search person <id> [--since <when>] [--limit <n>]');
      taking(['since', 'limit']);
      const result = await searchPerson(
        core,
        words[0] as string,
        {
          ...(values.since === undefined ? {} : { since: values.since }),
          ...(values.limit === undefined ? {} : { limit: limit(200) }),
        },
        options,
      );
      writeResult(result, output, (shown) =>
        [
          renderPeople([shown.person]),
          '',
          ...shown.messages.map(
            (message) =>
              `${new Date(message.at).toISOString()}  ${message.account.alias}  ${message.sourceId}\n${message.line}`,
          ),
          ...(shown.more ? ['', 'more: ask with a later --since or a larger --limit'] : []),
        ].join('\n'),
      );
      return;
    }
    case 'show': {
      if (words.length !== 1) throw usage('usage: search show <sourceId>');
      taking([]);
      const { message } = await searchShow(core, words[0] as string, options);
      writeResult({ message }, output, () =>
        [
          `${message.sourceId}  ${message.account.alias}  ${new Date(message.at).toISOString()}  ${message.direction}`,
          ...(message.from === null ? [] : [`from ${message.from}`]),
          ...(message.subject === null ? [] : [`subject ${message.subject}`]),
          message.text,
          ...message.answeredBy.map(
            (answer) => `answered by ${answer.sourceId} at ${new Date(answer.at).toISOString()}`,
          ),
        ].join('\n'),
      );
      return;
    }
    case 'index':
    case 'rebuild': {
      if (words.length > 0) throw usage(`usage: search ${sub} [--budget <seconds>]`);
      taking(['budget']);
      const seconds = budget();
      const request = seconds === undefined ? {} : { budgetSeconds: seconds };
      writeResult(
        sub === 'index' ? await searchIndex(core, request, options) : await searchRebuild(core, request, options),
        output,
        renderIndexRun,
      );
      return;
    }
    case 'link': {
      if (words.length !== 2) throw usage('usage: search link <person> <person>');
      taking([]);
      const result = await searchLink(core, words[0] as string, words[1] as string, options);
      writeResult(result, output, (linked) => `${linked.joined} is now ${linked.person}: ${linked.handles.join(', ')}`);
      return;
    }
    case 'unlink': {
      if (words.length !== 1) throw usage('usage: search unlink <handle>');
      taking([]);
      const result = await searchUnlink(core, words[0] as string, options);
      writeResult(
        result,
        output,
        (unlinked) => `${unlinked.handle} is now ${unlinked.person}, apart from ${unlinked.from}`,
      );
      return;
    }
    case 'label': {
      if (words.length < 2) throw usage('usage: search label <person> <name>');
      taking([]);
      const result = await searchLabel(core, words[0] as string, words.slice(1).join(' '), options);
      writeResult(result, output, (labelled) => `${labelled.person} is ${labelled.label}`);
      return;
    }
    case 'on':
    case 'off': {
      if (words.length > 0) throw usage(`usage: search ${sub}`);
      taking([]);
      await change({ enabled: sub }, [sub]);
      return;
    }
    case 'accounts': {
      const [action, alias, ...extra] = words;
      if ((action !== 'add' && action !== 'remove') || alias === undefined || extra.length > 0) {
        throw usage('usage: search accounts add|remove <account>');
      }
      taking([]);
      await change({ account: alias, include: action === 'add' }, ['accounts', action, alias]);
      return;
    }
    case 'model': {
      const [action, address, name, ...extra] = words;
      taking([]);
      if (action === 'none' && address === undefined) {
        await change({ model: null }, ['model', 'none']);
        return;
      }
      if (action !== 'set' || address === undefined || extra.length > 0) {
        throw usage('usage: search model set <address> [<model>] | search model none');
      }
      await change({ model: { address, ...(name === undefined ? {} : { name }) } }, [
        'model',
        'set',
        address,
        ...(name === undefined ? [] : [name]),
      ]);
      return;
    }
    case 'delete': {
      if (words.length > 0) throw usage('usage: search delete --all --confirm');
      taking(['all', 'confirm']);
      const result = await searchDeleteEverything(core, { all: values.all, confirm: values.confirm }, 'cli', options);
      writeResult(result, output, renderDelete);
      return;
    }
    default:
      throw usage(SEARCH_USAGE);
  }
}

// ── At a terminal ──────────────────────────────────────────────────────────────────────────────────────────────

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function renderStatus(status: SearchStatus): string {
  return [
    `search      ${status.on ? 'on' : 'off'}`,
    `accounts    ${status.accounts.length === 0 ? 'none' : status.accounts.map((account) => account.alias).join(', ')}`,
    `kept        ${counted(status.kept.messages, 'message')} (${status.kept.asked} asked, ${status.kept.answered} answered), ${counted(status.kept.people, 'person')}, ${Math.round(status.kept.bytes / 1024)} KiB${status.kept.oldestDay === null ? '' : `, from ${status.kept.oldestDay}`}`,
    `waiting     ${counted(status.kept.waiting, 'capture')}`,
    `for         ${counted(status.retentionDays, 'day')}, as Activity keeps them`,
    `words       ${status.words === 'ready' ? 'ready' : 'needs Node 22.18 or newer'}`,
    `model       ${status.model === null ? 'none: words only' : `${status.model.name} at ${status.model.address}: ${status.model.state} — ${status.model.detail}`}`,
    `backups     ${status.backups}`,
    `FileVault   ${status.diskEncryption}`,
    `key         ${status.key}, in the ${status.keyStore === 'keychain' ? 'system keychain' : 'secrets folder'}`,
    `folder      ${status.folder}`,
    ...status.notes.map((note) => `note        ${note}`),
    ...status.problems.map((problem) => `problem     ${problem}`),
  ].join('\n');
}

function renderQuery(result: SearchQueryResult): string {
  const head = `${result.mode === 'hybrid' ? 'By words and by meaning' : 'By words'}, on this machine: ${counted(result.hits.length, 'message')} of ${result.looked} looked through, in ${result.ms} ms${result.pending > 0 ? `; ${result.pending} not yet searchable by meaning` : ''}${result.modelNote === null ? '' : ` (${result.modelNote})`}`;
  return [
    head,
    ...result.hits.map((hit) =>
      [
        '',
        `${new Date(hit.at).toISOString()}  ${hit.account.alias}  ${hit.sourceId}${hit.person === null ? '' : `  ${hit.person.id}`}${hit.flags.length > 0 ? `  [${hit.flags.join(', ')}]` : ''}`,
        ...(hit.from === null ? [] : [hit.from]),
        hit.line,
        hit.excerpt,
        ...hit.answeredBy.map((answer) => `answered by ${answer.sourceId}`),
      ].join('\n'),
    ),
  ].join('\n');
}

function renderPeople(people: readonly SearchPersonView[]): string {
  if (people.length === 0) return 'no one yet';
  return people
    .map((person) =>
      [
        `${person.id}${person.label === null ? '' : `  ${person.label}`}  ${counted(person.count, 'message')}${person.lastAt === null ? '' : `, last ${new Date(person.lastAt).toISOString()}`}${person.linked ? '  (joined by you)' : ''}`,
        ...person.handles.map((handle) => `  ${handle.handle}${handle.name === null ? '' : `\n${handle.name}`}`),
      ].join('\n'),
    )
    .join('\n\n');
}

function renderIndexRun(run: IndexRunResult): string {
  if (run.busy) return 'Another index run is going: nothing was done here.';
  if (!run.ran) return 'Search has never been on here: nothing to index.';
  return [
    `Taken ${counted(run.taken, 'capture')}: ${run.inserted} new, ${run.replaced} replaced, ${run.unchanged} already kept, ${run.refused} not kept.`,
    `Pruned ${counted(run.pruned, 'message')}. Made ${counted(run.embedded, 'vector')}; ${run.pending} still to make.`,
    ...(run.model === null ? [] : [`Model: ${run.model.state} — ${run.model.detail}.`]),
    ...(run.stopped ? ['Stopped: everything is being deleted.'] : []),
  ].join('\n');
}

function renderSettingsChange(result: SearchSettingsResult): string {
  const now = `Search is ${result.on ? 'on' : 'off'}, for ${result.accounts.length === 0 ? 'no account' : result.accounts.map((account) => account.alias).join(', ')}, ${result.model === null ? 'by words only' : `with ${result.model.name} at ${result.model.address}`}.`;
  const deleted = result.deleted > 0 ? ` ${counted(result.deleted, 'kept message')} deleted.` : '';
  const next = result.next === null ? '' : ` If this machine does not have the model yet: ${result.next}`;
  return result.changed ? `${now}${deleted}${next}` : `Already so: nothing was changed. ${now}`;
}

function renderDelete(result: SearchDeleteResult): string {
  return `Deleted everything Search kept: ${counted(result.files, 'file')} in ${result.folder}${result.keyDeleted ? ', and its key' : ''}. Nothing in Slack or Gmail was touched.`;
}
