/*
 * Every test runs with no network: `fetch` throws, so a test that reaches for it fails rather than talking to anything.
 * The app itself never fetches (`repo-rules.test.ts`); this is the same promise, kept at run time.
 */
globalThis.fetch = () => {
  throw new Error('a test tried to reach the network');
};
