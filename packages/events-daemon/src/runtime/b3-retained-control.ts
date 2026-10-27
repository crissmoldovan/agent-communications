import { CommsError, canonicalJson, newBoundary, renderFencedBody, wrapUntrusted } from '@agentcomms/core';
import { catalogueEntry } from '@agentcomms/events';
import { type CanonicalFullRuleDocument, canonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { EventDomainError } from '../domain/lifecycle.ts';
import type { EventDatabase } from '../store/database.ts';
import {
  assertHumanTerminal as assertB1HumanTerminal,
  renderDryRunList,
  renderDryRunRecord,
} from '../targets/dry-run.ts';
import type { DryRunDispatcher, DryRunLogEntry, DryRunRecord } from './dispatcher.ts';
import { evaluateRuleProjection } from './mapping.ts';
import type { EventProjectionStore, ProjectionReference, StoredProjection } from './projections.ts';
import { sanitiseSenderFields } from './untrusted.ts';
import type { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';
import type { FlowTestResultV1 } from './workflow/flow-test.ts';

type HumanTerminal = {
  readonly env: NodeJS.ProcessEnv;
  readonly streams: {
    readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
    readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
    readonly stderr: NodeJS.WritableStream & { readonly isTTY?: boolean };
  };
  readonly json: boolean;
};

type DryRunReader = Pick<DryRunDispatcher, 'list' | 'read'>;

function assertHumanTerminal(input: HumanTerminal): void {
  // Importing this policy rather than copying it makes retained B3 reads retain the same agent/non-TTY rule as B1.
  assertB1HumanTerminal(input.env, input.streams, input.json);
}

/**
 * The B3 retained surface deliberately delegates all payload opening to the D/B2 DryRunDispatcher.  In particular,
 * `read` keeps its pre/post-decrypt disclosure fence and WhatsApp live-list gate; this class adds only the human
 * terminal boundary and renderer selection.
 */
export class B3RetainedControl {
  readonly #dispatcher: DryRunReader;

  constructor(options: { readonly dispatcher: DryRunReader }) {
    this.#dispatcher = options.dispatcher;
  }

  list(input: HumanTerminal): string {
    assertHumanTerminal(input);
    // B3_RETAINED_LIST_CONTENT_FREE: metadata only; never call `read`/decrypt while listing.
    return renderDryRunList(this.#dispatcher.list());
  }

  async read(input: HumanTerminal & { readonly deliveryId: string }): Promise<string> {
    assertHumanTerminal(input);
    const record = await this.#dispatcher.read(input.deliveryId);
    return renderDryRunRecord(record);
  }
}

export interface CatalogueExampleSelector {
  readonly type: string;
  readonly version: number;
  readonly exampleIndex: number;
}

export interface CatalogueRuleTestResult {
  readonly agentic: 'not-evaluated';
  readonly outcome: 'matched' | 'condition-false' | 'mapping-rejected';
  /** A terminal-only representation. Its mapped values are neutralised and enter exactly one content envelope. */
  readonly rendered: string;
}

function rejectRuleTestInput(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

/** The catalogue example a test selects, for the rule's own event, its sender's fields neutralised as a live event's are. */
export function exactCatalogueExample(selector: unknown, rule: CanonicalFullRuleDocument): Record<string, unknown> {
  if (typeof selector !== 'object' || selector === null || Array.isArray(selector))
    return rejectRuleTestInput('a rule test selects one catalogue example');
  const record = selector as Record<string, unknown>;
  // A retained record and an account are identity selectors, never a local example selector.  Reject their presence
  // rather than silently ignoring it so an MCP/CLI adapter cannot accidentally smuggle a retained-read form here.
  const isCatalogueForm =
    !Object.hasOwn(record, 'eventId') &&
    !Object.hasOwn(record, 'accountId') &&
    !Object.hasOwn(record, 'event') &&
    !Object.keys(record).some((key) => !['type', 'version', 'exampleIndex'].includes(key)) &&
    typeof record.type === 'string' &&
    Number.isSafeInteger(record.version) &&
    Number.isSafeInteger(record.exampleIndex) &&
    (record.exampleIndex as number) >= 0;
  if (!isCatalogueForm) return rejectRuleTestInput('a rule test catalogue selector is malformed');
  // `catalogueEntry` rejects both known and unknown agentcomms operational types before an event can be evaluated.
  const entry = catalogueEntry(record.type as string, record.version as number);
  if (!entry.ok) return rejectRuleTestInput(entry.issues[0]?.message ?? 'the catalogue event is not selectable');
  if ((record.type as string) !== rule.event.type || (record.version as number) !== rule.event.version)
    return rejectRuleTestInput('the catalogue example must have the rule event type and version');
  const example = entry.value.examples[record.exampleIndex as number];
  if (example === undefined) return rejectRuleTestInput('the catalogue example index is unavailable');
  // Every catalogue-declared untrusted field is neutralised before mapping, exactly as a live event's projection is.
  return sanitiseSenderFields(entry.value, JSON.parse(canonicalJson(example)) as Record<string, unknown>);
}

/**
 * Local-only rule evaluation. It consumes a checked-in catalogue example and executes the deterministic mapping
 * evaluator only: no cursor, provider, target, decision, cap, or judge path is reachable from this function.
 */
export function runCatalogueRuleTest(input: {
  readonly document: unknown;
  readonly catalogue: CatalogueExampleSelector;
}): CatalogueRuleTestResult {
  const rule = canonicalFullRuleDocument(input.document);
  const event = exactCatalogueExample(input.catalogue, rule);
  const evaluated = evaluateRuleProjection(rule, event);
  const outcome = evaluated === null ? 'condition-false' : 'rejected' in evaluated ? 'mapping-rejected' : 'matched';
  const payload =
    evaluated === null
      ? { outcome }
      : 'rejected' in evaluated
        ? { outcome, reason: evaluated.rejected }
        : { outcome, mapped: evaluated.mapped, untrusted: evaluated.classification.untrusted };
  const boundary = newBoundary();
  // B3_RULE_TEST_SINGLE_ENVELOPE: all example-derived data gets one neutralised envelope, independent of target shape.
  const enveloped = wrapUntrusted(
    canonicalJson(payload),
    { field: 'catalogue-example', id: 'local-rule-test' },
    boundary,
  );
  return { agentic: 'not-evaluated', outcome, rendered: renderFencedBody(enveloped) };
}

/**
 * A workflow with a flow, tried on a retained message (0.36.0 §7.7): judges, route and find answer for real; every
 * effect and event is a "would". The engine's, composed by the owner.
 */
export type RetainedFlowTry = (input: {
  readonly rule: CanonicalFullRuleDocument;
  readonly event: Record<string, unknown>;
  readonly eventId: string;
}) => Promise<FlowTestResultV1>;

export interface ExactRetainedRuleSelector {
  readonly eventId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
}

interface RetainedRuleSnapshot {
  readonly reference: ProjectionReference;
  readonly accountId: string;
  readonly rule: CanonicalFullRuleDocument;
}

function exactRetainedSelector(input: unknown): ExactRetainedRuleSelector {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return rejectRuleTestInput('a retained rule test needs an exact event and rule version');
  const record = input as Record<string, unknown>;
  if (Object.hasOwn(record, 'accountId')) return rejectRuleTestInput('a retained rule test has no account selector');
  if (
    Object.keys(record).some((key) => !['eventId', 'ruleId', 'ruleVersion'].includes(key)) ||
    typeof record.eventId !== 'string' ||
    typeof record.ruleId !== 'string' ||
    !Number.isSafeInteger(record.ruleVersion) ||
    (record.ruleVersion as number) < 1
  )
    return rejectRuleTestInput('a retained rule test needs eventId, ruleId, and ruleVersion');
  return { eventId: record.eventId, ruleId: record.ruleId, ruleVersion: record.ruleVersion as number };
}

/**
 * An exact saved-projection selector. There is intentionally no active-pointer lookup and no pending-document path:
 * the version named by the caller is the version whose persisted projection must still be independently live.
 */
export class RetainedRuleTestControl {
  readonly #projections: Pick<EventProjectionStore, 'row' | 'read'>;
  readonly #snapshot: (selector: ExactRetainedRuleSelector) => RetainedRuleSnapshot | null;
  readonly #accountLive: (input: {
    readonly source: CanonicalFullRuleDocument['source']['channel'];
    readonly accountId: string;
  }) => Promise<void>;
  readonly #whatsappVisibilityFence: Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility'> | undefined;
  readonly #flow: RetainedFlowTry | undefined;

  constructor(options: {
    readonly projections: Pick<EventProjectionStore, 'row' | 'read'>;
    readonly snapshot: (selector: ExactRetainedRuleSelector) => RetainedRuleSnapshot | null;
    readonly accountLive: (input: {
      readonly source: CanonicalFullRuleDocument['source']['channel'];
      readonly accountId: string;
    }) => Promise<void>;
    readonly whatsappVisibilityFence?: Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility'> | undefined;
    /** A workflow with a flow is walked on the message (0.36.0 §7.7): the engine's try, every effect a "would". */
    readonly flow?: RetainedFlowTry | undefined;
  }) {
    this.#projections = options.projections;
    this.#snapshot = options.snapshot;
    this.#accountLive = options.accountLive;
    this.#whatsappVisibilityFence = options.whatsappVisibilityFence;
    this.#flow = options.flow;
  }

  async test(input: unknown): Promise<CatalogueRuleTestResult | FlowTestResultV1> {
    const selector = exactRetainedSelector(input);
    const before = this.#snapshot(selector);
    if (before === null) throw new CommsError('NOT_FOUND', 'the exact retained rule projection is not available');
    await this.#accountLive({ source: before.rule.source.channel, accountId: before.accountId });
    const projection = await this.#projections.read(before.reference);
    // B3_RETAINED_POST_DECRYPT_FENCE: both identity and authority are read again after the decrypt await.
    const after = this.#snapshot(selector);
    if (after === null)
      throw new CommsError('APPROVAL_VOID', 'the retained projection changed while it was being read');
    await this.#accountLive({ source: after.rule.source.channel, accountId: after.accountId });
    const flow = this.#flow;
    const render = () =>
      flow !== undefined && after.rule.flow !== undefined
        ? flow({ rule: after.rule, event: projection.event, eventId: selector.eventId })
        : renderRetainedRuleResult(after.rule, projection);
    if (before.reference.whatsappMessageId === null) return render();
    if (this.#whatsappVisibilityFence === undefined)
      throw new CommsError(
        'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
        'a WhatsApp retained rule test requires the live-list fence',
      );
    const visible = await this.#whatsappVisibilityFence.withCurrentDryRunVisibility(
      { accountId: after.accountId, whatsappMessageId: before.reference.whatsappMessageId },
      async () => {
        const final = this.#snapshot(selector);
        if (final === null)
          throw new CommsError('APPROVAL_VOID', 'the retained projection changed during its visibility check');
        await this.#accountLive({ source: final.rule.source.channel, accountId: final.accountId });
      },
      render,
    );
    if (visible === undefined)
      throw new CommsError('NOT_FOUND', 'the retained WhatsApp projection is no longer visible');
    return visible;
  }
}

/**
 * Builds the production exact-row selector for retained rule tests. The SQL intentionally never joins
 * `active_versions`: an independently retained superseded version remains testable, while a revoked or expired one
 * does not. The caller supplies the same source/account liveness reader used by owner composition.
 */
export function createRetainedRuleTestControl(input: {
  readonly store: EventDatabase;
  readonly projections: Pick<EventProjectionStore, 'row' | 'read'>;
  readonly accountLive: (input: {
    readonly source: CanonicalFullRuleDocument['source']['channel'];
    readonly accountId: string;
  }) => Promise<void>;
  readonly now?: (() => number) | undefined;
  readonly whatsappVisibilityFence?: Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility'> | undefined;
  readonly flow?: RetainedFlowTry | undefined;
}): RetainedRuleTestControl {
  const now = input.now ?? Date.now;
  return new RetainedRuleTestControl({
    flow: input.flow,
    projections: input.projections,
    snapshot: (selector) => {
      const row = input.store.database
        .prepare(
          `SELECT ingest.account_id, rule.document
           FROM ingest_rules AS projection
           JOIN ingest ON ingest.event_id = projection.event_id
           JOIN rule_versions AS rule ON rule.rule_id = projection.rule_id AND rule.version = projection.rule_version
           JOIN event_settings AS settings ON settings.singleton = 1
           WHERE projection.event_id = ? AND projection.rule_id = ? AND projection.rule_version = ?
             AND projection.decision_deadline > ?
             AND settings.enabled = 1
             AND rule.state IN ('active', 'superseded')
             AND rule.revoked_at IS NULL`,
        )
        .get(selector.eventId, selector.ruleId, selector.ruleVersion, now()) as
        | { readonly account_id: string; readonly document: string }
        | undefined;
      if (row === undefined) return null;
      const reference = input.projections.row(selector.eventId, selector.ruleId, selector.ruleVersion);
      if (reference === null) return null;
      try {
        return { reference, accountId: row.account_id, rule: canonicalFullRuleDocument(JSON.parse(row.document)) };
      } catch {
        return null;
      }
    },
    accountLive: input.accountLive,
    whatsappVisibilityFence: input.whatsappVisibilityFence,
  });
}

function renderRetainedRuleResult(
  rule: CanonicalFullRuleDocument,
  projection: StoredProjection,
): CatalogueRuleTestResult {
  const evaluated = evaluateRuleProjection(rule, projection.event);
  const outcome = evaluated === null ? 'condition-false' : 'rejected' in evaluated ? 'mapping-rejected' : 'matched';
  const payload =
    evaluated === null
      ? { outcome }
      : 'rejected' in evaluated
        ? { outcome, reason: evaluated.rejected }
        : { outcome, mapped: evaluated.mapped };
  const boundary = newBoundary();
  return {
    agentic: 'not-evaluated',
    outcome,
    rendered: renderFencedBody(wrapUntrusted(canonicalJson(payload), { field: 'retained-projection' }, boundary)),
  };
}

export type { DryRunLogEntry, DryRunRecord };
