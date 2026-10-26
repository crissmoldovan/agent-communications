import cue from '@cueplusplus/theme-cue';
import soft from '@cueplusplus/theme-soft';
import terminal from '@cueplusplus/theme-terminal';
import {
  DEFAULT_PAINT,
  DEFAULT_STYLE_SET,
  type FontName,
  type Paint,
  prepaintScript,
  type StyleSet,
  type ThemeName,
} from '@cueplusplus/ui/system';

/**
 * The three presets the appearance menu offers: cue-ui's `soft` (the desktop design, 2026-10-24, §9; cue-ui 0.34.0
 * ships it as `@cueplusplus/theme-soft`), then cue's two (plan, "Where the design is silent" 4).
 */
export const THEMES = [soft, cue, terminal] as const;

/** Their names, as the provider takes them, in the same order. */
export const THEME_NAMES = ['soft', 'cue', 'terminal'] as const satisfies readonly ThemeName[];

export type AppTheme = (typeof THEME_NAMES)[number];

/** What a theme is worn with: the style set, the font pairing and the paint pack beside it. */
export type Look = { styleSet: StyleSet; font: FontName; paint: Paint };

/**
 * Each theme's look. A theme manifest cannot name a style set or a pack, and the provider holds all four axes apart, so
 * the app pairs them: picking a theme in the appearance menu sets its three beside it. `soft` is cue-ui's Soft Look,
 * its theme, the `soft` set, the `inter` pairing and the `glaze` pack. cue and terminal keep what they had before it:
 * the system pairing, and no set and no pack. Those two are stored as the library's defaults (`console`, `none`), which
 * restate what no set and no pack paint, because a stored axis left out falls back to the app's defaults, which are
 * soft's.
 */
export const LOOKS = {
  soft: { styleSet: 'soft', font: 'inter', paint: 'glaze' },
  cue: { styleSet: DEFAULT_STYLE_SET, font: 'system', paint: DEFAULT_PAINT },
  terminal: { styleSet: DEFAULT_STYLE_SET, font: 'system', paint: DEFAULT_PAINT },
} as const satisfies Record<AppTheme, Look>;

/**
 * What the app opens on before the person picks anything: the soft look at the `normal` rung, whose type is the
 * redesign's 13px body and 12px secondary text (§9; DA3 chose `cue` and `compact` before it).
 */
export const THEME_DEFAULTS = { theme: 'soft', density: 'normal', mode: 'system', ...LOOKS.soft } as const;

/** The local-storage key the provider and the pre-paint script share. */
// A new key in 0.34.0, as in 0.28.0: what 0.28 to 0.33 stored has no set and no pack, so under the soft defaults a
// stored cue or terminal would open in the soft set and pack, and a stored soft in the system face. The app opens once
// on the soft look, whatever an earlier version stored; the appearance menu still offers cue and terminal.
export const STORAGE_KEY = 'agent-comms.look.v2';

/**
 * The pre-paint script: stamps the stored theme, density, mode, font pairing, style set and pack on `<html>` before
 * anything paints. It is the one inline script the content policy allows, pinned there by its hash (`tauri.conf.json`,
 * checked by `csp.test.ts`).
 */
export function prepaintSource(): string {
  return prepaintScript({ storageKey: STORAGE_KEY, defaults: THEME_DEFAULTS, themes: THEMES });
}
