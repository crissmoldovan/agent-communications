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
  accounts: 'Accounts',
  approvals: 'Approvals',
  agent: 'Agent',
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
    });
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
      ['agent', ['Needs 0.22.0 or later; this machine has 0.21.0.', 'Needs 0.23.0 or later; this machine has 0.21.0.']],
      ['updates', ['Needs 0.24.0 or later; this machine has 0.21.0.']],
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
    ];
    expect(cliKinds(bridge).filter((kind) => gated.includes(kind))).toEqual([]);
    // The ungated reads still ran.
    expect(cliKinds(bridge)).toContain('approvalsPending');
  });

  it('a 0.24.0 CLI gets no update line anywhere, and its update status is polled', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge);
    await advance(0);
    for (const name of ['overview', 'accounts', 'agent', 'updates'] as const) {
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
