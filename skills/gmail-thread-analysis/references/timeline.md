# Every field the timeline carries

What each field of a computed timeline actually means, how it is derived, and which of them promise more
than they deliver. Open it before putting a timeline field into a briefing, when a flag fired and you are
about to describe it to a user, or when the computed answer and your reading of the thread disagree and
you need to know which one is on firmer ground.

The timeline is built from headers and dates, never from body text. That is what makes it quotable. It
is not the same as being right about what happened: several fields are honest heuristics with names that
sound like facts, and a briefing that repeats them in the language of the field name will overstate what
is known.

## How it is built

`gmail_thread_timeline` reads the thread with the bodies at their smallest — one character each — and
then computes the events from the headers. Two things follow from that and both matter:

- **No body text is consulted.** A thread where the whole story is in the prose produces a timeline that
  looks thin. That is the tool working, not a fault.
- **The read still costs the full thread budget.** The budget is spent by each message's *complete*
  body length, not by the single character returned, so a thread with more than about 20,000 characters
  of bodies has its timeline cut short at exactly the same place a full read would be — and the timeline
  result says nothing about it. This is why `messageCount` below cannot be trusted as a thread's size.

## The timeline

| Field | What it is | Fact or heuristic |
|---|---|---|
| `threadId`, `inbox` | the thread and the mailbox alias it was read from | fact |
| `subject` | the raw subject of the **first message read**, exactly as the sender wrote it | fact about a sender-controlled string |
| `messageCount` | the number of events — that is, messages that fitted the budget | **not** the thread's size; see below |
| `participants` | every address appearing as `from`, `to` or `cc` across the events | fact, and incomplete; see below |
| `events` | one entry per message, oldest first | see the next section |
| `longestWaitHours` | the largest `gapHours` among non-draft events | fact about the messages read |
| `waitingOn` | who sent last, and how long ago | fact, routinely misread |
| `firstAt`, `lastAt` | the dates of the first and last non-draft messages read | fact about the messages read |

**`messageCount` is the count of events, not of the thread.** The name is the trap. If the read was cut,
this number is the number of messages you were given and there is nothing in the timeline result that
says so. The thread's true size is `messageCount` on a `gmail_thread_get` result, which counts the
messages Gmail returned before any budget was applied. Compare the two before you describe a thread as
having any number of messages in it.

**`participants` is incomplete twice over.** Blind recipients are not in the headers, so a thread can
have a reader nobody in it knows about; and anyone who only appears in a message that did not fit the
budget is not in the list. Say "the participants visible in the messages I read", not "the four people
on this thread".

## Each event

| Field | What it is |
|---|---|
| `index` | position in the thread as read, from 0. The rendered table shows it from 1. |
| `messageId` | the message's id in this mailbox — the thing to cite |
| `at` | the message's date as an ISO string, or null |
| `from` | the sender's address, lower-cased with the domain in punycode |
| `fromName` | the sender's display name — chosen by the sender, and worth nothing as identification |
| `direction` | `in` or `out`; see below |
| `to`, `cc` | the addresses on those headers |
| `isDraft` | the message carries Gmail's `DRAFT` label |
| `attachments` | non-inline attachments only, each with `filename`, `size` in bytes as Gmail reports it, and `riskFlags` |
| `subjectChanged` | this message's subject differs from the first's; see below |
| `gapHours` | hours since the previous non-draft message; null for the first |
| `participantsAdded` | addresses on this message that were not on the previous one |
| `participantsDropped` | addresses on the previous message that are not on this one |
| `forwardedIn` | the subject looks like a forward, **or** this sender had not appeared before |

### `direction` — a fact resting on an identity lookup that may have failed

A message is `out` when its sender is one of the mailbox's own addresses, or when Gmail labelled it
`SENT`. Everything else is `in`, including a message with no `From` header at all.

"The mailbox's own addresses" means the connected address plus every send-as address the Gmail API
returns for it. Two caveats:

- The send-as call needs an extra permission and is allowed to fail quietly. When it fails, the list is
  the connected address alone, and a message the user sent from an alias reads as inbound — which
  inverts `waitingOn` for the whole thread.
- The list is every send-as address Gmail returns, not only the verified ones. An alias added and never
  confirmed still counts as the user.

If a direction looks wrong, compare the event's `from` against the address `gmail_whoami` reports before
building anything on top of it.

### `gapHours`, `longestWaitHours` and `businessHours` — arithmetic, with a hard-coded working week

`gapHours` is wall-clock hours to one decimal place, measured from the previous **non-draft** message.
Drafts do not advance the clock, because nobody has seen them: a draft sitting between two sent messages
leaves the gap between those two intact.

Pass `businessHours` and the arithmetic changes to whole hours counted only on Monday to Friday, between
09:00 and 17:00 **UTC**. Not the user's timezone, not the correspondent's, not a configurable one — UTC,
fixed in the code. For a mailbox in London that is an hour out in summer; for a correspondent in New
York it is five, and their afternoon reply lands in what this counts as the end of the working day. Use
it to strip weekends out of a number, which is what it is good at, and do not present the result as
anyone's working hours.

`longestWaitHours` is simply the largest gap among the messages read. On a truncated thread it is the
largest gap *so far*, and the real longest wait may be in the part you did not get.

### `waitingOn` — who sent last, which is not whose turn it is

`party` is `us` when the last non-draft message was inbound, `them` when it was outbound, and `nobody`
when nothing has been sent. `sinceHours` is measured from that message to the moment the timeline was
built, in the same units as `gapHours`. `since` is that message's date.

That is the whole computation. It is a fact about message order and nothing else, and it is wrong about
obligation in recognisable ways: a "thanks, will look into it" sent last puts the computed party on
them while the ball is plainly ours; a long reply that never touches the question moves the clock and
not the obligation; and a draft in the thread leaves `party` where it was, because a draft nobody
received has changed nothing.

Report the computed value, then your own reading, then the sentence that decides it. Where they
disagree, that disagreement is usually the most useful line in the briefing.

### `subjectChanged` — compares against the first message, so it stays set

The comparison is against the **first message's** subject, not the previous one, with `Re:`, `Fw:`,
`Fwd:`, `Aw:`, `Sv:`, `Vs:` and `Rv:` prefixes stripped and case ignored. So `Re: Phase 2 plan` does not
count as a change from `Phase 2 plan`.

The consequence is that after a genuine rename, *every* later message carries the flag. Only the first
one is where the conversation was renamed. Reading the flag as "renamed here" turns one rename into five
and makes a thread look far more turbulent than it was. Find the earliest event carrying it and describe
that one.

It is also never set on the first message, which is the baseline.

### `participantsAdded` and `participantsDropped` — a one-step diff

Both compare this message with the one immediately before it, not with the thread. Neither is set on the
first message.

- Someone who was on message 4, absent from message 5 and back on message 6 appears as dropped at 5 and
  **added again** at 6. They were never removed from anything and they never joined anything.
- A reply-to-one inside a group thread shows everybody else as dropped — which is a real and useful
  signal, because the answer went to somebody who may not be able to act on it, and the rest of the
  thread never saw it.
- `participantsAdded` is where somebody's colleague genuinely joins a conversation, and it is also where
  a person who was quietly dropped for one message comes back. The flag cannot tell you which.

To say "X joined the thread at message 6" you have to check that X appears in no earlier event. The
timeline does not do that check for you.

### `forwardedIn` — two conditions, one name

It is set when the raw subject begins with `Fw:`, `Fwd:`, `Tr:` or `Wg:` — **or** when the sender had
not appeared anywhere in the thread before, as sender or as a recipient.

The second condition is the one that fires most often, and it has nothing to do with forwarding. A
colleague replying from an address nobody had seen, a new person added to a thread who writes first, a
sender whose address changed: all of them read as "forwarded in". Because the subject test runs on the
raw subject, a reply to a forward — `Re: Fwd: Phase 2` — does not match the first condition and may
still match the second.

What it is genuinely good for is spotting the point where a conversation acquired somebody from
outside. What it cannot support is the sentence "this was forwarded to us". Look at the sender and the
subject in the event itself before writing that.

### `isDraft`

A draft reply that exists in the thread appears as an event, flagged, and is excluded from every
computation that describes the conversation's rhythm: it does not advance `gapHours`, it is not
considered for `longestWaitHours`, and it cannot be the message `waitingOn` is measured from.

It is worth surfacing in a briefing for the opposite reason — a thread that feels handled because
somebody wrote a reply is a thread where nothing was sent.

## The renderings

The result carries `markdown` and `mermaid` alongside the structured timeline. The Markdown table has a
column per event for when, direction, sender, wait, attachments and changes, and it deliberately shows
**addresses only**: display names are sender-controlled and one can contain another person's address.

Take the rendering as-is rather than rebuilding it. A hand-built table is a second place for a
transcription error to live, and the rendered one already makes the right choice about names.

## Fact or heuristic, in one table

| Field | Read it as |
|---|---|
| `messageId`, `at`, `from`, `to`, `cc`, `attachments` | fact, straight from the headers |
| `gapHours`, `longestWaitHours`, `firstAt`, `lastAt` | fact, arithmetic on dates, about the messages read |
| `isDraft` | fact, from Gmail's own label |
| `messageCount`, `participants` | fact about what was read; **not** about the thread |
| `direction`, `waitingOn.party` | fact about message order, resting on an identity lookup that can fail |
| `subjectChanged` | fact with a misleading name: differs from the first, not changed here |
| `participantsAdded`, `participantsDropped` | fact about two adjacent messages, not about the thread |
| `forwardedIn` | heuristic, and mostly a "new sender" flag |
| `businessHours` arithmetic | fact, in a working week that is nobody's in particular |
| whose turn it actually is | yours, and it belongs in the labelled half of the briefing |

## Where this lives in the code

`packages/gmail/src/domain/timeline.ts` computes every field above and renders both views;
`packages/gmail/src/operations/analyse.ts` reads the thread at one character per body, builds the list
of addresses that count as the user's own, and returns the three forms together.

See also `references/reading-bodies.md` for the budget that decides how many of these events you get.
