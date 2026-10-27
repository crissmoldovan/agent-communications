/**
 * A message in words (spec 2026-10-26-owner-feedback-0320 §3.6, prototype row 4): the card's status chip and line of
 * steps, and the story's timeline, the agent windows that touched it, and its one-line summary. Pure: each takes the
 * joined message and how the screen writes a time.
 *
 * A part is the app's own words (`text`) or the rule author's (`untrusted`: a rule's id, a target's id, a judge's
 * question), which the screen shows through `UntrustedText`. What a sender wrote never reaches these words: the
 * screen shows the kept sender and subject through `OutsideText`, beside them.
 *
 * Takes (0.35.0, design 2026-10-26-taking-messages §9): who has the message and each take, hand-back and lapse, in the
 * person's view — the window's folder and client, which an agent never sees of another session (T7). A take's note is
 * an agent's words and may carry a sender's: it is an `untrusted` part, never the app's.
 */
import { productLabel } from '../components/ApprovalCard.tsx';
import { shownFolder } from '../lanes.ts';
import { isHandedBack, type JoinedMessage, type Status, type Touch } from './join.ts';
import type {
  DecisionView,
  DeliveryView,
  HandBackReason,
  JudgeAnswer,
  Millis,
  TakeWindowView,
  WindowRef,
} from './read.ts';

export type Part = { text: string } | { untrusted: string };

export interface StoryContext {
  /** A moment as the screen writes it. */
  time: (at: Millis) => string;
  /** The person's home folder, to show a folder with it as `~`. */
  home: string | null;
  /** When the person approved each reply, by the draft it sent (from the approvals they used). */
  approvedAt?: ReadonlyMap<string, Millis> | undefined;
}

const words = (text: string): Part[] => [{ text }];

/** A channel's name: Gmail, Slack, WhatsApp, Resend. */
export function channelWords(channel: string): string {
  return productLabel(channel === '' ? null : channel);
}

// ── The status chip ────────────────────────────────────────────────────────────────────────────────────────────

export type ChipTone = 'ok' | 'accent' | 'warn' | 'neutral';

const BY = { person: 'you', window: 'an agent' } as const;

/** The status chip's words and tone: Replied, Acknowledged, Done or Dismissed with who, Read, Waiting, Not seen. */
export function statusLabel(status: Status): { label: string; tone: ChipTone } {
  switch (status.kind) {
    case 'replied':
      return { label: 'Replied', tone: 'ok' };
    case 'acknowledged':
      return { label: 'Acknowledged', tone: 'accent' };
    case 'done':
      return { label: status.actor === null ? 'Done' : `Done by ${BY[status.actor]}`, tone: 'ok' };
    case 'dismissed':
      return { label: status.actor === null ? 'Dismissed' : `Dismissed by ${BY[status.actor]}`, tone: 'neutral' };
    case 'read':
      return { label: 'Read by an agent', tone: 'neutral' };
    case 'taken':
      return { label: status.by === 'person' ? 'You’re handling it' : 'Taken by an agent', tone: 'accent' };
    case 'handed-back':
      return { label: 'Handed back', tone: 'warn' };
    case 'waiting':
      return { label: 'Waiting for you', tone: 'warn' };
    case 'not-taken':
      return { label: 'Nobody took it', tone: 'warn' };
    case 'not-seen':
      return { label: 'Not seen', tone: 'neutral' };
  }
}

// ── Where, and who from ────────────────────────────────────────────────────────────────────────────────────────

/** Where it came in: the channel, the account by its name (or its id), and a Slack direct message as one. */
export function whereWords(message: JoinedMessage): string {
  const account = message.accountAlias ?? message.accountId;
  const direct = message.channel === 'slack' && message.event?.source.channelId?.startsWith('D') === true;
  return [channelWords(message.channel), account, direct ? 'direct message' : null].filter(Boolean).join(' · ');
}

/** What a card says when nothing kept who it is from: what it is, and where to see it. */
export function unknownSender(channel: string): string {
  const name = channelWords(channel);
  return `A ${name} message. No workflow kept its sender or subject, so open it in ${name} to see it.`;
}

// ── Judges, rules and deliveries ───────────────────────────────────────────────────────────────────────────────

function judgeName(judge: JudgeAnswer): string {
  switch (judge.kind) {
    case 'typesafe':
      return 'Jev';
    case 'local-endpoint':
      return 'Local model';
    case 'laya':
      return 'Laya';
    default:
      return judge.id ?? 'The judge';
  }
}

/** "Jev: yes", for a card. */
function judgeShort(judge: JudgeAnswer): string | null {
  return judge.answer === null ? null : `${judgeName(judge)}: ${judge.answer}`;
}

/** "Jev said yes, 0.86 sure", for a story; a local model's score is no probability, and says so. */
function judgeLong(judge: JudgeAnswer): string | null {
  if (judge.answer === null) return null;
  const said = `${judgeName(judge)} said ${judge.answer}`;
  if (judge.confidence === null) return said;
  const score = judge.confidence.toFixed(2);
  return judge.uncalibrated ? `${said}, ${score}, uncalibrated` : `${said}, ${score} sure`;
}

/** The decisions that did something: a match, a hold, or a rule that could not use it. A rule that did not match is quiet. */
function actingDecisions(decisions: readonly DecisionView[]): DecisionView[] {
  return decisions.filter((decision) => decision.outcome !== 'no-match');
}

function ruleCardStep(decision: DecisionView): Part[] {
  const rule: Part[] = [{ text: 'Workflow ' }, { untrusted: decision.ruleId }];
  switch (decision.outcome) {
    case 'matched':
      return rule;
    case 'hold':
      return [...rule, { text: ', held for its judge' }];
    case 'mapping-rejected':
      return [...rule, { text: ' could not use it' }];
    case 'retention-expired':
      return [...rule, { text: ': its hold ran out' }];
    default:
      return [...rule, { text: `: ${decision.outcome}` }];
  }
}

function ruleStoryStep(decision: DecisionView): Part[] {
  switch (decision.outcome) {
    case 'matched':
      return [{ text: 'Matched the workflow ' }, { untrusted: decision.ruleId }];
    case 'hold':
      return [{ text: 'Held for the judge of the workflow ' }, { untrusted: decision.ruleId }];
    case 'mapping-rejected':
      return [{ text: 'The workflow ' }, { untrusted: decision.ruleId }, { text: ' could not use it' }];
    case 'retention-expired':
      return [{ text: 'The hold of the workflow ' }, { untrusted: decision.ruleId }, { text: ' ran out' }];
    default:
      return [{ text: 'The workflow ' }, { untrusted: decision.ruleId }, { text: `: ${decision.outcome}` }];
  }
}

/** The delivery states that will never reach their target. */
const UNDELIVERED = new Set([
  'dead-lettered',
  'retention-expired',
  'cancelled',
  'content-unreadable',
  'in-flight-at-disable',
  'in-flight-at-account-removal',
]);

function deliveryCardStep(delivery: DeliveryView): Part[] {
  const failed = UNDELIVERED.has(delivery.state) ? [{ text: ', not delivered' }] : [];
  switch (delivery.targetKind) {
    case 'queue':
      return [{ text: delivery.lane === null ? 'Queue' : `Queue, lane ${delivery.lane}` }, ...failed];
    case 'dry-run':
      return [{ text: 'Dry run' }, ...failed];
    case 'webhook':
      return [{ text: 'Webhook ' }, { untrusted: delivery.targetId }, ...failed];
    case 'sse':
      return [{ text: 'Stream ' }, { untrusted: delivery.targetId }, ...failed];
    default:
      return [{ text: 'Delivered to ' }, { untrusted: delivery.targetId }, ...failed];
  }
}

function deliveryState(delivery: DeliveryView): string {
  if (delivery.state === 'delivered') return 'Delivered';
  if (UNDELIVERED.has(delivery.state)) return 'Could not be delivered';
  return 'Not delivered yet';
}

function deliveryStoryStep(delivery: DeliveryView): { what: Part[]; sub: Part[]; failed: boolean } {
  const failed = UNDELIVERED.has(delivery.state);
  switch (delivery.targetKind) {
    case 'queue':
      return {
        what: words(delivery.lane === null ? 'Put in the Queue' : `Put in the Queue, lane ${delivery.lane}`),
        sub: words(
          failed
            ? deliveryState(delivery)
            : delivery.lane === null
              ? 'For you to look at'
              : `For the agent bound to ${delivery.lane}`,
        ),
        failed,
      };
    case 'dry-run':
      return { what: words('Logged as a dry run'), sub: words('Nothing was sent anywhere'), failed };
    case 'webhook':
      return {
        what: [{ text: 'Sent to the webhook ' }, { untrusted: delivery.targetId }],
        sub: words(deliveryState(delivery)),
        failed,
      };
    case 'sse':
      return {
        what: [{ text: 'Streamed to ' }, { untrusted: delivery.targetId }],
        sub: words(deliveryState(delivery)),
        failed,
      };
    default:
      return {
        what: [{ text: 'Delivered to ' }, { untrusted: delivery.targetId }],
        sub: words(deliveryState(delivery)),
        failed,
      };
  }
}

// ── Windows ────────────────────────────────────────────────────────────────────────────────────────────────────

function clientWords(window: WindowRef | null): string | null {
  const client = window?.client ?? null;
  if (client === null) return null;
  return client.version === null ? client.name : `${client.name} ${client.version}`;
}

function folderWords(window: WindowRef | null, home: string | null): string | null {
  return window?.folder ? shownFolder(window.folder, home) : null;
}

/** A window in a few words: its folder and its client, as each was recorded. */
function windowWords(window: WindowRef | null, home: string | null): string | null {
  const said = [folderWords(window, home), clientWords(window)].filter(Boolean).join(' · ');
  return said === '' ? null : said;
}

/** The lane the message's queue item is in, or the one its delivery went to. */
function laneOf(message: JoinedMessage): string | null {
  return message.event?.queueItem?.lane ?? message.event?.deliveries.find((each) => each.lane !== null)?.lane ?? null;
}

const SEARCHES = new Set(['gmail.search', 'slack.search']);
const THREADS = new Set(['gmail.thread.read', 'gmail.thread.timeline', 'slack.thread']);

function searchWhere(operation: string | null): string {
  return operation === 'slack.search' ? 'Slack' : 'your mail';
}

// ── Takes (0.35.0) ─────────────────────────────────────────────────────────────────────────────────────────────

/** Why a session handed a message back, in a few words: core's closed reasons (T8). */
export const REASON_WORDS: Readonly<Record<HandBackReason, string>> = {
  'not-mine': 'not mine',
  'wrong-account': 'wrong account',
  'needs-the-person': 'it needs you',
  duplicate: 'a duplicate',
  other: 'another reason',
};

function reasonWords(reason: HandBackReason | null): string {
  return reason === null ? 'no reason given' : REASON_WORDS[reason];
}

/** A take's window as a story names it: its folder and client, as the take recorded them, or the activity line's. */
function takeWindowOf(touch: Touch): TakeWindowView | null {
  if (touch.take?.window) return touch.take.window;
  if (touch.window === null) return null;
  return { key: touch.window.key, sessionId: null, folder: touch.window.folder, client: touch.window.client };
}

function takeClientWords(window: TakeWindowView | null): string | null {
  const client = window?.client ?? null;
  if (client === null) return null;
  return client.version === null ? client.name : `${client.name} ${client.version}`;
}

/** "the agent in ~/acme", or "an agent window" when the take recorded no folder. */
export function agentIn(window: TakeWindowView | null, home: string | null): string {
  return window?.folder ? `the agent in ${shownFolder(window.folder, home)}` : 'an agent window';
}

/** A take's window in a few words: its folder and its client, as each was recorded. */
function takeWindowWords(window: TakeWindowView | null, home: string | null): string | null {
  const said = [window?.folder ? shownFolder(window.folder, home) : null, takeClientWords(window)]
    .filter(Boolean)
    .join(' · ');
  return said === '' ? null : said;
}

/** Where a person's act came from: this app, or a terminal, in a folder when it was read (§10). */
function fromWords(touch: Touch, home: string | null): string | null {
  const from = touch.take?.from ?? null;
  if (from === null) return null;
  if (from === 'app') return 'In this app';
  return from.terminal === null ? 'At a terminal' : `At a terminal in ${shownFolder(from.terminal, home)}`;
}

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Whether an `expired` line ended an offer, rather than a take: what came before it was an offer. */
function endedAnOffer(touches: readonly Touch[], touch: Touch): boolean {
  const before = touches.filter((each) => each.via === 'take' && each.at <= touch.at && each !== touch);
  const last = before[before.length - 1];
  return last?.kind === 'offered' || last?.kind === 'given';
}

/** A card's steps for a message's take: each offer, take, hand-back and the person's acts, in order. */
function takeCardSteps(message: JoinedMessage, context: StoryContext): string[] {
  const steps: string[] = [];
  const lane = laneOf(message);
  for (const touch of message.touches) {
    if (touch.via !== 'take') continue;
    const window = takeWindowOf(touch);
    switch (touch.kind) {
      case 'offered':
        steps.push(
          touch.actor === 'service' && lane !== null
            ? `Offered to the agent bound to lane ${lane}`
            : `Offered to ${agentIn(window, context.home)}`,
        );
        break;
      case 'given':
        steps.push(`You gave it to ${agentIn(window, context.home)}`);
        break;
      case 'taken':
        steps.push(`Taken by ${agentIn(window, context.home)}${touch.take?.eyes ? ' (👀)' : ''}`);
        break;
      case 'handed-back':
        steps.push(`Handed back: ${reasonWords(touch.take?.reason ?? null)}`);
        break;
      case 'take-done':
        steps.push('Marked done by the agent that took it');
        break;
      case 'kept':
        steps.push('You’re handling it');
        break;
      case 'released':
        steps.push('You took it back');
        break;
      case 'expired':
        steps.push(endedAnOffer(message.touches, touch) ? 'The offer ran out' : 'The take ran out');
        break;
      case 'ended':
        steps.push('Its window closed');
        break;
      default:
        break;
    }
  }
  return steps;
}

/** The timeline's entry for one step of a message's take, in the person's view: the window's folder and client. */
function takeEntry(touch: Touch, message: JoinedMessage, context: StoryContext): TimelineEntry {
  const window = takeWindowOf(touch);
  const where = takeWindowWords(window, context.home);
  const who = capital(agentIn(window, context.home));
  const from = fromWords(touch, context.home);
  const joined = (...parts: (string | null)[]) => {
    const said = parts.filter(Boolean).join(' · ');
    return said === '' ? null : words(said);
  };
  const note = touch.take?.note ?? null;
  /** A session's note, as it wrote it: an `untrusted` part, after what the app says of the window. */
  const withNote = (before: string | null): Part[] | null =>
    note === null ? joined(before) : [...(before === null ? [] : [{ text: `${before} · ` }]), { untrusted: note }];
  const entry = (tone: EntryTone, what: string, sub: Part[] | null): TimelineEntry => ({
    at: touch.at,
    tone,
    what: words(what),
    sub,
  });
  switch (touch.kind) {
    case 'offered': {
      const lane = laneOf(message);
      return entry(
        'accent',
        touch.actor === 'service' && lane !== null
          ? `Offered to the agent window bound to ${lane}`
          : `Offered to ${agentIn(window, context.home)}`,
        joined(where, 'It must still take it before it acts on it'),
      );
    }
    case 'given':
      return entry(
        'accent',
        `You gave it to ${agentIn(window, context.home)}`,
        joined(from, where, 'It must take it within 15 minutes'),
      );
    case 'taken':
      return entry(
        'accent',
        `${who} took it${touch.take?.eyes ? ', and 👀 went under the message' : ''}`,
        joined(where, 'From then on only this session may act on it'),
      );
    case 'handed-back':
      return entry('warn', `${who} handed it back: ${reasonWords(touch.take?.reason ?? null)}`, withNote(where));
    case 'take-done':
      return entry('ok', `${who} marked it done`, withNote(where));
    case 'kept':
      return entry('accent', 'You said you’ll handle it', joined(from, 'Every session is refused it'));
    case 'released':
      return entry('idle', 'You took it back', joined(from, 'Any session may take it again'));
    case 'expired':
      return endedAnOffer(message.touches, touch)
        ? entry('idle', 'The offer ran out', joined(where, 'It wasn’t taken in time'))
        : entry('idle', 'The take ran out', joined(where, 'An hour passed with nothing done on it'));
    case 'ended':
      return entry('idle', `${who}’s window closed, so its take ended`, joined(where, 'Any session may take it again'));
    default:
      return entry('idle', 'Its take changed', joined(where));
  }
}

// ── A card's steps ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A card's line of steps, as the prototype draws it: "Rule invoices › Jev: yes › Queue, lane billing › Read by the
 * agent in ~/work/cue++/acme › Reply sent 11:45, after your approval".
 */
export function cardSteps(message: JoinedMessage, context: StoryContext): Part[][] {
  const steps: Part[][] = [];
  const { event, touches } = message;
  if (event === null) steps.push(words('No workflow'));
  else {
    const acting = actingDecisions(event.decisions);
    if (acting.length === 0) steps.push(words('No workflow matched'));
    for (const decision of acting) {
      steps.push(ruleCardStep(decision));
      const judge = decision.judge === null ? null : judgeShort(decision.judge);
      if (judge !== null) steps.push(words(judge));
    }
    for (const delivery of event.deliveries) steps.push(deliveryCardStep(delivery));
  }
  const woken = touches.find((touch) => touch.kind === 'woken');
  if (woken !== undefined) {
    const lane = laneOf(message);
    steps.push(words(lane === null ? 'Woke an agent window' : `Woke the agent bound to lane ${lane}`));
  }
  const read = touches.find((touch) => touch.kind === 'read');
  if (read !== undefined) {
    const folder = folderWords(read.window, context.home);
    const sameWindow = woken !== undefined && woken.windowKey !== null && woken.windowKey === read.windowKey;
    if (sameWindow || folder === null) steps.push(words(`Read ${context.time(read.at)}`));
    else {
      const searching = SEARCHES.has(read.operation ?? '') ? `, while searching ${searchWhere(read.operation)}` : '';
      steps.push(words(`Read by the agent in ${folder}${searching}`));
    }
  }
  for (const step of takeCardSteps(message, context)) steps.push(words(step));
  const ack = touches.find((touch) => touch.kind === 'acknowledged');
  if (ack !== undefined) steps.push(words(ack.replied ? 'Acknowledged with a reply' : 'Acknowledged with a reaction'));
  const sent = touches.find((touch) => touch.kind === 'sent');
  if (sent !== undefined) {
    steps.push(
      words(
        sent.channel === 'slack'
          ? `Replied in the thread ${context.time(sent.at)}`
          : `Reply sent ${context.time(sent.at)}, after your approval`,
      ),
    );
  } else if (touches.some((touch) => touch.kind === 'prepared')) steps.push(words('A reply waits for your approval'));
  else if (touches.some((touch) => touch.kind === 'drafted')) steps.push(words('A reply drafted'));
  const item = event?.queueItem ?? null;
  if (item !== null && item.state !== 'open') {
    const state = item.state;
    const marked = [...item.history].reverse().find((line) => line.kind === state);
    const verb = state === 'done' ? 'Marked done' : 'Dismissed';
    steps.push(words(marked === undefined ? verb : `${verb} by ${marked.actor === 'person' ? 'you' : 'the agent'}`));
  }
  if (message.notTaken !== null) steps.push(words('Nobody took it'));
  else if (!message.agentSeen) steps.push(words('No agent has read it'));
  else if (message.status.kind === 'acknowledged') steps.push(words('No reply yet'));
  return steps;
}

// ── A story's timeline ─────────────────────────────────────────────────────────────────────────────────────────

/** The marker's tone: the event service's own step, a step on the way, one waiting on the person, one done. */
export type EntryTone = 'idle' | 'accent' | 'warn' | 'ok';

export interface TimelineEntry {
  /** When, if it is known: a rule's decision and a delivery are told after the arrival, without a time of their own. */
  at: Millis | null;
  tone: EntryTone;
  what: Part[];
  sub: Part[] | null;
}

function touchEntry(touch: Touch, message: JoinedMessage, context: StoryContext, sentLater: boolean): TimelineEntry {
  const window = windowWords(touch.window, context.home);
  const channel = channelWords(touch.channel ?? message.channel);
  const through = `through Agent Comms ${channel}`;
  const entry = (tone: EntryTone, what: string, sub: string | null): TimelineEntry => ({
    at: touch.at,
    tone,
    what: words(what),
    sub: sub === null ? null : words(sub),
  });
  const who = touch.actor === 'person' ? 'You' : 'The agent';
  switch (touch.kind) {
    case 'woken': {
      const lane = laneOf(message);
      return entry('accent', lane === null ? 'Woke an agent window' : `Woke the agent window bound to ${lane}`, window);
    }
    case 'read': {
      if (touch.via === 'queue') return entry('accent', 'An agent read it from the Queue', window);
      const sub = [window, through].filter(Boolean).join(' · ');
      const operation = touch.operation ?? '';
      if (SEARCHES.has(operation))
        return entry('accent', `An agent saw it while searching ${searchWhere(operation)}`, sub);
      return entry('accent', THREADS.has(operation) ? 'An agent read its thread' : 'An agent read it', sub);
    }
    case 'drafted':
      return entry('accent', 'An agent drafted a reply', window);
    case 'prepared':
      return entry('warn', 'It asked to send the reply', sentLater ? 'For your approval' : 'Waiting for your approval');
    case 'sent': {
      if (touch.channel === 'slack')
        return entry('ok', 'An agent replied in the thread', [window, through].filter(Boolean).join(' · '));
      const approved = touch.draftId !== null && context.approvedAt?.has(touch.draftId) === true;
      return entry(
        'ok',
        'The reply was sent',
        approved ? `Through Agent Comms ${channel}` : `After your approval, ${through}`,
      );
    }
    case 'acknowledged':
      return entry(
        'ok',
        touch.replied ? 'An agent acknowledged it with a reply' : 'An agent acknowledged it with a reaction',
        window,
      );
    case 'done':
      return entry('ok', `${who} marked it done in the Queue`, touch.actor === 'window' ? window : null);
    case 'dismissed':
      return entry('idle', `${who} dismissed it in the Queue`, touch.actor === 'window' ? window : null);
    case 'reopened':
      return entry('idle', `${who} reopened it in the Queue`, touch.actor === 'window' ? window : null);
    case 'offered':
    case 'taken':
    case 'handed-back':
    case 'take-done':
    case 'expired':
    case 'ended':
    case 'released':
    case 'given':
    case 'kept':
      return takeEntry(touch, message, context);
  }
}

/**
 * The story's timeline: arrived, matched, judged, queued — told in that order after the arrival — then each step
 * after, oldest first: woke a window, read, a reply prepared, approved, sent, acknowledged, done.
 */
export function timeline(message: JoinedMessage, context: StoryContext): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const { event } = message;
  if (event === null) {
    entries.push({
      at: null,
      tone: 'idle',
      what: words("The event service didn't see it arrive"),
      sub: words('It is here because an agent read it through Agent Comms'),
    });
  } else {
    entries.push({
      at: event.occurredAt ?? event.observedAt,
      tone: 'idle',
      what: words(`Arrived in ${message.accountAlias ?? channelWords(message.channel)}`),
      sub: words('Seen by the event service'),
    });
    const acting = actingDecisions(event.decisions);
    if (acting.length === 0) entries.push({ at: null, tone: 'idle', what: words('No workflow matched'), sub: null });
    for (const decision of acting) {
      entries.push({ at: decision.at, tone: 'accent', what: ruleStoryStep(decision), sub: null });
      const judge = decision.judge === null ? null : judgeLong(decision.judge);
      if (judge !== null && decision.judge !== null) {
        const question = decision.judge.question;
        entries.push({
          at: null,
          tone: 'accent',
          what: words(judge),
          sub: question === null ? null : [{ text: '“' }, { untrusted: question }, { text: '”' }],
        });
      }
    }
    for (const delivery of event.deliveries) {
      const step = deliveryStoryStep(delivery);
      entries.push({ at: delivery.at, tone: step.failed ? 'warn' : 'accent', what: step.what, sub: step.sub });
    }
  }
  const after: TimelineEntry[] = [];
  const sends = message.touches.filter((touch) => touch.kind === 'sent');
  for (const touch of message.touches) {
    after.push(
      touchEntry(
        touch,
        message,
        context,
        sends.some((sent) => sent.at >= touch.at),
      ),
    );
  }
  // When the person approved each reply that was sent, from the approvals they used.
  for (const sent of sends) {
    const approvedAt = sent.draftId === null ? undefined : context.approvedAt?.get(sent.draftId);
    if (approvedAt !== undefined)
      after.push({ at: approvedAt, tone: 'ok', what: words('You approved the reply'), sub: null });
  }
  // An item marked before its history was kept: marked, with no one named.
  const item = event?.queueItem ?? null;
  if (item !== null && item.state !== 'open' && !item.history.some((line) => line.kind === item.state)) {
    after.push({
      at: item.stateAt,
      tone: item.state === 'done' ? 'ok' : 'idle',
      what: words(item.state === 'done' ? 'Marked done in the Queue' : 'Dismissed in the Queue'),
      sub: null,
    });
  }
  // Nobody took it in time (0.35.0): when it counted, and why.
  const late = message.notTaken;
  if (late !== null) {
    const minutes = Math.round((late.due - late.since) / 60_000);
    after.push({
      at: late.due,
      tone: 'warn',
      what: words('Nobody took it'),
      sub: words(
        late.why === 'needs-the-person'
          ? 'A session handed it back saying it needs you'
          : `No session took it within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
      ),
    });
  }
  after.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return [...entries, ...after];
}

// ── The windows that touched it ────────────────────────────────────────────────────────────────────────────────

export interface WindowSummary {
  key: string;
  /** Its folder, with the home as `~`, or null. */
  folder: string | null;
  /** The first letter of its client, for its badge. */
  initial: string;
  /** Its client, its lane, and what it did. */
  line: string;
}

function times(count: number, one: string, many: (n: number) => string): string {
  return count === 1 ? one : many(count);
}

/** Each agent window that touched the message, first to touch it first, with what it did. */
export function windowsOf(message: JoinedMessage, context: StoryContext): WindowSummary[] {
  const byKey = new Map<string, Touch[]>();
  for (const touch of message.touches) {
    if (touch.actor !== 'window' || touch.windowKey === null) continue;
    byKey.set(touch.windowKey, [...(byKey.get(touch.windowKey) ?? []), touch]);
  }
  const lane = laneOf(message);
  return [...byKey.entries()].map(([key, touches]) => {
    const window =
      touches.find((touch) => touch.window?.folder)?.window ?? touches.find((touch) => touch.window)?.window ?? null;
    const count = (kind: Touch['kind']) => touches.filter((touch) => touch.kind === kind).length;
    const sent = count('sent');
    const handedBack = [...touches].reverse().find((touch) => touch.kind === 'handed-back');
    const did = [
      count('woken') > 0 ? 'was woken for it' : null,
      count('read') > 0
        ? times(count('read'), 'read it once', (n) => (n === 2 ? 'read it twice' : `read it ${n} times`))
        : null,
      count('taken') > 0 ? 'took it' : null,
      sent === 0 && count('drafted') + count('prepared') > 0 ? 'drafted a reply' : null,
      sent > 0 ? times(sent, 'sent one reply', (n) => `sent ${n} replies`) : null,
      count('acknowledged') > 0 ? 'acknowledged it' : null,
      handedBack === undefined ? null : `handed it back: ${reasonWords(handedBack.take?.reason ?? null)}`,
      count('done') + count('take-done') > 0 ? 'marked it done' : null,
      count('dismissed') > 0 ? 'dismissed it' : null,
      count('reopened') > 0 ? 'reopened it' : null,
    ]
      .filter(Boolean)
      .join(', ');
    const bound = touches.some((touch) => touch.via === 'queue') && lane !== null ? `bound to lane ${lane}` : null;
    const client = clientWords(window);
    return {
      key,
      folder: folderWords(window, context.home),
      initial: (window?.client?.name.trim()[0] ?? 'A').toUpperCase(),
      line: [client, bound, did].filter(Boolean).join(' · '),
    };
  });
}

// ── The summary ────────────────────────────────────────────────────────────────────────────────────────────────

const COUNTS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];

/** A count to start a sentence with: "Two", or the number past five. */
function countWords(count: number): string {
  return COUNTS[count] ?? String(count);
}

/** " The agent in ~/acme has it." while a window has the message, after a summary of how far it got. */
function holderSentence(message: JoinedMessage, context: StoryContext): string {
  const record = message.take;
  if (record?.state !== 'taken' || record.holder === null) return '';
  if (record.holder === 'person') return ' You’re handling it.';
  return ` ${capital(agentIn(record.holder, context.home))} has it.`;
}

/** The story's one line: how far the message got, in a sentence or two. */
export function storySummary(message: JoinedMessage, context: StoryContext): string {
  const { status } = message;
  const item = message.event?.queueItem ?? null;
  const done = `${item?.state === 'done' ? " It's done in the Queue." : ''}${holderSentence(message, context)}`;
  switch (status.kind) {
    case 'replied':
      if (status.via === 'slack-thread') return `An agent replied in the thread at ${context.time(status.at)}.${done}`;
      if (status.via === 'slack-ack')
        return `An agent acknowledged it with a reply at ${context.time(status.at)}.${done}`;
      return `An agent replied in the same thread at ${context.time(status.at)}, after you approved the reply.${done}`;
    case 'acknowledged':
      return `An agent acknowledged it with a reaction at ${context.time(status.at)}. No reply was sent through Agent Comms.${done}`;
    case 'taken': {
      const since = status.at === null ? '' : ` since ${context.time(status.at)}`;
      if (status.by === 'person') return `You’re handling it${since}. No session may act on it until you let them.`;
      return `${capital(agentIn(status.window, context.home))} has it${since}.`;
    }
    case 'handed-back':
      return status.sessions >= 2
        ? `${countWords(status.sessions)} sessions handed it back; nobody has it.`
        : `A session handed it back: ${reasonWords(status.reason)}. Nobody has it now.`;
    case 'not-taken':
      return `Nobody took it. It has waited since ${context.time(status.since)}.`;
    case 'done':
    case 'dismissed': {
      const verb = status.kind === 'done' ? 'marked it done' : 'dismissed it';
      const who = status.actor === 'person' ? 'You' : status.actor === 'window' ? 'An agent' : 'Someone';
      const when = status.at === null ? '' : ` at ${context.time(status.at)}`;
      return `${who} ${verb} in the Queue${when}.`;
    }
    case 'read':
      return `An agent read it at ${context.time(status.at)}. No reply was sent through Agent Comms.${holderSentence(message, context)}`;
    case 'waiting':
      return "It's waiting in the Queue. No agent has read it.";
    case 'not-seen':
      return 'No agent has read it through Agent Comms.';
  }
}

// ── Who has it (0.35.0) ────────────────────────────────────────────────────────────────────────────────────────

export interface WhoHasIt {
  /** Who has the message now, in a few words. */
  title: string;
  /** What that means, and since when. */
  line: string;
  /** Who it is: nobody, an offer, an agent window, the person, or done. */
  state: 'nobody' | 'offered' | 'window' | 'person' | 'done';
}

/** The story's head: who has the message, what that means for the person, and since when (§9). */
export function whoHasIt(message: JoinedMessage, context: StoryContext): WhoHasIt {
  const record = message.take;
  if (record === null || record.state === 'open') {
    if (record !== null && isHandedBack(record)) {
      const back = [...record.history].reverse().find((line) => line.kind === 'handed-back');
      return {
        state: 'nobody',
        title: 'Nobody has it',
        line: `A session handed it back: ${reasonWords(back?.reason ?? null)}. Any session may take it again, or you can give it to one.`,
      };
    }
    if (message.notTaken !== null) {
      return {
        state: 'nobody',
        title: 'Nobody has taken it',
        line: `It has waited since ${context.time(message.notTaken.since)}. Give it to a window, or handle it yourself.`,
      };
    }
    return {
      state: 'nobody',
      title: 'Nobody has it',
      line: 'Any session that reads it may take it. You can give it to one, or handle it yourself.',
    };
  }
  if (record.state === 'offered') {
    const to = record.offer?.to ?? null;
    const until = record.offer?.until ?? null;
    return {
      state: 'offered',
      title: `Offered to ${agentIn(to, context.home)}${until === null ? '' : ` until ${context.time(until)}`}`,
      line: 'It must take it before it acts on it. Until then, every other session is refused it.',
    };
  }
  if (record.holder === 'person') {
    return {
      state: 'person',
      title: 'You’re handling it',
      line: 'Every session is refused it until you let them take it.',
    };
  }
  const holder = record.holder;
  const client = takeClientWords(holder);
  const since = record.takenAt === null ? null : `Since ${context.time(record.takenAt)}`;
  if (record.state === 'done') {
    return {
      state: 'done',
      title: `${capital(agentIn(holder, context.home))} marked it done`,
      line: [client, 'Other sessions are still refused it'].filter(Boolean).join(' · '),
    };
  }
  const lease =
    record.leaseUntil === null
      ? 'Only this session may act on it'
      : `Only this session may act on it. Its take runs out at ${context.time(record.leaseUntil)} unless it acts on it again`;
  return {
    state: 'window',
    title: `${capital(agentIn(holder, context.home))} has it`,
    line: [since, client, lease].filter(Boolean).join(' · '),
  };
}
