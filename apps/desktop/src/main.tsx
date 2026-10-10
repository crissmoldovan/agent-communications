import { createRoot } from 'react-dom/client';
import '@cueplusplus/ui/styles.css';
import { App } from './app';

const root = document.getElementById('root');
if (!root) throw new Error('Settings root is missing');
createRoot(root).render(<App kind="settings" />);
if (import.meta.env.VITE_NO_EGRESS_PROBE === '1') {
  void import('./egress-probe').then(({ runEgressProbe }) => runEgressProbe('settings'));
}
