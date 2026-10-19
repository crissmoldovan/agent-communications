import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenFrame } from './Screen.tsx';

/** The version, the update status, each doctor, what waits, standing approvals and the events service (DA5.1). Task 8. */
export function Overview() {
  return (
    <ScreenFrame title="Overview">
      <section aria-label="Update status">
        <Gated feature="updateStatus">{null}</Gated>
      </section>
    </ScreenFrame>
  );
}
