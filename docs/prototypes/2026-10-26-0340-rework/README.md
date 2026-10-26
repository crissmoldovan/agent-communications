# Agent Comms 0.34 rework prototype (2026-10-26)

The owner tried the 0.34 test build and found several screens confusing. These are those screens drawn again, for
feedback before anything is built: Your agents (was Agent), each account's own Agents here, MCP connections (was MCP
servers, and Connections before that; drawn for 0.35, with the single Agent Comms server), Events' Service and
Deliveries, Doctor's fixed layout, and a choice of face. They are written as a Claude Design canvas's sources, so the
prototype doesn't depend on any one Claude account.

## Open it on this Mac

```sh
cd docs/prototypes/2026-10-26-0340-rework
python3 -m http.server 8340
```

Then open http://localhost:8340/. `index.html` lists every screen.
- Each screen is clickable. Every button that changes something opens the step it would in the app: an approval, or a
  line saying it applied at once.
- Add `?theme=dark` to a screen's address for its dark look.
- Other levers work the same way: `McpServers.dc.html?empty=true` (the first time),
  `AddConnection.dc.html?type=manual&step=done` (`type` is the app, `step` one of `type`, `where`, `name`, `parts`,
  `review`, `done`), `Connection.dc.html?connection=raycast` (or `work`, `site`, `personal`, `reviews`),
  `EventsService.dc.html?state=on` (or `off`, `paused`), `AccountGmail.dc.html?account=personal%2Fgmail`,
  `AccountSlack.dc.html?view=about`, `Doctor.dc.html?layout=before`.
- Add a connection's Done, and Remove on an opened connection, carry what changed back to the list in the address
  (`?added=…`, `?removed=…`), so the list shows the new card or leaves the removed one out.
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
| 2 · MCP connections (0.35) | McpServers, AddConnection, Connection | one card per place an app uses Agent Comms, several per app, each with a name, its parts and accounts, last use and state; adding one, step by step, with its key or a snippet to paste; one opened, to rename, replace its key, change its parts, see its activity, or remove it |
| 3 · Events | EventsService, Deliveries | the service as off, on or paused, in words; a rule in dry-run, and where a match goes |
| 4 · Doctor and face | Doctor, Face | the fixed check layout, beside how it was; Inter beside SF Pro |

## What would be new

- **Your agents:** the two previews; changing your name or the word in the app, approved there; adding and removing an
  exception in the app; the per-account summary.
- **Each account's Agents here:** the whole tab — what agents may do as switches, the per-conversation (Slack) and
  per-person (Gmail) lines, how messages look (Slack), and the replies approved in advance, moved from the Agent
  screen. Every loosening here is approved in the app on macOS; today these are approved in Terminal.
- **MCP connections** (drawn for 0.35, with the single Agent Comms server): the whole idea of a connection as a thing
  of its own, several per app, each with a name; adding one in the app, step by step, in one approval; a key per
  connection, shown once, and replacing it; activity told apart by connection ("used by Work — Claude Code"); renaming
  one. Among the places, one project folder (a `.mcp.json`) is new, since Agent Comms writes only user settings today,
  and another Claude profile or Codex home is new in the app (today only by running Agent Comms with
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME` set). Keeping a part to one account, or to reading, is there today; keeping it
  to two or more of several accounts is not.
- **Events → Service:** Switch on… approved in the app on macOS (today `enable-all` is approved in Terminal).
- **Events → Deliveries:** a dry-run log you can open as a list.

Doctor's layout is not new: it is in the 0.34 test build already (ec814382), and drawn here to check it.

## MCP connections: what the drawing assumes, and what it leaves open

- **The key.** For apps on this Mac the servers run as you, so the key is not a password. The boards say so, and say
  what it does: it names the connection in Activity, and removing the connection, or replacing the key, stops it
  working. A quiet line adds that it becomes a real secret if Agent Comms is ever reachable over the network.
- **The snippet carries only the key.** The manual snippet has no parts or accounts in it, which assumes the single
  server looks a connection's parts up by its key. Then changing a manual connection's parts never needs a new
  snippet. If the parts travel in the snippet instead, every change to a manual connection means pasting again.
- **Two connections in one place.** A second connection where one already is (Claude Code in every folder twice)
  would make the app start Agent Comms twice and show every tool twice; the flow says so and offers the existing one,
  but does not stop you. The same happens, less visibly, with one project folder beside an every-folder connection:
  sessions in that folder get both. Whether a project connection should stand in for the every-folder one there is
  for the owner to decide.
- **One project folder writes that folder's `.mcp.json`**, as the brief says, and the board warns that the file is
  often shared through git and would hold this Mac's paths and the key. Claude Code's own `local` scope (one project,
  kept in `~/.claude.json`, never shared) may suit a key better; not drawn.
- **The sidebar.** These three boards call the section MCP connections and show 0.35.0; the other boards still say MCP
  servers and 0.34.0.

## Where it differs from the brief

- The brief's Deliveries line said "Agents can read that log." Through their MCP tools they can't: `dryrun list` and
  `dryrun show` have no MCP tool ("never in model context", `capabilities.json`). But the commands refuse only inside
  an MCP server's process, so an agent with a terminal, such as Claude Code, runs them as the person and can. The board
  says both, and its side note says which places are meant for an agent and which for the person.

All names, addresses, messages and numbers are made up, apart from the owner's own counts on Deliveries (one rule in
dry-run, 10 entries removed after 24 hours). None of it is real data.
