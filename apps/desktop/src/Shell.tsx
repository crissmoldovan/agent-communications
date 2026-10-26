import { AppShell, Sidebar } from '@cueplusplus/ui';
import {
  Activity,
  Bot,
  CheckCheck,
  History,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  Plug,
  RefreshCw,
  Settings,
  Stethoscope,
  Users,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { TEST_BUILD_COPY, useAppBuild } from './app-build.ts';
import { AppearanceMenu } from './components/AppearanceMenu.tsx';
import { NewTag } from './components/NewTag.tsx';
import { QueueBadge } from './components/QueueBadge.tsx';
import { TestBuildBand, TestProfile } from './components/TestBuild.tsx';
import { COPY, type Screen, SECTIONS, SETTINGS } from './copy.ts';
import { useAppData } from './data.tsx';
import { isMac } from './platform.ts';

const ICONS: Record<Screen, ComponentType> = {
  overview: LayoutDashboard,
  queue: Inbox,
  messages: MessagesSquare,
  accounts: Users,
  connections: Plug,
  approvals: CheckCheck,
  activity: History,
  agent: Bot,
  updates: RefreshCw,
  events: Activity,
  doctor: Stethoscope,
  settings: Settings,
};

/**
 * Supbuddy's shell (DA2, DA3): a header that drags the window, holding the appearance menu, and a sidebar of the
 * sections with Settings at its foot, Queue's with its open count and a new section's with a New tag. On macOS the
 * header leaves the traffic lights their room.
 *
 * The redesign's frame (the desktop design, D3 and §9): the header is no bar of its own but the top of the two columns
 * under it, the brand over the sidebar's ground and the menu over the page's, and text the screens leave unsized is the
 * rung's body size. Each is a token, so every theme paints it in its own colours.
 *
 * The local test build (0.32.0, spec §3.7) is told apart: an orange band across the top, which then holds the traffic
 * lights; the brand Agent Comms Test with an orange chip and a stripe down the sidebar; and the test profile's folder
 * at the sidebar's foot. A release build, or one that cannot say which it is, shows none of them.
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
  const build = useAppBuild();
  const test = build?.isTest === true ? build : null;
  const { installation } = useAppData();
  const installed = installation.state === 'ready' ? installation.value : null;
  const item = (target: Screen, label: string, isNew?: true) => (
    <Sidebar.Item
      key={target}
      icon={ICONS[target]}
      active={screen === target}
      onClick={() => onScreen(target)}
      // The queue's open count, once there is one (0.30.0), and a section new in this release's "New" (0.32.0).
      {...(target === 'queue' ? { badge: <QueueBadge /> } : isNew ? { badge: <NewTag /> } : {})}
    >
      {label}
    </Sidebar.Item>
  );
  return (
    <AppShell.Root className={mac ? 'app-macos text-(length:--cue-text-body)' : 'text-(length:--cue-text-body)'}>
      {test === null ? null : <TestBuildBand build={test} mac={mac} />}
      <AppShell.Bar
        platformDrag
        className="app-titlebar bg-bg"
        // Under a test build's band the traffic lights sit on the band, so the brand needs no room for them.
        brandClassName={test === null ? 'app-titlebar-brand bg-sunken' : 'bg-sunken'}
        brand={
          <span className="flex min-w-0 items-center gap-(--cue-space-3)">
            <span
              aria-hidden="true"
              data-slot="brand-chip"
              className={
                test === null
                  ? 'flex size-chip shrink-0 items-center justify-center rounded-control bg-accent font-semibold text-(length:--cue-text-ui) text-accent-fg'
                  : 'flex size-chip shrink-0 items-center justify-center rounded-control bg-warn font-semibold text-(length:--cue-text-ui) text-warn-fg'
              }
            >
              {test === null ? 'A' : TEST_BUILD_COPY.chip}
            </span>
            <span className="truncate font-semibold text-fg">
              {test === null ? COPY.appName : TEST_BUILD_COPY.appName}
            </span>
          </span>
        }
        actions={<AppearanceMenu />}
      />
      <AppShell.Body>
        <AppShell.Sidebar
          aria-label="Sections"
          drawerTitle="Sections"
          collapsible={false}
          className={test === null ? 'bg-sunken' : 'bg-sunken shadow-[inset_3px_0_0_var(--cue-warn)]'}
        >
          <Sidebar.Section>
            {SECTIONS.map(({ screen: target, label, isNew }) => item(target, label, isNew))}
          </Sidebar.Section>
          <Sidebar.Section className="mt-auto">
            {item(SETTINGS.screen, SETTINGS.label)}
            {test === null || installed === null ? null : (
              <TestProfile folders={installed.folders} home={installed.home} />
            )}
          </Sidebar.Section>
        </AppShell.Sidebar>
        <AppShell.Content>
          <AppShell.Scroller>{children}</AppShell.Scroller>
        </AppShell.Content>
      </AppShell.Body>
    </AppShell.Root>
  );
}
