import { CommsError } from '@agentcomms/core';
import { activationDocumentDigest, normaliseActivationDocument } from '../domain/activation-documents.ts';

export type PendingTargetOrigin = 'terminal-approval' | 'app-approval-screen';

export interface PendingActivationTargetSelector {
  readonly kind: 'pending-activation';
  readonly activationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
}

export interface ApprovalViewChallenge {
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
  readonly expiresAt: number;
}

function voidApproval(message: string): never {
  throw new CommsError('APPROVAL_VOID', message);
}

function validOrigin(origin: unknown): origin is PendingTargetOrigin {
  return origin === 'terminal-approval' || origin === 'app-approval-screen';
}

/**
 * Verifies the sole pending-target escape hatch. It accepts neither normal target-test/MCP origins nor a target
 * inferred from an activation pointer: approval view supplies a fresh challenge, while SQLite supplies the exact
 * immutable pending document.
 */
export async function verifyPendingTargetContext(input: {
  readonly database: { prepare(sql: string): { get(...values: unknown[]): unknown } };
  readonly selector: PendingActivationTargetSelector;
  readonly origin: PendingTargetOrigin | 'mcp' | 'cli' | string;
  readonly now: () => number;
  readonly approvalView: () => Promise<ApprovalViewChallenge>;
}): Promise<{
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
}> {
  if (!validOrigin(input.origin))
    return voidApproval(
      'a pending target test is available only from the terminal approval flow or app approval screen',
    );
  const challenge = await input.approvalView();
  // The approval view is an await boundary: a stale UI challenge cannot be reused after the view changes.
  if (
    challenge.expiresAt <= input.now() ||
    challenge.approvalId !== input.selector.approvalId ||
    challenge.digest !== input.selector.digest ||
    challenge.challenge !== input.selector.challenge
  )
    return voidApproval('the approval challenge is stale or does not bind this pending activation');
  const row = input.database
    .prepare('SELECT kind, document, digest, status, approval_id FROM activation_intents WHERE id = ?')
    .get(input.selector.activationId) as
    | {
        readonly kind: string;
        readonly document: string;
        readonly digest: string;
        readonly status: string;
        readonly approval_id: string | null;
      }
    | undefined;
  if (
    row === undefined ||
    row.status !== 'pending' ||
    row.kind !== 'rule' ||
    row.approval_id !== input.selector.approvalId
  )
    return voidApproval('the approval no longer names a pending rule activation');
  if (row.digest !== input.selector.digest) return voidApproval('the pending activation digest changed');
  let document: ReturnType<typeof normaliseActivationDocument>;
  try {
    document = normaliseActivationDocument(JSON.parse(row.document));
  } catch {
    return voidApproval('the pending activation document is not valid');
  }
  if (document.kind !== 'rule' || activationDocumentDigest(document) !== row.digest)
    return voidApproval('the pending activation document digest is invalid');
  const target = document.rule.targets.find(
    (candidate) => candidate.targetId === input.selector.targetId && candidate.version === input.selector.targetVersion,
  );
  if (
    document.rule.ruleId !== input.selector.ruleId ||
    document.rule.version !== input.selector.ruleVersion ||
    target === undefined
  )
    return voidApproval('the pending approval does not bind this exact rule target version');
  return {
    ruleId: document.rule.ruleId,
    ruleVersion: document.rule.version,
    targetId: target.targetId,
    targetVersion: target.version,
  };
}
