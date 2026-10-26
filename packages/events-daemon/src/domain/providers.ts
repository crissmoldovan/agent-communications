import { JUDGE_KIND_TYPESAFE } from './lifecycle.ts';

/**
 * The providers a person keeps a key for (owner decision 2026-10-26): each slot's owner is the provider itself.
 * TypeSafe and OpenRouter serve Jev; OpenRouter and Anthropic run Analyse's model (0.33.0 design §3.3); Linear is where
 * a rule's Linear target adds its issues, with the person's own API key (0.33.0 design §3.4).
 */
export const EVENT_SECRET_PROVIDERS: readonly [typeof JUDGE_KIND_TYPESAFE, 'openrouter', 'anthropic', 'linear'] = [
  JUDGE_KIND_TYPESAFE,
  'openrouter',
  'anthropic',
  'linear',
];
export type EventSecretProvider = (typeof EVENT_SECRET_PROVIDERS)[number];

/** Whether a value names a provider with a key slot. */
export function isEventSecretProvider(value: unknown): value is EventSecretProvider {
  return typeof value === 'string' && (EVENT_SECRET_PROVIDERS as readonly string[]).includes(value);
}

/** The providers in words, for a refusal: "typesafe, openrouter, anthropic or linear". */
export const EVENT_SECRET_PROVIDER_WORDS: string = `${EVENT_SECRET_PROVIDERS.slice(0, -1).join(', ')} or ${
  EVENT_SECRET_PROVIDERS[EVENT_SECRET_PROVIDERS.length - 1]
}`;
