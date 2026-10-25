import cue from '@cueplusplus/theme-cue';
import terminal from '@cueplusplus/theme-terminal';
import { prepaintScript, type ThemeName } from '@cueplusplus/ui/system';
import soft from './themes/soft/generated/index.js';

/**
 * The three presets the appearance menu offers: the app's own `soft` (the desktop design, 2026-10-24, §9), then cue's
 * two (plan, "Where the design is silent" 4).
 */
export const THEMES = [soft, cue, terminal] as const;

/** Their names, as the provider takes them, in the same order. */
export const THEME_NAMES = ['soft', 'cue', 'terminal'] as const satisfies readonly ThemeName[];

/**
 * What the app opens on before the person picks anything: `soft` at the `normal` rung, whose type is the redesign's
 * 13px body and 12px secondary text (§9; DA3 chose `cue` and `compact` before it).
 */
export const THEME_DEFAULTS = { theme: 'soft', density: 'normal', mode: 'system' } as const;

/** The local-storage key the provider and the pre-paint script share. */
// A new key in 0.28.0: the redesign opens once on its own look, `soft`, whatever an earlier version stored; the
// appearance menu still offers cue and terminal (desktop design §9).
export const STORAGE_KEY = 'agent-comms.look';

/**
 * The pre-paint script: stamps the stored theme, density and mode on `<html>` before anything paints. It is the one
 * inline script the content policy allows, pinned there by its hash (`tauri.conf.json`, checked by `csp.test.ts`).
 */
export function prepaintSource(): string {
  return prepaintScript({ storageKey: STORAGE_KEY, defaults: THEME_DEFAULTS, themes: THEMES });
}
