# Agent Comms: messages, from arrival to answer (prototype, 2026-10-26)

The owner asked, on 2026-10-26, where to see what happened to an incoming message: "David messages me, the event that
triggered gets sent to a session, the session does something, then the session posts back to the thread", and the same
without an event, when a session reads the message itself. He wanted an acknowledgement that is mandatory, "so no other
sessions are getting it", a way to see that a session decided a message was not for it and handed it back, a view of
"what one specific user has asked", and a local database with vectors to search past messages by meaning. He then added
projects: the code he works on, its checkouts and sessions, and a message routed to the right one.

These boards draw that for feedback before anything is built. They are written as a Claude Design canvas's sources, so
the prototype doesn't depend on any one Claude account. The format, palette, app shell and sidebar are those of
`docs/prototypes/2026-10-26-0340-rework`, with two new sidebar items, People and Projects.

## Open it on this Mac

```sh
cd docs/prototypes/2026-10-26-messages-lifecycle
python3 -m http.server 8341
```

Then open http://localhost:8341/. `index.html` lists every screen.
- Each screen is clickable. A button that changes something shows what would happen: an approval to give, or a line
  saying it applied at once. A screen not drawn here (Queue, Accounts, Activity and the rest) leads to `Main.dc.html`.
- Add `?theme=dark` to a screen's address for its dark look.
- Other levers: `MessageStory.dc.html?case=event` (or `direct`, `handback`, `routed`), `Messages.dc.html?show=handed`
  (or `waiting`, `taken`, `answered`, `done`), `Search.dc.html?q=…` (one of its three example questions),
  `SettingsSearch.dc.html?searchOn=false`, `Projects.dc.html?justAdded=true`.
- A small **new** chip marks what the app can't do yet. Everything without one is there today.

The screens need a local server, not `file://`, because each one loads `support.js`. That file is the small viewer
written for `docs/prototypes/2026-10-26-0320`, copied here unchanged. The screens load Inter from Google Fonts, so they
need the network to show that face.

## Put it on a canvas (any Claude account)

Ask Claude to create a Design canvas from these files:
- each `*.dc.html` file goes under the canvas's `project/` folder;
- `canvas.json` is the canvas's layout, and goes under `project/` too; it opens focused on `Main.dc.html`;
- leave out `support.js`, `index.html` and this README, since the canvas brings its own runtime.

`MessageRouted.dc.html` is `MessageStory.dc.html` with its `case` tweak set to `routed`, so the routed story has a board
of its own in row 4. The two files are the same apart from that default.

This folder hasn't been put on a canvas yet.

## What's here

| Row | Boards | What it shows |
|---|---|---|
| 0 · Start here | Main | every board, what to look at, and what to tell the lead |
| 1 · One message | MessageStory, Messages | a message's story with who took it and what each session did (through an event, read directly, handed back, routed); the list with each message's state and a filter |
| 2 · One person, and asking | Person, Search | everything David Park asked, one line each, with a search scoped to him; Ask about past messages, answered on this Mac |
| 3 · Settings | SettingsTaking, SettingsSearch | taking messages, per account; search on this Mac: what is kept, for how long, the local model, Rebuild and Delete everything |
| 4 · Projects | Projects, AddProject, MessageRouted | projects with their checkouts, sessions and profile; adding one from GitHub in four steps; a message routed to a project, waiting while its session is busy |

## What would be new

- **Taking a message:** a session takes a message before it reacts, replies or marks it done; the others that read it
  see "taken by acme-site · Claude Code" and leave it. Per account it can be switched off, which is approved.
- **Handing back:** a session that finds a message isn't for it hands it back with a reason, and it waits to be taken
  again.
- **👀 on taking:** when a session takes a Slack message, a 👀 under it, once per message. Choosing this in Settings is
  the approval for it; today a 👀 needs a reply approved in advance.
- **A message nobody takes:** after a set time, a reminder, or into the Queue.
- **The story:** Who has it, Read by N sessions with what each did, the take and hand-back steps, sessions that read it
  later and left it, a note when a session marks a message done, and done for a message no rule caught.
- **Messages:** the five states (waiting to be taken, taken by, handed back, answered, done) as a column and a filter;
  Ask about past messages as a tab.
- **People:** a person's page across Slack and Gmail, joined by the address on their Slack profile, with one-line
  summaries written on this Mac.
- **Search on this Mac:** the messages' words, what was done and a summary kept for 30 days, made searchable by a small
  model that runs on this Mac; a short answer above the results; letting sessions ask too (off, approved).
- **Projects:** a project's GitHub repository, its checkouts on this Mac, the sessions working in them, busy or idle,
  and a profile Agent Comms keeps; adding one through the person's own `gh` login, analysed by their own Claude or Codex.
- **Routing:** "Routed to the project acme-site, because…", handed to the owner's claude-stream, waiting its turn while
  the session is busy.

Already in the app, so not marked: the Messages list and each message's story of steps (0.32), a rule putting a message
in a lane that wakes the session bound to it (0.31), a session reading a channel itself, replies sent after the person
approves them and labelled as sent by an agent, and a 👀 or short fixed reply under a reply approved in advance.

## For the lead: where the drawing makes a choice

- **Search keeps message words; Activity doesn't.** Activity keeps "subjects, senders, searches and recipients, never a
  message body". Searching by meaning needs the words, so Search on this Mac keeps them, encrypted, for Activity's 30
  days, and switching it on is approved. The board says this in plain words.
- **The 👀 on taking is a setting that acts as an approval.** Choosing it is a loosening, so it asks to be approved, as
  every loosening in the 0.34 rework does; choosing "Say nothing" applies at once.
- **A handed-back lane item.** Only the window bound to a lane may read its items (routing spec). In the hand-back story
  the second session therefore finds the message by reading the channel itself, not through the lane.
- **Done for a message no rule caught.** Today done belongs to a Queue item. The direct story marks such a message done
  once it is taken, which needs taking to keep a record of its own.
- **Summaries** come from the person's local model server, if one is set up for a judge; otherwise a line is the
  message's first words. The vectors come from a small built-in model. Which model is the lead's call.
- **Busy or idle** for a session, and handing a message to claude-stream, are drawn as the owner described them; how
  Agent Comms learns a session is busy is not settled here.

All names, addresses, messages, repositories and numbers are made up (a colleague David Park at acme, the person Chris
Moldovan, sessions named by folder and app). None of it is real data.
