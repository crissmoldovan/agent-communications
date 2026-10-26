/**
 * The router as a program on real stdio, as `agentcomms mcp --connection <id>` would run (D2), for the spike's
 * end-to-end tests. SPIKE_PARTS is the parts as JSON; SPIKE_STATUS_FILE, when set, receives the pids once spawned.
 */
import { writeFileSync } from 'node:fs';
import { Router } from './router.mjs';
import { serverStdio } from './sdk.mjs';

// stdout is the protocol: everything else goes to stderr (§4, "At start").
console.log = (...args) => console.error(...args);

const router = new Router({
  parts: JSON.parse(process.env.SPIKE_PARTS ?? '[]'),
  connectionId: process.env.SPIKE_CONNECTION ?? 'cn_spike',
  startWindowMs: Number(process.env.SPIKE_START_WINDOW_MS ?? 8_000),
});
router.serve(new serverStdio.StdioServerTransport());

const status = process.env.SPIKE_STATUS_FILE;
if (status !== undefined) {
  await Promise.allSettled([...router.parts.values()].map((part) => part.spawned));
  const pids = Object.fromEntries([...router.parts.values()].map((part) => [part.id, part.pid ?? null]));
  writeFileSync(status, JSON.stringify({ gateway: process.pid, parts: pids }), { mode: 0o600 });
}
