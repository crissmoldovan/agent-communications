import { useEffect, useRef } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { useAppData } from '../data.tsx';

/**
 * Runs `reload` when the window has the focus again, and when Rust says something changed (DA4): a screen's own reads
 * then catch up with what the person did in Terminal — a sign-in, a change approved there — as the reads the screens
 * share do (`data.tsx`). It only reads again; it never runs a change.
 */
export function useReloadOnReturn(reload: () => Promise<void>): void {
  const bridge = useBridge();
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  useEffect(() => {
    const again = () => void latest.current().catch(() => undefined);
    window.addEventListener('focus', again);
    const stop = bridge.on('data-changed', again);
    return () => {
      window.removeEventListener('focus', again);
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [bridge]);
}

/**
 * Runs `reload` each time the event service's supervisor says the service started or stopped running
 * (`AppData.eventServiceTurns`), never when the screen opens: a read of the service that failed because it was not
 * running, or that showed it running, then catches up with it.
 */
export function useReloadOnServiceTurn(reload: () => Promise<void>): void {
  const { eventServiceTurns } = useAppData();
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  const seen = useRef(eventServiceTurns);
  useEffect(() => {
    if (seen.current === eventServiceTurns) return;
    seen.current = eventServiceTurns;
    void latest.current().catch(() => undefined);
  }, [eventServiceTurns]);
}
