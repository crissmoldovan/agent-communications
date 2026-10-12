import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ControlModel, type NativeInvoke } from './control-model';
import { phaseSeam } from './screens/phase-seams';
import { OperationResults } from './screens/shared';

/** Included only by VITE_NO_EGRESS_PROBE builds; uses the shipped adapter, renderer and native command. */
export async function runProductionFlow(invoke: NativeInvoke, entry: 'settings' | 'secrets') {
  if (entry !== 'settings') return;
  const requests = await invoke<{ operation: string; args: Record<string, unknown> }[]>('desktop_probe_full_fixture');
  const model = new ControlModel(invoke);
  const surface = document.createElement('div');
  document.body.append(surface);
  const renderer = createRoot(surface);
  let completed = 0;
  for (const { operation, args } of requests) {
    let result: Awaited<ReturnType<ControlModel['control']>>;
    try {
      result = await model.control(operation, args);
    } catch (error) {
      if (error === 'WINDOWS_CONTROL_UNAVAILABLE' && completed === 0) {
        await invoke('desktop_probe_report', { report: 'full-production,WINDOWS_CONTROL_UNAVAILABLE' });
        return;
      }
      throw error;
    }
    if (!result || model.rows.get(operation) !== result) throw new Error('production adapter bypass');
    flushSync(() => renderer.render(<OperationResults results={{ [operation]: result }} />));
    if (surface.querySelector('script,iframe,img,form')) throw new Error('unsafe result renderer');
    if (result.code === 'E2_REQUIRED' && !phaseSeam(result)?.includes('unavailable until Phase E2'))
      throw new Error('E2 reason absent');
    completed++;
  }
  model.close();
  if (model.rows.size !== 0) throw new Error('orphaned production state');
  renderer.unmount();
  surface.remove();
  await invoke('desktop_probe_report', { report: `full-production,${completed},adapter-renderer-native` });
}
