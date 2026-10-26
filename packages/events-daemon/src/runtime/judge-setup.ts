import { type AuditLog, CommsError, canonicalJson } from '@agentcomms/core';
import { HumanSecret } from '../domain/human-secret.ts';
import {
  isSetupJudgeKind,
  localSetupEndpoint,
  localSetupModel,
  PERSON_SETUP_ORIGIN,
  type SetupJudgeKind,
  setupBudgetDocument,
  setupJudgeDocument,
} from '../domain/judge-setup.ts';
import {
  type CanonicalJudgeBudgetDocument,
  canonicalJudge,
  isJevProvider,
  JEV_PROVIDER_ROUTES,
  type JevProvider,
  JUDGE_BUDGET_ID,
} from '../domain/judges.ts';
import { JUDGE_KIND_TYPESAFE } from '../domain/lifecycle.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import type { B3OwnerService } from '../operations/b3-contract.ts';
import type { EventDatabase } from '../store/database.ts';
import { EVENT_SECRET_PROVIDERS, type EventSecretProvider } from '../store/event-secrets.ts';
import type { ActivationRuntime, PreparedActivation } from './activations.ts';
import type { B3SecretControl } from './b3-secret-control.ts';
import { type WriterQuiescer, withEventWriterLease } from './writer-quiescer.ts';

export { PERSON_SETUP_ORIGIN } from '../domain/judge-setup.ts';

/** Who approved a setup's enablements: the person, through the desktop app or the CLI command it runs. */
export const SETUP_APPROVED_BY = 'desktop-app';

/** The AI providers a person keeps keys for, as Settings → AI providers names them. */
export const PROVIDER_NAMES: Readonly<Record<EventSecretProvider, string>> = Object.freeze({
  typesafe: 'TypeSafe',
  openrouter: 'OpenRouter',
});

export interface ProviderListResultV1 {
  readonly providers: readonly { readonly id: EventSecretProvider; readonly name: string; readonly hasKey: boolean }[];
}

export interface ProviderKeyResultV1 {
  readonly provider: EventSecretProvider;
  readonly hasKey: boolean;
  /** Live Jev judge versions of this provider that now hold the key, or, after a removal, hold none. */
  readonly judges: number;
}

export interface JudgeSetupResultV1 {
  readonly kind: SetupJudgeKind;
  readonly enabled: true;
  /** Whether this run turned the kind on; false when it was on already. */
  readonly enabledNow: boolean;
  readonly judge: {
    readonly judgeId: string;
    readonly version: number;
    readonly provider: string;
    readonly model: string;
    readonly endpoint: string;
    /** Whether this run made the version; false when the same judge was set up already. */
    readonly created: boolean;
  };
  /** The daemon-wide judge budget in force, and whether this run approved it. */
  readonly budget: {
    readonly version: number;
    readonly approvedNow: boolean;
    readonly global: CanonicalJudgeBudgetDocument['global'];
    readonly provider: CanonicalJudgeBudgetDocument['providers'][number];
  };
  /** Jev's key: given from the provider's stored key, already there, or none (a local server needs none). */
  readonly key: 'stored' | 'unchanged' | 'none';
  /** Where the fields a rule names go when it asks this judge. */
  readonly destination: string;
  readonly approvedBy: typeof SETUP_APPROVED_BY;
}

/** The plain words for where a judge's fields go: the disclosure the person agrees to by setting it up. */
export function judgeDestination(kind: SetupJudgeKind, provider: string): string {
  if (kind !== JUDGE_KIND_TYPESAFE) return 'A model server on this machine. Nothing leaves it.';
  return provider === 'openrouter'
    ? "Messages your rules choose are sent to OpenRouter (openrouter.ai), which passes them to TypeSafe's Jev to be judged."
    : 'Messages your rules choose are sent to TypeSafe (api.typesafe.ai) to be judged by Jev.';
}

function provider(value: unknown): EventSecretProvider {
  if (typeof value !== 'string' || !(EVENT_SECRET_PROVIDERS as readonly string[]).includes(value))
    throw new CommsError('USAGE', 'the AI provider is typesafe or openrouter');
  return value as EventSecretProvider;
}

/**
 * The person's setup: Jev or a local model server set up and turned on in one step, and the AI provider keys Jev uses.
 * Every enablement it needs — the judge kind and, when it has none for the provider, the daemon-wide budget — is D2's
 * own disclosure approval, prepared and approved here through the app channel, so the activation records and their
 * recovery are the same as a typed approval's; the command itself is the person's approval (owner decision 2026-10-26).
 */
export class JudgeSetupService {
  readonly #store: EventDatabase;
  readonly #b3: B3OwnerService;
  readonly #activations: Pick<ActivationRuntime, 'issueApprovalViewChallenge' | 'approve'>;
  readonly #secrets: Pick<
    B3SecretControl,
    'providerKeys' | 'providerKeySet' | 'providerKeyRemove' | 'syncJudgeKeyFromProvider'
  >;
  readonly #quiescer: WriterQuiescer;
  readonly #audit: Pick<AuditLog, 'append'> | undefined;
  readonly #now: () => number;

  constructor(input: {
    readonly store: EventDatabase;
    readonly b3: B3OwnerService;
    readonly activations: Pick<ActivationRuntime, 'issueApprovalViewChallenge' | 'approve'>;
    readonly secrets: Pick<
      B3SecretControl,
      'providerKeys' | 'providerKeySet' | 'providerKeyRemove' | 'syncJudgeKeyFromProvider'
    >;
    readonly quiescer: WriterQuiescer;
    readonly audit?: Pick<AuditLog, 'append'> | undefined;
    readonly now?: (() => number) | undefined;
  }) {
    this.#store = input.store;
    this.#b3 = input.b3;
    this.#activations = input.activations;
    this.#secrets = input.secrets;
    this.#quiescer = input.quiescer;
    this.#audit = input.audit;
    this.#now = input.now ?? Date.now;
  }

  providerList(): ProviderListResultV1 {
    return {
      providers: this.#secrets
        .providerKeys()
        .map((entry) => ({ id: entry.provider, name: PROVIDER_NAMES[entry.provider], hasKey: entry.hasKey })),
    };
  }

  async providerKeySet(
    args: Readonly<Record<string, unknown>>,
    origin: string | undefined,
  ): Promise<ProviderKeyResultV1> {
    const id = provider(args.provider);
    return this.#audited('providerKeySet', origin, { provider: id }, async () => {
      if (typeof args.hidden !== 'string' || args.hidden.length === 0)
        throw new CommsError('USAGE', 'the provider key is required');
      if (/[\r\n]/u.test(args.hidden) || args.hidden.length > 4096)
        throw new CommsError('USAGE', 'a provider key is one line of at most 4096 characters');
      return this.#secrets.providerKeySet({ provider: id, hidden: HumanSecret.fromTrustedInput(args.hidden) });
    });
  }

  async providerKeyRemove(
    args: Readonly<Record<string, unknown>>,
    origin: string | undefined,
  ): Promise<ProviderKeyResultV1> {
    const id = provider(args.provider);
    return this.#audited('providerKeyRemove', origin, { provider: id }, () =>
      this.#secrets.providerKeyRemove({ provider: id }),
    );
  }

  async setup(args: Readonly<Record<string, unknown>>, origin: string | undefined): Promise<JudgeSetupResultV1> {
    const kind = args.kind;
    if (!isSetupJudgeKind(kind)) throw new CommsError('USAGE', 'judge setup takes typesafe or local-endpoint');
    // Every word is checked before anything is written, and so is the provider's key: a setup that cannot finish
    // turns nothing on.
    let wanted: Record<string, unknown>;
    let jevProvider: JevProvider | undefined;
    if (kind === JUDGE_KIND_TYPESAFE) {
      if (args.url !== undefined || args.model !== undefined)
        throw new CommsError('USAGE', 'Jev takes --provider, not a URL or a model');
      const chosen = args.provider ?? 'typesafe';
      if (!isJevProvider(chosen)) throw new CommsError('USAGE', 'Jev’s provider is typesafe or openrouter');
      jevProvider = chosen;
      wanted = setupJudgeDocument({ kind, provider: chosen });
    } else {
      if (args.provider !== undefined)
        throw new CommsError('USAGE', 'a local model server takes --url and --model, not a provider');
      wanted = setupJudgeDocument({ kind, endpoint: localSetupEndpoint(args.url), model: localSetupModel(args.model) });
    }
    const ids: Record<string, string> = {
      kind,
      ...(jevProvider === undefined ? {} : { provider: jevProvider }),
      // The command is the person's approval of the enablements it makes (owner decision 2026-10-26).
      approvedBy: SETUP_APPROVED_BY,
    };
    return this.#audited('judgeSetup', origin, ids, async () => {
      if (
        jevProvider !== undefined &&
        !this.#secrets.providerKeys().some((entry) => entry.provider === jevProvider && entry.hasKey)
      )
        throw new CommsError(
          'CONFIG',
          `there is no ${JEV_PROVIDER_ROUTES[jevProvider].name} key yet: add one in Settings → AI providers, or with provider key set at your terminal`,
          { details: { reason: 'PROVIDER_KEY_MISSING', provider: jevProvider } },
        );
      // 1. The judge: the same version again when nothing changed, otherwise the next one.
      const judge = await this.#judgeVersion(wanted);
      ids.judgeId = judge.judgeId;
      ids.judgeVersion = String(judge.version);
      // 2. Its key, given from the provider's stored key.
      const key =
        jevProvider === undefined
          ? ('none' as const)
          : await this.#secrets.syncJudgeKeyFromProvider({
              judgeId: judge.judgeId,
              version: judge.version,
              provider: jevProvider,
            });
      // 3. The daemon-wide budget, when there is none for the judge's provider.
      const budget = await this.#budget(judge.provider);
      // 4. The kind, last: nothing is turned on until everything it needs is in place.
      const enabledNow = await this.#enableKind(kind);
      return {
        kind,
        enabled: true,
        enabledNow,
        judge,
        budget,
        key,
        destination: judgeDestination(kind, judge.provider),
        approvedBy: SETUP_APPROVED_BY,
      };
    });
  }

  /** Reuses the latest live version when it is the judge wanted; otherwise adds the next version. */
  async #judgeVersion(wanted: Record<string, unknown>): Promise<JudgeSetupResultV1['judge']> {
    const judgeId = wanted.judgeId as string;
    const rows = this.#store.database
      .prepare('SELECT version, document, revoked_at FROM judge_versions WHERE judge_id = ? ORDER BY version')
      .all(judgeId) as Array<{ version: number; document: string; revoked_at: number | null }>;
    const live = rows.filter((row) => row.revoked_at === null).at(-1);
    const shape = (document: Record<string, unknown>) => canonicalJson({ ...document, version: 0 });
    const described = (document: Record<string, unknown>, version: number, created: boolean) => ({
      judgeId,
      version,
      provider: document.provider as string,
      model: document.model as string,
      endpoint: document.endpoint as string,
      created,
    });
    if (live !== undefined) {
      const stored = JSON.parse(live.document) as Record<string, unknown>;
      if (shape(stored) === shape(wanted)) return described(stored, live.version, false);
    }
    const version = (rows.at(-1)?.version ?? 0) + 1;
    const document = canonicalJudge({ ...wanted, version }) as unknown as Record<string, unknown>;
    await this.#b3.handle({ operation: 'addJudge', args: { document } });
    return described(document, version, true);
  }

  async #budget(judgeProvider: string): Promise<JudgeSetupResultV1['budget']> {
    const versions = new ImmutableVersions(this.#store.database);
    const activePointer = versions.activeVersion('judge-budget', JUDGE_BUDGET_ID);
    const active = activePointer === null ? null : versions.loadJudgeBudget(activePointer.version);
    const latest = this.#store.database.prepare('SELECT max(version) AS version FROM judge_budget_versions').get() as {
      version: number | null;
    };
    const document = setupBudgetDocument(active, judgeProvider, (latest.version ?? 0) + 1);
    const applied = document ?? active;
    if (applied === null) throw new CommsError('BAD_DATA', 'the judge budget could not be read');
    const providerLimits = applied.providers.find((entry) => entry.provider === judgeProvider);
    if (providerLimits === undefined) throw new CommsError('BAD_DATA', 'the judge budget has no ceiling for the judge');
    if (document !== null) {
      const prepared = (await this.#b3.handle({ operation: 'updateBudget', args: { document } })) as PreparedActivation;
      await this.#approve(prepared);
    }
    return {
      version: applied.version,
      approvedNow: document !== null,
      global: applied.global,
      provider: providerLimits,
    };
  }

  async #enableKind(kind: SetupJudgeKind): Promise<boolean> {
    const versions = new ImmutableVersions(this.#store.database);
    if (versions.activeVersion('judge-kind', kind) !== null) return false;
    const prepared = (await this.#b3.handle({ operation: 'enableJudgeKind', args: { kind } })) as PreparedActivation;
    if (typeof prepared?.approvalId !== 'string')
      throw new CommsError('CONFIG', 'the judge kind could not be prepared for its approval');
    await this.#approve(prepared);
    return true;
  }

  /**
   * D2's own approval, through the app channel: the owner issues the approval's challenge and answers it at once, so
   * core records the disclosure approved via `app` and claims it, and the activation completes as a typed approval does.
   */
  async #approve(prepared: PreparedActivation): Promise<void> {
    const challenge = await this.#activations.issueApprovalViewChallenge(prepared.approvalId, this.#now() + 5 * 60_000);
    if (challenge === null) throw new CommsError('APPROVAL_VOID', 'the setup approval could not be issued');
    await withEventWriterLease(this.#quiescer, () =>
      this.#activations.approve({ approvalId: prepared.approvalId, answer: challenge, via: 'app' }),
    );
  }

  /** The person's origin only, and an audit line of its outcome: ids and the outcome, never a key. */
  async #audited<T>(
    operation: 'judgeSetup' | 'providerKeySet' | 'providerKeyRemove',
    origin: string | undefined,
    ids: Record<string, string>,
    work: () => Promise<T>,
  ): Promise<T> {
    const record = async (outcome: 'ok' | 'refused' | 'failed', reason?: string) =>
      this.#audit?.append({
        inboxId: '',
        operation: `events.${operation}`,
        outcome,
        surface: 'app',
        origin: 'app',
        ids: { ...ids },
        ...(reason === undefined ? {} : { reason }),
      });
    if (origin !== PERSON_SETUP_ORIGIN) {
      await record('refused', 'PERSON_SETUP_ONLY');
      throw new CommsError('APPROVAL_REQUIRED', 'this is the person’s own setup, from the app or their terminal');
    }
    try {
      const result = await work();
      await record('ok');
      return result;
    } catch (error) {
      await record('failed');
      throw error;
    }
  }
}
