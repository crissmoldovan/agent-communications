import { ThemeProvider } from '@cueplusplus/ui/system';
import type { DesktopWindowKind } from './types';

export function App({ kind }: { kind: DesktopWindowKind }) {
  return (
    <ThemeProvider theme="cue" density="normal" mode="system">
      <main>
        <h1>{kind === 'settings' ? 'Settings' : 'Secrets'}</h1>
      </main>
    </ThemeProvider>
  );
}
