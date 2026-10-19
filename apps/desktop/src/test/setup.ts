import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/*
 * Every test runs with no network: `fetch` throws, so a test that reaches for it fails rather than talking to anything.
 * The app itself never fetches (`repo-rules.test.ts`); this is the same promise, kept at run time.
 */
globalThis.fetch = () => {
  throw new Error('a test tried to reach the network');
};

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
