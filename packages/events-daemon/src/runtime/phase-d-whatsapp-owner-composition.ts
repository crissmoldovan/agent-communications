import { CommsError } from '@agentcomms/core';
import type { WhatsAppEventOperations } from '@agentcomms/whatsapp';
import type { EventDatabase } from '../store/database.ts';
import {
  type DSourceRetentionParticipant,
  RetainedContentHooks,
  type WhatsAppListChangeParticipant,
} from './retained-content-hooks.ts';
import { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';

type RetainedContentParticipants = Readonly<{
  list: WhatsAppListChangeParticipant;
  retention: DSourceRetentionParticipant;
}>;

/**
 * D's ordinary owner composition point for the live WhatsApp list fence.  B2 supplies its two synchronous
 * retained-content participants only after it exists; before that this still constructs and enforces the concrete
 * D fence rather than selecting a pass-through implementation.
 */
export function createPhaseDWhatsAppOwnerComposition(
  input: Readonly<{
    database: EventDatabase;
    eventOperations: Pick<WhatsAppEventOperations, 'withCurrentEventVisibility'>;
    createRetainedContentParticipants?:
      | ((input: Readonly<{ database: EventDatabase }>) => RetainedContentParticipants)
      | undefined;
    /** Test seam; production deliberately uses the fence's wall clock. */
    now?: (() => number) | undefined;
  }>,
): Readonly<{
  visibilityFence: WhatsAppVisibilityFence;
  retainedContentHooks: RetainedContentHooks;
}> {
  const retainedContentHooks = new RetainedContentHooks();
  const participants = input.createRetainedContentParticipants?.({ database: input.database });
  if (participants !== undefined) {
    retainedContentHooks.registerWhatsAppListChangeParticipant(participants.list);
    retainedContentHooks.registerRetentionTighteningParticipant(participants.retention);
  }
  const visibilityFence = new WhatsAppVisibilityFence({
    store: input.database,
    retainedContentHooks,
    withCurrentEventVisibility: (visibilityInput, work) =>
      input.eventOperations.withCurrentEventVisibility(visibilityInput, work),
    now: input.now,
  });
  return { visibilityFence, retainedContentHooks };
}

/** A registered WhatsApp source may never select the pre-D structural pass-through. */
export function requirePhaseDWhatsAppVisibilitySeam(
  input: Readonly<{
    hasWhatsAppSource: boolean;
    visibilityFence: WhatsAppVisibilityFence | undefined;
  }>,
): WhatsAppVisibilityFence | undefined {
  if (!input.hasWhatsAppSource || input.visibilityFence !== undefined) return input.visibilityFence;
  throw new CommsError(
    'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
    'the registered WhatsApp event source requires its concrete visibility fence',
  );
}
