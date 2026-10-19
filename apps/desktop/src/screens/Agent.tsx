import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenFrame } from './Screen.tsx';

/** The label, the behaviour rules and the standing approvals (DA5.4). Task 9. */
export function Agent() {
  return (
    <ScreenFrame title="Agent">
      <section aria-label="Behaviour rules">
        <Gated feature="behaviour">{null}</Gated>
      </section>
      <section aria-label="Standing approvals">
        <Gated feature="standing">{null}</Gated>
      </section>
    </ScreenFrame>
  );
}
