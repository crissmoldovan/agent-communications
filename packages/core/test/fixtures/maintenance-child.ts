import { ApprovalStore } from '../../src/approvals.ts';
import { withFileLock } from '../../src/lock.ts';

/*
 * Another process beside an approval store, for the retention and report tests (`approval-retention.test.ts`,
 * `unsent-report.test.ts`): run as a child with `--experimental-strip-types`, it does what the parent asks over IPC.
 *
 * - `{ op: 'hold', id, paths }` takes each lock with the store's own `withFileLock` — exactly as a claim or a look in
 *   another process holds one — and answers `{ id, ok: true, held }` once every one is held. It keeps them all, and
 *   renews them as a live holder does, so however slow the machine, no lock it holds is ever judged abandoned, until
 * - `{ op: 'release', id }`, which answers `{ id, ok: true }` once every lock is let go.
 * - `{ op: 'prune', id, stateDir, now }` opens its own store over `stateDir`, at the parent's time, runs the day's
 *   maintenance and answers `{ id, ok: true, status }`.
 */

interface Request {
  op: 'hold' | 'release' | 'prune';
  id: string;
  paths?: string[];
  stateDir?: string;
  now?: number;
}

/** How often a held lock is renewed: a third of the record locks' 30-second stale interval. */
const HOLD_RENEW_MS = 10_000;

let release: (() => void) | undefined;
let holding: Promise<unknown> | undefined;

process.on('message', async (message: Request) => {
  try {
    if (message.op === 'hold') {
      const letGo = new Promise<void>((settle) => {
        release = settle;
      });
      const paths = message.paths ?? [];
      let taken = 0;
      let allTaken!: () => void;
      const ready = new Promise<void>((settle) => {
        allTaken = settle;
      });
      holding = Promise.all(
        paths.map((path) =>
          withFileLock(
            path,
            async () => {
              taken += 1;
              if (taken === paths.length) allTaken();
              await letGo;
            },
            // A record lock is abandoned after 30 s without a renewal; a test on a slow machine can hold one longer.
            { renewMs: HOLD_RENEW_MS },
          ),
        ),
      );
      if (paths.length === 0) allTaken();
      await ready;
      process.send?.({ id: message.id, ok: true, held: taken });
    } else if (message.op === 'release') {
      release?.();
      await holding;
      process.send?.({ id: message.id, ok: true });
    } else {
      const at = message.now ?? Date.now();
      const store = new ApprovalStore(message.stateDir ?? '', { now: () => new Date(at) });
      process.send?.({ id: message.id, ok: true, status: await store.ensurePruned() });
    }
  } catch (error) {
    process.send?.({ id: message.id, ok: false, code: String(error) });
  }
});

process.send?.({ op: 'ready' });
