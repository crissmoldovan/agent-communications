import { ThemeProvider } from '@cueplusplus/ui/system';
import { type RenderResult, render } from '@testing-library/react';
import { App } from '../App.tsx';
import { BridgeProvider } from '../bridge-context.tsx';
import type { Screen } from '../copy.ts';
import { AppDataProvider } from '../data.tsx';
import type { Bridge } from '../ipc.ts';
import { STORAGE_KEY, THEME_DEFAULTS, THEMES } from '../theme.ts';

/** The whole app, as `main.tsx` mounts it, on `bridge`, opening on `screen` (Overview by default). */
export function renderApp(bridge: Bridge, options: { screen?: Screen } = {}): RenderResult {
  return render(
    <ThemeProvider themes={THEMES} storageKey={STORAGE_KEY} {...THEME_DEFAULTS}>
      <BridgeProvider bridge={bridge}>
        <AppDataProvider>
          <App initialScreen={options.screen} />
        </AppDataProvider>
      </BridgeProvider>
    </ThemeProvider>,
  );
}
