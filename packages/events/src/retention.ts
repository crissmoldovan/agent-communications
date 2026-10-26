/** A rule's retention defaults: the one copy, which the event service and the rule text both use. */

const DAY = 86_400_000;

/**
 * What a rule keeps, and for how long, when its author says nothing: the defaults the owner set on 2026-10-06
 * (local-event-emission design, D2) — seven days for each kind of content, except dry runs at 24 hours and decision
 * metadata, which holds no content, at 90 days — and the action queue's 7 days (action queue design, Q2). `queueMs` is
 * a rule's only when it has a queue target, and it is also a queue target's own default retention.
 */
export const RULE_RETENTION_DEFAULTS: Readonly<{
  ingestMs: number;
  holdMs: number;
  deliveryMs: number;
  dryrunMs: number;
  sseReplayMs: number;
  deadLetterMs: number;
  decisionMetadataMs: number;
  queueMs: number;
}> = Object.freeze({
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
  queueMs: 7 * DAY,
});
