// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@cueplusplus/theme-base';
import { contrastRatio } from '@cueplusplus/theme-base/contrast';
import soft from '@cueplusplus/theme-soft';
import { FONT_PAIRINGS } from '@cueplusplus/tokens';
import { DEFAULT_PAINT, DEFAULT_STYLE_SET } from '@cueplusplus/ui/system';
import { describe, expect, it } from 'vitest';
import { LOOKS, prepaintSource, STORAGE_KEY, THEME_DEFAULTS, THEME_NAMES, THEMES } from '../theme.ts';

/*
 * The soft look (the desktop design, 2026-10-24, §9), from cue-ui since 0.34.0 (CUE-571): the theme is
 * `@cueplusplus/theme-soft`, worn with cue-ui's `soft` style set, the `inter` pairing and the `glaze` pack. The app's
 * own copy of it, built with `cue-theme` since 0.28.0, is gone. These hold that the app registers cue-ui's, opens on it,
 * paints it from the package's stylesheet, keeps only what cue-ui does not ship yet, and bundles the pairing's faces.
 */

const SRC = fileURLToPath(new URL('../', import.meta.url));
const APP = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');
/** A file inside one of the app's own dependencies, as installed beside it. */
const packageFile = (name: string, path: string): string => readFileSync(join(APP, 'node_modules', name, path), 'utf8');

type Mode = 'dark' | 'light';
const MODES: readonly Mode[] = ['dark', 'light'];

/** `ink` laid over `ground` at `share`, as a browser paints a translucent colour: the ground under `accent-soft`. */
function over(ink: string, ground: string, share: number): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(ink), rgb(ground)];
  const mixed = a.map((value, i) => Math.round(value * share + (b[i] ?? 0) * (1 - share)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** The custom properties declared by the first rule in `css` whose selector is exactly `selector`. */
function declared(css: string, selector: string): string[] {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `a rule for ${selector}`).toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf('\n}', at));
  return [...body.matchAll(/(--cue-[\w-]+):/g)].map((match) => match[1] ?? '');
}

describe('the soft theme', () => {
  it("registers cue-ui's soft preset as soft, first, beside cue and terminal, and opens on it", () => {
    expect(THEMES[0]).toBe(soft);
    expect(soft.name).toBe('soft');
    expect(soft.package).toBe('@cueplusplus/theme-soft');
    expect(THEME_NAMES).toEqual(['soft', 'cue', 'terminal']);
    expect(THEMES.map((theme) => theme.name)).toEqual(['soft', 'cue', 'terminal']);
    expect(THEME_DEFAULTS).toMatchObject({ theme: 'soft', density: 'normal', mode: 'system' });
  });

  it("is a manifest the provider accepts, built through cue-ui's contrast gate with nothing waived", () => {
    expect(validateManifest(soft)).toEqual([]);
    expect(soft.mode).toBe('complete');
    expect(soft.supportsLight).toBe(true);
    expect(soft.contrast).toMatchObject({ passes: true, advisories: 0, waived: 0 });
  });

  it("has the mockup's corners, 8px controls and 14px surfaces, at the rung the app opens on", () => {
    expect(THEME_DEFAULTS.density).toBe('normal');
    expect(soft.densities.overrides.normal).toEqual({ 'radius-control': '8px', 'radius-surface': '14px' });
  });

  it('clears 4.5:1 on the three text pairs cue-ui-82 found short, with its smallest fixes', () => {
    for (const mode of MODES) {
      const c = soft.colors[mode];
      if (c === undefined) throw new Error(`no ${mode} palette`);
      expect(contrastRatio(c['fg-subtle'], c['surface-3']), `${mode} fg-subtle on surface-3`).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(c['fg-muted'], c['surface-3']), `${mode} fg-muted on surface-3`).toBeGreaterThanOrEqual(4.5);
      // cue-ui's own default for an active item and a pressed segment: accent ink on accent-soft, the accent at 14%.
      for (const ground of ['bg', 'surface-1'] as const) {
        const soft14 = over(c.accent, c[ground], 0.14);
        expect(contrastRatio(c.accent, soft14), `${mode} accent on accent-soft over ${ground}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
    expect(soft.colors.light?.accent.toLowerCase()).toBe('#4c52d3');
    expect(soft.colors.light?.['fg-subtle'].toLowerCase()).toBe('#686871');
    expect(soft.colors.dark['fg-subtle'].toLowerCase()).toBe('#8e8e97');
  });

  it("is painted by the package's stylesheet, after the library's, and the app keeps no copy of its own", () => {
    const imports = [...read('styles.css').matchAll(/^@import "([^"]+)";/gm)].map((match) => match[1]);
    expect(imports).toEqual([
      'tailwindcss',
      '@cueplusplus/ui/styles.css',
      '@cueplusplus/theme-cue/theme.css',
      '@cueplusplus/theme-terminal/theme.css',
      '@cueplusplus/theme-soft/theme.css',
      './soft.css',
      './fonts.css',
    ]);
    expect(packageFile('@cueplusplus/theme-soft', 'theme.css')).toContain('[data-theme="soft"]');
    // 0.34.0 adds no rung or pairing of soft's own, so its variants stylesheet is empty and is not imported.
    expect(packageFile('@cueplusplus/theme-soft', 'variants.css').trim()).toBe('');
    expect(existsSync(join(SRC, 'themes'))).toBe(false);
  });
});

describe('the soft look', () => {
  it("wears cue-ui's soft style set, the inter pairing and the glaze pack, and is what the app opens on", () => {
    expect(LOOKS.soft).toEqual({ styleSet: 'soft', font: 'inter', paint: 'glaze' });
    expect(THEME_DEFAULTS).toEqual({
      theme: 'soft',
      density: 'normal',
      mode: 'system',
      styleSet: 'soft',
      font: 'inter',
      paint: 'glaze',
    });
  });

  it('gives cue and terminal the system pairing and the library default set and pack, never the soft ones', () => {
    for (const theme of ['cue', 'terminal'] as const) {
      expect(LOOKS[theme], theme).toEqual({ styleSet: DEFAULT_STYLE_SET, font: 'system', paint: DEFAULT_PAINT });
      expect(LOOKS[theme].styleSet).not.toBe('soft');
      expect(LOOKS[theme].paint).not.toBe('glaze');
    }
    // A stored axis left out falls back to the defaults, which are soft's, so "none" has to be a stored value.
    expect([DEFAULT_STYLE_SET, DEFAULT_PAINT]).toEqual(['console', 'none']);
  });

  it('is what the pre-paint script falls back to, under a key no earlier version wrote', () => {
    const script = prepaintSource();
    expect(STORAGE_KEY).toBe('agent-comms.look.v2');
    expect(script).toContain('var k="agent-comms.look.v2"');
    expect(script).toContain('var T=["soft","cue","terminal"]');
    expect(script).toContain(':"soft")');
    expect(script).toContain('a.d.indexOf("normal")>-1?"normal"');
    expect(script).toContain('a.f.indexOf("inter")>-1?"inter"');
    expect(script).toContain('s.style:"soft"');
    expect(script).toContain('s.paint:"glaze"');
  });

  it("keeps only what cue-ui's soft set and glaze pack leave unset, scoped to soft", () => {
    const kept = read('soft.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...kept.matchAll(/([^{}]+)\{/g)].flatMap((match) => (match[1] ?? '').split(','));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.trim(), selector).toMatch(/^\[data-theme="soft"\](?:\s|$)/);
    const names = declared(`\n${kept.trim()}`, '[data-theme="soft"]');
    expect(names.length).toBeGreaterThan(0);
    // Each kept name is one cue-ui does not declare for this look: when its set or pack does, the name goes from here.
    const axes = packageFile('@cueplusplus/tokens', 'dist/axes.css');
    const library = new Set([...declared(axes, '[data-style="soft"]'), ...declared(axes, '[data-paint="glaze"]')]);
    expect(names.filter((name) => library.has(name))).toEqual([]);
  });

  it("bundles the inter pairing's two faces, and names Inter's variable family for the pairing to read", () => {
    expect(FONT_PAIRINGS.inter.faces).toEqual(['--cue-face-inter', '--cue-face-ibm-plex-mono']);
    const fonts = read('fonts.css');
    const imports = [...fonts.matchAll(/^@import "([^"]+)";/gm)].map((match) => match[1]);
    expect(imports).toEqual([
      '@fontsource-variable/inter',
      '@fontsource/ibm-plex-mono/400',
      '@fontsource/ibm-plex-mono/500',
    ]);
    const family = /font-family:\s*'([^']+)'/.exec(packageFile('@fontsource-variable/inter', 'index.css'))?.[1];
    expect(family).toBe('Inter Variable');
    expect(fonts).toContain(`--cue-face-inter: "${family}";`);
    // IBM Plex Mono's family is the pairing's own fallback name, so it needs no property of its own.
    expect(packageFile('@fontsource/ibm-plex-mono', '400.css')).toContain("font-family: 'IBM Plex Mono'");
    expect(FONT_PAIRINGS.inter.mono).toBe('IBM Plex Mono');
  });
});
