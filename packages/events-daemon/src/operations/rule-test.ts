import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

/**
 * Calls the owner-local deterministic catalogue test; neither this operation nor its caller can supply event bytes. A
 * workflow with a flow is walked over the example (0.36.0 §7.7), each step in `outcomes` answering as named, every
 * other with its first outcome, every effect a "would".
 */
export async function ruleTest(
  document: unknown,
  catalogue: { readonly type: string; readonly version: number; readonly exampleIndex: number },
  options: Options & { readonly outcomes?: Readonly<Record<string, string>> | undefined } = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('ruleTest', {
    document,
    catalogue,
    ...(options.outcomes === undefined ? {} : { outcomes: options.outcomes }),
  });
}

/** Retained projections stay behind the owner boundary and are intentionally a human-only capability. */
export async function ruleTestRetained(
  eventId: string,
  ruleId: string,
  ruleVersion: number,
  options: Options = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('ruleTestRetained', {
    eventId,
    ruleId,
    ruleVersion,
  });
}
