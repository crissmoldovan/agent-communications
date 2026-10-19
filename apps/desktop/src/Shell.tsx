import { AppShell, Sidebar } from '@cueplusplus/ui';
import { Activity, Bot, CheckCheck, LayoutDashboard, RefreshCw, Settings, Stethoscope, Users } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { AppearanceMenu } from './components/AppearanceMenu.tsx';
import { COPY, type Screen, SECTIONS, SETTINGS } from './copy.ts';
import { isMac } from './platform.ts';

const ICONS: Record<Screen, ComponentType> = {
  overview: LayoutDashboard,
  accounts: Users,
  approvals: CheckCheck,
  agent: Bot,
  updates: RefreshCw,
  events: Activity,
  doctor: Stethoscope,
  settings: Settings,
};

/**
 * Supbuddy's shell (DA2, DA3): a header that drags the window, holding the appearance menu, and a sidebar of the seven
 * sections with Settings at its foot. On macOS the header leaves the traffic lights their room.
 */
export function Shell({
  screen,
  onScreen,
  mac = isMac(),
  children,
}: {
  screen: Screen;
  onScreen: (screen: Screen) => void;
  mac?: boolean;
  children: ReactNode;
}) {
  const item = (target: Screen, label: string) => (
    <Sidebar.Item key={target} icon={ICONS[target]} active={screen === target} onClick={() => onScreen(target)}>
      {label}
    </Sidebar.Item>
  );
  return (
    <AppShell.Root className={mac ? 'app-macos' : undefined}>
      <AppShell.Bar
        platformDrag
        className="app-titlebar"
        brandClassName="app-titlebar-brand"
        brand={<span className="text-fg">{COPY.appName}</span>}
        actions={<AppearanceMenu />}
      />
      <AppShell.Body>
        <AppShell.Sidebar aria-label="Sections" drawerTitle="Sections" collapsible={false}>
          <Sidebar.Section>{SECTIONS.map(({ screen: target, label }) => item(target, label))}</Sidebar.Section>
          <Sidebar.Section className="mt-auto">{item(SETTINGS.screen, SETTINGS.label)}</Sidebar.Section>
        </AppShell.Sidebar>
        <AppShell.Content>
          <AppShell.Scroller>{children}</AppShell.Scroller>
        </AppShell.Content>
      </AppShell.Body>
    </AppShell.Root>
  );
}
