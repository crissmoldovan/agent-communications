import { CommsError, canonicalJson, newBoundary, wrapUntrusted } from '@agentcomms/core';
import type { JsonValue } from '@agentcomms/events';
import {
  ANALYSE_PROVIDERS,
  ANALYSE_ROUTES,
  type AnalyseProvider,
  buildAnalyseRequest,
  chooseAnalyseProvider,
  isAnalyseProvider,
  isHeaderSafeKey,
} from '../domain/analyse-model.ts';
import { ANALYSE_PROMPTS } from '../domain/analyse-prompts.ts';
import { MESSAGE_DECISION_OUTCOMES, type MessageDecisionOutcome } from '../domain/messages.ts';
import type { EventSecretProvider } from '../domain/providers.ts';
import {
  ANALYSE_SENT,
  ANALYSE_WINDOW_MS,
  deterministicSuggestions,
  type JudgedFact,
  type ModelPartRequest,
  modelInput,
  modelPartsOf,
  type QueueFact,
  type RuleAnalyseFacts,
  type RuleAnalyseModelV1,
  type RuleAnalyseResultV1,
  type RuleSuggestionV1,
  readModelAnswer,
  summariseAnalyseFacts,
} from '../domain/rule-analyse.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { AnalyseTransport } from './analyse-transport.ts';
import { senderDomainLocation } from './sender-domains.ts';

/**
 * `rule analyse <ruleId> [--draft -]` in the event service (0.33.0 design §3.3): the person's view, reached only from
 * the CLI and the app. It reads the rule's stored version (the active one, else the newest) or the person's draft, and
 * content-free counts of the rule's last 30 days: its decisions and their outcomes; the judge's answers, their spread
 * and, per sending domain, what it said — from each decision's encrypted judge metadata, which holds numbers and that
 * domain, never a message; and its queue items done or dismissed against the judge's number. It reads no ingest
 * projection, no queue item's content, no delivery record and no dry-run log, so no subject, body, snippet or address.
 *
 * It suggests from the counts alone, and then asks a model — on the provider the person picks among those with a key —
 * to improve the judge's question, a session's text and a Linear title, each through its fixed brief, sending only the
 * rule's own text and the counts. It never applies anything and writes nothing.
 */

/** At most this many of the newest judged decisions are read; the counts say how many decisions there were in all. */
export const ANALYSE_MAX_DECISIONS_READ = 2_000;
/** A draft is at most this large, as JSON: it travels in one control frame. */
export const ANALYSE_DRAFT_MAX_BYTES: number = 48 * 1024;

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface RuleAnalyseServiceOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'decrypt'>;
  /** Whether each AI provider has a key: presence only. */
  readonly keyPresence: () => readonly { readonly provider: EventSecretProvider; readonly hasKey: boolean }[];
  /** The provider's key, read at the call and never kept, or null when it has none. */
  readonly keyFor: (provider: AnalyseProvider) => Promise<string | null>;
  readonly transport?: Pick<AnalyseTransport, 'call'> | undefined;
  readonly now?: (() => number) | undefined;
}

interface DecisionRow {
  readonly id: string;
  readonly outcome: string;
  readonly metadata_state: string;
  readonly encrypted_record: Uint8Array | null;
  readonly hold_created_at: number | null;
}

/** A part's answer: a suggestion, nothing to change (null), or the closed word for why there is none. */
type AskResult = { readonly after: string; readonly why: string } | null | string;

interface JudgeMetadata {
  readonly value: number;
  readonly threshold: number;
  readonly judgeId: string | null;
}

function usage(message: string): never {
  throw new CommsError('USAGE', message);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** `rule analyse`'s arguments, read strictly: a rule id, an optional draft object, an optional provider. */
export function parseRuleAnalyseArguments(args: Readonly<Record<string, unknown>>): {
  readonly ruleId: string;
  readonly draft: Readonly<Record<string, unknown>> | undefined;
  readonly provider: AnalyseProvider | undefined;
} {
  for (const key of Object.keys(args))
    if (!['ruleId', 'draft', 'provider'].includes(key)) usage(`workflow analyse takes no ${key.slice(0, 40)}`);
  const { ruleId, draft, provider } = args;
  if (typeof ruleId !== 'string' || !RULE_ID.test(ruleId))
    usage('a workflow id is a word of letters, digits and . _ : -');
  if (provider !== undefined && !isAnalyseProvider(provider))
    usage(`Analyse's provider is ${ANALYSE_PROVIDERS.join(' or ')}`);
  if (draft === undefined) return { ruleId, draft: undefined, provider };
  const document = record(draft);
  if (document === null) usage('a draft is one JSON object: a workflow document');
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalJson(document as JsonValue));
  } catch {
    usage('a draft is plain JSON');
  }
  if (bytes > ANALYSE_DRAFT_MAX_BYTES) usage(`a draft is at most ${ANALYSE_DRAFT_MAX_BYTES} bytes of JSON`);
  if (document.ruleId !== undefined && document.ruleId !== ruleId) usage('the draft is a version of another workflow');
  return { ruleId, draft: document, provider };
}

export class RuleAnalyseService {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly #keyPresence: RuleAnalyseServiceOptions['keyPresence'];
  readonly #keyFor: RuleAnalyseServiceOptions['keyFor'];
  readonly #transport: Pick<AnalyseTransport, 'call'>;
  readonly #now: () => number;

  constructor(options: RuleAnalyseServiceOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#keyPresence = options.keyPresence;
    this.#keyFor = options.keyFor;
    this.#transport = options.transport ?? new AnalyseTransport();
    this.#now = options.now ?? Date.now;
  }

  async analyse(args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<RuleAnalyseResultV1> {
    const { ruleId, draft, provider: named } = parseRuleAnalyseArguments(args);
    const stored = this.#stored(ruleId);
    if (stored === null && draft === undefined)
      throw new CommsError('NOT_FOUND', 'the requested workflow does not exist', {
        hint: 'workflows list gives every workflow; a new workflow is analysed as a draft, with --draft -.',
      });
    const document = draft ?? (stored?.document as Readonly<Record<string, unknown>>);
    const facts = await this.#facts(ruleId, document);
    const boundary = newBoundary();
    const wrapDomain = (domain: string) => wrapUntrusted(domain, { field: 'senderDomain' }, boundary);
    const counts = summariseAnalyseFacts(facts, wrapDomain);
    const suggestions: RuleSuggestionV1[] = [
      ...deterministicSuggestions(document, facts, { hasHistory: stored !== null, wrapDomain }),
    ];
    const { model, suggested } = await this.#model(document, counts, named, signal);
    suggestions.push(...suggested);
    return {
      ruleId,
      analysed: draft === undefined ? { source: 'stored', version: stored?.version as number } : { source: 'draft' },
      counts,
      suggestions,
      model,
    };
  }

  /** The rule's active version, else its newest; null when it has none. */
  #stored(ruleId: string): { readonly version: number; readonly document: unknown } | null {
    const rows = this.#store.database
      .prepare('SELECT version, document, state FROM rule_versions WHERE rule_id = ? ORDER BY version DESC')
      .all(ruleId) as unknown as { version: number; document: string; state: string | null }[];
    const chosen = rows.find((row) => row.state === 'active') ?? rows[0];
    return chosen === undefined ? null : { version: chosen.version, document: JSON.parse(chosen.document) };
  }

  /** The decision's judge metadata: its number, bar and judge; null when there is none, or none kept. */
  async #metadata(row: Pick<DecisionRow, 'id' | 'metadata_state' | 'encrypted_record'>): Promise<JudgeMetadata | null> {
    if (row.metadata_state === 'purged' || row.encrypted_record === null) return null;
    let metadata: Readonly<Record<string, unknown>> | null;
    try {
      metadata = record(
        JSON.parse(
          (
            await this.#cipher.decrypt(
              { table: 'decisions', column: 'encryptedRecord', key: [{ type: 'text', value: row.id }] },
              row.encrypted_record,
            )
          ).toString('utf8'),
        ),
      );
    } catch (error) {
      if (error instanceof RecordStorageError || error instanceof SyntaxError) return null;
      throw error;
    }
    // Only these three fields are read from it; nothing else in it could reach a result or a model.
    const value = metadata?.value;
    const threshold = metadata?.threshold;
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof threshold !== 'number') return null;
    return {
      value,
      threshold,
      judgeId: typeof metadata?.judgeId === 'string' ? metadata.judgeId : null,
    };
  }

  /**
   * The sending domains this rule's decisions still keep — each only until its projection's deadline (security review
   * of 0.33.0, finding 9) — by decision id. A domain that cannot be opened is left out.
   */
  async #senderDomains(ruleId: string): Promise<ReadonlyMap<string, string>> {
    const rows = this.#store.database
      .prepare(
        `SELECT decision_id, encrypted_domain FROM decision_sender_domains
          WHERE rule_id = ? AND expires_at > ?
          LIMIT ?`,
      )
      .all(ruleId, this.#now(), ANALYSE_MAX_DECISIONS_READ) as unknown as {
      decision_id: string;
      encrypted_domain: Uint8Array;
    }[];
    const domains = new Map<string, string>();
    for (const row of rows) {
      try {
        domains.set(
          row.decision_id,
          (await this.#cipher.decrypt(senderDomainLocation(row.decision_id), row.encrypted_domain)).toString('utf8'),
        );
      } catch (error) {
        if (!(error instanceof RecordStorageError)) throw error;
      }
    }
    return domains;
  }

  async #facts(ruleId: string, document: Readonly<Record<string, unknown>>): Promise<RuleAnalyseFacts> {
    const since = this.#now() - ANALYSE_WINDOW_MS;
    const database = this.#store.database;
    // A decision is in the window when its event was observed in it, as `rule show` counts (the event service keeps no
    // decision time).
    const decisions = database
      .prepare(
        `SELECT d.id, d.outcome, d.metadata_state, d.encrypted_record, d.hold_created_at
           FROM decisions AS d JOIN ingest AS i ON i.event_id = d.event_id
          WHERE d.rule_id = ? AND i.observed_at >= ?
          ORDER BY i.observed_at DESC, d.id`,
      )
      .all(ruleId, since) as unknown as DecisionRow[];
    const outcomes = Object.fromEntries(MESSAGE_DECISION_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
      MessageDecisionOutcome,
      number
    >;
    for (const row of decisions)
      if ((MESSAGE_DECISION_OUTCOMES as readonly string[]).includes(row.outcome))
        outcomes[row.outcome as MessageDecisionOutcome] += 1;
    const read = new Map<string, JudgeMetadata | null>();
    const metadataOf = async (row: Pick<DecisionRow, 'id' | 'metadata_state' | 'encrypted_record'>) => {
      if (!read.has(row.id)) read.set(row.id, await this.#metadata(row));
      return read.get(row.id) ?? null;
    };
    const domains = await this.#senderDomains(ruleId);
    const judged: JudgedFact[] = [];
    for (const row of decisions.slice(0, ANALYSE_MAX_DECISIONS_READ)) {
      const metadata = await metadataOf(row);
      if (metadata === null) continue;
      judged.push({
        value: metadata.value,
        yes: metadata.value >= metadata.threshold,
        held: row.outcome === 'hold' || row.hold_created_at !== null,
        senderDomain: domains.get(row.id) ?? null,
      });
    }
    // The judge's number for each item the person kept or dismissed — only this judge's, so the numbers compare.
    const judgeId = record(record(document.agentic)?.judge)?.judgeId;
    const items = database
      .prepare(
        `SELECT q.state, d.id, d.metadata_state, d.encrypted_record
           FROM queue_items AS q LEFT JOIN decisions AS d ON d.id = q.decision_id
          WHERE q.rule_id = ? AND q.arrived_at >= ?
          ORDER BY q.arrived_at DESC, q.id
          LIMIT ?`,
      )
      .all(ruleId, since, ANALYSE_MAX_DECISIONS_READ) as unknown as {
      state: QueueFact['state'];
      id: string | null;
      metadata_state: string | null;
      encrypted_record: Uint8Array | null;
    }[];
    const queue: QueueFact[] = [];
    for (const item of items) {
      const metadata =
        item.id === null || typeof judgeId !== 'string'
          ? null
          : await metadataOf({
              id: item.id,
              metadata_state: item.metadata_state ?? 'purged',
              encrypted_record: item.encrypted_record,
            });
      queue.push({
        state: item.state,
        score: metadata !== null && metadata.judgeId === judgeId ? metadata.value : null,
      });
    }
    return { since, decisions: decisions.length, outcomes, judged, queue };
  }

  async #model(
    document: Readonly<Record<string, unknown>>,
    counts: RuleAnalyseResultV1['counts'],
    named: AnalyseProvider | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly model: RuleAnalyseModelV1; readonly suggested: readonly RuleSuggestionV1[] }> {
    const presence = new Map(this.#keyPresence().map((entry) => [entry.provider, entry.hasKey]));
    const noKey = ANALYSE_PROVIDERS.filter((provider) => presence.get(provider) !== true);
    const chosen = chooseAnalyseProvider(named, (provider) => presence.get(provider) === true);
    const route = chosen === null ? null : ANALYSE_ROUTES[chosen.provider];
    const requests = modelPartsOf(document);
    const base = {
      provider: route?.provider ?? null,
      name: route?.name ?? null,
      model: route?.model ?? null,
      noKey,
      sent: ANALYSE_SENT,
    };
    const notRun = (reason: RuleAnalyseModelV1['reason']) => ({
      model: {
        ...base,
        ran: false,
        reason,
        parts: requests.map((request) => ({ part: request.part, at: request.at, outcome: 'not-run' })),
      },
      suggested: [],
    });
    if (requests.length === 0) return notRun('NO_MODEL_PARTS');
    if (chosen === null || route === null || !chosen.hasKey) return notRun('NO_KEY');
    const key = await this.#keyFor(chosen.provider);
    if (key === null) return notRun('NO_KEY');
    if (!isHeaderSafeKey(key))
      return {
        model: {
          ...base,
          ran: false,
          reason: null,
          parts: requests.map((request) => ({ part: request.part, at: request.at, outcome: 'KEY_MALFORMED' })),
        },
        suggested: [],
      };
    const answers = await Promise.all(
      requests.map(async (request) => this.#ask(chosen.provider, key, document, request, counts, signal)),
    );
    const suggested: RuleSuggestionV1[] = [];
    const parts = requests.map((request, index) => {
      const answer = answers[index] as AskResult;
      if (typeof answer === 'string') return { part: request.part, at: request.at, outcome: answer };
      if (answer === null) return { part: request.part, at: request.at, outcome: 'unchanged' };
      suggested.push({
        part: request.part,
        before: request.current,
        after: answer.after,
        why: answer.why,
        evidence: { by: 'model', provider: route.provider, model: route.model, ...request.at } as Record<
          string,
          JsonValue
        >,
      });
      return { part: request.part, at: request.at, outcome: 'suggested' };
    });
    return { model: { ...base, ran: true, reason: null, parts }, suggested };
  }

  /** One part through its fixed brief: the model's answer read strictly, or the closed word for why there is none. */
  async #ask(
    provider: AnalyseProvider,
    key: string,
    document: Readonly<Record<string, unknown>>,
    request: ModelPartRequest,
    counts: RuleAnalyseResultV1['counts'],
    signal: AbortSignal | undefined,
  ): Promise<AskResult> {
    const wire = buildAnalyseRequest({
      provider,
      key,
      system: ANALYSE_PROMPTS[request.part],
      user: modelInput(document, request, counts),
    });
    const result = await this.#transport.call(ANALYSE_ROUTES[provider], wire, signal);
    if (result.kind === 'refused') return result.code;
    const answer = readModelAnswer(request, result.text);
    if (answer === null) return null;
    return 'refused' in answer ? answer.refused : answer;
  }
}
