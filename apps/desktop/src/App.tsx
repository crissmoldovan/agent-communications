import { Button, Spinner } from '@cueplusplus/ui';
import { type ComponentType, useEffect, useState } from 'react';
import { UntrustedText } from './components/UntrustedText.tsx';
import { COPY, type Screen } from './copy.ts';
import { useAppData } from './data.tsx';
import { Shell } from './Shell.tsx';
import { Accounts } from './screens/Accounts.tsx';
import { Agent } from './screens/Agent.tsx';
import { Approvals } from './screens/Approvals.tsx';
import { Doctor } from './screens/Doctor.tsx';
import { Events } from './screens/Events.tsx';
import { NotInstalled } from './screens/NotInstalled.tsx';
import { Overview } from './screens/Overview.tsx';
import { Settings } from './screens/Settings.tsx';
import { Updates } from './screens/Updates.tsx';

const SCREENS: Record<Screen, ComponentType> = {
  overview: Overview,
  accounts: Accounts,
  approvals: Approvals,
  agent: Agent,
  updates: Updates,
  events: Events,
  doctor: Doctor,
  settings: Settings,
};

/**
 * The app: the install screen when nothing is installed, otherwise the shell and the screen chosen. A deep link opens
 * Approvals.
 */
export function App({ initialScreen = 'overview' }: { initialScreen?: Screen | undefined }) {
  const { installation, deepLink } = useAppData();
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [settingsFirst, setSettingsFirst] = useState(false);

  useEffect(() => {
    if (deepLink !== null) setScreen('approvals');
  }, [deepLink]);

  if (installation.state === 'loading') return <Spinner label={COPY.loading} />;
  if (installation.state === 'error') {
    return (
      <p role="alert" className="text-danger">
        <UntrustedText text={installation.message} />
      </p>
    );
  }
  if (!installation.value.installed) {
    // Nothing is installed: the install screen, and Settings, where the folders the CLI uses can be named.
    if (!settingsFirst) return <NotInstalled onSettings={() => setSettingsFirst(true)} />;
    return (
      <div className="flex flex-col gap-(--cue-space-4) p-(--cue-space-4)">
        <div>
          <Button variant="ghost" onClick={() => setSettingsFirst(false)}>
            {COPY.back}
          </Button>
        </div>
        <Settings />
      </div>
    );
  }
  const Current = SCREENS[screen];
  return (
    <Shell screen={screen} onScreen={setScreen}>
      <Current />
    </Shell>
  );
}
