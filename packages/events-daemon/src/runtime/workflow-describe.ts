import type { DatabaseSync } from 'node:sqlite';
import { CommsError, newBoundary } from '@agentcomms/core';
import { ANALYSE_PROVIDERS, ANALYSE_ROUTES, type AnalyseProvider, isHeaderSafeKey } from '../domain/analyse-model.ts';
import {
  buildDescribeRequest,
  type DescribeNamesV1,
  type DescribePrompt,
  type DescribeProvider,
  describePrompt,
  describeResult,
  isDescribeProvider,
  parseDescribeRequest,
  readDescribeAnswer,
  type WorkflowDescribeResultV1,
} from '../domain/describe-brief.ts';
import type { EventSecretProvider } from '../domain/providers.ts';
import { AnalyseTransport } from './analyse-transport.ts';
import { checkRuleDocument } from './workflow/flow-test.ts';

/**
 * `workflow describe` in the event service (workflows design §11.4, W21): the names a draft may use, the prompt, and —
 * with a key kept for Analyse — the model's draft on Analyse's pinned transport and bounds (a 64 KB request, a 256 KB
 * response, a 4,096-token answer, 60 seconds). For the person's own Claude subscription the CLI runs `claude` in its
 * own process and hands the answer back here to be read and checked: the event service runs no program for it.
 *
 * Every draft is read strictly and checked in-process, with `parseRuleText` and then `workflow check`'s own
 * `checkRuleDocument` (B7) against this database. Nothing is written: no version, target, approval or run. It is the
 * person's alone: the owner takes it only from the person's origin, and no tool reaches it.
 */

/** The internal wire the CLI asks for the prompt on, before it runs `claude` itself: the person's, never a tool's. */
export const WORKFLOW_DESCRIBE_BRIEF_WIRE = 'workflow-describe-brief';

export interface WorkflowDescribeServiceOptions {
  readonly database: DatabaseSync;
  /** The accounts set up on this Mac: their stable ids, names and channels, read afresh at each call. */
  readonly accounts: () => Promise<
    readonly { readonly source: string; readonly accountId: string; readonly account: string }[]
  >;
  /** Whether each AI provider has a key: presence only. */
  readonly keyPresence: () => readonly { readonly provider: EventSecretProvider; readonly hasKey: boolean }[];
  /** The provider's key, read at the call and never kept, or null when it has none. */
  readonly keyFor: (provider: AnalyseProvider) => Promise<string | null>;
  readonly transport?: Pick<AnalyseTransport, 'call'> | undefined;
}

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

function documentOf(text: unknown): Row | null {
  if (typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function usage(message: string): never {
  throw new CommsError('USAGE', message);
}

/** The newest live version of each object a versioned table holds. */
function newestLive(database: DatabaseSync, table: 'target_versions' | 'judge_versions', idColumn: string): Row[] {
  const rows = database
    .prepare(
      `SELECT ${idColumn} AS id, version, document FROM ${table} AS outer_row
        WHERE revoked_at IS NULL
          AND version = (SELECT MAX(version) FROM ${table} AS inner_row
                          WHERE inner_row.${idColumn} = outer_row.${idColumn} AND inner_row.revoked_at IS NULL)
        ORDER BY ${idColumn}`,
    )
    .all() as unknown as { id: string; version: number; document: string }[];
  return rows.flatMap((row) => {
    const document = documentOf(row.document);
    return document === null ? [] : [{ ...document, __id: row.id, __version: row.version }];
  });
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The names a draft may use (§11.4), and nothing else of what they name: ids, aliases, kinds and the names the person
 * gave — never a profile, a folder, a URL, a template, a count, a subscriber or a secret.
 */
export async function describeNames(
  database: DatabaseSync,
  accounts: WorkflowDescribeServiceOptions['accounts'],
): Promise<DescribeNamesV1> {
  const targets = newestLive(database, 'target_versions', 'target_id');
  const judges = newestLive(database, 'judge_versions', 'judge_id');
  const lanes = targets.flatMap((target) =>
    target.kind === 'queue' && isRecord(target.lane) && text(target.lane.name) !== null
      ? [target.lane.name as string]
      : [],
  );
  const linear = targets.filter((target) => target.kind === 'linear' || target.kind === 'linear-change');
  const teams = linear.flatMap((target) =>
    isRecord(target.team) && text(target.team.key) !== null ? [target.team.key as string] : [],
  );
  const labelNames = linear.flatMap((target) => {
    const lists = Array.isArray(target.labels)
      ? [target.labels]
      : isRecord(target.labels)
        ? [target.labels.add, target.labels.remove]
        : [];
    return lists.flatMap((list) =>
      Array.isArray(list)
        ? list.flatMap((label) => (isRecord(label) && text(label.name) !== null ? [label.name as string] : []))
        : [],
    );
  });
  const states = linear.flatMap((target) =>
    isRecord(target.state) && text(target.state.name) !== null ? [target.state.name as string] : [],
  );
  const projects = database.prepare('SELECT id, name FROM projects ORDER BY id').all() as unknown as {
    id: string;
    name: string;
  }[];
  // The person's namespaces: those their workflows name their events in.
  const namespaces = (
    database.prepare("SELECT document FROM rule_versions WHERE state = 'active' ORDER BY rule_id").all() as unknown as {
      document: string;
    }[]
  ).flatMap((row) => {
    const flow = documentOf(row.document)?.flow;
    const events = isRecord(flow) ? flow.events : null;
    return isRecord(events) && text(events.namespace) !== null ? [events.namespace as string] : [];
  });
  const sorted = (values: readonly string[]) => [...new Set(values)].sort();
  return {
    accounts: (await accounts()).map((account) => ({
      accountId: account.accountId,
      channel: account.source,
      alias: account.account,
    })),
    lanes: sorted(lanes),
    judges: judges.flatMap((judge) =>
      text(judge.kind) === null
        ? []
        : [{ judgeId: judge.__id as string, version: judge.__version as number, kind: judge.kind as string }],
    ),
    targets: targets.flatMap((target) =>
      text(target.kind) === null
        ? []
        : [{ targetId: target.__id as string, version: target.__version as number, kind: target.kind as string }],
    ),
    projects: projects.map((project) => ({ projectId: project.id, name: project.name })),
    namespaces: sorted(namespaces),
    linear: { teams: sorted(teams), labels: sorted(labelNames), states: sorted(states) },
  };
}

export class WorkflowDescribeService {
  readonly #database: DatabaseSync;
  readonly #accounts: WorkflowDescribeServiceOptions['accounts'];
  readonly #keyPresence: WorkflowDescribeServiceOptions['keyPresence'];
  readonly #keyFor: WorkflowDescribeServiceOptions['keyFor'];
  readonly #transport: Pick<AnalyseTransport, 'call'>;

  constructor(options: WorkflowDescribeServiceOptions) {
    this.#database = options.database;
    this.#accounts = options.accounts;
    this.#keyPresence = options.keyPresence;
    this.#keyFor = options.keyFor;
    this.#transport = options.transport ?? new AnalyseTransport();
  }

  /** The prompt for the person's own `claude`: the CLI sends it, in its own process. */
  async brief(args: Readonly<Record<string, unknown>>): Promise<DescribePrompt> {
    for (const key of Object.keys(args)) if (key !== 'request') usage(`the brief takes no ${key.slice(0, 40)}`);
    const request = parseDescribeRequest(args.request);
    return describePrompt({
      request,
      names: await describeNames(this.#database, this.#accounts),
      boundary: newBoundary(),
    });
  }

  /**
   * `workflow-describe`: `{ request, provider?, answer?, model? }`. With `answer` — the text `claude` gave the CLI — it is
   * read and checked; otherwise the draft comes from the key's provider, the one named or the first with a key.
   */
  async describe(args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<WorkflowDescribeResultV1> {
    for (const key of Object.keys(args))
      if (!['request', 'provider', 'answer', 'model'].includes(key))
        usage(`workflow describe takes no ${key.slice(0, 40)}`);
    const request = parseDescribeRequest(args.request);
    const named = args.provider;
    if (named !== undefined && !isDescribeProvider(named))
      usage('Describe it’s provider is claude-cli, openrouter or anthropic');
    const check = (document: Readonly<Record<string, unknown>>) => checkRuleDocument(this.#database, document);
    if (args.answer !== undefined) {
      if (named !== 'claude-cli') usage('an answer is handed back only from the person’s own claude');
      if (typeof args.answer !== 'string') usage('an answer is text');
      const model = args.model === undefined || args.model === null ? null : args.model;
      if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9._:@/-]{1,128}$/u.test(model)))
        usage('a model is a name');
      return this.#read(request, args.answer, { provider: 'claude-cli', model }, check);
    }
    if (named === 'claude-cli') usage('the person’s own claude runs in the CLI, which hands its answer back');
    const provider = this.#provider(named as DescribeProvider | undefined);
    const key = await this.#keyFor(provider);
    if (key === null || !isHeaderSafeKey(key))
      throw new CommsError(
        'AUTH_REQUIRED',
        `there is no usable ${ANALYSE_ROUTES[provider].name} key kept for Analyse`,
        {
          details: { reason: key === null ? 'NO_KEY' : 'KEY_MALFORMED', provider },
          hint: `Set one in Settings → AI providers, or: provider key set ${provider}.`,
        },
      );
    const prompt = describePrompt({
      request,
      names: await describeNames(this.#database, this.#accounts),
      boundary: newBoundary(),
    });
    const route = ANALYSE_ROUTES[provider];
    const result = await this.#transport.call(route, buildDescribeRequest({ provider, key, prompt }), signal);
    if (result.kind === 'refused')
      throw new CommsError('PROVIDER_UNAVAILABLE', `${route.name} gave no draft`, {
        details: { reason: result.code, provider },
        hint: 'Try again, or pick another provider.',
      });
    return this.#read(request, result.text, { provider, model: route.model }, check);
  }

  /** The provider a key path runs on: the one named, else the first with a key, OpenRouter first. */
  #provider(named: DescribeProvider | undefined): AnalyseProvider {
    if (named !== undefined) return named as AnalyseProvider;
    const presence = new Map(this.#keyPresence().map((entry) => [entry.provider, entry.hasKey]));
    const found = ANALYSE_PROVIDERS.find((provider) => presence.get(provider) === true);
    if (found === undefined)
      throw new CommsError(
        'AUTH_REQUIRED',
        'no Claude on this Mac, and no OpenRouter or Anthropic key kept for Analyse',
        {
          details: { reason: 'NO_PROVIDER' },
          hint: 'Sign in to Claude Code on this Mac, or set a key in Settings → AI providers.',
        },
      );
    return found;
  }

  #read(
    request: ReturnType<typeof parseDescribeRequest>,
    text: string,
    model: WorkflowDescribeResultV1['model'],
    check: (document: Readonly<Record<string, unknown>>) => NonNullable<WorkflowDescribeResultV1['check']>,
  ): WorkflowDescribeResultV1 {
    const answer = readDescribeAnswer(text);
    if (answer === null)
      throw new CommsError('PROVIDER_UNAVAILABLE', 'the model’s answer was not a draft Describe it can read', {
        details: { reason: 'RESPONSE_MALFORMED', provider: model.provider },
        hint: 'Try again.',
      });
    return describeResult({ request, answer, model, check });
  }
}
