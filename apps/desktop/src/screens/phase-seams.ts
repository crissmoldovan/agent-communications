import type { SafeAppResult } from '../types';

export function phaseSeam(result?: SafeAppResult): string | null {
  if (result?.code === 'E_REQUIRED') return 'Judge operations are unavailable until Phase E. No judge call is made.';
  if (result?.code === 'E2_REQUIRED')
    return 'Laya is unavailable until Phase E2. No runtime, model, download or worker is started.';
  if (result?.code === 'HOLDS_UNAVAILABLE') return 'Held decisions are unavailable until Phase E.';
  return null;
}
