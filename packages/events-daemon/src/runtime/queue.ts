import { type ApprovalStore, CommsError, type ConfigStore, newBoundary, wrapUntrusted } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { isQueueItemId, parseQueueItemContent, type QueueItemContent, queueItemLink } from '../domain/queue-target.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import { EventExpiry } from './expiry.ts';
import { queueItemLocation, ruleFor } from './queue-dispatcher.ts';
import type { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';

/**
 * The action queue's read model and the person's state changes (action queue design §4.4, §8 contract, Q1, Q3, Q5).
 * `list` and `show` return item content and are reached only by the CLI (and the desktop app through it); `items` and
 * `counts` are content-free, and `done`, `dismiss`, `reopen` and `clear` change only the person's own list.
 */

export const QUEUE_STATES: readonly ['open', 'done', 'dismissed'] = Object.freeze([
  'open',
  'done',
  'dismissed',
] as const);
export type QueueState = (typeof QUEUE_STATES)[number];
export const QUEUE_CHANNELS: readonly ['gmail', 'slack', 'resend', 'whatsapp'] = Object.freeze([
  'gmail',
  'slack',
  'resend',
  'whatsapp',
] as const);
export type QueueChannel = (typeof QUEUE_CHANNELS)[number];

export const QUEUE_LIST_DEFAULT_LIMIT = 50;
export const QUEUE_LIST_MAX_LIMIT = 500;

/** The judge's part of an item, read from its decision at the moment it is shown, never copied (Q3). */
export interface QueueJudgeV1 {
  readonly state: 'answered' | 'expired' | 'released' | 'none';
  readonly id?: string;
  readonly kind?: string;
  readonly model?: string;
  readonly question?: string;
  readonly answer?: 'yes' | 'no';
  readonly confidence?: number;
  readonly uncalibrated?: boolean;
}

/** The content-free part of every item: the whole of a `queue items` entry (Q5). */
export interface QueueItemSummaryV1 {
  readonly id: string;
  readonly state: QueueState;
  readonly stateAt: string;
  readonly arrivedAt: string;
  readonly expiresAt: string;
  readonly rule: { readonly id: string; readonly version: number; readonly name: string };
  readonly channel: QueueChannel;
  readonly account: { readonly id: string; readonly alias: string | null };
}

/** A `queue list` or `queue show` item: sender-written fields arrive inside the untrusted-content envelope. */
export interface QueueItemV1 extends QueueItemSummaryV1 {
  readonly from: { readonly name?: string; readonly address?: string };
  readonly subject?: string;
  readonly text?: string;
  readonly link?: { readonly kind: 'gmail' | 'slack'; readonly url: string };
  readonly judge: QueueJudgeV1;
}

export interface QueueListResultV1 {
  readonly items: readonly QueueItemV1[];
  readonly more: boolean;
}

export interface QueueItemsResultV1 {
  readonly items: readonly QueueItemSummaryV1[];
  readonly more: boolean;
}

export interface QueueCountsResultV1 {
  readonly open: number;
  readonly done: number;
  readonly dismissed: number;
  readonly byRule: readonly { readonly ruleId: string; readonly name: string; readonly open: number }[];
}

export interface QueueStateChangeResultV1 {
  readonly item: { readonly id: string; readonly state: QueueState; readonly stateAt: string };
}

export interface QueueClearResultV1 {
  readonly cleared: number;
}

export interface QueueQuery {
  readonly state: QueueState | 'all';
  readonly ruleId?: string;
  readonly channel?: QueueChannel;
  readonly since?: number;
  readonly limit: number;
}

const SINCE_SPAN = /^(\d{1,4})([dh])$/u;
const SINCE_ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

function usage(message: string): never {
  throw new CommsError('USAGE', message);
}

/** `--since`: an ISO time, or a span back from now such as `7d` or `12h` — the same grammar as `activity`. */
export function queueSince(value: unknown, now: number): number {
  if (typeof value !== 'string') return usage('--since takes an ISO time, or a span back from now such as 7d or 12h');
  const text = value.trim();
  const span = SINCE_SPAN.exec(text);
  if (span !== null) return now - Number(span[1]) * (span[2] === 'd' ? 86_400_000 : 3_600_000);
  const at = SINCE_ISO.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isFinite(at)) return at;
  return usage(`--since takes an ISO time, or a span back from now such as 7d or 12h — not "${text.slice(0, 40)}"`);
}

/** The one parser for `list` and `items` filters, used by the CLI before it asks and by the owner when it answers. */
export function parseQueueQuery(
  args: Readonly<Record<string, unknown>>,
  now: number,
  options: { readonly since: boolean } = { since: true },
): QueueQuery {
  const state = args.state ?? 'open';
  if (state !== 'all' && !(QUEUE_STATES as readonly unknown[]).includes(state))
    usage('--state is open, done, dismissed or all');
  const ruleId = args.rule;
  if (ruleId !== undefined && (typeof ruleId !== 'string' || ruleId.length === 0 || ruleId.length > 256))
    usage('--rule takes a rule id');
  const channel = args.channel;
  if (channel !== undefined && !(QUEUE_CHANNELS as readonly unknown[]).includes(channel))
    usage('--channel is gmail, slack, resend or whatsapp');
  if (!options.since && args.since !== undefined) usage('queue items takes no --since');
  const since = args.since === undefined ? undefined : queueSince(args.since, now);
  const limit = args.limit ?? QUEUE_LIST_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > QUEUE_LIST_MAX_LIMIT)
    usage(`--limit is a whole number from 1 to ${QUEUE_LIST_MAX_LIMIT}`);
  return {
    state: state as QueueQuery['state'],
    ...(ruleId === undefined ? {} : { ruleId: ruleId as string }),
    ...(channel === undefined ? {} : { channel: channel as QueueChannel }),
    ...(since === undefined ? {} : { since }),
    limit: limit as number,
  };
}

/** Refuses a malformed item id before anything is read, with the contract's bad-argument exit (64). */
export function requireQueueItemId(value: unknown): string {
  if (!isQueueItemId(value)) usage('an item id is qi_ followed by 26 Crockford base32 characters');
  return value;
}

function noSuchItem(): never {
  throw new CommsError('NOT_FOUND', 'there is no such queue item', {
    hint: 'queue items lists every item still kept, by id.',
  });
}

interface QueueRow {
  readonly id: string;
  readonly delivery_id: string;
  readonly decision_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly account_id: string;
  readonly channel: QueueChannel;
  readonly whatsapp_message_id: string | null;
  readonly state: QueueState;
  readonly state_at: number;
  readonly arrived_at: number;
  readonly expires_at: number;
  readonly released: number;
  readonly encrypted_record: Uint8Array | null;
  readonly switch_generation: number;
}

const ROW_COLUMNS = `qi.id, qi.delivery_id, qi.decision_id, qi.rule_id, qi.rule_version, qi.target_id, qi.target_version,
  qi.account_id, qi.channel, qi.whatsapp_message_id, qi.state, qi.state_at, qi.arrived_at, qi.expires_at, qi.released,
  qi.encrypted_record, d.switch_generation`;

interface AccountNames {
  readonly inboxes?: Readonly<Record<string, { readonly id?: unknown; readonly email?: unknown }>>;
  readonly accounts?: Readonly<Record<string, { readonly id?: unknown; readonly platform?: unknown }>>;
}

function accountAlias(config: AccountNames, channel: QueueChannel, accountId: string): string | null {
  if (channel === 'gmail')
    return Object.entries(config.inboxes ?? {}).find(([, inbox]) => inbox.id === accountId)?.[0] ?? null;
  return (
    Object.entries(config.accounts ?? {}).find(
      ([, account]) => account.id === accountId && account.platform === channel,
    )?.[0] ?? null
  );
}

function gmailEmail(config: AccountNames, accountId: string): string | undefined {
  const email = Object.values(config.inboxes ?? {}).find((inbox) => inbox.id === accountId)?.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

export interface QueueStoreOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly expiry?: EventExpiry | undefined;
  /** Production uses the shared resolver; tests inject refusal cases at the exact read boundary. */
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly now?: (() => number) | undefined;
  /** The concrete D6 gate is mandatory before any WhatsApp item's content is read. */
  readonly whatsappVisibilityFence?: Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility'> | undefined;
}

export class QueueStore {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #expiry: EventExpiry;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #now: () => number;
  readonly #whatsappVisibilityFence: Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility'> | undefined;

  constructor(options: QueueStoreOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#expiry = options.expiry ?? new EventExpiry(options.store, options.now ?? Date.now);
    this.#fence = options.fence ?? assertDisclosable;
    this.#now = options.now ?? Date.now;
    this.#whatsappVisibilityFence = options.whatsappVisibilityFence;
  }

  /** `queue list`: items with their content, newest first (CLI only, Q1). */
  async list(args: Readonly<Record<string, unknown>> = {}): Promise<QueueListResultV1> {
    const query = parseQueueQuery(args, this.#now());
    this.#expiry.sweep();
    const rows = this.#rows(query);
    const config = (await this.#config.load()) as AccountNames;
    const boundary = newBoundary();
    const items: QueueItemV1[] = [];
    for (const row of rows.slice(0, query.limit)) {
      const item = await this.#item(row, config, boundary, 'list');
      if (item !== undefined) items.push(item);
    }
    return { items, more: rows.length > query.limit };
  }

  /** `queue show <id>`: one item with its content (CLI only, Q1). */
  async show(id: unknown): Promise<{ readonly item: QueueItemV1 }> {
    const itemId = requireQueueItemId(id);
    this.#expiry.sweep();
    const row = this.#row(itemId);
    if (row === undefined) return noSuchItem();
    const item = await this.#item(row, (await this.#config.load()) as AccountNames, newBoundary(), 'show');
    if (item === undefined) return noSuchItem();
    return { item };
  }

  /** `queue items`: the content-free list an agent may read through MCP (Q5) — never a sender, subject, text or link. */
  async items(args: Readonly<Record<string, unknown>> = {}): Promise<QueueItemsResultV1> {
    const query = parseQueueQuery(args, this.#now(), { since: false });
    this.#expiry.sweep();
    const rows = this.#rows(query);
    const config = (await this.#config.load()) as AccountNames;
    return { items: rows.slice(0, query.limit).map((row) => summary(row, config)), more: rows.length > query.limit };
  }

  /** `queue counts`: the open, done and dismissed totals and each rule's open count, for a badge (content-free). */
  counts(): QueueCountsResultV1 {
    this.#expiry.sweep();
    const totals = this.#store.database
      .prepare('SELECT state, COUNT(*) AS count FROM queue_items GROUP BY state')
      .all() as Array<{ state: QueueState; count: number }>;
    const byRule = this.#store.database
      .prepare(
        `SELECT rule_id, SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open
           FROM queue_items GROUP BY rule_id ORDER BY rule_id`,
      )
      .all() as Array<{ rule_id: string; open: number }>;
    const total = (state: QueueState) => totals.find((row) => row.state === state)?.count ?? 0;
    return {
      open: total('open'),
      done: total('done'),
      dismissed: total('dismissed'),
      byRule: byRule.map((row) => ({ ruleId: row.rule_id, name: row.rule_id, open: row.open })),
    };
  }

  done(id: unknown): QueueStateChangeResultV1 {
    return this.#setState(id, 'done');
  }

  dismiss(id: unknown): QueueStateChangeResultV1 {
    return this.#setState(id, 'dismissed');
  }

  reopen(id: unknown): QueueStateChangeResultV1 {
    return this.#setState(id, 'open');
  }

  /** `queue clear`: purges done and dismissed items now, content and row (§4.3). Open items are untouched. */
  clear(): QueueClearResultV1 {
    return this.#store.immediate(() => ({
      cleared: Number(
        this.#store.database.prepare("DELETE FROM queue_items WHERE state IN ('done', 'dismissed')").run().changes,
      ),
    }));
  }

  /** Done, dismiss and reopen change only the person's own list; they tighten and loosen nothing (§4.4, DA10). */
  #setState(id: unknown, state: QueueState): QueueStateChangeResultV1 {
    const itemId = requireQueueItemId(id);
    const now = this.#now();
    return this.#store.immediate(() => {
      const current = this.#store.database
        .prepare('SELECT state, state_at FROM queue_items WHERE id = ?')
        .get(itemId) as { state: QueueState; state_at: number } | undefined;
      if (current === undefined) return noSuchItem();
      if (current.state === state) return { item: { id: itemId, state, stateAt: iso(current.state_at) } };
      this.#store.database
        .prepare('UPDATE queue_items SET state = ?, state_at = ? WHERE id = ?')
        .run(state, now, itemId);
      return { item: { id: itemId, state, stateAt: iso(now) } };
    });
  }

  #rows(query: QueueQuery): readonly QueueRow[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (query.state !== 'all') {
      where.push('qi.state = ?');
      values.push(query.state);
    }
    if (query.ruleId !== undefined) {
      where.push('qi.rule_id = ?');
      values.push(query.ruleId);
    }
    if (query.channel !== undefined) {
      where.push('qi.channel = ?');
      values.push(query.channel);
    }
    if (query.since !== undefined) {
      where.push('qi.arrived_at >= ?');
      values.push(query.since);
    }
    return this.#store.database
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM queue_items qi JOIN deliveries d ON d.id = qi.delivery_id
         ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
         ORDER BY qi.arrived_at DESC, qi.id DESC LIMIT ?`,
      )
      .all(...values, query.limit + 1) as unknown as QueueRow[];
  }

  #row(id: string): QueueRow | undefined {
    return this.#store.database
      .prepare(`SELECT ${ROW_COLUMNS} FROM queue_items qi JOIN deliveries d ON d.id = qi.delivery_id WHERE qi.id = ?`)
      .get(id) as QueueRow | undefined;
  }

  /**
   * One item as the person reads it. Content is opened only after the read fence (the bound rule version unrevoked,
   * the switch at the item's generation, the account live) and, for WhatsApp, the live-list check; a `list` leaves
   * out an item the fence refuses, and a `show` refuses it.
   */
  async #item(
    row: QueueRow,
    config: AccountNames,
    boundary: string,
    surface: 'list' | 'show',
  ): Promise<QueueItemV1 | undefined> {
    const rule = ruleFor(this.#store, row.rule_id, row.rule_version);
    const base = summary(row, config);
    const judge = await this.#judge(row, rule);
    if (row.encrypted_record === null) return { ...base, from: {}, judge };
    let content: QueueItemContent | null;
    try {
      await this.#readFence(row, rule);
      content = await this.#open(row);
      if (content === null) return { ...base, from: {}, judge };
      const visible = await this.#withWhatsAppVisibility(
        row,
        () => this.#readFence(row, rule),
        () =>
          this.#store.database.prepare('SELECT 1 AS present FROM queue_items WHERE id = ?').get(row.id) !== undefined,
      );
      if (visible !== true) return surface === 'show' ? noSuchItem() : undefined;
    } catch (error) {
      if (surface === 'list' && error instanceof CommsError) return undefined;
      throw error;
    }
    const wrap = (text: string, field: string) => wrapUntrusted(text, { field }, boundary);
    const link = queueItemLink(content.link, row.channel === 'gmail' ? gmailEmail(config, row.account_id) : undefined);
    return {
      ...base,
      from: {
        ...(content.from.name === undefined ? {} : { name: wrap(content.from.name, 'from-name') }),
        ...(content.from.address === undefined ? {} : { address: wrap(content.from.address, 'from-address') }),
      },
      ...(content.subject === undefined ? {} : { subject: wrap(content.subject, 'subject') }),
      ...(content.text === undefined ? {} : { text: wrap(content.text, 'text') }),
      ...(link === undefined ? {} : { link }),
      judge,
    };
  }

  async #readFence(row: QueueRow, rule: CanonicalFullRuleDocument): Promise<void> {
    try {
      await this.#fence({
        database: this.#store.database,
        approvals: this.#approvals,
        config: this.#config,
        accountId: row.account_id,
        boundary: 'read',
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        targetId: row.target_id,
        targetVersion: row.target_version,
        switchGeneration: row.switch_generation,
      });
    } catch (error) {
      if (isRemovedAccountError(error))
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            { source: rule.source.channel, accountId: row.account_id },
            this.#now(),
          ),
        );
      throw error;
    }
  }

  /** Opens an item's content; content that cannot be authenticated or read is purged, never shown in part (D8). */
  async #open(row: QueueRow): Promise<QueueItemContent | null> {
    if (row.encrypted_record === null) return null;
    let content: QueueItemContent | null = null;
    try {
      content = parseQueueItemContent(
        JSON.parse((await this.#cipher.decrypt(queueItemLocation(row.id), row.encrypted_record)).toString('utf8')),
      );
    } catch (error) {
      if (!(error instanceof RecordStorageError) && !(error instanceof SyntaxError)) throw error;
    }
    if (content === null)
      this.#store.immediate(() =>
        this.#store.database.prepare('UPDATE queue_items SET encrypted_record = NULL WHERE id = ?').run(row.id),
      );
    return content;
  }

  /** Q3: the judge's answer comes from the decision while its metadata lives; it is never copied into the item. */
  async #judge(row: QueueRow, rule: CanonicalFullRuleDocument): Promise<QueueJudgeV1> {
    const agentic = rule.agentic;
    if (agentic === undefined) return { state: 'none' };
    const bound = {
      id: agentic.judge.judgeId,
      kind: agentic.judge.kind,
      model: agentic.judge.model,
      question: agentic.question,
    };
    // A held decision the person let through: say so, with no judge answer.
    if (row.released === 1) return { state: 'released', ...bound };
    const decision = this.#store.database
      .prepare('SELECT metadata_state, encrypted_record FROM decisions WHERE id = ?')
      .get(row.decision_id) as { metadata_state: string; encrypted_record: Uint8Array | null } | undefined;
    if (decision === undefined || decision.metadata_state === 'purged' || decision.encrypted_record === null)
      return { state: 'expired', ...bound };
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(
        (
          await this.#cipher.decrypt(
            { table: 'decisions', column: 'encryptedRecord', key: [{ type: 'text', value: row.decision_id }] },
            decision.encrypted_record,
          )
        ).toString('utf8'),
      ) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RecordStorageError || error instanceof SyntaxError) return { state: 'expired', ...bound };
      throw error;
    }
    const value = metadata.value;
    const threshold = metadata.threshold;
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof threshold !== 'number')
      return { state: 'expired', ...bound };
    return {
      state: 'answered',
      ...bound,
      ...(typeof metadata.model === 'string' ? { model: metadata.model } : {}),
      answer: value >= threshold ? 'yes' : 'no',
      confidence: value,
      uncalibrated: metadata.valueLabel === 'uncalibrated-score',
    };
  }

  async #withWhatsAppVisibility(
    row: QueueRow,
    recheck: () => Promise<void>,
    commit: () => boolean,
  ): Promise<boolean | undefined> {
    if (row.whatsapp_message_id === null) return commit();
    if (this.#whatsappVisibilityFence === undefined)
      throw new CommsError(
        'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
        'reading a WhatsApp queue item requires the concrete visibility fence',
      );
    return this.#whatsappVisibilityFence.withCurrentDryRunVisibility(
      { accountId: row.account_id, whatsappMessageId: row.whatsapp_message_id },
      recheck,
      commit,
    );
  }
}

function summary(row: QueueRow, config: AccountNames): QueueItemSummaryV1 {
  return {
    id: row.id,
    state: row.state,
    stateAt: iso(row.state_at),
    arrivedAt: iso(row.arrived_at),
    expiresAt: iso(row.expires_at),
    // A rule has no separate name: its id is what the person gave it and what every other surface shows.
    rule: { id: row.rule_id, version: row.rule_version, name: row.rule_id },
    channel: row.channel,
    account: { id: row.account_id, alias: accountAlias(config, row.channel, row.account_id) },
  };
}
