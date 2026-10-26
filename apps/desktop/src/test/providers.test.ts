import { describe, expect, it } from 'vitest';
import { readProviders } from '../providers.ts';

describe('provider list, as the app reads it', () => {
  it('reads the AI providers and reads past a provider that is not one, such as Linear (0.33.0)', () => {
    expect(
      readProviders({
        providers: [
          { id: 'typesafe', name: 'TypeSafe', hasKey: false },
          { id: 'openrouter', name: 'OpenRouter', hasKey: true },
          { id: 'linear', name: 'Linear', hasKey: true },
        ],
      }),
    ).toEqual({ typesafe: false, openrouter: true });
  });

  it('still refuses a list that is not one: a missing AI provider, or an entry of the wrong shape', () => {
    expect(readProviders({ providers: [{ id: 'typesafe', name: 'TypeSafe', hasKey: true }] })).toBeNull();
    expect(
      readProviders({
        providers: [
          { id: 'typesafe', name: 'TypeSafe', hasKey: true },
          { id: 'openrouter', name: 'OpenRouter', hasKey: 'yes' },
        ],
      }),
    ).toBeNull();
    expect(readProviders({ providers: [{ id: 7, hasKey: true }] })).toBeNull();
    expect(readProviders('providers')).toBeNull();
  });
});
