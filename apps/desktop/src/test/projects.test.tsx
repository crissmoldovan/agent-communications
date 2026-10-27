/*
 * Projects (0.36.0, plan F2, spec §8, §11.2): the repositories found on this Mac, their folders, the agent windows
 * working in them, a profile and hints, the person's alone. Add a project… scans, groups the checkouts by repository,
 * and adds the folders ticked; the profile and the hints change at once; Remove asks first. Projects need the event
 * service, from 0.36.0. Every answer is a fixture; nothing scans a real disk.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call, Installation } from '../ipc.ts';
import { foldTypedRepo } from '../screens/projects/AddProject.tsx';
import {
  cliKinds,
  createFakeBridge,
  EXAMPLE_INSTALLATION,
  type FakeBridge,
  type Fixture,
  RECENT_SESSIONS,
} from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/** Every product at 0.36.0: core with the activity log, and the event service with projects. */
const INSTALLATION: Installation = { ...EXAMPLE_INSTALLATION, version: '0.36.0' };

function bridgeAt(events: string, fixtures: Partial<Record<Call['kind'], Fixture>> = {}, installation = INSTALLATION) {
  return createFakeBridge(
    { installation: async () => installation },
    {
      version: (call: Call) => (call.kind === 'version' && call.product === 'events-daemon' ? events : '0.36.0'),
      activitySessions: RECENT_SESSIONS,
      ...fixtures,
    },
  );
}

const callsOf = (bridge: FakeBridge, kind: Call['kind']): Call[] =>
  bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === kind)
    .map((call) => call.args as Call);

async function projectCard(name: string): Promise<HTMLElement> {
  return screen.findByRole('region', { name: `Project ${name}` });
}

describe('Projects', () => {
  it('lists each project with its folders, its profile and its hints', async () => {
    renderApp(bridgeAt('0.36.0'), { screen: 'projects' });
    const card = await projectCard('acme-site');
    expect(card.textContent).toContain('github.com/example/acme-site');
    const folders = within(card).getByRole('region', { name: 'On this Mac' });
    expect(folders.textContent).toContain('~/work/acme-site');
    expect(folders.textContent).toContain(
      'checkout · starts worktrees from main · worktrees go in ~/work/acme-site-wt',
    );
    expect(folders.textContent).toContain('~/work/acme-site-wt/ac-acme-123');
    expect(card.querySelector('[data-slot="project-profile"]')?.textContent).toBe(
      'The Acme site: its pages and its booking form.',
    );
    const hints = within(card).getByRole('region', { name: 'Hints' });
    expect(hints.querySelector('[data-hints="senderDomains"]')?.textContent).toContain('acme.example');
    expect(hints.querySelector('[data-hints="slackConversations"]')?.textContent).toContain('C0123ABCD');
    expect(hints.querySelector('[data-hints="people"]')?.textContent).toContain('@jo');
  });

  it('the sessions working in each project, and when each was last active', async () => {
    renderApp(bridgeAt('0.36.0'), { screen: 'projects' });
    const card = await projectCard('acme-site');
    const sessions = await within(card).findByRole('region', { name: 'Sessions working in it' });
    await waitFor(() => expect(sessions.querySelector('[data-window="3f9a1c2e7b4d5a60"]')).not.toBeNull());
    const window = sessions.querySelector<HTMLElement>('[data-window="3f9a1c2e7b4d5a60"]') as HTMLElement;
    expect(window.textContent).toContain('~/work/acme-site');
    expect(window.textContent).toContain('claude-code');
    expect(window.textContent).toContain('last active');
    // A window in another project's folder, or in the home itself, is not one of acme-site's.
    expect(sessions.querySelector('[data-window="7c1e5b9a0d2f4e68"]')).toBeNull();
    expect(sessions.querySelector('[data-window="0c0ffee000000001"]')).toBeNull();
  });

  it('Add a project… scans, groups by repository, and adds the ticked folders', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'projects' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a project…' }));
    const page = await screen.findByRole('region', { name: 'Add a project' });
    // The scan starts from the event service's own roots: the app names none.
    await waitFor(() =>
      expect(callsOf(bridge, 'eventsProjectScan')).toEqual([{ kind: 'eventsProjectScan', roots: [] }]),
    );
    const repos = await within(page).findByRole('radiogroup', { name: 'Its repository' });
    expect(page.textContent).toContain('Looked in ~/work, ~/code for checkouts of a GitHub repository.');
    // Grouped by repository: one already a project, and one with a checkout and its worktree.
    const known = within(repos).getByRole('radio', { name: /github\.com\/example\/acme-site/ });
    expect(known.hasAttribute('data-disabled') || known.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(repos.textContent).toContain('Already the project acme-site');
    const billing = within(repos).getByRole('radio', { name: /github\.com\/example\/billing-tool/ });
    expect(repos.textContent).toContain('2 folders');
    fireEvent.click(billing);
    const folders = await within(page).findByRole('region', { name: 'Its folders on this Mac' });
    const boxes = within(folders).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    // Untick the worktree: only the checkout goes in.
    fireEvent.click(boxes[1] as HTMLElement);
    const profile = within(page).getByRole('textbox', { name: 'What Agent Comms knows about it' });
    fireEvent.change(profile, { target: { value: 'Makes the monthly invoices.' } });
    const add = within(page).getByRole('button', { name: 'Add the project' }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(callsOf(bridge, 'eventsProjectAdd')).toHaveLength(1));
    expect(callsOf(bridge, 'eventsProjectAdd')[0]).toEqual({
      kind: 'eventsProjectAdd',
      document: {
        projectId: 'billing-tool',
        name: 'billing-tool',
        repo: 'github.com/example/billing-tool',
        profile: 'Makes the monthly invoices.',
        hints: { senderDomains: [], slackConversations: [], people: [] },
        folders: [
          { folder: '/example/home/code/billing-tool', kind: 'checkout', defaultBranch: 'main', worktreeRoot: null },
        ],
      },
    });
    // Back on the list, which is read again.
    expect(await screen.findByText(/^Added billing-tool\./)).toBeTruthy();
    await waitFor(() => expect(callsOf(bridge, 'eventsProjectsList').length).toBeGreaterThanOrEqual(2));
  });

  it('a typed owner/name with no checkout found says so', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'projects' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add a project…' }));
    const page = await screen.findByRole('region', { name: 'Add a project' });
    await within(page).findByRole('radiogroup', { name: 'Its repository' });
    const typed = within(page).getByRole('textbox', { name: 'Or type its name on GitHub' });
    fireEvent.change(typed, { target: { value: 'example/booking-app' } });
    expect((await within(page).findByRole('status')).textContent).toBe(
      'No checkout of github.com/example/booking-app was found on this Mac. Clone it first, or look in the folder it is in.',
    );
    expect((within(page).getByRole('button', { name: 'Add the project' }) as HTMLButtonElement).disabled).toBe(true);
    // A repository it found, typed in any of its forms, is chosen as if picked.
    fireEvent.change(typed, { target: { value: 'https://github.com/Example/Billing-Tool.git' } });
    expect(await within(page).findByRole('region', { name: 'Its folders on this Mac' })).toBeTruthy();
    expect(callsOf(bridge, 'eventsProjectAdd')).toEqual([]);
  });

  it('typed names fold to github.com/owner/name, and anything else is refused', () => {
    expect(foldTypedRepo('acme/site')).toBe('github.com/acme/site');
    expect(foldTypedRepo(' github.com/Acme/Site/ ')).toBe('github.com/acme/site');
    expect(foldTypedRepo('https://github.com/acme/site.git')).toBe('github.com/acme/site');
    for (const bad of ['acme', 'acme/site/more', 'git@gitlab.com:acme/site', '/acme/site', 'acme/..', '-acme/site'])
      expect(foldTypedRepo(bad), bad).toBeNull();
  });

  it('the profile and the hints change at once, as a whole document', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'projects' });
    const card = await projectCard('acme-site');
    const profile = within(card).getByRole('region', { name: 'What Agent Comms knows about it' });
    fireEvent.click(within(profile).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(profile).getByRole('textbox'), { target: { value: 'The Acme site and its invoices.' } });
    fireEvent.click(within(profile).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsOf(bridge, 'eventsProjectUpdate')).toHaveLength(1));
    const document = (callsOf(bridge, 'eventsProjectUpdate')[0] as Extract<Call, { kind: 'eventsProjectUpdate' }>)
      .document;
    expect(document).toEqual({
      projectId: 'acme-site',
      name: 'acme-site',
      repo: 'github.com/example/acme-site',
      profile: 'The Acme site and its invoices.',
      hints: { senderDomains: ['acme.example'], slackConversations: ['C0123ABCD'], people: ['@jo'] },
      folders: [
        {
          folder: '/example/home/work/acme-site',
          kind: 'checkout',
          defaultBranch: 'main',
          worktreeRoot: '/example/home/work/acme-site-wt',
        },
        {
          folder: '/example/home/work/acme-site-wt/ac-acme-123',
          kind: 'worktree',
          defaultBranch: null,
          worktreeRoot: null,
        },
      ],
    });
    expect(await within(profile).findByText('Saved. It applies at once.')).toBeTruthy();
    // A profile past 2,000 characters is refused before anything is asked.
    fireEvent.click(within(profile).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(profile).getByRole('textbox'), { target: { value: 'x'.repeat(2_001) } });
    expect((within(profile).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Remove asks first, then removes at once', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'projects' });
    const card = await projectCard('acme-site');
    fireEvent.click(within(card).getByRole('button', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(callsOf(bridge, 'eventsProjectRemove')).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(callsOf(bridge, 'eventsProjectRemove')).toEqual([{ kind: 'eventsProjectRemove', projectId: 'acme-site' }]),
    );
  });

  it('without the event service the screen says Projects need the event service', async () => {
    const bridge = bridgeAt('0.36.0', {}, { ...INSTALLATION, present: ['core', 'gmail', 'slack'] });
    renderApp(bridge, { screen: 'projects' });
    expect(await screen.findByText('Projects need the event service.')).toBeTruthy();
    expect(cliKinds(bridge).filter((kind) => kind.startsWith('eventsProject'))).toEqual([]);
  });

  it('Projects needs 0.36.0', async () => {
    const bridge = bridgeAt('0.35.0');
    renderApp(bridge, { screen: 'projects' });
    expect(await screen.findByText('Needs 0.36.0 or later; this machine has 0.35.0.')).toBeTruthy();
    expect(cliKinds(bridge).filter((kind) => kind.startsWith('eventsProject'))).toEqual([]);
  });
});
