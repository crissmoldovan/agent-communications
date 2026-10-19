import './styles.css';
import { ThemeProvider } from '@cueplusplus/ui/system';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { STORAGE_KEY, THEME_DEFAULTS, THEMES } from './theme.ts';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root to render into');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider themes={THEMES} storageKey={STORAGE_KEY} {...THEME_DEFAULTS}>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
