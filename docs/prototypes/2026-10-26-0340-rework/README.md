# Agent Comms 0.34 rework prototype (2026-10-26)

The owner tried the 0.34 test build and found several screens confusing. These are those screens drawn again, for
feedback before anything is built: Your agents (was Agent), each account's own Agents here, MCP servers (was
Connections), Events' Service and Deliveries, Doctor's fixed layout, and a choice of face. They are written as a Claude
Design canvas's sources, so the prototype doesn't depend on any one Claude account.

## Open it on this Mac

```sh
cd docs/prototypes/2026-10-26-0340-rework
python3 -m http.server 8340
```

Then open http://localhost:8340/. `index.html` lists every screen.
- Each screen is clickable. Every button that changes something opens the step it would in the app: an approval, or a
  line saying it applied at once.
- Add `?theme=dark` to a screen's address for its dark look.
- Other levers work the same way: `McpServers.dc.html?testBuild=true`, `EventsService.dc.html?state=on` (or `off`,
  `paused`), `AccountGmail.dc.html?account=personal%2Fgmail`, `AccountSlack.dc.html?view=about`,
  `Doctor.dc.html?layout=before`.
- A small **new** chip marks what the app can't do yet. Everything without one is there today, reworded or moved.

The screens need a local server, not `file://`, because each one loads `support.js`. That file is the small viewer
written for `docs/prototypes/2026-10-26-0320`, copied here unchanged. The screens load Inter from Google Fonts, so they
need the network to show that face.

## Put it back on a canvas (any Claude account)

Ask Claude to create a Design canvas from these files:
- each `*.dc.html` file goes under the canvas's `project/` folder;
- `canvas.json` is the canvas's layout, and goes under `project/` too;
- leave out `support.js`, `index.html` and this README, since the canvas brings its own runtime.

This folder hasn't been put on a canvas yet.

## What's here

| Row | Screens | What it shows |
|---|---|---|
| 1 · Your agents | YourAgents, AccountSlack, AccountGmail | what people see when an agent writes, your name and word, the exceptions; each account's Agents here |
| 2 · MCP servers | McpServers | one card per server, with each app under it; the test build's state |
| 3 · Events | EventsService, Deliveries | the service as off, on or paused, in words; a rule in dry-run, and where a match goes |
| 4 · Doctor and face | Doctor, Face | the fixed check layout, beside how it was; Inter beside SF Pro |

## What would be new

- **Your agents:** the two previews; changing your name or the word in the app, approved there; adding and removing an
  exception in the app; the per-account summary.
- **Each account's Agents here:** the whole tab — what agents may do as switches, the per-conversation (Slack) and
  per-person (Gmail) lines, how messages look (Slack), and the replies approved in advance, moved from the Agent
  screen. Every loosening here is approved in the app on macOS; today these are approved in Terminal.
- **MCP servers:** the card layout, and Bring up to date for an app that starts an older copy.
- **Events → Service:** Switch on… approved in the app on macOS (today `enable-all` is approved in Terminal).
- **Events → Deliveries:** a dry-run log you can open as a list.

Doctor's layout is not new: it is in the 0.34 test build already (ec814382), and drawn here to check it.

## Where it differs from the brief

- The brief's Deliveries line said "Agents can read that log." Through their MCP tools they can't: `dryrun list` and
  `dryrun show` have no MCP tool ("never in model context", `capabilities.json`). But the commands refuse only inside
  an MCP server's process, so an agent with a terminal, such as Claude Code, runs them as the person and can. The board
  says both, and its side note says which places are meant for an agent and which for the person.

All names, addresses, messages and numbers are made up, apart from the owner's own counts on Deliveries (one rule in
dry-run, 10 entries removed after 24 hours). None of it is real data.
