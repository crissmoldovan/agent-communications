// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@cueplusplus/theme-base';
import { contrastRatio } from '@cueplusplus/theme-base/contrast';
import { describe, expect, it } from 'vitest';
import { prepaintSource, THEME_DEFAULTS, THEME_NAMES, THEMES } from '../theme.ts';
import soft from '../themes/soft/generated/index.js';

/*
 * The app's own theme, `soft` (the desktop design, 2026-10-24, §9): built by `cue-theme` from `themes/soft/sources`,
 * offered first and opened on. These hold what `cue-theme check` would, without the app depending on theme-tools: the
 * generated manifest and stylesheet say what the sources say, the manifest is one the provider accepts, and the text
 * pairs cue-ui-82 found under 4.5:1 clear it.
 */

const SOFT = fileURLToPath(new URL('../themes/soft/', import.meta.url));
const read = (path: string): string => readFileSync(`${SOFT}${path}`, 'utf8');
const json = (path: string): Record<string, unknown> => JSON.parse(read(path)) as Record<string, unknown>;

type Mode = 'dark' | 'light';
const MODES: readonly Mode[] = ['dark', 'light'];
const RUNGS = ['ultra-compact', 'compact', 'normal', 'large', 'ultra-large'] as const;

/** A colour source's values, by token, with the one alias the sources use resolved as the token layer resolves it. */
function sourceColours(mode: Mode): Record<string, string> {
  const group = json(`sources/soft.${mode}.tokens.json`).color as Record<string, { $value?: string }>;
  const out: Record<string, string> = {};
  for (const [name, token] of Object.entries(group)) {
    if (name.startsWith('$') || token.$value === undefined) continue;
    out[name] = token.$value === '{primitive.black}' ? '#000000' : token.$value;
  }
  return out;
}

/** The declarations of the first rule in `css` whose selector list ends with `selector`. */
function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, `theme.css has a rule for ${selector}`).toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/(--cue-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]?.trim() ?? '']));
}

/** `ink` laid over `ground` at `share`, as a browser paints a translucent colour: the ground under `accent-soft`. */
function over(ink: string, ground: string, share: number): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(ink), rgb(ground)];
  const mixed = a.map((value, i) => Math.round(value * share + (b[i] ?? 0) * (1 - share)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

describe('the soft theme', () => {
  it('is offered first, beside cue and terminal, and is what the app opens on', () => {
    expect(THEME_NAMES).toEqual(['soft', 'cue', 'terminal']);
    expect(THEMES.map((theme) => theme.name)).toEqual(['soft', 'cue', 'terminal']);
    expect(THEME_DEFAULTS).toEqual({ theme: 'soft', density: 'normal', mode: 'system' });
    expect(soft.name).toBe('soft');
  });

  it('is a manifest the provider accepts, built through the contrast gate with nothing waived', () => {
    expect(validateManifest(soft)).toEqual([]);
    expect(soft.mode).toBe('complete');
    expect(soft.supportsLight).toBe(true);
    expect(soft.contrast).toMatchObject({ passes: true, advisories: 0, waived: 0 });
  });

  it("carries its sources' colours, in the manifest and in its stylesheet, in both modes", () => {
    const css = read('generated/theme.css');
    const blocks: Record<Mode, Record<string, string>> = {
      dark: block(css, '[data-theme="soft"]'),
      light: block(css, '[data-theme="soft"][data-mode="light"]'),
    };
    for (const mode of MODES) {
      const colours = sourceColours(mode);
      expect(Object.keys(colours)).toHaveLength(26);
      expect(soft.colors[mode]).toEqual(colours);
      for (const [name, value] of Object.entries(colours)) expect(blocks[mode][`--cue-${name}`], name).toBe(value);
    }
  });

  it("has the mockup's corners, 8px controls and 14px surfaces, at the rung it opens on, and every rung derived", () => {
    expect(soft.densities.default).toBe('normal');
    expect(soft.densities.overrides.normal).toEqual({ 'radius-control': '8px', 'radius-surface': '14px' });
    for (const rung of RUNGS) {
      const source = json(`sources/soft.${rung}.tokens.json`).density as Record<string, { $value?: string }>;
      const values = Object.fromEntries(
        Object.entries(source)
          .filter(([name]) => !name.startsWith('$'))
          .map(([name, token]) => [name, token.$value]),
      );
      expect(soft.densities.overrides[rung], rung).toEqual(values);
    }
  });

  it('sets its sans as the system face on macOS and Inter elsewhere, and leaves the monospace to the pairing', () => {
    const system = soft.fontPairings.overrides.system;
    expect(system?.['font-sans']?.split(', ').slice(0, 4)).toEqual([
      '-apple-system',
      'BlinkMacSystemFont',
      '"SF Pro Text"',
      'Inter',
    ]);
    expect(system?.['font-mono']).toBeUndefined();
    expect(soft.fonts).toEqual({});
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
    expect(soft.colors.light?.accent).toBe('#4C52D3');
    expect(soft.colors.light?.['fg-subtle']).toBe('#686871');
    expect(soft.colors.dark['fg-subtle']).toBe('#8E8E97');
  });

  it('is what the pre-paint script falls back to, at the normal rung, ahead of cue and terminal', () => {
    const script = prepaintSource();
    expect(script).toContain('var T=["soft","cue","terminal"]');
    expect(script).toContain(':"soft")');
    expect(script).toContain('a.d.indexOf("normal")>-1?"normal"');
  });
});
