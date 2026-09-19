# Reading a long thread without pulling it all in

The character budgets, how a cut shows up in the result, when to stop reading into the conversation and
write the thread to a file instead, and how to cite what you read so that somebody can check it. Open it
before briefing on a thread of more than a handful of messages, when a body came back shorter than it
should be, or when you are about to quote something and want the citation to be checkable rather than
decorative.

The rule underneath all of it: a briefing built on a thread you did not finish reading sounds exactly
like a briefing built on one you did. Nothing warns the reader. The fields below are the only way to
tell the difference, so they belong in the briefing, not just in your working memory.

## The budgets

| Budget | Value | Applies to |
|---|---|---|
| `DEFAULT_MAX_CHARS` | 8,000 characters | one message body, on a single-message read and on each message inside a thread read |
| `DEFAULT_THREAD_CHARS` | 20,000 characters | the whole of one thread read |
| export, per message | 100,000 characters | each message in an exported message or thread |
| export, per thread | 1,000,000 characters | an exported thread |
| export as `eml` | none | one message, raw, exactly as it arrived |

The per-message figure can be lowered or raised on a read (`maxChars`, CLI `--max-chars`). The per-thread
figure cannot: no tool argument and no CLI flag exposes it. Twenty thousand characters is what a thread
read gets, and export is the only way past it.

## How the budget is spent

Oldest message first. For each message in turn: if nothing is left, stop and mark the thread truncated;
otherwise read it with a limit of whichever is smaller, the per-message budget or what remains of the
thread budget. Then subtract.

The subtlety that decides everything else is **what gets subtracted**: the message's *whole* body length
after quote collapsing, not the number of characters you were actually given. Four consequences, and
they are not obvious:

1. **The cut lands at the end.** A thread read that runs out has read the beginning and lost the most
   recent messages — which are usually the ones the user is asking about. "The thread ends with our
   reply on the 14th" is the classic wrong sentence: it ends there in what you were given.
2. **Lowering `maxChars` does not fit more messages in.** Ask for 500 characters per message and you
   still spend the full length of each one. You get less text and the same number of messages.
3. **`includeQuoted` costs the budget.** Without collapsing, every reply carries the whole chain again,
   so each message's full length balloons and the thread runs out several messages earlier. Ask for
   quoted history on a specific message, not on a long thread.
4. **A timeline can be cut too.** The timeline reads the thread with bodies at one character each, but
   it spends the budget by the same full lengths, so a thread over the budget produces a short timeline
   — and the timeline result has no field that says so.

One more: a single message longer than 20,000 characters consumes the entire thread budget by itself,
and everything after it is missing.

## How a cut shows up

Per message, on a read or inside a thread:

| Field | Meaning |
|---|---|
| `body.truncated` | the window did not reach the end of this body |
| `body.nextOffset` | where a continuation starts; absent when the body is complete |
| `body.totalChars` | the whole collapsed body's length — how much there is |
| `body.quotedLinesOmitted` | lines the quote collapse removed, which are **not** counted in `totalChars` |

Per thread:

| Field | Meaning |
|---|---|
| `messageCount` | the thread's true number of messages, before any budget |
| `messages` | the ones that fitted — compare the length against `messageCount` |
| `truncated` | true when the budget ran out **or** any included message's body was cut |
| `totalChars` | the sum of the full body lengths of the messages included |

Note that thread-level `truncated` is one flag for two different problems. It does not say whether you
are missing whole messages or only the tail of one, so read it with the count comparison rather than on
its own.

On a timeline, nothing. The timeline's own `messageCount` is the number of events it produced, so it
agrees with itself whatever was lost. The only cross-check is a `gmail_thread_get` result's
`messageCount`.

| Symptom | What it means | What to do |
|---|---|---|
| `messages` shorter than `messageCount` | whole messages are missing, from the newest end | read the last ids individually, or export |
| `truncated` true, counts equal | one or more bodies were cut, no messages lost | continue from `nextOffset`, or export |
| a body of two lines with a large `quotedLinesOmitted` | probably an inline point-by-point reply | re-read that message with `includeQuoted` |
| the timeline has fewer events than the thread has messages | the timeline read was cut | take the tail from the message ids you do have |
| `totalChars` close to 20,000 | the budget is about to bind, or just did | export before building anything on it |

## Getting the end of a truncated thread

Two routes, and they are not equivalent.

**Read the last messages individually.** The timeline gave you every message's id, including the ones
the thread read dropped. `gmail_message_get` (CLI: `agent-gmail read <messageId> --inbox <alias>`) gives
each one its own 8,000-character budget, and `offset` continues a body that is itself long. This is the
right route when you need the last two or three messages and nothing else — it is a couple of calls and
the material stays small.

**Export the whole thread.** `gmail_export` with `thread: true` (CLI:
`agent-gmail export <threadId> --inbox <alias> --thread`) reads with the budgets raised to 100,000 per
message and 1,000,000 for the thread, writes the result under the downloads root and returns the path,
the byte count and how many messages it wrote. This is the right route when the answer might be anywhere
in the thread, when you need quoted history across several messages, or when the user is going to want
the material afterwards.

Formats are `md` (the default), `json` and `eml`. A thread cannot be exported as `eml` — that is one
message's original bytes, and it is the only form with no budget and no sanitising at all. The Markdown
export writes each message with its sender, recipients, date, **message id**, authentication summary,
attachment list, a note of any hidden content removed, and the body still inside its untrusted-content
envelope. That last point matters: a file is read back by the same model that would have read the
message, and it is still somebody else's writing. Exporting is not laundering.

## When to export rather than read

Export when any of these is true:

- More than two or three messages are needed in full.
- `messages` is shorter than `messageCount` and the missing part is not obviously irrelevant.
- The question needs quoted history across a chain.
- You are going to quote something precisely, and precision matters more than brevity.
- The user asked for the thread itself rather than a briefing on it.

Read into the conversation when the question is narrow and the evidence is a sentence or two in one or
two messages. The test is not thread length; it is how much of the thread has to be in your context for
the answer to be sound.

And whichever you choose, do not paste a long body into the conversation to prove you read it. Quote the
line that carries the point and cite the id.

## Citing so a claim can be checked

Three things make a claim checkable, and all three are cheap:

1. **The mailbox alias.** Ids belong to one account. A thread id from `work` means nothing in
   `personal`, and the same conversation read from a second mailbox is a different thread with different
   ids.
2. **The id.** A message id for a claim about one message; the thread id for a claim about the
   conversation. The timeline index (`m4`) is a useful shorthand *alongside* the id, not instead of it —
   it is a position in what you read, and it shifts if the thread is read again with a different budget.
3. **The shape of the read.** How many messages of how many, whether history was collapsed, whether
   anything was truncated, and where the material came from if it came from a file.

A briefing line that does all three:

```text
Ana asked for the revised figures on 14 Sep (m4, `work` / 18f2c1a…). We answered 98 minutes later
saying we would come back with numbers (m5, `work` / 18f2c4b…) and nothing has been sent since.

Read: 5 of 7 messages — the thread read hit its budget, so I took m6 and m7 individually by id.
Quoted history was collapsed throughout; m5 omitted 31 lines and I re-read it with quoting on,
which changed nothing.
```

The same claims without that shape are not shorter, they are weaker: nobody can tell whether "nothing has
been sent since" means the thread ends there or the reading did.

When the material is in a file, the path is the citation, and it should be quoted as it was returned
rather than described:

```text
The full conversation is at <the path gmail_export returned> — 11 messages, 48 KB.
I have quoted the two lines the answer turns on; everything else is in the file.
```

## The one thing this cannot fix

Quote collapsing happens before any of these budgets, and `totalChars` is measured after it. So a
message can be complete by every field above and still be missing the answer, because the answer was
written inside the quoted block. The budget fields tell you what the reader dropped; only
`quotedLinesOmitted` tells you what the collapse dropped, and only re-reading with quoting on tells you
what was in it.

## Where this lives in the code

`packages/gmail/src/domain/body.ts` holds the per-message budget, the collapse and the truncation
fields; `packages/gmail/src/operations/read.ts` holds the thread budget and the oldest-first spending;
`packages/gmail/src/operations/export.ts` holds the raised budgets, the file layout and the Markdown
rendering; `packages/comms-core/src/sanitize.ts` is what removed anything the body no longer has.

See also `references/timeline.md` for the fields a timeline gives you before any of this reading starts.
