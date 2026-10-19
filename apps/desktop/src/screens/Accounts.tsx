import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenFrame } from './Screen.tsx';

/** Each account, its policies, label style and what agents may do there, and its writing profiles (DA5.2). Task 9. */
export function Accounts() {
  return (
    <ScreenFrame title="Accounts">
      <section aria-label="Writing profiles">
        <Gated feature="profiles">{null}</Gated>
      </section>
    </ScreenFrame>
  );
}
