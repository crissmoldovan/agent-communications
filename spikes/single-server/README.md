# Spike: one router in front of each part's own MCP server (0.35, phase P0)

The question, from `docs/superpowers/specs/2026-10-26-single-server-design.md` §13 (P0) and §14 ("Era relay is the one
part of this the SDK may resist"): can one MCP server per connection sit in front of each channel's own MCP server
process, with the SDK this repository already uses, and pass everything through unchanged?

**Answer: yes, with SDK `@modelcontextprotocol/server` / `client` 2.3.1 as installed, and with three changes to the
design.** Each claim below is a test in `single-server.test.mjs` that runs against real child processes.

- Run: `node --test spikes/single-server/single-server.test.mjs` (44 tests, about 26 s; the SIGKILL test is POSIX only).
- Not product code. No package is changed. Nothing talks to any service, and every process gets a temporary `HOME`.

| File | What it is |
|---|---|
| `router.mjs` | The router. Toward the client: one low-level SDK `Server` served by `serveStdio`. Toward each part: a raw JSON-RPC link over the SDK's `StdioClientTransport` (framing and process only, no `Client`). About 550 lines |
| `fake-part.mjs` | Stand-in parts, each on `serveStdio`, as P0 would make them. `slack` is a low-level `Server` with hand-written JSON Schemas. `gmail` is an `McpServer` that raises its approval form with `inputRequired(...)`, for allow-listed clients only, as Gmail does. `events` answers `events_watch` with a task and registers `tasks/get` and `tasks/cancel` by hand, as events-daemon does |
| `gateway-cli.mjs` | The router as a program on real stdio, as `agentcomms mcp --connection` would run |
| `raw-client.mjs` | A hand-written 2026-07-28 client. The SDK `Client` cannot take a task answer (see 3) |
| `sdk.mjs` | Loads the SDK and zod from `packages/core`'s own dependencies, so the spike cannot drift to another version |

"Direct" in the tests means the same stand-in served to the same client with no router. Most tests compare the two
on the wire, byte for byte.

## Answers

| # | Point | Verdict | Tests |
|---|---|---|---|
| 1 | Tool passthrough and prefix ownership | **Works**, in both eras | `SPIKE-1 (…)` ×4 per era; `SPIKE-1: a client that probes…`; `SPIKE-1: a part is started without the connection key…` |
| 2 | Approval forms (elicitation) relayed | **Works with a change.** The router itself needs none beyond 1. Every part needs one in P0: read the client from the request's envelope | `SPIKE-2 (…)` ×5 per era; `SPIKE-2 (2025-11-25): a relayed form needs the router to lift the SDK timeout…`; `SPIKE-2: under serveStdio on 2026-07-28 getClientVersion() is never set…` |
| 3 | Tasks relayed both ways | **Works with a change**: the link to each part must be raw JSON-RPC, not the SDK `Client`. `tasks/list` does not exist on 2026-07-28 | `SPIKE-3 …` ×7 |
| 4 | `notifications/tools/list_changed` | **Works**, in both eras, in the SDK client | `SPIKE-4 (…)` ×3 per era |
| 5 | Crash and slowness | **Works** | `SPIKE-5 (…)` ×2 per era; `SPIKE-5: a part that exits at start…`; `SPIKE-5: a router killed with SIGKILL…`; `SPIKE-0 (…)` real stdio ×2 |

SDK line numbers below are in `node_modules/.pnpm/@modelcontextprotocol+{server,client}@2.3.1/node_modules/@modelcontextprotocol/*/dist/`.

## 1. Tool passthrough: works

- **`tools/list`:** the router's list is the parts' lists concatenated, and each tool definition is byte-equal to the
  part's own: names, `title`, `inputSchema` with `$defs`, `$ref`, `pattern`, `format` and `additionalProperties`,
  `outputSchema`, annotations and `_meta`. This holds in both eras.
- **`tools/call`:** answers are byte-equal to direct. That covers text, image, resource link and embedded resource
  content, non-ASCII and bidi text, `structuredContent`, result `_meta`, `isError`, and a JSON-RPC error with its
  `code`, unprefixed `message` and `data`. On 2026-07-28 the part's own `_meta.serverInfo` is kept: the SDK stamps the
  router's only when the key is absent (server `src-Cqbh3MYc.mjs:3832`).
- **The other direction:** the part receives the client's call unchanged, with its arguments, its own `_meta` and, on
  2026-07-28, its envelope.
- **Progress** reaches the client under the client's own `progressToken`.
- **Prefix ownership:**
  - A part that lists `slack_echo`, `events_status` and `comms_doctor` beside its own tools has them dropped and logged.
  - Calls are routed by prefix, never by who listed the tool, so `slack_echo` reaches Slack even when the rogue part
    comes first.
  - A prefix with no part answers "Tool … not found" from the router; the call reaches no part.
- **What the router had to do:**
  - **Forward the client's own params, not the handler's.** The SDK `Server` strips the envelope keys and
    `inputResponses`/`requestState` out of params before any handler runs (`liftWireOnlyMaterial`,
    `src-Cqbh3MYc.mjs:6089`). The router therefore keeps the raw inbound message by request id, through a wrapping
    transport (`peeking` in `router.mjs`), and forwards that. If it forwards what the handler sees instead, a 2026-07-28
    part refuses every call for its missing envelope; a mutation run showed this.
  - **Survive a probe followed by `initialize`.** A client that probes with `server/discover` and then falls back to
    `initialize` gets every part reopened in the 2025 era, with its `initialize`.
- **The environment:** each part starts without `AGENT_COMMS_CONNECTION_KEY` and `AGENT_COMMS_LAUNCHER`, and with
  `AGENTCOMMS_GATEWAY_PID` and `AGENTCOMMS_CONNECTION`. `StdioClientTransport` always merges `getDefaultEnvironment()`
  under the env it is given (client `stdio.mjs:76`), so the stripping must happen in the env the router passes, as it
  does here.

## 2. Approval forms: works; every part needs one change in P0

- **2025 era.** The part's `inputRequired(...)` becomes, through the part's own SDK shim, an `elicitation/create`
  request to the router.
  - The router relays it to the client with `Server.request(…, passthrough schema)`, and returns the client's answer to
    that part unchanged.
  - The test records that the client answered (`answeredBy: 'client'`).
- **2026-07-28.** The form travels in-band: the part's `input_required` result goes to the client unchanged, and the
  client's retry carries `inputResponses` and the opaque `requestState`. The router forwards the retry's raw params and
  asks the client nothing itself.
- **What is shown, in both eras:**
  - **The form round trip:** the person's yes, with the typed code, reaches Gmail; so does a decline, and so does a yes
    after 1.5 s.
  - **The client's identity:** Gmail sees the client's own name and capabilities exactly as direct. That is
    `getClientVersion()` in 2025, because the part's `initialize` is the client's own, byte for byte, and the envelope's
    `clientInfo` on 2026-07-28. It is never the router's.
  - **Refusals:** a client off the allow-list (`cursor`) gets the same refusal byte for byte as direct. So does a
    client that declares no `elicitation`.
- **Two things the design does not yet say:**
  - **No server under `serveStdio` knows the client's name on 2026-07-28, direct or routed.**
    - Under `serveStdio` on 2026-07-28, `server.getClientVersion()` and `getClientCapabilities()` are never set. Only
      the HTTP entry backfills them from the envelope (`createMcpHandler`, server `index.mjs:1420`); `serveStdio` never
      does. The accessor's own doc comment says otherwise.
    - Every server here reads the accessor:
      - core `mcp/server.ts:372`;
      - gmail `:253`, `:1113`, `:2679`, `:2782`;
      - slack `:241`;
      - resend `:140`;
      - whatsapp `:94`.
      Only events reads the envelope first (`events-daemon/src/mcp/server.ts:205`).
    - So when P0 moves Gmail to `serveStdio`, its `confirm` form stops appearing for every 2026-07-28 client, and activity
      (each part's records, and `comms_activity`'s session lookup) loses the client's name. The router changes nothing about this (`SPIKE-2: under serveStdio on
      2026-07-28 getClientVersion() is never set…`).
    - **Fix (P0):** read `ctx.mcpReq.envelope['io.modelcontextprotocol/clientInfo'] ?? getClientVersion()` per request,
      as events does. The `clientInfo: () => …` closures that activity calls must be given the request's context.
  - **The relayed 2025 form needs the SDK's timeout lifted.**
    - `Server.request` defaults to 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC`, `src-Cqbh3MYc.mjs:6059`). When that expires,
      the router itself answers the part with a timeout error, so a person who took longer than a minute would be cut
      off.
    - The part's own shim allows 10 min a leg (`mcp-DIH4cS6P.mjs:805`). The router passes
      `forwardedRequestTimeoutMs` (10 min by default).
    - The test sets it to 300 ms to show the failure mode: `answeredBy: 'router'`, and Gmail reports "Fulfilling input
      required … failed: … timed out".
    - That timeout, and a client that has gone away, are the only cases where the router answers a part's request
      itself.

## 3. Tasks: works, but not through the SDK `Client`

- **Through the router:**
  - `events_watch` answers `resultType: "task"`; `tasks/get` polls it; `events_fire` completes it; and `tasks/get`
    returns the completed result.
  - Every step after the handshake has the same shape as direct, ids and times aside.
  - `tasks/cancel` reaches the part that made the task, and a later poll gets that part's `cancelled`.
  - A task id no part made is refused by the router (`-32602 unknown task`).
  - A second part that hands out an id already owned is refused, and the task is cancelled in that part.
  - A request that does not declare the tasks extension gets Events' own refusal, byte for byte.
- **What the SDK cannot do:**
  - **The SDK `Client` cannot be the link to a part.**
    - Its `decodeResult` rejects any `resultType` other than `complete` or `input_required` with
      `UNSUPPORTED_RESULT_TYPE` (client `src-WCy6ifGf.mjs:3991`). This happens before `allowInputRequired` is consulted
      (`:6220`), and no option admits a task.
    - `SPIKE-3: the SDK Client cannot be the router's link…` shows `callTool` and `request(…, passthrough)` both fail.
    - This decides the open point in §5.5: **use a raw JSON-RPC child transport**, which is `StdioClientTransport` plus
      an id map (`Part` in `router.mjs`, about 150 lines).
    - The raw link also means no SDK default can answer, retry or refuse a part's form, and it is what makes the
      byte-for-byte results in 1 possible.
  - **The `Server` side has no such limit.** For `tools/call` it passes `resultType: "task"` through
    (`EXTENDED_RESULT_TYPE_METHODS`, `src-Cqbh3MYc.mjs:3753`), and it accepts hand-registered `tasks/get` and
    `tasks/cancel`, as events-daemon does.
  - **There is no `tasks/list` or `tasks/result` on 2026-07-28.** The SDK answers both with "Method not found" before
    any handler runs (`isExtensionReusedRequestMethod`, `src-Cqbh3MYc.mjs:4225`, allows only `tasks/get` and
    `tasks/cancel`). `tasks/update`, which is not a spec method, can be served. §5.3's "`tasks/list` is merged across
    parts" should go. Events serves neither.
- **A risk the design must handle: the tasks extension is advertised only if Events was ready inside the start
  window.**
  - Capabilities are fixed when the handshake is answered. With Events slow, the router's `server/discover` advertises
    no extension, and Events' tools join later.
  - **Recommendation:** advertise every extension the connection's parts declare, read from config or the build-time
    snapshot, rather than from the parts that happened to be ready. Events already refuses a request that does not
    declare the extension.

## 4. `tools/list_changed`: works

- **When a part is added or removed** (`addPart`, `removePart`, the D15 path), the router emits `list_changed`, and the
  SDK client (`listChanged` option) sees the new list in both eras.
- **When a part changes its own tools,** its `list_changed` comes up through the router: the router lists that part
  again and emits its own.
- **A part that misses the start window** is left out of the handshake and joins later with `list_changed`. The
  handshake's instructions name it as starting.
- **How 2026-07-28 differs:**
  - Change notifications reach a client only on a `subscriptions/listen` subscription. `serveStdio`'s listen router
    drops any change notification no subscription asked for (server `mcp-DIH4cS6P.mjs:433`).
  - The SDK client opens the subscription itself, and its `connect()` waits for the acknowledgement (client
    `index.mjs:3449`), so the router's `sendToolListChanged()` reaches it.
  - The router must likewise open `subscriptions/listen` on each part, or a part's own `list_changed` never reaches it.
- **Not shown:** whether Claude Code, Codex, Cursor and VS Code act on it (§13 P0, §14). The spike may not drive the
  owner's apps.

## 5. Crash and slowness: works

- **A part that exits mid-call.**
  - The in-flight call fails at once with JSON-RPC `-32603` "slack stopped in this connection; Agent Comms is not
    retrying this call", and it is not retried (D13).
  - Its tools stay listed, and later calls get the same error rather than "no such tool".
  - The other parts keep answering.
- **A part that hangs.**
  - Nothing else waits on it, not even its own other calls.
  - The router sets no timeout of its own. The client's timeout ends the call (`REQUEST_TIMEOUT`), and the client's
    `notifications/cancelled` reaches the part under the part's own request id.
- **A part that exits at start, or never finishes its handshake.**
  - The handshake is answered after the start window without it, and the instructions say "stopped" or "starting".
  - After the join window, the part that never finished is stopped, and calls to either part say so.
- **A router killed with SIGKILL** leaves no part running: each part ends when its stdin closes (POSIX).
- **Real stdio:** the router run as a program serves both eras, with Gmail's form.

## What this means for the design

- **Keep:** D1, the process model; D4, verbatim passthrough on a low-level `Server`; D5, prefixes; D6, one era end to
  end; D7, the client's own `clientInfo` (made exact by forwarding `initialize` and the envelope verbatim); and D13,
  no retry.
- **Adjust:**
  1. **§5.5:** the child link is raw JSON-RPC over `StdioClientTransport`, not the SDK `Client` (point 3).
  2. **§4's "SDK 2.3.1's factory receives that request" is wrong.**
     - `serveStdio` calls the factory with `{ era }` only (server `stdio.mjs:400`; `McpRequestContext`,
       `createMcpHandler-D4NN8WsG.d.mts:3876`).
     - The smallest change: pass `serveStdio` a wrapping transport (its `transport` option) that records the client's
       `initialize` and first envelope before `serveStdio` sees them. The same wrapper keeps raw params for forwarding
       (point 1).
  3. **P0 is not only `StdioServerTransport` → `serveStdio`.** Every server must read the client from
     `ctx.mcpReq.envelope` first (point 2). Each must also build a fresh `McpServer` per factory call, since one
     connection can construct two: a discarded probe, then the real one.
  4. **§5.3:** drop the `tasks/list` merge. Route `tasks/get` and `tasks/cancel` by the id recorded from the task answer;
     add `tasks/update` if Events ever uses it.
  5. **§4 initialisation:** advertise every extension the connection's parts declare, from the snapshot, not from the
     parts ready at the handshake (point 3).
  6. **§4 timeouts:** besides the forwarded calls, a part's request relayed to the client (a 2025 form) needs its
     timeout lifted (point 2).
- **What remains unproven:**
  - Real apps' handling of `list_changed` and of 190 tools; Claude Code's local-over-user precedence.
  - Windows: kill by handle, and PID reuse.
  - Restart backoff, the status file, the key check and the instructions budget: none is built here.
  - **The router's own validation of a `tools/call` result.** If the SDK `Server` ever judged a part's result invalid,
    it would answer `-32602` "Invalid tools/call result" in the part's place. A first-party part is an SDK server that
    validates its own result before sending it, so this never happened in the tests.
  - **Logging.** No part declares `logging` today. If one does, the router must declare it too, or its SDK refuses to
    relay `notifications/message`.
