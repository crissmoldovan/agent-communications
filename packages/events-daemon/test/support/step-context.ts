import { readFileSync } from 'node:fs';
import type { AgenticConditionV1, FlowDocumentV1, FlowStep, JsonValue, StepId } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../src/domain/activation-documents.ts';
import type { JudgeAnswer, Output, RunView, StepContext } from '../../src/runtime/workflow/contracts.ts';

/**
 * A `StepContext` for one executor's unit test (workflows plan T0.2): every part may be given, the rest are the owner
 * example's (`packages/events/test/fixtures/flows/owner-example.json`), and `charge`, `judge` and `fence` record each
 * call, so a test asserts what an executor asked for as well as what it answered. Nothing here opens a store, a socket
 * or a secret.
 */

/** The spec §4.4 owner example, whole: a workflow document with its flow. */
export const OWNER_EXAMPLE: CanonicalFullRuleDocument & { readonly flow: FlowDocumentV1 } = JSON.parse(
  readFileSync(new URL('../../../events/test/fixtures/flows/owner-example.json', import.meta.url), 'utf8'),
) as CanonicalFullRuleDocument & { readonly flow: FlowDocumentV1 };

/** The fixed instant a stand-in context's clock reads, unless a test gives its own. */
export const STEP_CONTEXT_NOW = 1_793_000_000_000;

type ChargeKind = 'session-start' | 'worktree' | 'linear-write';

export interface StepContextParts {
  readonly run?: Partial<RunView>;
  readonly rule?: CanonicalFullRuleDocument;
  /** The step's id; the step itself is then the rule's flow's, unless `step` is given too. */
  readonly stepId?: StepId;
  readonly step?: FlowStep;
  readonly attempt?: { id: string; number: number };
  readonly now?: () => number;
  /** The run's mapped values, as `fields()` gives them. */
  readonly fields?: Readonly<Record<string, JsonValue>>;
  /** A chained run's `/trigger`. */
  readonly trigger?: Output | null;
  /** Settled steps' closed outputs, by step id. */
  readonly outputs?: Readonly<Record<StepId, Output>>;
  readonly charge?: (kind: ChargeKind) => { ok: true } | { ok: false; until: number };
  readonly judge?: (
    ask: AgenticConditionV1,
    inputs: Readonly<Record<string, JsonValue>>,
    question?: string,
  ) => JudgeAnswer | Promise<JudgeAnswer>;
  /** Throw from here to model authority that is gone (`CommsError` `APPROVAL_VOID`). */
  readonly fence?: () => void | Promise<void>;
}

/** What a stand-in context recorded. */
export interface RecordedStepContext extends StepContext {
  readonly charged: ChargeKind[];
  readonly judged: { ask: AgenticConditionV1; inputs: Readonly<Record<string, JsonValue>>; question?: string }[];
  /** How many times `fence()` was called. */
  readonly fenced: { count: number };
}

/** A stand-in `StepContext`: the given parts over the owner example's, with `charge`, `judge` and `fence` recorded. */
export function stepContext(partial: StepContextParts = {}): RecordedStepContext {
  const rule = partial.rule ?? OWNER_EXAMPLE;
  const flow = (rule as { readonly flow?: FlowDocumentV1 }).flow;
  const stepId = partial.stepId ?? flow?.start ?? 'step';
  const step = partial.step ?? flow?.steps[stepId];
  if (step === undefined) throw new Error(`stepContext: no step ${stepId} in the rule's flow, and none was given`);
  const now = partial.now ?? (() => STEP_CONTEXT_NOW);
  const run: RunView = {
    id: 'wfr_0123456789abcdefghjkmnpqrs',
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    accountId: 'acme/slack',
    eventId: 'event-1',
    depth: 0,
    parentRunId: null,
    startedAt: STEP_CONTEXT_NOW,
    expiresAt: STEP_CONTEXT_NOW + (flow?.limits.runMs ?? 259_200_000),
    shadow: flow?.shadow === true,
    ...partial.run,
  };
  const charged: ChargeKind[] = [];
  const judged: RecordedStepContext['judged'] = [];
  const fenced = { count: 0 };
  return {
    run,
    rule,
    stepId,
    step,
    attempt: partial.attempt ?? { id: 'attempt-1', number: 1 },
    now,
    fields: async () => partial.fields ?? {},
    trigger: async () => partial.trigger ?? null,
    output: (id: StepId) => partial.outputs?.[id] ?? null,
    charge: (kind: ChargeKind) => {
      charged.push(kind);
      return partial.charge?.(kind) ?? { ok: true };
    },
    judge: async (ask, inputs, question) => {
      judged.push({ ask, inputs, ...(question === undefined ? {} : { question }) });
      return (await partial.judge?.(ask, inputs, question)) ?? { kind: 'answer', said: 'yes', score: 0.9 };
    },
    fence: async () => {
      fenced.count += 1;
      await partial.fence?.();
    },
    charged,
    judged,
    fenced,
  };
}
