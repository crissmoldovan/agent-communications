# Search on this Mac: what each person asked, found by words and by meaning

Date: 2026-10-26. Status: draft for the owner. **Nothing is built until the owner answers §11.** The screens (People →
one person, Search, Settings → Search on this Mac) are being drawn in parallel. This document covers what sits behind
them. Repository facts were read from `.agentcomms-wt/v034-soft` at 1c169674 on 2026-10-26. Outside facts are listed in
§12 with the date each was read. **L** marks the lead's call and **O** the owner's.

## 1. Why

The owner (2026-10-26): "The point would be to be able to see clearly what one specific user has asked… it might be
useful for us to use a local database or something where we can store vectors as well (because we may want to embed
what has been asked and what things have happened, and so we can then search it semantically)."

Today nothing can answer "what did David ask about invoices?":
- **The activity log keeps no content, by design.** It holds ids, subjects, senders' names and addresses, and a search's
  words (`packages/core/src/activity.ts:17-31`, `:89-100`). Its anti-goal is "Content is stored"
  (`2026-10-25-activity-design.md:57`).
- **The event service keeps content only for the length of a rule's approved retention, encrypted.** A queue item
  keeps it 1 to 30 days (`events-daemon/src/store/migrations.ts:880`) and a dry run 24 hours (`store/retention.ts:3`,
  `:105-111`).
- **The Messages screen already joins the story by message id,** but over 30 days and with no text
  (`apps/desktop/src/messages/join.ts:1-20`).
- **Nobody joins a person across channels.** Gmail contacts and Slack people are each one channel's own, and both say a
  name proves nothing (`packages/gmail/src/operations/contacts.ts:9-16`, `packages/slack/src/operations/people.ts:5-18`).

## 2. What is true today (each fact grounds a decision below)

- **SQLite is already here, through Node's own module.** The event service opens `node:sqlite` lazily, behind a version
  check (`events-daemon/src/runtime/sqlite.ts:5-16`, `:52-80`), with WAL and `secure_delete`
  (`store/database.ts:77-80`). Its content is AES-256-GCM packed records under keys derived from a master key held in
  the secret store (`store/crypto.ts:1-35`, `store/event-secrets.ts:1-25`).
- **Measured on this Mac (M1 Max, 2026-10-26), in throwaway scratch scripts that read no user data:**
  - Node 22.14.0 (SQLite 3.47.2) has **no FTS5** ("no such module: fts5").
  - Node 22.18.0 (SQLite 3.50.2) and 24.15.0 (3.51.3) have FTS5, a contentless table with `contentless_delete=1`, and
    the `unicode61 remove_diacritics 2` tokenizer. With it, `factura` matched "Factură" and `intelES` matched
    "înțeles". Both versions are compiled with FTS5, math functions and R-tree, and offer `loadExtension`.
  - The root `engines` is already `>=22.18.0` (`package.json:10`). Core's own is `>=22.12.0`.
  - An exact dot-product scan in plain JS, warmed, took:
    - 10,000 × 768 dimensions: 30–56 ms;
    - 50,000 × 768: 240–280 ms;
    - 50,000 × 256: 80–120 ms.
- **A local model server is already a known thing.** Judges of kind `local-endpoint` call Ollama only at a literal
  `127.0.0.1` or `[::1]` with an explicit port (`events-daemon/src/domain/judge-setup.ts:131-189`,
  `network/local-endpoint.ts:18-44`). The app's copy already says "Nothing leaves the Mac"
  (`apps/desktop/src/components/judges/copy.ts:32`, `:94-97`).
- **ONNX in the published packages is refused.** The Laya runtime (`onnxruntime-node` 1.30.0,
  `@huggingface/tokenizers` 0.2.0) is a private, never-published closure. The daemon installs it itself, and only after
  three owner gates. Its lock is still the fail-closed placeholder (`packages/events-laya-runtime/README.md`,
  `events-daemon/laya-runtime.json`: `"E2_EXTERNAL_REFERENCE_BLOCKED"`).
- **Packages are bundled.** Every dependency is inlined and noticed from the bundler's graph
  (`scripts/third-party-licenses.mjs:1-33`). A native `.dylib`/`.node` file cannot be inlined.
- **Every content view so far is the person's alone.** "No new MCP tool returns message content"
  (`2026-10-26-owner-feedback-0320-design.md:463`). An agent sees only its own window's activity
  (`2026-10-25-activity-design.md:194-199`). `activity items` and `messages list` are CLI-only exception rows, refused
  inside an MCP server (`capabilities.json`; `packages/core/src/operations/activity.ts:296-306`).
- **What the channels already have in hand when an agent reads a message:**
  - a Gmail read returns the sanitised visible text, with quoted history collapsed
    (`packages/gmail/src/operations/read.ts:270-290`);
  - a Slack read returns the decoded text and the poster's user id (`packages/slack/src/operations/message.ts:26`, `:98`);
  - both record through `withActivity`, which sees the whole result (`packages/gmail/src/activity.ts:55-80`).
- **What the event service sees:**
  - for a Gmail event, `subject` and `snippet` always, and `body` only when a rule asked for it (event design
    `:3784`, `:3804`, `:3743`);
  - for a Slack event, the full `text` and `author.userId`, top-level posts only (`:3885`, `:754`).

## 3. Decisions

**S1. Off by default; switching it on is a loosening the person approves (L).**
- Search is the first store whose job is to keep message text, so it starts off.
- **On** goes through the change policy: in the app on macOS (attested origin), at a terminal elsewhere. This is the
  0.34 pattern (`2026-10-26-desktop-0340-design.md` §3).
- **Off** is a tightening and applies at once.
- *Rejected:* on by default, as activity recording is. Activity keeps no content; this does.

**S2. Only what Agent Comms already had in hand. Nothing is fetched for Search (L).**
- **An agent read it:** captured in that process, at the read, from the result the agent got.
- **The event service observed it for a rule:** handed over at ingest, with only what the event already holds (S15,
  phase 2).
- Gmail and Slack only. **Never WhatsApp:** its visibility rule leaves no trace of a denied chat, and activity keeps
  only counts for it (activity spec S4). **Never Resend in v1.**
- **Never the person's own messages.** A message from the account's own address, its send-as addresses or its own Slack
  user is not an ask.

  > **Note, 2026-10-27 (the security review of 0.35.0, a LOW finding; L).** 0.35's Gmail capture never passed the
  > send-as addresses, so a message from one was kept as someone's ask. Now Gmail's capture reads the mailbox's
  > send-as list (`users.settings.sendAs.list`, which fetches no message). It reads it only while Search keeps that
  > mailbox and a read holds someone's message, keeps it for 15 minutes in the process (1 minute after a failure),
  > and waits for it at most 2 seconds. A message labelled `SENT` or `DRAFT` is the person's own too, which still
  > keeps out what the mailbox sent should the list not come.
- *Rejected:* indexing whole mailboxes and workspaces. That is a new reader of all mail, against Gmail quota and Slack
  rate limits, and the widest store possible. It is open question 1, as a per-person fill-in.
- *Rejected:* indexing only activity's subjects and senders. That is too thin to find "about invoices".

**S3. Replies Agent Comms sent are kept too, as what was done (L).**
- After an ok `gmail.send.execute`, or a Slack post in a thread, an `out` row keeps the text that went.
- It is linked to what it answers by the ids activity already records: `replyTo`, `thread`
  (`packages/core/src/activity.ts:142-146`, `:181-186`).
- So "what did we tell David about the invoice" is searchable, and a hit shows its answer.
- No new send path: the capture comes after the send, never from it (AGENTS.md).

**S4. "What was done" is joined, never copied (L).**
- A message's state (Replied, Acknowledged, Done, Read by an agent, Waiting for you, Not seen) stays what the
  Messages join computes. That join is `join.ts:319-340`, over `activity items` and the event service's
  `messages list`/`message show`.
- Search keeps the same message id the join uses: a Gmail message id, or Slack `<channelId>/<ts>`
  (`apps/desktop/src/messages/read.ts:101-103`).
- *Rejected:* a state column in the index. Two truths would drift apart, and the copy would outlive the stores it came
  from.

**S5. A person is a set of exact handles. Only the person joins channels (L).**
- **Handles:**
  - a Gmail address as `canonicalAddress` gives it (`packages/core/src/taint.ts:78`);
  - a Slack user as `<teamId>/<userId>` (`people.ts:20-39`).
- **Joined automatically:** one handle seen in several accounts. An address is one address, and an Enterprise Grid user
  id is one user.
- **Joined by the person only:** a Gmail person and a Slack person, through "Same person". This can be undone.
- **Names never join.** They are sender-controlled. The People screen may *suggest* a link when names match exactly,
  shown as a suggestion.
- *Rejected:* matching by name, since anyone can take a name.
- *Rejected for now:* asking Slack for `users:read.email`, so Slack people carry their address (open question 6).

**S6. The store: one SQLite file through `node:sqlite`. FTS5 for words; vectors as Float32 BLOBs, scanned exactly in
JS (L).**
- **No new dependency and no native code.** The event service already works with the same module on all three CI
  platforms.
- **The exact scan is fast enough:** about 30 days of what Agent Comms sees is thousands of messages, and filters run
  first (§2's numbers).
- **Escape hatch:** past about 100,000 vectors, first int8 vectors, then `sqlite-vec` through `loadExtension`.
- *Rejected:* `sqlite-vec` now:
  - it is pre-v1 ("expect breaking changes");
  - it is a native loadable library per platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64; no
    Windows arm64), which cannot be bundled;
  - it needs `allowExtension: true`, which turns on SQL's own `load_extension()` for that connection.
- *Rejected:* LanceDB (`@lancedb/lancedb` 0.40.0):
  - the darwin-arm64 binary alone is 254 MB unpacked;
  - it needs an `apache-arrow` peer;
  - 0.40.0 publishes no darwin-x64 build;
  - it is a second store beside SQLite.
- *Rejected:* an in-memory JS index (Orama-style) or a native HNSW library. The first holds the whole index in memory,
  and the second is native; either way it is a second store.

**S7. The code lives in core: `packages/core/src/search/`, `operations/search.ts` and `agentcomms search …` (L).**
- Capture must be in core anyway, because every channel captures and every channel depends on core.
- The person's machine-wide views (activity, approvals) are already core's.
- *Rejected:* the event service. It is optional and off by default, and its database is one owner's, with normative
  invariants (event design D8, D12). Search must work without it.
- *Rejected:* a new published package. It would need its own kind, release lists and notices, for code only core's CLI
  runs.

**S8. One writer. Captures go to an encrypted inbox; only the indexer writes the database (L).**
- A capture is one encrypted line, appended to `<state>/search/inbox/<UTC day>-<process id>.jsonl` with
  `appendPrivateLine` (`packages/core/src/fs.ts:113-133`).
- Each process writes only its own file, so a large line cannot interleave with another process's.
- `node:sqlite` stays out of the agents' read paths.
- *Rejected:* every process writing SQLite. That means lock waits inside an agent's read, and a database opened by
  every MCP server.

**S9. Meaning comes from Ollama on this Mac, from a reviewed short list. Never a cloud API (L; the default model is
open question 4).**
- **Endpoint:**
  - the judges' rule: plain HTTP to a literal `127.0.0.1` or `[::1]` with an explicit port. A copy of
    `localSetupEndpoint`'s rule goes into core, pinned by the same test vectors;
  - called with `node:http`, with that host and port and no agent, so no `HTTP_PROXY` can carry the traffic elsewhere.
- **Model:**
  - **v1 list:**

    | Model | Download | Licence | Context |
    | --- | --- | --- | --- |
    | `qwen3-embedding:0.6b` (**lead's default**) | 639 MB | Apache-2.0 | 32K |
    | `embeddinggemma` (Ollama's own example) | 622 MB | Gemma Terms of Use | 2K |
    | `bge-m3` | 1.2 GB | MIT | 8K |

  - All three are multilingual (100+ languages), so Romanian and English both work.
  - Each has a profile: its query and document templates (Qwen's instruction; Gemma's `task: search result | query:`),
    and 512 dimensions, which Qwen (32–1024) and Gemma (768/512/256/128) both offer through Ollama's `dimensions`.
  - A model off the list is refused in v1, so quality claims stay honest.
- **Never remote:**
  - before each run, `/api/tags` must list the model **without** `remote_model`/`remote_host`, and a name ending in
    `cloud` is refused;
  - the model's `digest` is recorded, and a new digest asks for Rebuild;

    > **Note, 2026-10-27 (the security review of 0.35.0, a LOW finding).** This line and §5 disagree: §5 (and §9's
    > test) say a model change, a new digest among them, starts generation n+1 at once. 0.35 does what §5 says, so a
    > new `ollama pull` under the approved name sends every kept message's words to the new weights again without
    > asking. The narrow change, for now: `search status` gives `model.vectorsDigest`, the digest the vectors in use
    > were made with, beside `model.digest`, and while the two differ a note says the new weights are making every
    > vector again. The app's Settings shows that note. Whether a new digest should instead wait for the person's
    > Rebuild, as this line says, is open for the owner. The server is the same loopback one the person approved,
    > and the not-remote checks still run each time.
  - doctor recommends Ollama's local-only mode (`OLLAMA_NO_CLOUD=1`, or `disable_ollama_cloud` in
    `~/.ollama/server.json`) and says whether it is set.
- **No model:** search works by words only, and says so.
- **Getting it:** the app shows `ollama pull <model>` with Copy, and Check again. Agent Comms downloads nothing itself.
- *Rejected:* a bundled ONNX model:
  - ONNX is refused in published packages, and Laya's reviewed runtime is still behind the owner's gates;
  - transformers.js 4.3.1 pulls `onnxruntime-node`, `onnxruntime-web` and `sharp`.
  It is the later path once Laya's runtime ships: same closure, a model manifest with SHA-256s like
  `laya-manifest.json`.
- *Rejected:* any hosted embedding API (the owner's stance).

**S10. No new background job. The indexer runs when someone looks (L).**
- `agentcomms search index --budget <seconds>` takes the inbox, writes rows, embeds, summarises (if S14 is on) and
  prunes. A file lock keeps it to one run at a time (`withFileLock`, `packages/core/src/lock.ts:201`).
- **Run by:**
  - the app, every 5 minutes while it is open, and when Search, People or Settings → Search opens;
  - every search, first, up to 2 seconds;
  - the first core call each day prunes, as activity does (`activity.ts:760`).
- **Without the app:** captures wait, encrypted, and are pruned by day all the same.
- *Rejected:* a launchd/Task Scheduler job (one more job to install, attest and explain).
- *Rejected:* the event service as the indexer (S7).

**S11. Text encrypted at rest. The word index and the vectors are not, and the screens say so (L).**
- **Encrypted (AES-256-GCM):** each message's text, subject, sender name and summary, and each person's label. The key
  is `search-index` in the configured secret store (Keychain on macOS; `secrets.ts:58`, `:181`). The format and AAD
  follow the event service's packed records. The inbox lines are encrypted with the same key.
- **Not encrypted, and cannot be:**
  - the words (FTS5 must read tokens; a contentless table keeps the tokens but not the text);
  - the vectors (a scan must read them);
  - handles (lookups need them; activity already keeps addresses).

  Vectors can be turned back into close text (Vec2Text recovers 32-token inputs almost exactly). So doctor and the
  settings say: "Treat this folder like your mail."
- **Backups:** `<state>/search` is excluded from Time Machine with `tmutil addexclusion` (sticky, the default kind).
  Otherwise a backup would outlive retention and Delete everything.
- **Disk encryption:** doctor reads `fdesetup status` and warns when FileVault is off. Windows and Linux are not checked,
  and doctor says so.
- With a file secret store (no Keychain), the key sits beside the data, and the encryption only protects copies of the
  search folder alone. Doctor says that too.
- *Rejected:* whole-database encryption. SQLCipher is not in `node:sqlite`, and it is a native build.
- *Rejected:* plaintext text, as activity keeps subjects. A body is more than a subject.

> **Note, 2026-10-27 (the security review of 0.35.0, finding M2; L).** "A contentless table keeps the tokens but not
> the text" was false. FTS5's default `detail=full` keeps each token's position, and `fts5vocab 'instance'` gave a
> message's subject and text back in order, with no key. The words index is changed, and it is now encrypted in all
> but name:
> - **Keyed hashes, not words.** The words are made into tokens in JS: case and diacritics are folded as
>   `unicode61 remove_diacritics 2` folded them for English and Romanian (`Factură` = `factura`, `înțeles` = `INTELES`),
>   and each run of letters and digits is one word. Each word is replaced by HMAC-SHA256 under the `words` subkey of
>   `search-index` (HKDF, `agentcomms-search/words/v1`), cut to 128 bits as 32 hex digits. FTS5 sees only those
>   tokens (`tokenize='ascii'`), each once a message, sorted. A search's words are hashed the same way.
> - **No positions:** `detail=none`. Each word of a search is looked for alone, so no phrase needs them.
> - **Prefixes are kept.** The last word of a search still matches as a prefix: each word is also kept by its first 3
>   to 24 characters, under a hash of their own kind. A last word of one or two letters now matches whole only.
> - **Ranking:** bm25 needs positions in a contentless table, so a row scores the bm25 weight of each word it holds,
>   `ln((N − n + ½)/(n + ½))`, without counts or length; newer first on ties.
> - **What the file still shows without the key:** which rows share a token, and how many tokens a row has. It shows no
>   word, and no word's place. With the key a guessed word can be tested, but the key opens the sealed text anyway.
> - **An index of schema 1** (only a 0.35 test build made one; 0.35.0 was never released with it) is upgraded on its
>   first open. Its words table is dropped at once, under `secure_delete`, and the WAL is checkpointed. Then the hashes
>   are made from the sealed text at the first open that has the key, before anything is searched. Schema is now 2.
>
> The words index therefore moves out of "not encrypted" above. The vectors and the handles stay there, and the
> approval for `on` and `model set`, `search status`, doctor and the app's notes now say exactly that.

**S12. Retention follows Activity's days (L; open question 5).**
- A message is kept while Activity keeps its day: `activity.retentionDays`, 30 by default, 1–365
  (`activity-settings.ts:21-22`), counted from `seen_at`.
- The story beside a hit comes from activity lines (S4), so a hit kept longer would have no story.
- Lowering the days prunes at once.

> **Note, 2026-10-27 (the security review of 0.35.0, finding M6; L).** Raising Activity's days kept Search's message
> words longer too, and the preview a person approved said nothing about Search. Now, while Search keeps words — on,
> or off with an index still holding what was kept — the preview for more days gains a line: "keeps the words of the
> messages Search on this machine holds for as long too: N days, not M". It is only on more days. A line on fewer
> days would make that tightening wait for an approval.

**S13. No agent searches. CLI and app only (L; open question 3).**
- **Every `search` command except `status` and the tightenings is refused:**
  - inside an MCP server's process (`MCP_SERVER_PROCESS`, as `operations/activity.ts:296-306` refuses);
  - under an agent marker (`packages/core/src/cli-runtime.ts:125-139`).
- The marker check is a speed bump, and the docs say so: a shell runs as the person.
- **No MCP tool** (exception rows). A year of everyone's mail, searchable by meaning, is the widest read there is, and
  0.32's §4 promises no MCP tool returns message content.
- Agents keep their live, per-account, recorded tools (`gmail_search`, `slack_search`).

**S14. Summaries are optional and off (L).**
- **The line per message:** a summary from a local chat model, or the Gmail subject, or the first sentence of a Slack
  message (up to 120 characters each).
- **The summary model:** through Ollama's `/api/chat`, under the same loopback and not-remote checks, with the prompt
  "the ask in at most 12 words, or none". The model is named in settings.
- **Its output is sender-derived:** it is shown as outside text, never given to an agent, cut to one line, and control
  characters are stripped.

**S15. The event service's half is phase 2, behind an amendment to the events design (L).**
- When Search is on for an account, the event service's ingest appends the same encrypted capture: Gmail
  `from`/`subject`/`snippet` (and `body` only if a rule fetched it); Slack `author`/`text`/`mismatch`/`unrenderable`.
- It never fetches for Search.
- This is a new local content destination, so D8's content rules gain it, under the person's Search consent and S12's
  retention. It is not a rule's.
- Until phase 2, Search covers what agents read, and Messages still shows every event.

## 4. Data model

`<state>/search/` (folder 700, files 600; `%LOCALAPPDATA%` on Windows, `paths.ts:109-111`): `search.sqlite` and its WAL,
and `inbox/`. The database is opened like the event service's: WAL, `synchronous = FULL`, `secure_delete = ON`,
`foreign_keys = ON`. An FTS5 probe runs before first use; with no FTS5 it says "needs Node 22.18 or newer".

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  -- schema, keyId, generation, model {name, digest, dims}, summaries model
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,                -- the FTS rowid
  source_id TEXT NOT NULL UNIQUE,        -- Gmail messageId | Slack <channelId>/<ts>: join.ts's id
  event_id TEXT,                         -- the event service's, when it saw it (phase 2)
  channel TEXT NOT NULL CHECK (channel IN ('gmail','slack')),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  account_id TEXT NOT NULL,
  thread_id TEXT,                        -- Gmail threadId | Slack <channelId>/<parent ts>
  reply_to TEXT,                         -- out: the source_id it answers
  handle TEXT REFERENCES handles(handle),-- in: who sent it
  at INTEGER NOT NULL,                   -- sent (ms)
  seen_at INTEGER NOT NULL,              -- first in hand: the retention clock
  seen_by TEXT NOT NULL CHECK (seen_by IN ('agent','event','send')),
  partial INTEGER NOT NULL CHECK (partial IN (0,1)), -- a snippet, or a read cut by --max-chars
  flags INTEGER NOT NULL DEFAULT 0,      -- Slack mismatch | unrenderable
  line_state TEXT NOT NULL CHECK (line_state IN ('off','pending','done','failed')),
  encrypted_record BLOB NOT NULL         -- {subject, fromName, text ≤ 32 KiB, line}
) STRICT;
CREATE VIRTUAL TABLE words USING fts5(subject, text,
  content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
  -- 2026-10-27 (S11's note): fts5(tokens, content='', contentless_delete=1, detail=none, tokenize='ascii'),
  -- holding keyed hashes of the words
CREATE TABLE vectors (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  vector BLOB NOT NULL                   -- dims × float32, L2-normalised
) STRICT;
CREATE TABLE people (
  id TEXT PRIMARY KEY, linked INTEGER NOT NULL, encrypted_label BLOB,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE handles (
  handle TEXT PRIMARY KEY,               -- email:<canonical> | slack:<teamId>/<userId>
  person_id TEXT NOT NULL REFERENCES people(id),
  encrypted_name BLOB,                   -- the latest name the sender gave
  last_seen_at INTEGER NOT NULL) STRICT;
```

- **One vector per message** (L): the subject and the first 2,000 characters of the new text. Quoted history is
  already collapsed by the read, and an ask sits at the top.
- **The words index holds all the kept text.** *Rejected:* chunking. It means more vectors, and the quoted history it
  would add is noise.
- **A full read replaces a partial row,** never the reverse.
- **A deleted row leaves nothing behind:** its words row goes too (contentless delete), and its vector by cascade.

  > **Note, 2026-10-27 (the security review of 0.35.0, finding M3; L).** It did leave something: a contentless
  > delete only marks a row's tokens deleted, and they stay in the file until FTS5 merges the segments holding them.
  > So every prune that deletes a row also optimises the words index (`'optimize'`: one segment, without them).
  > Prunes are retention, an account taken out of Search, and the day's first command. `secure_delete` zeroes the
  > pages that frees, and the WAL is checkpointed after. Measured on this Mac, under load: about 1 s for 5,000
  > synthetic messages of 150 words. It runs only when a row went, and an edit that replaces a row's words leaves
  > the old ones to FTS5's own merging, since that message is still kept.
- A person with no messages left is deleted, unless the person linked or labelled them.

## 5. Indexing: what, when, how

**Capture** happens in the process that had the message, after an ok call. Only when Search is on and the account is
included. Never from the person's own handles.

| Operation | What it keeps |
| --- | --- |
| `gmail.message.read`, `gmail.thread.read`, `gmail.thread.timeline` | each inbound message: sanitised visible text, subject, sender |
| `gmail.search`, `gmail.followups` | subject, snippet, sender; `partial` |
| `slack.read`, `slack.thread`, `slack.search` | each inbound message: text, user id, flags |
| `gmail.send.execute`, `slack.post.send`, `slack.ack` (reply) | `out`: the text sent, `reply_to` / thread |
| event ingest (phase 2) | §S15 |

- **Never in the way:** a capture never throws and never changes a result. A failure is said once per process and kept
  for doctor, as activity's are (activity spec §4.6).
- **Budget:** about 5 ms per call (one encryption, one append), measured in the tests.

**An index run:**
1. take inbox files, by renaming each;
2. decrypt and validate each line;
3. upsert `messages`, `words` and `handles`/`people`;
4. embed rows with no current vector, 32 per `/api/embed`, with `dimensions: 512` and the document template;
5. summarise if S14 is on;
6. prune past S12 and the removed accounts;
7. checkpoint the WAL.

Each step resumes after a crash. An inbox line is deleted only after its row commits.

**A model change** (another name, digest or dimensions) starts generation n+1. Rebuild re-embeds from the stored text
in the background, and the old vectors serve until the new set is complete. Words keep working throughout.

## 6. Search

**`agentcomms search query <text> [--person <id>] [--account <alias>…] [--channel gmail|slack] [--since] [--until]
[--limit ≤50] --json`:**
1. **Filter first, in SQL:** account, channel, time, and the person's handles; `direction = 'in'` unless asked.
2. **Words:** FTS5 `MATCH` on the query's terms (each quoted, the last as a prefix), ranked by `bm25`. (2026-10-27:
   the terms are keyed hashes, and the rank is bm25's weight of each word without counts; S11's note.)
3. **Meaning:** embed the query with the profile's query template, then an exact cosine over the filtered rows' current
   vectors.
4. **Fuse** the two top-50 lists by reciprocal rank (k = 60), newer first on ties. With no model, or one that fails its
   check, `mode` is `words`.

**Result:**

```json
{ "mode": "hybrid", "searchedOnThisMac": true, "pending": 3,
  "model": { "name": "qwen3-embedding:0.6b", "digest": "…" },
  "hits": [ { "sourceId": "…", "eventId": null, "channel": "gmail", "account": { "id": "…", "alias": "acme/gmail" },
    "direction": "in", "at": 1761480000000, "person": { "id": "p_…", "linked": true },
    "from": "<untrusted-content …>…", "subject": "<untrusted-content …>…", "line": "<untrusted-content …>…",
    "excerpt": "<untrusted-content …>…", "flags": [], "partial": false,
    "answeredBy": [ { "sourceId": "…", "at": 1761483600000 } ],
    "rank": { "words": 2, "meaning": 1 } } ] }
```

- **Every sender-derived field is in the untrusted-content envelope,** each with a fresh boundary (`untrusted.ts:99`,
  `:108`): name, subject, excerpt, and the summary.
- **The excerpt** is about 240 characters around the first matched term, or the start of the text.
- **The story:** the app joins it to each hit with `join.ts`, through `activity items --ids` (at most 50,
  `allowlist.rs:665-672`) and `message show <eventId>`.
- **State as a filter** (Waiting, Replied…) narrows the joined hits in the app. In v1 the screen says "among the best
  50".
- **A person chip:** when a word of the query equals a person's label or latest name (case-folded), the app offers
  "David" as a removable filter. It is a suggestion, never an identity claim.

**People:**
- `search people [--since] --json`: each person, with their handles, their latest name (enveloped), their count, and
  when they last wrote.
- `search person <id> [--since] [--limit] --json`: their messages, newest first, one line each. State comes from the
  same join.

**A search writes one activity line:** the query and a count, **with no items**. If it named items, `join.ts`
(`:151-154`, `:286-312`) would show the person's search as "Read by an agent". `searchContacts` does the same
(`contacts.ts:55-73`).

## 7. Privacy, retention, who reads what

- **Where things live:** everything in §4 is on this Mac. The only connection is to loopback (S9), and a test seals the
  network (§9).
- **The words "nothing leaves it":** the screen's "Searched on this Mac: nothing leaves it" is shown when the run used
  the checked local model, or words only. A check that fails says why, and falls back to words.
- **Retention:** S12, plus these:
  - removing an account from Search, or from Agent Comms, deletes its rows at once;
  - **Off** stops capture and indexing at once. What is kept stays searchable until its days pass, or until Delete
    everything.
- **Delete everything** (a tightening; applies from anywhere, after the app's confirm or `--confirm`). In order:
  1. stop any run;
  2. delete the inbox, the database, its WAL and SHM;
  3. delete the `search-index` key, so any copy left anywhere is unreadable;
  4. write a content-free audit line.

  A test then finds no planted marker under `<state>`.

  > **Note, 2026-10-27 (the security review of 0.35.0, a LOW finding; L).** "Applies from anywhere" let an agent's
  > shell run `search delete --all --confirm` and erase what the person kept, and its key, at once. It cannot be
  > undone, so it is now the person's alone. It is refused inside an MCP server's process and under an agent's
  > marker, as the person's searches are (S13), and the app's confirm still runs it. `off`, `accounts remove` and
  > `model none` stay anyone's: they stop keeping, or drop vectors that Rebuild makes again.
- **Who reads what:**
  - the person alone, in the app and at a terminal (S13);
  - no MCP tool reads the index;
  - doctor's `search` check (on or off, counts, size, the oldest day, the model's state, FileVault, the backup
    exclusion) is content-free, so `comms_doctor` may show it;
  - the event service never reads the index.
- **Untrusted content:** Gmail text was sanitised at the read. Slack's `mismatch` and `unrenderable` are kept and shown
  on the hit, as the Slack server requires. The app renders every enveloped field with `OutsideText`.

## 8. Surfaces

**CLI** (`agentcomms search …`, in `operations/search.ts`):

| Command | Class |
| --- | --- |
| `status` | content-free read; allowed anywhere |
| `query`, `people`, `person`, `show <sourceId>` | the person's read; S13 refusals |
| `index [--budget]`, `rebuild` | upkeep; S13 refusals |
| `link <p> <p>`, `unlink <handle>`, `label <p> <name>` | the person's own data; no approval; S13 refusals |
| `on`, `accounts add <alias>`, `model set <address> <name>`, `summaries on <model>` | loosening: the change policy, `--app-approval` from the attested app |
| `off`, `accounts remove`, `model none`, `summaries off`, `delete --all --confirm` | tightening: at once (2026-10-27: `delete` is the person's alone, §7's note) |

**MCP:** none. Each command gets an exception row in `capabilities.json`, giving its reason, as `core.activity.items`
has. `pnpm verify:parity` checks them.

**Desktop:**
- **Calls:** new allow-list calls for each command above.
- **Grammars:**
  - the query is free text, 1–500 characters, with no control or bidi characters, passed as one argument after `--`.
    It is a new grammar in `grammar.rs`;
  - person ids are `p_` and a ULID;
  - handles follow `ItemId`'s rules.
- **Version gate:** `SEARCH_VERSION`.
- **Do it in Terminal** is offered where the origin is not attested.
- **Screens:**
  - **People → one person:** `search person`, plus the join for state.
  - **Search:** `search query`, plus the join.
  - **Settings → Search on this Mac:**
    - on/off;
    - the accounts;
    - what is kept (counts, size, oldest day) and for how long (Activity's days, linked);
    - the local model (address, model, its state: running, missing, remote refused; Copy for `ollama pull`);
    - summaries;
    - Rebuild (with progress);
    - Delete everything (with a confirm).

## 9. Tests

- **Capture:**
  - it never fails or changes a call;
  - nothing is captured while Search is off, or for an account left out;
  - nothing is captured from the person's own handles;
  - inbox files and the database's text are ciphertext: a planted marker body is absent from every file under
    `<state>`, apart from the words and vector tables, which are pinned separately.
- **Retention and deletion:**
  - lowering Activity's days prunes at once: rows, words and vectors;
  - removing an account deletes its rows;
  - Delete everything leaves no file and no key, and a later run starts empty.
- **Refusals:** inside an MCP server's process, and under each agent marker. `status` and the tightenings still work.
- **Model:**
  - the loopback vectors are shared with the event service's `local-endpoint` tests;
  - a model with `remote_host`, or a `…cloud` name, is refused;
  - a digest change starts a new generation, and the old one serves until the new one is complete.
- **No network but loopback:** the run is sealed by `test/helpers/loopback-seal-preload.mjs`, against a fake Ollama in
  the style of `fake-slack.ts`.
- **Ranking:**
  - a synthetic English and Romanian corpus with diacritics (no real mail), and a deterministic fake embedder;
  - fusion order, the words-only fallback, and the filters.
  - Real-model quality is checked by hand on the owner's Mac, and the corpus is never committed.
- **Envelopes:** a hostile subject, name, excerpt or summary that tries to close the envelope stays inside it.
- **People:**
  - one handle across two accounts is one person;
  - names never join;
  - link and unlink;
  - the person's own handles never appear.
- **Activity:** a search's line has no items. The Messages join shows no "Read by an agent" after a search.
- **Platforms:**
  - the FTS5 probe, folder modes and atomic inbox appends on Windows, Linux and macOS;
  - `tmutil`/`fdesetup` on macOS only, and only through stand-ins in CI.
- **Desktop:**
  - the query grammar refuses control and bidi characters and over-long queries;
  - every enveloped field renders through `OutsideText`.

## 10. Risks

- **The index is as sensitive as the mail.** Words and vectors are unencrypted (S11), and Vec2Text inverts vectors.
  Mitigations: off by default, owner-only files, excluded from backups, the FileVault warning, short retention, and
  Delete everything.
- **A same-user process listening on 11434 receives message text.** This is code running as the person: the repo's
  standing "speed bump, not a boundary" (0.32 §4).
- **Ollama's own behaviour may change,** for example with new cloud routing. We check `remote_*` and names on every
  run, and recommend local-only mode, but Ollama is the person's software.
- **Coverage looks complete when it is not.** v1 sees what agents read, and phase 2 what rules watched. The screens say
  "from what Agent Comms saw".
- **Quality on short Slack messages and on Romanian is unmeasured.** The spike measures it before building.
- **Speed is unmeasured:** embedding throughput, and the cold model load (seconds; `keep_alive` helps).
- **Scale:** the exact scan passes 250 ms near 50,000 rows at 768 dimensions (§2), which is why 512 dimensions and the
  escape hatch exist (S6).
- **`node:sqlite` is "release candidate"** (Stability 1.2), and FTS5 arrived somewhere between Node 22.14 and 22.18.
  So we probe for it rather than trusting the version number.
- **A summary is model output steered by a sender.** It is optional, shown as outside text, and never given to agents.
- **Linking the wrong people** is the person's act, and can be undone.
- **The capture adds work to every read.** A test pins its budget.

## 11. Open questions for the owner (each with the lead's default)

1. **Coverage:** only what Agent Comms saw, or also a "Fill in" that fetches, per person or per account, the last N
   days (a new recorded reader)? *Default: only what it saw.*
2. **The event service's half (S15):** in the same release (it amends the events design), or after? *Default: after,
   as phase 2.*
3. **Agents:** no search over MCP at all, or later a tool limited to the calling window's own reads (as
   `comms_activity` is)? *Default: none.*
4. **Default model:** `qwen3-embedding:0.6b` (Apache-2.0, 32K context) or `embeddinggemma` (Gemma terms, smaller,
   2K)? *Default: Qwen.*
5. **How long:** follow Activity's days, or a separate, longer keep for Search? *Default: follow.*
6. **Slack ↔ Gmail:** linked by hand only, or ask each workspace for `users:read.email`, so Slack people carry their
   address (a re-consent)? *Default: by hand.*
7. **Summaries:** wanted in the first release, and with which local chat model? *Default: off, a later setting.*
8. **Platforms:** ship on Windows and Linux too, where backups and disk encryption are not checked? *Default: yes, and
   the settings say what is not checked.*

## 12. Outside sources (each read 2026-10-26)

- **sqlite-vec:**
  - https://github.com/asg017/sqlite-vec (pre-v1 warning; MIT or Apache-2.0);
  - https://registry.npmjs.org/sqlite-vec/latest (0.1.9; five platform packages, with provenance);
  - https://registry.npmjs.org/sqlite-vec-darwin-arm64/latest (162 KB).
- **Node's SQLite:** https://nodejs.org/api/sqlite.html (`allowExtension`; `loadExtension` since 22.13.0 and 23.5.0;
  Stability 1.2).
- **LanceDB:**
  - https://registry.npmjs.org/@lancedb/lancedb/latest (0.40.0, Apache-2.0, native packages, an `apache-arrow` peer);
  - https://registry.npmjs.org/@lancedb/lancedb-darwin-arm64/latest (253,737,208 bytes unpacked).
- **transformers.js:** https://registry.npmjs.org/@huggingface/transformers/latest (4.3.1; `onnxruntime-node` 1.30.0,
  `onnxruntime-web`, `sharp`).
- **Ollama:**
  - https://docs.ollama.com/capabilities/embeddings (L2-normalised vectors, batch input);
  - https://docs.ollama.com/api/embed (`truncate`, `dimensions`, `keep_alive`);
  - https://docs.ollama.com/api/tags (`remote_model`, `remote_host`, `digest`);
  - https://docs.ollama.com/cloud (cloud models run through the local server);
  - https://docs.ollama.com/faq (`OLLAMA_NO_CLOUD`, `disable_ollama_cloud`).
- **Models:**
  - https://ollama.com/library/qwen3-embedding (0.6b, 639 MB, 32K);
  - https://huggingface.co/Qwen/Qwen3-Embedding-0.6B (Apache-2.0, 32–1024 dimensions, 100+ languages);
  - https://ollama.com/library/embeddinggemma (622 MB, 2K, needs Ollama 0.11.10 or newer);
  - https://huggingface.co/google/embeddinggemma-300m (Gemma terms; 768/512/256/128; no float16);
  - https://ollama.com/library/bge-m3 (1.2 GB, 8K).
- **Inversion:** https://arxiv.org/abs/2310.06816 ("Text Embeddings Reveal (Almost) As Much As Text": 32-token inputs
  recovered almost exactly).
- **macOS:** `man tmutil` (`addexclusion`, sticky by default) and `man fdesetup` (`status`), read on this Mac.

## Order of work

1. **Spike, on the owner's Mac, with nothing committed but numbers:**
   - embedding throughput and cold load, for the three models;
   - scan and load time at 5k, 20k and 50k rows;
   - quality on a hand-made English and Romanian set.
2. **Core:** the store, the inbox, the indexer, the CLI, settings and the change classes, doctor's check, exception
   rows, and tests.
3. **Gmail and Slack capture** (§5's table) and their tests.
4. **Desktop:** the calls and grammars, People, Search, Settings, and the join reused.
5. **Phase 2:** the events design amendment, then the event service's capture.
6. **Summaries,** if the owner wants them.
7. The docs, the skills where a command is new, and a CHANGELOG entry that says what is kept, where, for how long, and
   how to delete it.
