import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '../cli-types.ts';
import { COPY } from '../copy.ts';
import type { Call, CliResult } from '../ipc.ts';
import { cliKinds, createFakeBridge, type FakeBridge, type Fixture, failed } from './fake-bridge.ts';
import updateStatus from './fixtures/update-status.json';
import { renderApp } from './render.tsx';

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const STATUS = updateStatus as UpdateStatus;

/** A change the CLI prepared and holds for the person's approval, as the runner reads `APPROVAL_PENDING`. */
function pending(preview: string): CliResult {
  return { status: 'approvalPending', approvalId: ID, preview, expiresAt: null };
}

/**
 * A fake bridge whose `cli` answers the kinds in `results` with a whole result (a pending approval, a failure, or one
 * that never comes), and every other kind from `fixtures`.
 */
function bridgeWith(
  results: Partial<Record<Call['kind'], CliResult | Promise<CliResult>>>,
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
): FakeBridge {
  const inner = createFakeBridge({}, fixtures);
  return createFakeBridge(
    {
      cli: (call) => {
        const result = results[call.kind];
        return result === undefined ? inner.cli(call) : Promise.resolve(result);
      },
    },
    fixtures,
  );
}

const count = (bridge: FakeBridge, kind: Call['kind']): number =>
  cliKinds(bridge).filter((each) => each === kind).length;

const cliCalls = (bridge: FakeBridge): Call[] =>
  bridge.calls.filter((call) => call.command === 'cli').map((call) => call.args as Call);

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('Updates', () => {
  it('Updates: each state; pause 7 runs updatePause 7; a less frequent level goes to Terminal; Remove applies at once', async () => {
    // Loading: the status has not come yet.
    const waiting = bridgeWith({ updateStatus: new Promise<CliResult>(() => undefined) });
    const first = renderApp(waiting, { screen: 'updates' });
    expect(await within(await screen.findByRole('main')).findByRole('status', { name: COPY.loading })).toBeTruthy();
    first.unmount();

    // An error: what went wrong, as text.
    const broken = bridgeWith({ updateStatus: failed('CONFIG', 'the update record could not be read') });
    const second = renderApp(broken, { screen: 'updates' });
    expect(await screen.findByText('the update record could not be read')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Update level' })).toBeNull();
    second.unmount();

    // Populated, from the fixture: the level set, the versions, the job and its last run.
    let pausedUntil: string | null = null;
    const bridge = bridgeWith(
      { updateLevel: pending('Update less often: every-14-days to never\n<img src=x onerror=alert(1)>') },
      {
        updateStatus: () => ({ ...STATUS, pausedUntil }),
        updatePause: (call: Call) => {
          pausedUntil = '2026-10-26T08:00:00.000Z';
          return { days: (call as Extract<Call, { kind: 'updatePause' }>).days, pausedUntil, security: null };
        },
        updateBackgroundJob: { backgroundJob: 'off', changed: true, where: STATUS.job.where, schedule: null },
      },
    );
    renderApp(bridge, { screen: 'updates' });
    const level = await screen.findByRole('group', { name: 'Update level' });
    const pressed = within(level)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.textContent);
    expect(pressed).toEqual(['Every 14 days']);
    expect(within(region('Versions')).getByText('0.24.1')).toBeTruthy();
    expect(within(region('Versions')).getByText('0.24.0')).toBeTruthy();
    const job = region('Background updates');
    expect(within(job).getByText('set up')).toBeTruthy();
    expect(within(job).getByText(STATUS.job.where ?? '')).toBeTruthy();
    expect(job.querySelector(`time[datetime="${STATUS.job.lastRun}"]`)).not.toBeNull();
    expect(within(region('Pause')).getByText('Update notices are on.')).toBeTruthy();

    // Pause for 7 days: `updatePause` with 7, at once, then the status read again, which shows the pause.
    const reads = count(bridge, 'updateStatus');
    fireEvent.click(within(region('Pause')).getByRole('button', { name: 'Pause for 7 days' }));
    expect(await within(region('Pause')).findByText(/^Update notices are paused until/)).toBeTruthy();
    expect(cliCalls(bridge)).toContainEqual({ kind: 'updatePause', days: 7 });
    expect(count(bridge, 'updateStatus')).toBeGreaterThan(reads);
    expect(region('Pause').querySelector('time[datetime="2026-10-26T08:00:00.000Z"]')).not.toBeNull();
    expect(within(region('Pause')).getByRole('button', { name: 'Resume' })).toBeTruthy();

    // A less frequent level is a loosening: its preview under the app's header, as text, and the button opens the
    // change itself in Terminal, naming the approval Rust revokes first. Nothing is approved here.
    fireEvent.click(within(level).getByRole('button', { name: 'Never' }));
    expect(await within(region('Level')).findByText(COPY.approveThisInTerminal)).toBeTruthy();
    expect(cliCalls(bridge)).toContainEqual({ kind: 'updateLevel', level: 'never' });
    expect(region('Level').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(region('Level').querySelector('img')).toBeNull();
    fireEvent.click(within(region('Level')).getByRole('button', { name: COPY.approveInTerminal }));
    expect(await within(region('Level')).findByText('Opened in Terminal.')).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([
      {
        command: 'openInTerminal',
        args: { kind: 'change', call: { kind: 'updateLevel', level: 'never' }, revoke: ID },
      },
    ]);
    expect(count(bridge, 'approvalRevoke')).toBe(0);

    // Remove applies at once: no preview, no terminal, and the status read again.
    const before = count(bridge, 'updateStatus');
    fireEvent.click(within(region('Background updates')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(count(bridge, 'updateStatus')).toBeGreaterThan(before));
    expect(cliCalls(bridge)).toContainEqual({ kind: 'updateBackgroundJob', on: false });
    expect(within(region('Background updates')).queryByText(COPY.approveThisInTerminal)).toBeNull();
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toHaveLength(1);
  });

  it('a more frequent level applies at once and the status is read again', async () => {
    const bridge = bridgeWith({}, { updateLevel: { level: 'auto', changed: true } });
    renderApp(bridge, { screen: 'updates' });
    const level = await screen.findByRole('group', { name: 'Update level' });
    const before = count(bridge, 'updateStatus');
    fireEvent.click(within(level).getByRole('button', { name: 'Auto' }));
    await waitFor(() => expect(count(bridge, 'updateStatus')).toBeGreaterThan(before));
    expect(cliCalls(bridge)).toContainEqual({ kind: 'updateLevel', level: 'auto' });
    expect(screen.queryByText(COPY.approveThisInTerminal)).toBeNull();
  });

  it('a paused machine says until when, and Resume ends it at once', async () => {
    const bridge = bridgeWith(
      {},
      {
        updateStatus: { ...STATUS, pausedUntil: '2026-10-20T08:00:00.000Z', security: '0.24.2' },
        updateResume: { resumed: true },
      },
    );
    renderApp(bridge, { screen: 'updates' });
    const pause = await screen.findByRole('region', { name: 'Pause' });
    expect(await within(pause).findByText(/^Update notices are paused until/)).toBeTruthy();
    expect(within(pause).getByText(/0\.24\.2/)).toBeTruthy();
    const before = count(bridge, 'updateStatus');
    fireEvent.click(within(pause).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(count(bridge, 'updateStatus')).toBeGreaterThan(before));
    expect(cliCalls(bridge)).toContainEqual({ kind: 'updateResume' });
  });

  it('a level an environment variable or an organisation decides says so', async () => {
    renderApp(
      createFakeBridge({}, { updateStatus: { ...STATUS, level: 'never', set: 'auto', by: 'AGENT_COMMS_UPDATES' } }),
      { screen: 'updates' },
    );
    expect(await screen.findByText('AGENT_COMMS_UPDATES decides the level here: Never.')).toBeTruthy();
  });

  it('the background job: set up goes to Terminal; a system without one offers nothing', async () => {
    const bridge = bridgeWith(
      { updateBackgroundJob: pending('Set up the background update job') },
      {
        updateStatus: {
          ...STATUS,
          level: 'auto',
          set: 'auto',
          job: { state: 'not-set-up', where: null, installedAt: null, lastRun: null, working: null },
        },
      },
    );
    const view = renderApp(bridge, { screen: 'updates' });
    const job = await screen.findByRole('region', { name: 'Background updates' });
    expect(await within(job).findByText('not set up')).toBeTruthy();
    expect(within(job).queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(within(job).getByRole('button', { name: 'Set up background updates' }));
    expect(await within(job).findByText('Set up the background update job')).toBeTruthy();
    expect(cliCalls(bridge)).toContainEqual({ kind: 'updateBackgroundJob', on: true });
    fireEvent.click(within(job).getByRole('button', { name: COPY.approveInTerminal }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([
        {
          command: 'openInTerminal',
          args: { kind: 'change', call: { kind: 'updateBackgroundJob', on: true }, revoke: ID },
        },
      ]),
    );
    view.unmount();

    renderApp(
      createFakeBridge(
        {},
        {
          updateStatus: {
            ...STATUS,
            job: { state: 'unsupported', where: null, installedAt: null, lastRun: null, working: null },
          },
        },
      ),
      { screen: 'updates' },
    );
    const none = await screen.findByRole('region', { name: 'Background updates' });
    expect(await within(none).findByText("Background updates aren't offered on this system.")).toBeTruthy();
    expect(within(none).queryAllByRole('button')).toEqual([]);
  });

  it('a preview replaced by an applied change, or left behind with its screen, revokes its own approval', async () => {
    const OTHER = 'ap_ZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const inner = createFakeBridge({}, { updateLevel: { level: 'auto', changed: true } });
    const bridge = createFakeBridge({
      cli: (call) => {
        if (call.kind === 'updateLevel' && call.level === 'never') return Promise.resolve(pending('Never check'));
        if (call.kind === 'updateRollback') {
          return Promise.resolve({
            status: 'approvalPending',
            approvalId: OTHER,
            preview: 'Roll back',
            expiresAt: null,
          });
        }
        return inner.cli(call);
      },
    });
    const revokes = () => bridge.calls.filter((call) => call.command === 'revokePreview').map((call) => call.args);
    renderApp(bridge, { screen: 'updates' });
    const level = await screen.findByRole('group', { name: 'Update level' });
    fireEvent.click(within(level).getByRole('button', { name: 'Never' }));
    expect(await within(region('Level')).findByText('Never check')).toBeTruthy();
    // Another change in its place, one that applies at once: the preview goes, and its approval with it.
    fireEvent.click(within(level).getByRole('button', { name: 'Auto' }));
    await waitFor(() => expect(within(region('Level')).queryByText('Never check')).toBeNull());
    await waitFor(() => expect(revokes()).toEqual([ID]));

    // A preview left showing when the screen changes: revoked as it goes.
    fireEvent.click(within(region('Rollback')).getByRole('button', { name: 'Roll back to the release before' }));
    expect(await within(region('Rollback')).findByText('Roll back')).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    fireEvent.click(within(navigation).getByRole('button', { name: 'Overview' }));
    await waitFor(() => expect(revokes()).toEqual([ID, OTHER]));
    // Never through a revoke of the app's own choosing, and never approved.
    expect(count(bridge, 'approvalRevoke')).toBe(0);
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([]);
  });

  it('a rollback with nothing to go back to says so, in the words the CLI uses', async () => {
    const bridge = bridgeWith({
      updateRollback: {
        status: 'ok',
        exit: 69,
        data: {
          status: 'nothing',
          steps: [],
          left: [{ channel: 'core', launcher: '/example/launch/core', reason: 'it has no release before' }],
          ok: false,
          next: null,
        },
      },
    });
    renderApp(bridge, { screen: 'updates' });
    const rollback = await screen.findByRole('region', { name: 'Rollback' });
    fireEvent.click(within(rollback).getByRole('button', { name: 'Roll back to the release before' }));
    const said = await within(rollback).findByRole('status');
    expect(said.textContent).toContain('Nothing was changed: no stable launcher here has a release before.');
    expect(said.textContent).toContain('Left as it is: /example/launch/core: it has no release before.');
    expect(within(rollback).queryByText(COPY.approveThisInTerminal)).toBeNull();
  });

  it('rollback goes to Terminal, and a failure says what went wrong', async () => {
    const bridge = bridgeWith({
      updateRollback: pending('Roll back agent-communications from 0.24.0 to 0.23.0'),
      updatePause: failed('UNAVAILABLE', 'the update record is locked', 'Try again in a moment.'),
    });
    renderApp(bridge, { screen: 'updates' });
    const rollback = await screen.findByRole('region', { name: 'Rollback' });
    fireEvent.click(within(rollback).getByRole('button', { name: 'Roll back to the release before' }));
    expect(await within(rollback).findByText('Roll back agent-communications from 0.24.0 to 0.23.0')).toBeTruthy();
    fireEvent.click(within(rollback).getByRole('button', { name: COPY.approveInTerminal }));
    expect(await within(rollback).findByText('Opened in Terminal.')).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([
      { command: 'openInTerminal', args: { kind: 'change', call: { kind: 'updateRollback' }, revoke: ID } },
    ]);

    fireEvent.click(within(region('Pause')).getByRole('button', { name: 'Pause for 1 day' }));
    expect(await within(region('Pause')).findByText('the update record is locked')).toBeTruthy();
    expect(within(region('Pause')).getByText('Try again in a moment.')).toBeTruthy();
    expect(cliCalls(bridge)).toContainEqual({ kind: 'updatePause', days: 1 });
  });
});
