import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Screen } from '../copy.ts';
import { COPY } from '../copy.ts';
import { GATES, supports } from '../gates.ts';
import { cliKinds, createFakeBridge, EXAMPLE_INSTALLATION } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const LABELS: Record<Screen, string> = {
  overview: 'Overview',
  queue: 'Queue',
  messages: 'Messages New',
  accounts: 'Accounts',
  // Its button's name, with its "New" tag (0.32.0).
  connections: 'Connections New',
  approvals: 'Approvals',
  activity: 'Activity',
  agent: 'Your agents',
  updates: 'Updates',
  events: 'Events',
  doctor: 'Doctor',
  settings: 'Settings',
};

async function open(screenName: Screen): Promise<HTMLElement> {
  const navigation = screen.getByRole('navigation', { name: 'Sections' });
  fireEvent.click(within(navigation).getByRole('button', { name: LABELS[screenName] }));
  await advance(0);
  return screen.getByRole('main');
}

describe('what each CLI version supports', () => {
  it('a feature is there from the version that brings it', () => {
    expect(GATES).toEqual({
      behaviour: '0.22.0',
      profiles: '0.22.0',
      standing: '0.23.0',
      updateStatus: '0.24.0',
      layaJudge: '0.25.0',
      judges: '0.17.0',
      activity: '0.29.0',
      queue: '0.30.0',
      lanes: '0.31.0',
      judgeSetup: '0.32.0',
      messages: '0.32.0',
      ruleEditor: '0.33.0',
      labelChanges: '0.34.0',
    });
    // Judge setup and AI provider keys are the event service's from 0.32.0, a pull request's build of it included.
    expect(supports('0.31.0', 'judgeSetup')).toBe(false);
    expect(supports('0.32.0', 'judgeSetup')).toBe(true);
    expect(supports('0.32.0-feat-0.32-judges', 'judgeSetup')).toBe(true);
    // Messages reads core's activity by message and the event service's messages, each from 0.32.0.
    expect(supports('0.31.0', 'messages')).toBe(false);
    expect(supports('0.32.0', 'messages')).toBe(true);
    expect(supports('0.32.0-feat-0.32', 'messages')).toBe(true);
    // Lanes are the event service's from 0.31.0, read from its own version, a pull request's build of it included.
    expect(supports('0.30.0', 'lanes')).toBe(false);
    expect(supports('0.30.9', 'lanes')).toBe(false);
    expect(supports('0.31.0', 'lanes')).toBe(true);
    expect(supports('0.31.0-feat-0.31', 'lanes')).toBe(true);
    expect(supports(null, 'lanes')).toBe(false);
    // The queue is the event service's from 0.30.0, read from its own version, a pull request's build of it included.
    expect(supports('0.29.0', 'queue')).toBe(false);
    expect(supports('0.29.9', 'queue')).toBe(false);
    expect(supports('0.30.0', 'queue')).toBe(true);
    expect(supports('0.30.0-feat-0.30', 'queue')).toBe(true);
    expect(supports(null, 'queue')).toBe(false);
    // The activity log is core's from 0.29.0, a pull request's build of it included.
    expect(supports('0.28.0', 'activity')).toBe(false);
    expect(supports('0.29.0', 'activity')).toBe(true);
    expect(supports('0.29.0-feat-0.29', 'activity')).toBe(true);
    // The Judges section reads the events service's own version: 0.17.0 is the first with judges at all.
    expect(supports('0.16.0', 'judges')).toBe(false);
    expect(supports('0.17.0', 'judges')).toBe(true);
    expect(supports('0.21.0', 'behaviour')).toBe(false);
    expect(supports('0.22.0', 'behaviour')).toBe(true);
    expect(supports('0.22.0', 'profiles')).toBe(true);
    expect(supports('0.22.9', 'standing')).toBe(false);
    expect(supports('0.23.0', 'standing')).toBe(true);
    expect(supports('0.23.5', 'updateStatus')).toBe(false);
    expect(supports('0.24.0', 'updateStatus')).toBe(true);
    expect(supports('1.0.0', 'updateStatus')).toBe(true);
    // A pull request's build of the release that brings it has it too.
    expect(supports('0.24.0-feat-desktop', 'updateStatus')).toBe(true);
    // A version that cannot be read has nothing.
    for (const installed of [null, '', '0.24', 'v0.24.0', 'latest']) {
      expect(supports(installed, 'behaviour')).toBe(false);
    }
  });
});

describe('the gated sections', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 0.21.0 CLI gets the update line in every gated section and none of their calls', async () => {
    const bridge = createFakeBridge({ installation: async () => ({ ...EXAMPLE_INSTALLATION, version: '0.21.0' }) });
    renderApp(bridge);
    await advance(0);
    const expectations: [Screen, string[]][] = [
      [
        'overview',
        ['Needs 0.24.0 or later; this machine has 0.21.0.', 'Needs 0.23.0 or later; this machine has 0.21.0.'],
      ],
      ['accounts', ['Needs 0.22.0 or later; this machine has 0.21.0.']],
      // Your agents shows the label read-only before 0.34.0, and reads nothing behaviour needs before 0.22.0.
      ['agent', ['Needs 0.34.0 or later; this machine has 0.21.0.']],
      ['updates', ['Needs 0.24.0 or later; this machine has 0.21.0.']],
      ['activity', ['Needs 0.29.0 or later; this machine has 0.21.0.']],
      // The queue is gated on the events service's own version, which the fake bridge gives as 0.24.0.
      ['queue', ['Needs 0.30.0 or later; this machine has 0.24.0.']],
    ];
    for (const [name, lines] of expectations) {
      const main = await open(name);
      expect(within(main).getAllByText(COPY.updateToUse)).toHaveLength(lines.length);
      for (const line of lines) expect(within(main).getByText(line)).toBeTruthy();
    }
    // Every screen visited, and a minute of polling: none of the gated calls ran.
    await advance(60_000);
    const gated = [
      'behaviour',
      'behaviourAllow',
      'behaviourClear',
      'profileView',
      'profileInit',
      'standingList',
      'standingRevoke',
      'standingOff',
      'updateStatus',
      'activitySessions',
      'activityShow',
      'queueList',
      'queueCounts',
      'queueDone',
      'queueDismiss',
      'queueReopen',
      'queueClear',
      'labelWord',
      'labelName',
      'labelRuleAdd',
      'labelRuleRemove',
    ];
    expect(cliKinds(bridge).filter((kind) => gated.includes(kind))).toEqual([]);
    // The ungated reads still ran.
    expect(cliKinds(bridge)).toContain('approvalsPending');
  });

  it('a 0.24.0 CLI gets no update line anywhere, and its update status is polled', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge);
    await advance(0);
    // Your agents changes the label from 0.34.0 (`your-agents.test.tsx`): before it, its update line is the one there.
    for (const name of ['overview', 'accounts', 'updates'] as const) {
      const main = await open(name);
      expect(within(main).queryByText(COPY.updateToUse)).toBeNull();
    }
    expect(cliKinds(bridge)).toContain('updateStatus');
  });

  it('a version that cannot be read is treated as too old, and says so', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, version: null, problem: 'core printed no version' }),
    });
    renderApp(bridge);
    await advance(0);
    const main = await open('updates');
    expect(
      within(main).getByText('Needs 0.24.0 or later; this machine has a version the app could not read.'),
    ).toBeTruthy();
    expect(cliKinds(bridge)).not.toContain('updateStatus');
  });
});
