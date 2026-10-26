# Agent Comms 0.32 prototype (2026-10-26)

These are the screens the owner reviewed before 0.32.0 was built, plus three ideas drawn for later releases: editing a
rule with Analyse, agent sessions, and a digital-twin agent. They were drawn as a Claude Design canvas. These files are
that canvas's sources, so the prototype doesn't depend on any one Claude account.

## Open it on this Mac

```sh
cd docs/prototypes/2026-10-26-0320
python3 -m http.server 8320
```

Then open http://localhost:8320/. `index.html` lists every screen.
- Each screen is clickable.
- Add `?theme=dark` to a screen's address for its dark look.
- Other levers work the same way: `Main.dc.html?jevState=on`, `JevSetup.dc.html?hasTypeSafeKey=true`.

The screens need a local server, not `file://`, because each one loads `support.js`. That file is a small viewer
written for this folder. It understands only what these screens use: `{{holes}}`, `<sc-if>`, `<sc-for>`, click
handlers and the `data-props` defaults.

## Put it back on a canvas (any Claude account)

Ask Claude to create a Design canvas from these files:
- each `*.dc.html` file goes under the canvas's `project/` folder;
- `canvas.json` is the canvas's layout, and goes under `project/` too;
- leave out `support.js`, `index.html` and this README, since the canvas brings its own runtime.

The original canvas was https://claude.ai/artifact/3dRSZuWTRDfw9JjGmurYNM (private to the owner's account).

## What's here

| Row | Screens | Status |
|---|---|---|
| 1 · Judges and keys | Main (Judges), JevSetup, LocalModel, Providers | 0.32.0 |
| 2 · Rules | Rules, RuleDetail | 0.32.0 |
| 2 · Rule editing | RuleEdit, RuleEditText, RuleAnalyse | later; spec to follow |
| 3 · Deliveries | Deliveries, DeliveryDetail | 0.32.0 |
| 4 · Messages | Messages, MessageTimeline | 0.32.0 |
| 5 · Connections, test build | Connections, TestBuild | 0.32.0 |
| 6 · Agents | AgentSessions, SessionDetail, AgentProviders, Integrations | later; the live view comes from the separate session-streaming project |
| 7 · Your agent | Twin, TwinRules, TwinConversations, Playground | later; spec to follow |

All names, messages and numbers are made up. None of them is real data.
