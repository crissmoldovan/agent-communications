import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenFrame } from './Screen.tsx';

/** The update level, pauses, the background job and rollback (DA5.5). Task 10. */
export function Updates() {
  return (
    <ScreenFrame title="Updates">
      <Gated feature="updateStatus">{null}</Gated>
    </ScreenFrame>
  );
}
