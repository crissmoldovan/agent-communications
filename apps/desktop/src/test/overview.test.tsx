import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Bridge, Call, CliResult } from '../ipc.ts';
import { createFakeBridge, EXAMPLE_INSTALLATION, FIXTURES, type Fixture, failed } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/** A bridge whose CLI reads all wait until `release`, then answer from the fixtures. */
function heldBridge(): { bridge: Bridge; release: () => void } {
  const answers = createFakeBridge();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = createFakeBridge({
    cli: async (call: Call): Promise<CliResult> => {
      await gate;
      return answers.cli(call);
    },
  });
  return { bridge, release };
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

/** The Doctor block's row for a product, by the name it shows. */
function doctorRow(name: string): HTMLElement {
  const row = within(region('Doctor')).getByText(name).closest<HTMLElement>('[data-product]');
  if (row === null) throw new Error(`no doctor row for ${name}`);
  return row;
}

/** The tone of the status dot on a row. */
const toneOf = (row: HTMLElement): string | null =>
  row.querySelector('[role="status"][data-tone]')?.getAttribute('data-tone') ?? null;

const doctorFixture = FIXTURES.doctor as (call: Call) => unknown;

describe('Overview', () => {
  it('Overview shows loading, then every block from the fixtures', async () => {
    const { bridge, release } = heldBridge();
    renderApp(bridge);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    // The version comes with the installation, before any CLI read answers.
    expect(within(region('Version')).getByText('agent-communications 0.24.0')).toBeTruthy();
    // Every block that waits on a read says it is loading.
    for (const name of ['Updates', 'Approvals waiting', 'Standing approvals', 'Events']) {
      expect(within(region(name)).getByRole('status', { name: 'Loading…' })).toBeTruthy();
    }
    // The doctors that run at start are checking; Gmail's waits to be asked.
    await waitFor(() => expect(toneOf(doctorRow('agent-communications'))).toBe('busy'));
    for (const name of ['Slack', 'Resend', 'WhatsApp', 'Events']) expect(toneOf(doctorRow(name))).toBe('busy');
    expect(toneOf(doctorRow('Gmail'))).toBe('idle');

    release();

    // The update status: level, background job with its last run, and the pause.
    const updates = region('Updates');
    expect(await within(updates).findByText('every-14-days')).toBeTruthy();
    const job = within(updates).getByText(/^set up; last ran$/);
    expect(job.querySelector('time[datetime="2026-10-19T03:00:00.000Z"]')).not.toBeNull();
    expect(within(updates).getByText('not paused')).toBeTruthy();

    // A row per doctor: core has a warning, the others pass, Gmail's has not been asked for.
    await waitFor(() => expect(toneOf(doctorRow('agent-communications'))).toBe('warn'));
    expect(within(doctorRow('agent-communications')).getByText('1 warning')).toBeTruthy();
    for (const name of ['Slack', 'Resend', 'WhatsApp', 'Events']) expect(toneOf(doctorRow(name))).toBe('ok');
    expect(toneOf(doctorRow('Gmail'))).toBe('idle');
    // In the products' order.
    const rows = Array.from(region('Doctor').querySelectorAll('[data-product]')).map((row) =>
      row.getAttribute('data-product'),
    );
    expect(rows).toEqual(['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon']);

    // The approvals waiting.
    expect(within(region('Approvals waiting')).getByText('3 approvals are waiting.')).toBeTruthy();

    // The active standing approvals.
    const standing = region('Standing approvals');
    expect(within(standing).getByText('example/slack')).toBeTruthy();
    expect(within(standing).getByText('C0EXAMPLE1')).toBeTruthy();
    expect(standing.querySelector('time[datetime="2026-10-26T09:00:00.000Z"]')).not.toBeNull();

    // The events service.
    expect(within(region('Events')).getByText('Running')).toBeTruthy();
    expect(toneOf(region('Events'))).toBe('ok');

    // The approvals waiting link to Approvals.
    fireEvent.click(within(region('Approvals waiting')).getByRole('button', { name: 'Open Approvals' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
  });

  it('a failing doctor shows danger for that channel', async () => {
    const failing: Fixture = (call: Call) =>
      (call as Extract<Call, { kind: 'doctor' }>).product === 'slack'
        ? {
            healthy: false,
            checks: [
              {
                id: 'config',
                title: 'Configuration',
                status: 'ok',
                detail: 'one workspace',
                fix: null,
                workspace: null,
              },
              {
                id: 'auth-example/slack',
                title: 'example/slack signs in',
                status: 'fail',
                detail: 'Slack said invalid_auth',
                fix: null,
                workspace: 'example/slack',
              },
            ],
          }
        : doctorFixture(call);
    const answers = createFakeBridge({}, { doctor: failing });
    const bridge = createFakeBridge({
      // Resend's doctor does not answer at all: that is a failure too.
      cli: async (call: Call) =>
        call.kind === 'doctor' && call.product === 'resend'
          ? failed('APP_TIMEOUT', 'resend did not answer within 90 seconds', null, -1)
          : answers.cli(call),
    });
    renderApp(bridge);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    await waitFor(() => expect(toneOf(doctorRow('Slack'))).toBe('danger'));
    expect(within(doctorRow('Slack')).getByText('1 check failing')).toBeTruthy();
    await waitFor(() => expect(toneOf(doctorRow('Resend'))).toBe('danger'));
    expect(within(doctorRow('Resend')).getByText('resend did not answer within 90 seconds')).toBeTruthy();
    // The others are as they were.
    expect(toneOf(doctorRow('agent-communications'))).toBe('warn');
    expect(toneOf(doctorRow('WhatsApp'))).toBe('ok');
    expect(toneOf(doctorRow('Events'))).toBe('ok');
  });

  it('shows no events block without the events launcher, and asks it nothing', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'gmail'] }),
    });
    renderApp(bridge);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await within(region('Approvals waiting')).findByText('3 approvals are waiting.');
    expect(screen.queryByRole('region', { name: 'Events' })).toBeNull();
    // Only the products that are here have a doctor row.
    const rows = Array.from(region('Doctor').querySelectorAll('[data-product]')).map((row) =>
      row.getAttribute('data-product'),
    );
    expect(rows).toEqual(['core', 'gmail']);
  });

  it('says plainly when nothing waits and no standing approval is active', async () => {
    const bridge = createFakeBridge(
      {},
      { approvalsPending: [], standingList: [], eventsStatus: { owner: 'not-running' } },
    );
    renderApp(bridge);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(await within(region('Approvals waiting')).findByText('Nothing is waiting for you.')).toBeTruthy();
    expect(await within(region('Standing approvals')).findByText('No standing approval is active.')).toBeTruthy();
    expect(await within(region('Events')).findByText('Not running')).toBeTruthy();
  });
});
