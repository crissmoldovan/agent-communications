import type { ControlModel } from './control-model';
import type { SafeAppResult, Selection } from './types';

/** Shared by every screen callback; publication occurs only for the model's current request. */
export function createScreenController(
  model: ControlModel,
  publish: (rows: Record<string, SafeAppResult>) => void,
  showError: (error: string) => void,
) {
  return {
    async approval(id: string, digest: string, answer: string | null) {
      showError('');
      try {
        const pending = model.approval(id, digest, answer);
        publish(Object.fromEntries(model.rows));
        const result = await pending;
        if (result !== null) publish(Object.fromEntries(model.rows));
      } catch (error) {
        showError(String(error));
      }
    },
    async run(operation: string, args: Record<string, unknown>, expectedScope: Selection = {}) {
      showError('');
      try {
        const pending = model.control(operation, args, expectedScope);
        publish(Object.fromEntries(model.rows));
        await pending;
        // A suppressed destructive reply may still invalidate rows. Paint only the model's current state.
        publish(Object.fromEntries(model.rows));
      } catch (error) {
        showError(String(error));
      }
    },
  };
}
