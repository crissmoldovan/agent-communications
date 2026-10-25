/**
 * The words the app shows: its sections, and the lines and buttons more than one screen uses (plan, Global
 * Constraints). A screen's own sentences live with the screen.
 */

/** The app's screens: the nine sections, then Settings. */
export type Screen =
  | 'overview'
  | 'queue'
  | 'accounts'
  | 'approvals'
  | 'activity'
  | 'agent'
  | 'updates'
  | 'events'
  | 'doctor'
  | 'settings';

/**
 * The nine sections in the sidebar's order (DA3; Queue, 0.30.0, first after Overview; Activity, 0.29.0, between
 * Approvals and Agent), then Settings.
 */
export const SECTIONS: readonly { screen: Exclude<Screen, 'settings'>; label: string }[] = [
  { screen: 'overview', label: 'Overview' },
  { screen: 'queue', label: 'Queue' },
  { screen: 'accounts', label: 'Accounts' },
  { screen: 'approvals', label: 'Approvals' },
  { screen: 'activity', label: 'Activity' },
  { screen: 'agent', label: 'Agent' },
  { screen: 'updates', label: 'Updates' },
  { screen: 'events', label: 'Events' },
  { screen: 'doctor', label: 'Doctor' },
];

export const SETTINGS = { screen: 'settings', label: 'Settings' } as const;

/** Every screen's label. */
export const SCREEN_LABELS: Readonly<Record<Screen, string>> = {
  ...(Object.fromEntries(SECTIONS.map(({ screen, label }) => [screen, label])) as Record<
    Exclude<Screen, 'settings'>,
    string
  >),
  settings: SETTINGS.label,
};

export const COPY = {
  appName: 'Agent Comms',
  approveThisInTerminal: 'Approve this in Terminal',
  approveInTerminal: 'Approve in Terminal',
  runInTerminal: 'Run in Terminal',
  revoke: 'Revoke',
  copy: 'Copy',
  copied: 'Copied',
  cancel: 'Cancel',
  updateToUse: 'Update agent-communications to use this',
  endEveryStanding: 'End every standing approval',
  appearance: 'Appearance',
  loading: 'Loading…',
  notInstalled: "agent-communications isn't installed for this user.",
  runThis: 'Run this in a terminal, then come back to this window:',
  foldersElsewhere: 'If you keep its folders elsewhere with AGENT_COMMS_* variables, set the same folders in Settings.',
  openSettings: 'Open Settings',
  back: 'Back',
  noTerminal: 'No terminal app was found. The command is copied: paste it into a terminal.',
  noSafeLine: 'This command cannot be written as one safe line. Its words are copied as JSON.',
  unreadableVersion: 'a version the app could not read',
  fromOutside: 'From outside',
} as const;

/** `Needs <version> or later; this machine has <installed>.` */
export function needsLine(version: string, installed: string | null): string {
  return `Needs ${version} or later; this machine has ${installed ?? COPY.unreadableVersion}.`;
}

/** `Opened in <via>.` */
export function openedLine(via: string): string {
  return `Opened in ${via}.`;
}
