import { withRouteFoldersHidden } from '../runtime/rule-show.ts';

/**
 * What the event service's MCP server passes an agent of an approval view (0.34.0 design B7): a ready view's approval
 * id, digest and preview (and a Laya rule's limits), and every other variant as it is. The owner issues no challenge for
 * an agent's view; one from before 0.34.0 still issues one and returns it, with each pending target's selector, and
 * neither reaches the agent. A workflow's route candidates keep their ids and names, and their folders and worktree
 * roots are hidden, as `rule show` hides them from an agent (security review of 0.36.0, M3): the person reads them in
 * the app or at their terminal, where the view is whole. A presentation step of the MCP adapter, as its reply is: the
 * operation both surfaces run is `approvalView`.
 */
export function approvalViewForAgent(view: unknown): unknown {
  if (typeof view !== 'object' || view === null || Array.isArray(view)) return view;
  const record = view as Readonly<Record<string, unknown>>;
  if (record.kind !== 'READY') return view;
  return {
    kind: 'READY',
    approvalId: record.approvalId,
    digest: record.digest,
    preview: previewForAgent(record.preview),
    ...(Object.hasOwn(record, 'layaJudge') ? { layaJudge: record.layaJudge } : {}),
    ...(Object.hasOwn(record, 'subscription') ? { subscription: record.subscription } : {}),
  };
}

/** A rule activation's preview with its workflow's route folders hidden; every other preview as it is. */
function previewForAgent(preview: unknown): unknown {
  if (typeof preview !== 'object' || preview === null || Array.isArray(preview)) return preview;
  const record = preview as Readonly<Record<string, unknown>>;
  if (record.kind !== 'rule' || !Object.hasOwn(record, 'rule')) return preview;
  const rule = withRouteFoldersHidden(record.rule);
  return rule === record.rule ? preview : { ...record, rule };
}
