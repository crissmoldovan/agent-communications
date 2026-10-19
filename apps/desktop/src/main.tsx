import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tauriBridge } from './ipc.ts';
import { Root } from './Root.tsx';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root to render into');

createRoot(root).render(
  <StrictMode>
    <Root bridge={tauriBridge} />
  </StrictMode>,
);
