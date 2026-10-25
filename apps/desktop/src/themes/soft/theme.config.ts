/**
 * The `soft` theme's build config, in the shape `@cueplusplus/theme-tools`' `defineTheme` takes: the app's own theme
 * until cue-ui ships its soft preset (cue-ui-82), when the app moves to that and this folder goes (the desktop design,
 * 2026-10-24, §9). It is plain data, with no import, so `cue-theme` reads it without the app depending on theme-tools.
 *
 * `generated/` is `cue-theme build`'s output, never edited by hand. After changing a source, from any folder where
 * `@cueplusplus/theme-tools@1.3.0` and `@cueplusplus/tokens@0.30.0` are installed:
 *
 *   cue-theme build --config <this file> --out <this folder>/generated
 *
 * `soft-theme.test.ts` holds `generated/` to these sources and to the contrast floors cue-ui-82 asks for.
 */
export default {
  name: 'soft',
  package: '@agentcomms/desktop',
  extends: '@cueplusplus/theme-base@^1',
  mode: 'complete',
  advisories: 'fail',
  sources: { dark: 'sources/soft.dark.tokens.json', light: 'sources/soft.light.tokens.json' },
  densities: {
    overrides: {
      'ultra-compact': 'sources/soft.ultra-compact.tokens.json',
      compact: 'sources/soft.compact.tokens.json',
      normal: 'sources/soft.normal.tokens.json',
      large: 'sources/soft.large.tokens.json',
      'ultra-large': 'sources/soft.ultra-large.tokens.json',
    },
    default: 'normal',
  },
  fontPairings: { overrides: { system: 'sources/soft.system.tokens.json' } },
};
