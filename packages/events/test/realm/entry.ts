/**
 * The library and its vector runners, as one script for a host with nothing but ECMAScript: the bare realm of
 * `test/support/realm.ts` and, from `pnpm verify:browser`, real browsers. Bundled as an IIFE whose global is
 * `AgentcommsEventsRealm`, so the only way in is `run`, and only strings cross: a family's name and its vector file's
 * text go in, the runner's result comes back as JSON text.
 */
import * as library from '../../src/index.ts';
import { RUNNERS } from './runners/index.ts';

export function run(family: string, vectorsJson: string): string {
  const runner = RUNNERS[family];
  if (runner === undefined) throw new Error(`no runner for the vector family "${family}"`);
  return JSON.stringify(runner(library, JSON.parse(vectorsJson)));
}
