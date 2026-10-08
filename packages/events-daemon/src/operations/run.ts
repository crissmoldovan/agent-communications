import { runEventOwner } from '../runtime/owner.ts';

/** Starts the only process allowed to open the local event database and provider sessions. */
export async function run(options: { readonly stateDir?: string | undefined } = {}): Promise<void> {
  await runEventOwner(options);
}
