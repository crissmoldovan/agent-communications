import { useRef } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { useAppData } from '../../data.tsx';
import { supports } from '../../gates.ts';
import { usePoll } from '../../hooks/use-poll.ts';
import { readIndexRun } from '../../search.ts';

/** How often the app runs Search's indexer while it is open (S10), and for how long each run may make vectors. */
export const UPKEEP_EVERY_MS = 5 * 60 * 1000;
export const UPKEEP_BUDGET = 20;

/**
 * Search's upkeep (0.35.0, design 2026-10-26-local-search S10): no background job of its own, so the app runs `search
 * index` every five minutes while it is open — what agents read is kept, missing vectors are made, and what is past
 * Activity's days is deleted. A run that finds Search never on here makes it rest until the app starts again; Search,
 * People and Settings → Search run it themselves as they open. It renders nothing.
 */
export function SearchUpkeep() {
  const bridge = useBridge();
  const { installation } = useAppData();
  const installed = installation.state === 'ready' && installation.value.installed ? installation.value.version : null;
  const resting = useRef(false);
  usePoll(
    async () => {
      if (resting.current) return;
      const result = await bridge.cli({ kind: 'searchIndex', budget: UPKEEP_BUDGET });
      const run = result.status === 'ok' ? readIndexRun(result.data) : null;
      if (run !== null && !run.ran) resting.current = true;
    },
    { everyMs: UPKEEP_EVERY_MS, enabled: supports(installed, 'search') },
  );
  return null;
}
