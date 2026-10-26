/**
 * What the event service's MCP server passes an agent of an approval view (0.34.0 design B7): a ready view's approval
 * id, digest and preview (and a Laya rule's limits), and every other variant as it is. The owner issues no challenge for
 * an agent's view; one from before 0.34.0 still issues one and returns it, with each pending target's selector, and
 * neither reaches the agent. A presentation step of the MCP adapter, as its reply is: the operation both surfaces run is
 * `approvalView`.
 */
export function approvalViewForAgent(view: unknown): unknown {
  if (typeof view !== 'object' || view === null || Array.isArray(view)) return view;
  const record = view as Readonly<Record<string, unknown>>;
  if (record.kind !== 'READY') return view;
  return {
    kind: 'READY',
    approvalId: record.approvalId,
    digest: record.digest,
    preview: record.preview,
    ...(Object.hasOwn(record, 'layaJudge') ? { layaJudge: record.layaJudge } : {}),
  };
}
