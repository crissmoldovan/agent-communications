import { createRoot } from 'react-dom/client';
import '@cueplusplus/ui/styles.css';
import { SecretsApp } from './secrets-app';

const root = document.getElementById('root');
if (!root) throw new Error('Secrets root is missing');
createRoot(root).render(<SecretsApp />);
if (import.meta.env.VITE_NO_EGRESS_PROBE === '1') {
  void import('./egress-probe').then(({ runEgressProbe }) => runEgressProbe('secrets'));
}
