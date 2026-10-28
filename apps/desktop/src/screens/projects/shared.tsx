/**
 * What Projects and Add a project… share (workflows design §8.1): their words, and the document `project add -` and
 * `project update -` take.
 */
import type { ReactNode } from 'react';
import type { JsonDocument } from '../../ipc.ts';
import type { ProjectHintsV1, ProjectV1 } from '../../workflows/types.ts';

export const PROJECTS_COPY = {
  title: 'Projects',
  about:
    'The code you work on, where it is on this Mac, and the sessions working in it. A workflow’s Which project? step chooses among them, by your hints first, then by its judge reading each profile.',
  needsService: 'Projects need the event service.',
  add: 'Add a project…',
  empty: 'No project yet. Add one from the checkouts on this Mac.',
  unreadable: 'The projects could not be read.',
  added: (name: string) => `Added ${name}. A workflow’s Which project? step can choose it once its approval names it.`,
  onThisMac: 'On this Mac',
  kinds: { checkout: 'checkout', worktree: 'worktree' },
  defaultBranch: (branch: string) => `starts worktrees from ${branch}`,
  worktreesIn: (folder: string) => `worktrees go in ${folder}`,
  sessions: 'Sessions working in it',
  noSessions: 'No agent window has worked in it today.',
  sessionsUnreadable: 'The agent windows could not be read.',
  lastActive: 'last active',
  relaySessions: 'In claude-stream now',
  sessionStates: { busy: 'busy', idle: 'idle', watched: 'watched' },
  relayUnreadable: (reason: string) => `claude-stream could not be asked (${reason}).`,
  relayWhere:
    'The claude-stream sessions working now in one of its folders, or in a worktree a workflow made: busy while a turn runs.',
  sessionsWhere:
    'The agent windows that used Agent Comms in one of its folders in the last 24 hours, as the activity log saw them.',
  profile: 'What Agent Comms knows about it',
  profileEmpty: 'No profile yet. A judge choosing a project reads this; your hints choose without one.',
  profileBy: (day: ReactNode) => <>Written by you on {day}.</>,
  profileLimit: 'Your words: what the project is, and who asks about it. At most 2,000 characters.',
  profileTooLong: 'At most 2,000 characters.',
  hints: 'Hints',
  hintsAbout: 'A message with one of these goes to this project without asking a judge.',
  hintWords: {
    senderDomains: 'Sender domains',
    slackConversations: 'Slack conversations',
    people: 'People',
  } satisfies Record<keyof ProjectHintsV1, string>,
  hintExamples: {
    senderDomains: 'acme.example',
    slackConversations: 'C0123ABCD',
    people: 'U0123ABCD or jo@acme.example',
  } satisfies Record<keyof ProjectHintsV1, string>,
  noHints: 'None',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  saved: 'Saved. It applies at once.',
  remove: 'Remove…',
  removeTitle: (name: string) => `Remove ${name}?`,
  removeBody:
    'It goes from this list at once. A workflow whose approval names it keeps those folders until you change the workflow; nothing in the folders is touched.',
  removeAction: 'Remove',
} as const;

/** A profile is at most 2,000 characters (spec §8.2). */
export const PROFILE_MAX = 2_000;
/** The three hint lists, in the order a card shows them. */
export const HINT_KEYS = ['senderDomains', 'slackConversations', 'people'] as const;

/** What `project add -` and `project update -` take: the project without the fields the event service sets. */
export function projectDocument(project: Omit<ProjectV1, 'profileBy' | 'profileAt' | 'createdAt' | 'updatedAt'>) {
  return {
    projectId: project.projectId,
    name: project.name,
    repo: project.repo,
    profile: project.profile,
    hints: project.hints,
    folders: project.folders,
  } satisfies JsonDocument;
}
