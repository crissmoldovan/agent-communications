# Your agent: a digital twin colleagues can ask

Status: draft, 2026-10-26. **Spec only.** The owner: a feature "that, later … maybe will not be included in this
delivery run, but would be worth prototyping now". Building waits for the owner's go, after 0.33.0 and the Agents
screen.

The prototype's row 7 holds the screens: `Twin`, `TwinRules`, `TwinConversations` and `Playground` in
`docs/prototypes/2026-10-26-0320/`.

## 1. Intent

The owner: "I want … me to have an agent that is called, for example, Chris's minion or Chris's bot. I want other
colleagues to have similar agents that basically can be added to any chat … a question or a thing can be sent to it.
That will then be handled here in the app … an agent's playground where various agents of our digital twins are able to
ask each other things and respond to them … define some rules that are coming in from people versus from this … The bot
may be able to provide some simple answers before actually having to do anything … an exchange of information that can
happen easily."

## 2. Goals, non-goals, anti-goals

**Goals**
- **A named agent per person,** reachable as a Slack bot user (added to channels, mentioned, or messaged directly),
  and later by email.
- **Two rule sets:** messages to you (the event service's rules today), and messages to your agent.
- **Answers it gives alone,** from sources the person turns on:
  - free or busy from the calendar, never what a meeting is;
  - the titles and states of Linear issues;
  - a notes file for colleagues;
  - a document index (names and places, not contents).
- **Everything else is handed over:** to the person (the Queue, plus a reply saying it was passed on) or to a session
  (0.33's session target), with the answer sent after the person approves it.
- **A playground:** colleagues' agents ask yours, under per-agent permissions, and you can step in.

**Non-goals (the first release of it)**
- An agent agreeing to anything: dates, money, work, or files.
- Answers built from mail or chat content.
- Its own transport between machines (Slack is the transport first, §3).

**Anti-goals: it fails if:**
- **A colleague, or their agent, gets anything** outside the turned-on sources without the person's yes.
- **An answer doesn't say it came from an agent.** Every reply starts "<name>'s agent here:", per the 0.19 label.
- **A question's text steers what the agent may share.** Questions are untrusted; the sources and their limits are
  fixed by the person.

## 3. Decisions (L)

- **Identity:** the twin is a Slack app the person installs in each workspace, built from the manifest tooling that
  `slack_manifest` already has, with a bot user named by the person. Email comes later.
- **Inbound:** a new Slack event type, `slack.bot.addressed` (a mention of the bot, or a direct message to it), enters
  the event service like any other. "Messages to your agent" rules are ordinary rules on that event type, which
  0.33's editors show as their own set.
- **Answers alone:** a new target kind, `answer`:
  - its document names the sources it may use, the template of its reply, and who may be answered (workspaces,
    channels, people, agents);
  - its activation is a **standing approval of a new kind**, bounded by exactly that document (0.23 is the model);
  - a source is read fresh at dispatch, and its read is content-limited by construction (free/busy needs the calendar
    free/busy scope only);
  - the reply goes out through Slack's existing send path, with the agent label.
- **Hand to you:** the Queue, plus a fixed reply ("I've passed this to <name>"), under the same standing approval.
- **Hand to a session:** 0.33's session target. Its answer is sent only after the person approves it, as any send is.
- **The playground:**
  - colleagues' agents reach yours through Slack: a shared channel, or direct messages between bot users;
  - each other agent is an audience entry naming what it may ask, using the same sources;
  - the playground screen is a view of those exchanges.
  - corale's "audiences" idea (reaching only allowed agents) is the model; corale itself has nothing for agents of
    different people.

## 4. What it needs first

- **0.33.0:** rule editing, and the session target.
- **A calendar free/busy source,** with its own OAuth scope and the person's consent.
- **The standing-approval kind for answers,** designed with the same care as 0.23's.

## 5. Release

After the Agents screen. It gets its own design pass with the owner, starting from this document and the prototype.
