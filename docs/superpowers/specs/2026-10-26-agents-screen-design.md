# The Agents screen: sessions and providers, on top of claude-stream

Status: draft, 2026-10-26. **Spec only.** The owner: "prototype now but not implement yet, because we have another
project called Claude Stream … We may not want to duplicate work." Building waits for the owner's go and for the
claude-stream items in §5.

The prototype's row 6 holds the screens: `AgentSessions`, `SessionDetail`, `AgentProviders` and `Integrations` in
`docs/prototypes/2026-10-26-0320/`. The claude-stream facts were read on 2026-10-26 at 40ea7f57.

## 1. Intent

The owner: "Whenever I go there, I should see which sessions are actively doing some things or have done something …
all the sessions listed with a status, like a small green dot, an orange dot, a spinner … click and open the session in
either VS Code, the desktop app, or CLI … for Claude and for Codex as well … choose if I want to use the locally
installed CLI … or a custom one where I connect either an API or a subscription."

## 2. Decisions (L)

- **Agent Comms is a client of claude-stream's relay, not a second relay.** It lists what the relay knows, adds what
  only Agent Comms knows, and links to claude-stream's console for a session's conversation. It never rebuilds that
  console.
- **The sessions it lists are the union of three sources,** joined by Claude Code's session id where one exists:
  - the relay's sessions (`GET /v1/sessions`, then `GET /v1/sessions/:id` for runs and open requests);
  - activity's agent windows (0.29: folder, client, last seen);
  - lane bindings (0.31).
- **Its states are four words,** from the relay's own:
  - **Working** (a spinner): a run is `starting` or `running`;
  - **Needs you** (orange): the run is `waiting`, or an open request or approval exists;
  - **Ready** (green): the session has no active run and was seen in the last 30 minutes;
  - **Ended** (grey): the session was observed to end, or not seen for 30 minutes.

  A window only activity knows about shows Ready or Ended, from its last seen.
- **"Doing"** is the relay's latest event, as a short line such as "Running the tests", or the open request's title.
  For an activity-only window, it is the last Agent Comms call.
- **Open in:**
  - **Terminal:** `claude --resume <nativeSessionId>` in its folder, through the app's terminal allow-list;
  - **VS Code:** `code <folder>`, with the resume command copied for the person;
  - **claude-stream's console:** its link with `#conversation=<id>`;
  - **the Claude or Codex app:** shown only when claude-stream provides a URL scheme (§5); until then it isn't offered.
- **Sending a message** works only to an idle relay session (`POST /runs`). A busy one queues it in 0.33's session
  queue. A window the person opened is reached through its lane (0.31).
- **What is waiting** for each session comes from 0.33's session queue, and from its lane's open items.
- **Providers** are claude-stream's accounts (`/v1/accounts`), shown read-only, with a link to manage them in
  claude-stream:
  - "installed" means each tool's own login;
  - "custom" means an `api-key` account there.

  Agent Comms stores no agent provider credentials.

## 3. Anti-goals

- **A second place that starts and owns agents.**
- **Showing a session's conversation** without claude-stream's redaction and journal.
- **Any token in a URL or argv.**

## 4. Commands

- **CLI only** (the person's view): `agents sessions --json` (the union above) and `agents open <id> --in
  terminal|vscode|console`.
- **The app:** two allow-list rows.

## 5. What to ask claude-stream for first

1. **A published client package** (today every package is private).
2. **A macOS URL scheme** to open a conversation in its app.
3. **A status field** on `GET /v1/sessions`, and a filter by `cwd`, to avoid one call per session.

## 6. Release

The release after 0.33.0. One builder for the event-service client and the CLI, one for the screens.
