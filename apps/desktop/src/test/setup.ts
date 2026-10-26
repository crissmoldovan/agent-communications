import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/*
 * Every test runs with no network: `fetch` throws, so a test that reaches for it fails rather than talking to anything.
 * The app itself never fetches (`repo-rules.test.ts`); this is the same promise, kept at run time.
 */
globalThis.fetch = () => {
  throw new Error('a test tried to reach the network');
};

/*
 * A `findBy…` waits 5 s, not the library's 1 s: a file's first test renders the whole app cold, and on the slower
 * macOS Intel runner that once took longer than a second (Events → Rules, desktop run of 2026-10-26).
 */
configure({ asyncUtilTimeout: 5000 });

if (typeof window !== 'undefined') {
  // jsdom has neither; the theme provider asks the first (mode `system`), and the library's layout the second.
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });
}
