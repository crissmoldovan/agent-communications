import { CSPProvider } from '@base-ui/react/csp-provider';
import { ThemeProvider } from '@cueplusplus/ui/system';
import { App } from './App.tsx';
import { BridgeProvider } from './bridge-context.tsx';
import type { Screen } from './copy.ts';
import { AppDataProvider } from './data.tsx';
import type { Bridge } from './ipc.ts';
import { STORAGE_KEY, THEME_DEFAULTS, THEMES } from './theme.ts';

/**
 * The app with everything around it, as `main.tsx` mounts it and the tests render it. Base UI writes no `<style>`
 * element of its own (`CSPProvider disableStyleElements`): the content policy's `style-src 'self'` refuses one, so
 * what it would have written is in the app's stylesheet instead.
 */
export function Root({ bridge, initialScreen }: { bridge: Bridge; initialScreen?: Screen | undefined }) {
  return (
    <CSPProvider disableStyleElements>
      <ThemeProvider themes={THEMES} storageKey={STORAGE_KEY} {...THEME_DEFAULTS}>
        <BridgeProvider bridge={bridge}>
          <AppDataProvider>
            <App initialScreen={initialScreen} />
          </AppDataProvider>
        </BridgeProvider>
      </ThemeProvider>
    </CSPProvider>
  );
}
