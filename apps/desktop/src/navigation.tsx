import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { Screen } from './copy.ts';

/**
 * Where a link inside a screen takes the person (0.32.0): Settings at its AI providers, from Events → Judges, or at its
 * Integrations, from the rule editor (0.33.0); Events
 * at its Judges, from Settings; and Messages at one message's story, by its event id, from anywhere — Events →
 * Deliveries' "See everything that happened to this message" calls `navigate({ screen: 'messages', eventId })` from
 * inside its `NavigationProvider`. The screen that opens reads its destination once, as it mounts.
 *
 * Messages opens the story whether or not the event is on the list's first page (it reads `message show` for it); an
 * event the event service no longer keeps says so, and an id that is no event id opens the list. Back goes to the
 * Messages list.
 *
 * Accounts opens one account's page, by its name (0.34.0: Your agents' "Open in Accounts ›"), on its channel's tab, once
 * that channel's list has it; without a name, or with one no list has, it opens the lists. Your agents opens as it
 * is, from an account page's line about the exceptions that live there.
 */
export type Destination =
  | { readonly screen: 'settings'; readonly section: 'ai-providers' | 'integrations' }
  | { readonly screen: 'events'; readonly tab: 'judges' }
  | { readonly screen: 'messages'; readonly eventId: string }
  // Accounts at one account's page (0.34.0), from Your agents' line for it; with no account, the list.
  | { readonly screen: 'accounts'; readonly account?: string }
  // Your agents as it opens, from an account page's line about what is set there for every account (0.34.0).
  | { readonly screen: 'agent' };

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

/**
 * The destination asked for on `screen`, once: a second read finds none. With `match`, only a destination it accepts is
 * taken, so two parts of one screen — Settings' AI providers and its Integrations (0.33.0) — each take only their own.
 */
export function takeDestination<S extends Destination['screen']>(
  screen: S,
  match?: (destination: Extract<Destination, { screen: S }>) => boolean,
): Extract<Destination, { screen: S }> | null {
  if (pending?.screen !== screen) return null;
  const found = pending as Extract<Destination, { screen: S }>;
  if (match !== undefined && !match(found)) return null;
  pending = null;
  return found;
}
