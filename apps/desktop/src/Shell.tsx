import { AppShell, Sidebar } from '@cueplusplus/ui';
import {
  Activity,
  Bot,
  CheckCheck,
  History,
  LayoutDashboard,
  RefreshCw,
  Settings,
  Stethoscope,
  Users,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { AppearanceMenu } from './components/AppearanceMenu.tsx';
import { COPY, type Screen, SECTIONS, SETTINGS } from './copy.ts';
import { isMac } from './platform.ts';

const ICONS: Record<Screen, ComponentType> = {
  overview: LayoutDashboard,
  accounts: Users,
  approvals: CheckCheck,
  activity: History,
  agent: Bot,
  updates: RefreshCw,
  events: Activity,
  doctor: Stethoscope,
  settings: Settings,
};

/**
 * Supbuddy's shell (DA2, DA3): a header that drags the window, holding the appearance menu, and a sidebar of the eight
 * sections with Settings at its foot. On macOS the header leaves the traffic lights their room.
 *
 * The redesign's frame (the desktop design, D3 and §9): the header is no bar of its own but the top of the two columns
 * under it, the brand over the sidebar's ground and the menu over the page's, and text the screens leave unsized is the
 * rung's body size. Each is a token, so every theme paints it in its own colours.
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
    <AppShell.Root className={mac ? 'app-macos text-(length:--cue-text-body)' : 'text-(length:--cue-text-body)'}>
      <AppShell.Bar
        platformDrag
        className="app-titlebar bg-bg"
        brandClassName="app-titlebar-brand bg-sunken"
        brand={
          <span className="flex min-w-0 items-center gap-(--cue-space-3)">
            <span
              aria-hidden="true"
              className="flex size-chip shrink-0 items-center justify-center rounded-control bg-accent font-semibold text-(length:--cue-text-ui) text-accent-fg"
            >
              A
            </span>
            <span className="truncate font-semibold text-fg">{COPY.appName}</span>
          </span>
        }
        actions={<AppearanceMenu />}
      />
      <AppShell.Body>
        <AppShell.Sidebar aria-label="Sections" drawerTitle="Sections" collapsible={false} className="bg-sunken">
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
