import { CommsError } from '@agentcomms/core';
import { normaliseGmailSourceOptions, type SourceOptions } from '../domain/source-options.ts';
import type { LocalEventSource } from './contracts.ts';
import { createResendLocalEventSource } from './resend.ts';
import { createSlackLocalEventSource } from './slack.ts';
import { createWhatsAppLocalEventSource } from './whatsapp.ts';

export type { LocalEventSource } from './contracts.ts';

/** The owner registers a finite set of adapters; a rule may never make a missing source appear. */
export class LocalEventSourceRegistry {
  readonly #sources: ReadonlyMap<SourceOptions['channel'], LocalEventSource>;

  constructor(sources: readonly LocalEventSource[]) {
    const entries = new Map<SourceOptions['channel'], LocalEventSource>();
    for (const source of sources) {
      if (entries.has(source.source))
        throw new CommsError('CONFIG', 'a local event source was registered more than once', {
          details: { reason: 'DUPLICATE_SOURCE', source: source.source },
        });
      entries.set(source.source, source);
    }
    this.#sources = entries;
  }

  sources(): readonly SourceOptions['channel'][] {
    return [...this.#sources.keys()].sort();
  }

  require(source: SourceOptions['channel']): LocalEventSource {
    const adapter = this.#sources.get(source);
    if (adapter !== undefined) return adapter;
    throw new CommsError('SOURCE_UNAVAILABLE', 'the local event source is unavailable in this installation', {
      details: { reason: 'SOURCE_UNAVAILABLE', source },
    });
  }
}

/** B2 adapters are intentionally not implied by this registration: D3 ships Gmail as the one live source. */
export function gmailOnlySourceRegistry(): LocalEventSourceRegistry {
  return new LocalEventSourceRegistry([
    {
      source: 'gmail',
      canonicalise: normaliseGmailSourceOptions,
      scopesFor: ({ accountId }) => [{ source: 'gmail', accountId, scopeId: 'mailbox' }],
      withScopes: (lock, scopes, work) => lock.withScopes(scopes, work),
      baseline: (sample) => sample(),
      resume: (step) => step(),
      describeCursor: (cursor) => cursor,
      cleanup: (_kind, work) => Promise.resolve(work()),
    },
  ]);
}

/** The owner is the one auditable registration point for the complete held Phase-D source set. */
export function phaseDSourceRegistry(): LocalEventSourceRegistry {
  const gmail = gmailOnlySourceRegistry().require('gmail');
  return new LocalEventSourceRegistry([
    gmail,
    createSlackLocalEventSource(),
    createResendLocalEventSource(),
    createWhatsAppLocalEventSource(),
  ]);
}
