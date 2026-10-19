import cue from '@cueplusplus/theme-cue';
import terminal from '@cueplusplus/theme-terminal';
import { prepaintScript, type ThemeName } from '@cueplusplus/ui/system';

/** The two presets the appearance menu offers (plan, "Where the design is silent" 4). */
export const THEMES = [cue, terminal] as const;

/** Their names, as the provider takes them, in the same order. */
export const THEME_NAMES = ['cue', 'terminal'] as const satisfies readonly ThemeName[];

/** What the app opens on before the person picks anything (desktop design DA3). */
export const THEME_DEFAULTS = { theme: 'cue', density: 'compact', mode: 'system' } as const;

/** The local-storage key the provider and the pre-paint script share. */
export const STORAGE_KEY = 'agent-comms';

/**
 * The pre-paint script: stamps the stored theme, density and mode on `<html>` before anything paints. It is the one
 * inline script the content policy allows, pinned there by its hash (`tauri.conf.json`, checked by `csp.test.ts`).
 */
export function prepaintSource(): string {
  return prepaintScript({ storageKey: STORAGE_KEY, defaults: THEME_DEFAULTS, themes: THEMES });
}
