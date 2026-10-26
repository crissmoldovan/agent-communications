import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { Screen } from './copy.ts';

/**
 * Where a link inside a screen takes the person (0.32.0): Settings at its AI providers, from Events → Judges; and Events
 * at its Judges, from Settings. The screen that opens reads its destination once, as it mounts.
 */
export type Destination =
  | { readonly screen: 'settings'; readonly section: 'ai-providers' }
  | { readonly screen: 'events'; readonly tab: 'judges' };

/** The destination asked for, until the screen it names reads it. */
let pending: Destination | null = null;

const NavigateContext = createContext<((to: Destination) => void) | null>(null);

/** Gives a screen's parts a way to open another screen at one of its places, through the shell's `onScreen`. */
export function NavigationProvider({
  onScreen,
  children,
}: {
  onScreen?: ((screen: Screen) => void) | undefined;
  children: ReactNode;
}) {
  const navigate = useMemo(
    () =>
      onScreen === undefined
        ? null
        : (to: Destination) => {
            pending = to;
            onScreen(to.screen);
          },
    [onScreen],
  );
  return <NavigateContext.Provider value={navigate}>{children}</NavigateContext.Provider>;
}

/** Opens a destination; `null` where the screen was shown without the shell (Settings before an install). */
export function useNavigate(): ((to: Destination) => void) | null {
  return useContext(NavigateContext);
}

/** The destination asked for on `screen`, once: a second read finds none. */
export function takeDestination<S extends Destination['screen']>(
  screen: S,
): Extract<Destination, { screen: S }> | null {
  if (pending?.screen !== screen) return null;
  const found = pending as Extract<Destination, { screen: S }>;
  pending = null;
  return found;
}
