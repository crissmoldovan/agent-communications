import { AI_PROVIDERS, type AiProvider } from './ipc.ts';

/*
 * The AI providers whose keys Jev uses (0.32.0), as the events service's `provider list` answers: TypeSafe and
 * OpenRouter, each with whether it has a key — never a key, nor any part of one. From 0.33.0 the list also names
 * providers that are not AI providers (Linear, whose key a Linear target uses); this reads past them.
 */

/** `provider list`, read as the event service gives it, or `null` when it is not exactly that. */
export function readProviders(value: unknown): Record<AiProvider, boolean> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const providers = (value as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return null;
  const found: Partial<Record<AiProvider, boolean>> = {};
  for (const entry of providers) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, hasKey } = entry as { id?: unknown; hasKey?: unknown };
    if (typeof id !== 'string' || typeof hasKey !== 'boolean') return null;
    // A provider this screen has no row for — Anthropic's key, which Analyse uses, or Linear's, a Linear target's
    // (0.33.0) — is passed over, so a newer event service still reads; the two Jev providers must each be there.
    if (!(AI_PROVIDERS as readonly string[]).includes(id)) continue;
    found[id as AiProvider] = hasKey;
  }
  if (AI_PROVIDERS.some((provider) => found[provider] === undefined)) return null;
  return found as Record<AiProvider, boolean>;
}

/** `judges list`, read leniently: only to say whether Jev uses a key, and which judges a rule may ask. */
export function readListedJudges(value: unknown): ListedJudge[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (entry): entry is ListedJudge =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as ListedJudge).kind === 'string' &&
      typeof (entry as ListedJudge).provider === 'string',
  );
}

/** Whether `provider list` says `provider` has a key: false when it does not name it. */
export function keyOf(value: unknown, provider: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const providers = (value as { providers?: unknown }).providers;
  return (
    Array.isArray(providers) &&
    providers.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { id?: unknown }).id === provider &&
        (entry as { hasKey?: unknown }).hasKey === true,
    )
  );
}

/** A judge as `judges list` gives it: content-free, the fields the Judges rows read. */
export interface ListedJudge {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: string;
  readonly provider: string;
  readonly model: string;
  readonly revokedAt: number | null;
}

/** The latest live version of a kind's judges: the one its row describes. */
export function latestJudge(judges: readonly ListedJudge[] | null, kind: string): ListedJudge | null {
  const live = (judges ?? []).filter((judge) => judge.kind === kind && judge.revokedAt === null);
  return live.reduce<ListedJudge | null>(
    (latest, judge) => (latest === null || judge.version > latest.version ? judge : latest),
    null,
  );
}

/** Whether a live Jev judge is served by `provider`: its key is then in use. */
export function providerInUse(judges: readonly ListedJudge[] | null, provider: AiProvider): boolean {
  return (judges ?? []).some(
    (judge) => judge.kind === 'typesafe' && judge.revokedAt === null && judge.provider === provider,
  );
}

/** A Jev model as a person reads it: `typesafe/jev-1.14` and `jev-1.13.0` are Jev 1.14 and Jev 1.13. */
export function jevModelName(model: string): string {
  const version = /jev-(\d+\.\d+)/u.exec(model)?.[1];
  return version === undefined ? model : `Jev ${version}`;
}

/**
 * `judge show <judgeId> --version <n>` (0.33.0), read for the rule editor: the judge version's exact canonical
 * document, which a rule embeds as the event service will approve it — or `null` when the answer is not exactly the
 * live version asked for, with a document of its own id and version and a digest. Its fields are configuration only (a
 * judge's key is a separate secret, never in it); the editor shows none of them as markup.
 */
export function readJudgeShow(
  value: unknown,
  asked: { readonly judgeId: string; readonly version: number },
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { judgeId, version, document, digest, state } = value as Record<string, unknown>;
  if (judgeId !== asked.judgeId || version !== asked.version || state !== 'live') return null;
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) return null;
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return null;
  const shown = document as Record<string, unknown>;
  if (shown.judgeId !== asked.judgeId || shown.version !== asked.version) return null;
  if (typeof shown.kind !== 'string' || typeof shown.provider !== 'string') return null;
  return shown;
}
