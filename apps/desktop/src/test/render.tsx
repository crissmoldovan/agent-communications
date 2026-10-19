import { type RenderResult, render } from '@testing-library/react';
import type { Screen } from '../copy.ts';
import type { Bridge } from '../ipc.ts';
import { Root } from '../Root.tsx';

/** The whole app, as `main.tsx` mounts it (without StrictMode), on `bridge`, opening on `screen` (Overview by default). */
export function renderApp(bridge: Bridge, options: { screen?: Screen } = {}): RenderResult {
  return render(<Root bridge={bridge} initialScreen={options.screen} />);
}
