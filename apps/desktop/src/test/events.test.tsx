import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.ts';
import type { Call, CliResult } from '../ipc.ts';
import {
  cliKinds,
  createFakeBridge,
  EXAMPLE_INSTALLATION,
  type FakeBridge,
  type Fixture,
  failed,
} from './fake-bridge.ts';
import deliveries from './fixtures/events-deliveries.json';
import rules from './fixtures/events-rules.json';
import running from './fixtures/events-status.running.json';
import { renderApp } from './render.tsx';

/** A fake bridge whose `cli` answers the kinds in `results` with a whole result, and every other from `fixtures`. */
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

const EVENTS_CALLS: Call['kind'][] = ['eventsStatus', 'eventsPause', 'eventsResume', 'eventsRules', 'eventsDeliveries'];

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('Events', () => {
  it('Events: absent, loading, error, populated; Pause and Resume run', async () => {
    // Absent: no launcher, so the screen says so and nothing of the events service is asked.
    const absent = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'gmail'] }),
    });
    const first = renderApp(absent, { screen: 'events' });
    expect(await screen.findByText("The events service isn't installed.")).toBeTruthy();
    expect(cliKinds(absent).filter((kind) => EVENTS_CALLS.includes(kind))).toEqual([]);
    first.unmount();

    // Loading: nothing has come back yet.
    const never = new Promise<CliResult>(() => undefined);
    const waiting = bridgeWith({ eventsStatus: never, eventsRules: never, eventsDeliveries: never });
    const second = renderApp(waiting, { screen: 'events' });
    const main = await screen.findByRole('main');
    expect(await within(main).findAllByRole('status', { name: COPY.loading })).toHaveLength(3);
    second.unmount();

    // An error: each part says what went wrong, as text.
    const broken = bridgeWith({
      eventsStatus: failed('CLI_FAILED', 'the events service did not answer'),
      eventsRules: failed('CLI_FAILED', 'the local event service is not running'),
      eventsDeliveries: failed('CLI_FAILED', 'no deliveries could be read'),
    });
    const third = renderApp(broken, { screen: 'events' });
    expect(await screen.findByText('the events service did not answer')).toBeTruthy();
    expect(await screen.findByText('the local event service is not running')).toBeTruthy();
    expect(await screen.findByText('no deliveries could be read')).toBeTruthy();
    third.unmount();

    // Populated, from the fixtures: the status, then each list as a table of its own fields.
    let paused = false;
    const bridge = bridgeWith(
      {},
      {
        eventsStatus: () => ({ ...running, paused }),
        eventsRules: rules,
        eventsDeliveries: deliveries,
        eventsPause: () => {
          paused = true;
          return { enabled: true, paused, switchGeneration: 3 };
        },
        eventsResume: () => {
          paused = false;
          return { enabled: true, paused, switchGeneration: 3 };
        },
      },
    );
    renderApp(bridge, { screen: 'events' });
    const status = await screen.findByRole('region', { name: 'Status' });
    expect(await within(status).findByText('running')).toBeTruthy();
    expect(within(status).getByText('on')).toBeTruthy();

    const ruleTable = await screen.findByRole('table', { name: 'Rules' });
    const ruleRows = within(ruleTable).getAllByRole('row');
    expect(ruleRows).toHaveLength(1 + rules.length);
    expect(within(ruleTable).getAllByText('rule_example')).toHaveLength(2);
    expect(within(ruleTable).getByText('active')).toBeTruthy();
    expect(within(ruleTable).getByText('superseded')).toBeTruthy();
    expect(within(ruleTable).getByText('ap_1A2B3C4D5E6F7G8H9J0K1M2N3P')).toBeTruthy();

    const deliveryTable = await screen.findByRole('table', { name: 'Recent deliveries' });
    expect(within(deliveryTable).getAllByRole('row')).toHaveLength(1 + deliveries.length);
    expect(within(deliveryTable).getByText('dlv_example_1')).toBeTruthy();
    expect(within(deliveryTable).getByText('retryable')).toBeTruthy();
    expect(deliveryTable.querySelector(`time[datetime="${new Date(1760950800000).toISOString()}"]`)).not.toBeNull();

    // Pause runs `eventsPause`, the status is read again, and Resume runs `eventsResume`.
    const resume = within(status).getByRole('button', { name: 'Resume' }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.click(within(status).getByRole('button', { name: 'Pause' }));
    expect(await within(region('Status')).findByText('paused')).toBeTruthy();
    expect(cliKinds(bridge)).toContain('eventsPause');
    await waitFor(() =>
      expect((within(region('Status')).getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(within(region('Status')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(cliKinds(bridge)).toContain('eventsResume'));
    await waitFor(() => expect(within(region('Status')).queryByText('paused')).toBeNull());
  });

  it('a service that is not running offers neither Pause nor Resume, and an empty list says so', async () => {
    const bridge = bridgeWith({}, { eventsStatus: { owner: 'not-running' }, eventsRules: [], eventsDeliveries: [] });
    renderApp(bridge, { screen: 'events' });
    const status = await screen.findByRole('region', { name: 'Status' });
    expect(await within(status).findByText('not running')).toBeTruthy();
    expect((within(status).getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(status).getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('No rules yet.')).toBeTruthy();
    expect(await screen.findByText('No deliveries yet.')).toBeTruthy();
  });

  it('a list in a shape the app does not know says so, and hostile text stays text', async () => {
    const bridge = bridgeWith(
      {},
      {
        eventsRules: { rules: 'not a list' },
        eventsDeliveries: [{ deliveryId: '<img src=x onerror=alert(1)>', state: '</untrusted-content>' }],
      },
    );
    renderApp(bridge, { screen: 'events' });
    expect(await screen.findByText('The list could not be read.')).toBeTruthy();
    const deliveryTable = await screen.findByRole('table', { name: 'Recent deliveries' });
    expect(within(deliveryTable).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(within(deliveryTable).getByText('</untrusted-content>')).toBeTruthy();
    expect(deliveryTable.querySelector('img')).toBeNull();
  });
});
