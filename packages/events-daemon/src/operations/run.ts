import { readDesktopCapabilityPipe } from '../runtime/desktop-capability-pipe.ts';
import { type EventOwnerOptions, runEventOwner } from '../runtime/owner.ts';

/** Starts the only process allowed to open the local event database and provider sessions. */
export async function run(options: Pick<EventOwnerOptions, 'stateDir' | 'configDir'> = {}): Promise<void> {
  const desktopCapabilityKey = readDesktopCapabilityPipe();
  try {
    await runEventOwner({ ...options, desktopCapabilityKey });
  } finally {
    desktopCapabilityKey?.fill(0);
  }
}
