import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriBridge } from '../ipc.ts';
import { createFakeBridge, type FakeBridge } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/*
 * Quitting while a service the app started runs (plan P3, Review Focus 5). Rust shows and focuses the window and emits
 * `quit-requested`; the window asks, in cue-ui's AlertDialog, and Rust quits on the answer. A second Quit while it asks
 * must not show a second question, and an answer is sent once however often it is pressed.
 */

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  listen: vi.fn(
    async (..._args: unknown[]) =>
      () =>
        undefined,
  ),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

const TITLE = 'Keep the event service running?';
const BODY = 'It keeps watching your accounts after Agent Comms quits.';

const answers = (bridge: FakeBridge) => bridge.calls.filter((call) => call.command === 'answerQuit');

/** The app on `screen`, once it has read what it shares, with Quit pressed `times` times. */
async function quitPressed(bridge: FakeBridge, times: number): Promise<HTMLElement> {
  await screen.findByRole('heading', { level: 1 });
  await act(async () => {
    for (let pressed = 0; pressed < times; pressed += 1) bridge.emit('quit-requested', null);
  });
  return screen.findByRole('alertdialog', { name: TITLE });
}

describe('Quit', () => {
  it('quit-requested twice shows one dialog; Keep running calls answerQuit(true, remember)', async () => {
    // The app quits on the answer, so the answer never comes back.
    const bridge = createFakeBridge({ answerQuit: () => new Promise<void>(() => undefined) });
    renderApp(bridge);
    const dialog = await quitPressed(bridge, 2);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(within(dialog).getByText(BODY)).toBeTruthy();
    const remember = within(dialog).getByRole('checkbox', { name: 'Remember my answer' });
    expect(remember.getAttribute('aria-checked')).toBe('false');
    // Keep running is the default: the answer the dialog holds when it opens.
    const keep = within(dialog).getByRole('button', { name: 'Keep running' });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    expect(within(dialog).getByRole('button', { name: 'Stop it' })).toBeTruthy();
    // Nothing is answered until a button is pressed, and a third Quit while it asks changes nothing.
    await act(async () => bridge.emit('quit-requested', null));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(answers(bridge)).toEqual([]);

    fireEvent.click(keep);
    fireEvent.click(keep);
    await waitFor(() => expect(answers(bridge)).toEqual([{ command: 'answerQuit', args: [true, false] }]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop it' }));
    expect(answers(bridge)).toHaveLength(1);
  });

  it('Stop it with Remember my answer calls answerQuit(false, true)', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'events' });
    const dialog = await quitPressed(bridge, 1);
    const remember = within(dialog).getByRole('checkbox', { name: 'Remember my answer' });
    fireEvent.click(remember);
    await waitFor(() => expect(remember.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop it' }));
    await waitFor(() => expect(answers(bridge)).toEqual([{ command: 'answerQuit', args: [false, true] }]));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('Escape does not dismiss the question, and an answer that fails says why and can be given again', async () => {
    let refuse = true;
    const bridge = createFakeBridge({
      answerQuit: async () => {
        if (refuse) throw { code: 'APP_IO', message: 'the event service could not be stopped' };
      },
    });
    renderApp(bridge);
    const dialog = await quitPressed(bridge, 1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: TITLE })).toBeTruthy();
    expect(answers(bridge)).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop it' }));
    expect(await within(dialog).findByText('the event service could not be stopped')).toBeTruthy();
    refuse = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }));
    await waitFor(() =>
      expect(answers(bridge).map((call) => call.args)).toEqual([
        [false, false],
        [true, false],
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});

describe("the bridge to Task 2's supervisor", () => {
  beforeEach(() => {
    invoke.mockClear();
    listen.mockClear();
  });

  it('invokes each command by its Rust name, with its arguments named as Rust names them', async () => {
    await tauriBridge.eventServiceState();
    await tauriBridge.setEventService(false);
    await tauriBridge.eventServiceRetry();
    await tauriBridge.restartEventService();
    await tauriBridge.answerFirstStart(true);
    await tauriBridge.openFullDiskAccess();
    await tauriBridge.answerQuit(false, true);
    expect(invoke.mock.calls).toEqual([
      ['event_service_state'],
      ['set_event_service', { on: false }],
      ['event_service_retry'],
      ['restart_event_service'],
      ['answer_first_start', { start: true }],
      ['open_full_disk_access'],
      ['answer_quit', { keep: false, remember: true }],
    ]);
  });

  it('listens for the two events by their names', async () => {
    await tauriBridge.on('event-service:changed', () => undefined);
    await tauriBridge.on('quit-requested', () => undefined);
    expect(listen.mock.calls.map(([event]) => event)).toEqual(['event-service:changed', 'quit-requested']);
  });
});
