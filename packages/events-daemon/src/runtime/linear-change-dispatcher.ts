import type { LinearChangeTargetDocument } from '../domain/linear-change-target.ts';
import { linearCommentId } from '../domain/linear-change-target.ts';
import { type LinearClient, type LinearFailure, type LinearGates, linearFailure } from './linear-client.ts';

/*
 * A Linear change's delivery (workflows design §6.7, W15; plan B5): a comment on, and an update of, the issue a create
 * step of the same run made — the issue the delivery's sealed record names, which came from that step's closed output
 * and never from a message. It is one act inside the Linear target's dispatcher (`LinearDispatcher`), so it has that
 * dispatcher's whole boundary: the exact claim, every authority fence before each network phase and the synchronous
 * gate right before it, a WhatsApp chat's visibility checked under its lock before each write, the person's one Linear
 * key, the one pinned endpoint, and a settlement only the exact claim can make.
 *
 * A retry changes nothing twice. Each try first reads the issue — it must be there, in the target's team — and the
 * comment by its own id, chosen from the delivery's (`linearCommentId`): Linear's `CommentCreateInput` takes `id` ("The
 * identifier in UUID v4 format. If none is provided, the backend will generate one.", Linear's GraphQL schema, read
 * 2026-10-27), so a comment whose answer was lost is found by its id and never made again. A state, labels or an
 * assignee go through one `issueUpdate`, which a second try repeats harmlessly. A rate limit, a 5xx or no usable answer
 * retries; Linear refusing (a 4xx, or a GraphQL error) fails at once with Linear's code.
 */

const LOOKUP_QUERY =
  'query AgentCommsLinearChangeLookup($issue: ID!, $comment: ID!) { viewer { id } issues(first: 1, includeArchived: true, filter: { id: { eq: $issue } }) { nodes { id team { id } } } comments(first: 1, includeArchived: true, filter: { id: { eq: $comment } }) { nodes { id } } }';
const COMMENT_MUTATION =
  'mutation AgentCommsLinearCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }';
const UPDATE_MUTATION =
  'mutation AgentCommsLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }';

/** The issue a Linear change acts on, as its record keeps it: the create step's closed output. */
export interface LinearChangeIssue {
  readonly id: string;
  readonly identifier: string;
  readonly url: string;
}

/** A Linear change delivery's sealed record: the run's own issue, and its comment rendered once. */
export interface LinearChangeDeliveryRecord {
  readonly kind: 'linear-change';
  readonly issue: LinearChangeIssue;
  /** The comment's Markdown, slot values quoted and labelled by who wrote them; null when the target comments not. */
  readonly comment: string | null;
}

/** What one try of a change came to: the issue changed, or a failure to try again, or one that will not succeed. */
export type LinearChangeOutcome =
  | { readonly kind: 'changed'; readonly issue: LinearChangeIssue; readonly status: number }
  | LinearFailure;

/** Test-only interruption points of a change, beside the dispatcher's own. */
export type LinearChangeCrashPoint = 'after-lookup' | 'after-comment' | 'after-update';

/** The `IssueUpdateInput` a change's target fixes; null when it only comments. `me` is the key's own user. */
export function linearChangeUpdate(
  target: LinearChangeTargetDocument,
  viewer: string | null,
): Readonly<Record<string, unknown>> | null | 'viewer-unknown' {
  const input: Record<string, unknown> = {};
  if (target.state !== undefined) input.stateId = target.state.id;
  if (target.labels !== undefined) {
    if (target.labels.add.length > 0) input.addedLabelIds = target.labels.add.map((label) => label.id);
    if (target.labels.remove.length > 0) input.removedLabelIds = target.labels.remove.map((label) => label.id);
  }
  if (target.assignee !== undefined) {
    if (target.assignee === 'me') {
      if (viewer === null) return 'viewer-unknown';
      input.assigneeId = viewer;
    } else input.assigneeId = target.assignee === null ? null : target.assignee.id;
  }
  return Object.keys(input).length === 0 ? null : input;
}

/** What a change's target changes, in its closed words (plan I5's `changed`): comment, state, labels, assignee. */
export function linearChangeKinds(target: LinearChangeTargetDocument): readonly string[] {
  return [
    ...(target.comment === undefined ? [] : ['comment']),
    ...(target.state === undefined ? [] : ['state']),
    ...(target.labels === undefined ? [] : ['labels']),
    ...(target.assignee === undefined ? [] : ['assignee']),
  ];
}

function nodes(value: unknown): readonly Record<string, unknown>[] {
  const list = (value as { nodes?: unknown } | null)?.nodes;
  return Array.isArray(list) ? list.filter((entry) => typeof entry === 'object' && entry !== null) : [];
}

/**
 * One try of a Linear change: read the issue and the comment, comment if it is not there yet, then update. Each request
 * goes through `gates`, a write's with the WhatsApp chat's lock.
 */
export async function changeLinearIssue(input: {
  readonly client: Pick<LinearClient, 'request'>;
  readonly key: string;
  readonly target: LinearChangeTargetDocument;
  readonly record: LinearChangeDeliveryRecord;
  readonly deliveryId: string;
  readonly gates: (write: boolean) => LinearGates;
  readonly deadline: number;
  readonly failpoint?: ((point: LinearChangeCrashPoint) => void) | undefined;
}): Promise<LinearChangeOutcome> {
  const { client, key, target, record, deadline } = input;
  const commentId = linearCommentId(input.deliveryId);
  // 1. The issue, as Linear has it now, and the comment a try of this delivery made already, if any.
  const lookup = await client.request({
    key,
    query: LOOKUP_QUERY,
    variables: { issue: record.issue.id, comment: commentId },
    gates: input.gates(false),
    deadline,
  });
  input.failpoint?.('after-lookup');
  if (lookup.kind !== 'data') return linearFailure(lookup);
  const issue = nodes(lookup.data.issues).find((node) => node.id === record.issue.id);
  // Gone, or moved out of the target's team: the change the person approved is not for it, and nothing is changed.
  if (issue === undefined) return { kind: 'failed', code: 'LINEAR_ISSUE_NOT_FOUND', status: lookup.status };
  if ((issue.team as { id?: unknown } | null)?.id !== target.team.id)
    return { kind: 'failed', code: 'LINEAR_TEAM_MISMATCH', status: lookup.status };
  const commented = nodes(lookup.data.comments).some((node) => node.id === commentId);
  const viewer = (lookup.data.viewer as { id?: unknown } | null)?.id;
  const update = linearChangeUpdate(target, typeof viewer === 'string' ? viewer : null);
  if (update === 'viewer-unknown') return { kind: 'retry', code: 'LINEAR_ANSWER_INVALID', status: lookup.status };
  let status = lookup.status;
  // 2. The comment, with its own id: a retry after a lost answer finds it in step 1.
  if (record.comment !== null && !commented) {
    const created = await client.request({
      key,
      query: COMMENT_MUTATION,
      variables: { input: { id: commentId, issueId: record.issue.id, body: record.comment } },
      gates: input.gates(true),
      deadline,
    });
    input.failpoint?.('after-comment');
    if (created.kind !== 'data') return linearFailure(created);
    const result = created.data.commentCreate as { success?: unknown; comment?: { id?: unknown } | null } | null;
    if (result?.success !== true || result.comment?.id !== commentId)
      return { kind: 'failed', code: 'LINEAR_NOT_COMMENTED', status: created.status };
    status = created.status;
  }
  // 3. The state, labels and assignee: setting them again is setting them.
  if (update !== null) {
    const updated = await client.request({
      key,
      query: UPDATE_MUTATION,
      variables: { id: record.issue.id, input: update },
      gates: input.gates(true),
      deadline,
    });
    input.failpoint?.('after-update');
    if (updated.kind !== 'data') return linearFailure(updated);
    const result = updated.data.issueUpdate as { success?: unknown } | null;
    if (result?.success !== true) return { kind: 'failed', code: 'LINEAR_NOT_UPDATED', status: updated.status };
    status = updated.status;
  }
  return { kind: 'changed', issue: record.issue, status };
}

/** A sealed Linear change record, as the dispatcher reads it back; null when it is not one. */
export function linearChangeRecord(value: unknown): LinearChangeDeliveryRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, issue, comment } = value as { kind?: unknown; issue?: unknown; comment?: unknown };
  if (kind !== 'linear-change' || (comment !== null && typeof comment !== 'string')) return null;
  if (typeof issue !== 'object' || issue === null) return null;
  const { id, identifier, url } = issue as { id?: unknown; identifier?: unknown; url?: unknown };
  if (typeof id !== 'string' || typeof identifier !== 'string' || typeof url !== 'string') return null;
  return { kind, issue: { id, identifier, url }, comment };
}
