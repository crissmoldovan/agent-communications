import { useEffect, useRef } from 'react';

/**
 * Runs `fn` at once and then every `everyMs` while `enabled`, and never two at a time: a run still going when the
 * next is due is not doubled. Stops when `enabled` turns false, and starts again, at once, when it turns true.
 */
export function usePoll(fn: () => Promise<void>, options: { everyMs: number; enabled: boolean }): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  const { everyMs, enabled } = options;
  useEffect(() => {
    if (!enabled) return;
    let running = false;
    let stopped = false;
    const tick = () => {
      if (running || stopped) return;
      running = true;
      latest
        .current()
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    };
    tick();
    const timer = setInterval(tick, everyMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [everyMs, enabled]);
}
