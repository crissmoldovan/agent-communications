import { CommsError, sha256Hex } from '@agentcomms/core';
import { activationDocumentDigest, normaliseActivationDocument } from '../domain/activation-documents.ts';
import type { CanonicalJudgeDocument } from '../domain/judges.ts';
import { canonicalJudge } from '../domain/judges.ts';

export type PendingRuleJudgeTestOrigin = 'terminal-approval' | 'app-approval-screen';

/** A sidecar request: the frozen v1 approval-view shape deliberately remains untouched. */
export interface PendingRuleJudgeTestSelector {
  readonly kind: 'pending-rule-judge-test';
  readonly activationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly judgeId: string;
  readonly judgeVersion: number;
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
}

export interface PendingRuleJudgeTestAuthority {
  readonly activationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly judge: CanonicalJudgeDocument;
  readonly question: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Present only after a selector has checked the exact live approval-view row. Never persist the raw challenge. */
  readonly challenge?:
    | {
        readonly approvalId: string;
        readonly hash: string;
        readonly origin: 'terminal' | 'view';
        readonly expiresAt: number | null;
      }
    | undefined;
}

export interface PendingRuleApprovalChallenge {
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
  readonly expiresAt: number;
}

type PendingRow = {
  readonly kind: string;
  readonly document: string;
  readonly digest: string;
  readonly status: string;
  readonly approval_id: string | null;
};

type Database = { prepare(sql: string): { get(...values: unknown[]): unknown } };

function voidApproval(message: string): never {
  throw new CommsError('APPROVAL_VOID', message);
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validOrigin(origin: unknown): origin is PendingRuleJudgeTestOrigin {
  return origin === 'terminal-approval' || origin === 'app-approval-screen';
}

/** The sidecar is closed before it reaches either the approval or network paths. */
export function isPendingRuleJudgeTestSelector(value: unknown): value is PendingRuleJudgeTestSelector {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = [
    'kind',
    'activationId',
    'ruleId',
    'ruleVersion',
    'judgeId',
    'judgeVersion',
    'approvalId',
    'digest',
    'challenge',
  ];
  if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) return false;
  return (
    record.kind === 'pending-rule-judge-test' &&
    ['activationId', 'ruleId', 'judgeId', 'approvalId', 'digest', 'challenge'].every(
      (key) => typeof record[key] === 'string' && (record[key] as string).length > 0,
    ) &&
    positiveVersion(record.ruleVersion) &&
    positiveVersion(record.judgeVersion)
  );
}

function pendingAuthority(
  database: Database,
  selector: Pick<
    PendingRuleJudgeTestSelector,
    'activationId' | 'approvalId' | 'digest' | 'ruleId' | 'ruleVersion' | 'judgeId' | 'judgeVersion'
  >,
): PendingRuleJudgeTestAuthority {
  const row = database
    .prepare('SELECT kind, document, digest, status, approval_id FROM activation_intents WHERE id = ?')
    .get(selector.activationId) as PendingRow | undefined;
  if (
    row === undefined ||
    row.status !== 'pending' ||
    row.kind !== 'rule' ||
    row.approval_id !== selector.approvalId ||
    row.digest !== selector.digest
  )
    return voidApproval('the approval no longer names this pending workflow activation');
  try {
    const document = normaliseActivationDocument(JSON.parse(row.document));
    if (document.kind !== 'rule' || activationDocumentDigest(document) !== row.digest)
      return voidApproval('the pending workflow activation document digest is invalid');
    const agentic = document.rule.agentic;
    if (
      agentic === undefined ||
      document.rule.ruleId !== selector.ruleId ||
      document.rule.version !== selector.ruleVersion ||
      agentic.judge.judgeId !== selector.judgeId ||
      agentic.judge.version !== selector.judgeVersion
    )
      return voidApproval('the pending approval does not reference this exact judge version');
    return {
      activationId: selector.activationId,
      ruleId: document.rule.ruleId,
      ruleVersion: document.rule.version,
      judge: canonicalJudge(agentic.judge),
      question: agentic.question,
      maxInputTokens: agentic.maxInputTokens,
      maxOutputTokens: agentic.maxOutputTokens,
    };
  } catch (error) {
    if (error instanceof CommsError) throw error;
    return voidApproval('the pending workflow activation document is not valid');
  }
}

/** Re-reads a pending authority at admission and at every later transport fence. */
export function assertPendingRuleJudgeTestAuthority(input: {
  readonly database: Database;
  readonly activationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly judgeId: string;
  readonly judgeVersion: number;
}): PendingRuleJudgeTestAuthority {
  const row = input.database
    .prepare('SELECT kind, document, digest, status, approval_id FROM activation_intents WHERE id = ?')
    .get(input.activationId) as PendingRow | undefined;
  if (row === undefined || row.status !== 'pending' || row.kind !== 'rule' || row.approval_id === null)
    return voidApproval('the pending workflow authority is no longer live');
  return pendingAuthority(input.database, {
    ...input,
    approvalId: row.approval_id,
    digest: row.digest,
  });
}

/**
 * Validates one terminal/app selector before the shared fixed-input judge path is even constructed.  The challenge
 * await occurs only after the origin gate, so MCP/ordinary CLI cannot turn it into a network attempt.
 */
export async function verifyPendingRuleJudgeTestContext(input: {
  readonly database: Database;
  readonly selector: PendingRuleJudgeTestSelector;
  readonly origin: PendingRuleJudgeTestOrigin | 'mcp' | 'cli' | string;
  readonly now: () => number;
  readonly approvalView: () => Promise<PendingRuleApprovalChallenge>;
}): Promise<PendingRuleJudgeTestAuthority> {
  if (!validOrigin(input.origin))
    return voidApproval(
      'a pending workflow judge test is available only from the terminal approval flow or app approval screen',
    );
  if (!isPendingRuleJudgeTestSelector(input.selector))
    return voidApproval('the pending workflow judge test selector is invalid');
  const challenge = await input.approvalView();
  if (
    challenge.expiresAt <= input.now() ||
    challenge.approvalId !== input.selector.approvalId ||
    challenge.digest !== input.selector.digest ||
    challenge.challenge !== input.selector.challenge
  )
    return voidApproval('the approval challenge is stale or does not bind this pending workflow activation');
  const authority = pendingAuthority(input.database, input.selector);
  return {
    ...authority,
    challenge: {
      approvalId: input.selector.approvalId,
      hash: sha256Hex(input.selector.challenge),
      origin: input.origin === 'terminal-approval' ? 'terminal' : 'view',
      expiresAt: input.origin === 'terminal-approval' ? null : challenge.expiresAt,
    },
  };
}
