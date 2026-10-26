import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import judgesContract from '../../../../packages/events-daemon/test/fixtures/judges/desktop-contract-judges-v1.json';
import { JEV_SETUP_COPY, JUDGE_ROWS_COPY, PROVIDERS_COPY } from '../components/judges/copy.ts';
import { COPY } from '../copy.ts';
import type { AiProvider, Call } from '../ipc.ts';
import { createFakeBridge, type FakeBridge, type Fixture } from './fake-bridge.ts';
import layaUnavailable from './fixtures/events-judge-model-status.unavailable-placeholder.json';
import { renderApp } from './render.tsx';

/*
 * Judge setup in the app (0.32.0, owner decision 2026-10-26, the owner's prototype of that day): Jev and a local model
 * server set up and turned on in Events → Judges, their keys kept in Settings → AI providers. A key goes to Rust's
 * `provider_key_set` alone, never into a `cli` call, and the field that held it is emptied.
 */

// The app acts as the person only on macOS, which attests it; elsewhere each setup is offered at the terminal. These
// tests run as macOS unless one says otherwise.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

const SETUP = '0.32.0';
const SLOW = 30_000;

/** A synthetic key: never a real one. */
const KEY = 'fake-key';

interface Vector {
  kinds: unknown[];
  judges: unknown[];
}

function at(name: string): Vector {
  const found = (judgesContract as { vectors: (Vector & { name: string })[] }).vectors.find(
    (vector) => vector.name === name,
  );
  if (found === undefined) throw new Error(`no judges vector ${name}`);
  return structuredClone(found);
}

/** An event service at `version`, with judge kinds and judges as `vector` has them and keys as `keys` says. */
function setupBridge(
  options: {
    version?: string;
    vector?: Vector;
    keys?: Partial<Record<AiProvider, boolean>>;
    fixtures?: Partial<Record<Call['kind'], Fixture>>;
  } = {},
): FakeBridge {
  const keys = { typesafe: false, openrouter: false, ...options.keys };
  const vector = options.vector ?? at('fresh');
  return createFakeBridge(
    {},
    {
      version: (call: Call) =>
        call.kind === 'version' && call.product === 'events-daemon' ? (options.version ?? SETUP) : '0.24.0',
      eventsRules: [],
      eventsDeliveries: [],
      eventsJudgeModelStatus: layaUnavailable,
      judgeKindsList: () => vector.kinds,
      judgesList: () => vector.judges,
      providerList: () => ({
        providers: [
          { id: 'typesafe', name: 'TypeSafe', hasKey: keys.typesafe },
          { id: 'openrouter', name: 'OpenRouter', hasKey: keys.openrouter },
          // 0.33.0's event service lists Anthropic's key too (Analyse's); the Jev screens pass over it.
          { id: 'anthropic', name: 'Anthropic', hasKey: true },
        ],
      }),
      judgeSetup: () => ({}),
      judgeKindDisable: () => ({ disabled: true }),
      providerKeyRemove: (call: Call) => ({
        provider: (call as Extract<Call, { kind: 'providerKeyRemove' }>).provider,
        hasKey: false,
        judges: 0,
      }),
      ...options.fixtures,
    },
  );
}

const cliCalls = (bridge: FakeBridge): Call[] =>
  bridge.calls.filter((call) => call.command === 'cli').map((call) => call.args as Call);

/** Opens Events → Judges and waits for its rows. */
async function judges(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('tab', { name: /^Judges\b/ }));
  const section = await screen.findByRole('region', { name: 'Judges' }, { timeout: SLOW });
  await within(section).findByRole('region', { name: JUDGE_ROWS_COPY.jev.name }, { timeout: SLOW });
  return section;
}

const row = (section: HTMLElement, name: string) => within(section).getByRole('region', { name });

describe('Judges, set up in the app', () => {
  it('Jev off says what it needs and which keys there are; Laya is not available yet, with no button', {
    timeout: SLOW,
  }, async () => {
    renderApp(setupBridge({ keys: { openrouter: true } }), { screen: 'events' });
    const section = await judges();
    expect(within(section).getByText(JUDGE_ROWS_COPY.intro)).toBeTruthy();
    const jev = row(section, JUDGE_ROWS_COPY.jev.name);
    expect(within(jev).getByText(JUDGE_ROWS_COPY.notSetUp)).toBeTruthy();
    expect(
      await within(jev).findByText(`${JUDGE_ROWS_COPY.jev.needsKey} You have an OpenRouter key already.`),
    ).toBeTruthy();
    expect(within(jev).getByRole('button', { name: JUDGE_ROWS_COPY.setUp })).toBeTruthy();
    expect(within(jev).queryByRole('button', { name: /Terminal/ })).toBeNull();
    const laya = row(section, 'Laya');
    expect(within(laya).getByText(JUDGE_ROWS_COPY.laya.notAvailable)).toBeTruthy();
    expect(within(laya).getByText(JUDGE_ROWS_COPY.laya.body)).toBeTruthy();
    expect(within(laya).queryAllByRole('button')).toEqual([]);
    const local = row(section, JUDGE_ROWS_COPY.local.name);
    expect(within(local).getByRole('button', { name: JUDGE_ROWS_COPY.setUp })).toBeTruthy();
    expect(within(section).getByText(/Turning a judge off applies at once\./)).toBeTruthy();
  });

  it('Set up Jev greys an option without a key, links to Settings, and turns Jev on with the stored key', {
    timeout: SLOW,
  }, async () => {
    const bridge = setupBridge({ keys: { openrouter: true } });
    renderApp(bridge, { screen: 'events' });
    const section = await judges();
    fireEvent.click(
      within(row(section, JUDGE_ROWS_COPY.jev.name)).getByRole('button', { name: JUDGE_ROWS_COPY.setUp }),
    );
    const dialog = await screen.findByRole('dialog', { name: JEV_SETUP_COPY.title });
    const openrouter = await within(dialog).findByRole('radio', { name: /OpenRouter/ });
    const typesafe = within(dialog).getByRole('radio', { name: /TypeSafe, directly/ });
    expect(openrouter.getAttribute('aria-checked')).toBe('true');
    expect(typesafe.getAttribute('aria-disabled') ?? typesafe.getAttribute('data-disabled')).not.toBeNull();
    expect(dialog.querySelector('[data-provider="typesafe"]')?.className).toMatch(/opacity-60/);
    expect(within(dialog).getByText(JEV_SETUP_COPY.options.typesafe.noKey)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: JEV_SETUP_COPY.addOne })).toBeTruthy();
    expect(within(dialog).getByText(JEV_SETUP_COPY.options.openrouter.sees)).toBeTruthy();
    expect(within(dialog).getByText('Jev 1.14')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: JEV_SETUP_COPY.turnOn }));
    await waitFor(() =>
      expect(cliCalls(bridge)).toContainEqual({ kind: 'judgeSetup', judgeKind: 'typesafe', provider: 'openrouter' }),
    );
    // The setup uses the stored key: nothing in the window sends one.
    expect(bridge.calls.some((call) => call.command === 'providerKeySet')).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: JEV_SETUP_COPY.title })).toBeNull());
  });

  it('with no key at all, Set up Jev says to add one first and opens Settings → AI providers', {
    timeout: SLOW,
  }, async () => {
    const bridge = setupBridge();
    renderApp(bridge, { screen: 'events' });
    const section = await judges();
    fireEvent.click(
      within(row(section, JUDGE_ROWS_COPY.jev.name)).getByRole('button', { name: JUDGE_ROWS_COPY.setUp }),
    );
    const dialog = await screen.findByRole('dialog', { name: JEV_SETUP_COPY.title });
    expect(await within(dialog).findByText(JEV_SETUP_COPY.noKeys)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: JEV_SETUP_COPY.turnOn }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: JEV_SETUP_COPY.openProviders }));
    expect(await screen.findByRole('region', { name: PROVIDERS_COPY.title }, { timeout: SLOW })).toBeTruthy();
    expect(cliKinds(bridge)).not.toContain('judgeSetup');
  });

  it('Jev on shows who serves it and its model, and turns off at once', { timeout: SLOW }, async () => {
    const vector = at('typesafe-on-with-jev');
    vector.judges = [
      {
        judgeId: 'jev',
        version: 2,
        kind: 'typesafe',
        provider: 'openrouter',
        model: 'typesafe/jev-1.14',
        revokedAt: null,
      },
    ];
    const bridge = setupBridge({ vector, keys: { openrouter: true } });
    renderApp(bridge, { screen: 'events' });
    const section = await judges();
    const jev = row(section, JUDGE_ROWS_COPY.jev.name);
    expect(within(jev).getByText(JUDGE_ROWS_COPY.on)).toBeTruthy();
    expect(within(jev).getByText('OpenRouter')).toBeTruthy();
    expect(within(jev).getByText('Jev 1.14')).toBeTruthy();
    expect(within(jev).getByRole('button', { name: JUDGE_ROWS_COPY.change })).toBeTruthy();
    fireEvent.click(within(jev).getByRole('button', { name: JUDGE_ROWS_COPY.turnOff }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: JUDGE_ROWS_COPY.turnOff }));
    await waitFor(() => expect(cliCalls(bridge)).toContainEqual({ kind: 'judgeKindDisable', judgeKind: 'typesafe' }));
  });

  it('a local model server takes only an address on this Mac, and its model', { timeout: SLOW }, async () => {
    const bridge = setupBridge();
    renderApp(bridge, { screen: 'events' });
    const section = await judges();
    fireEvent.click(
      within(row(section, JUDGE_ROWS_COPY.local.name)).getByRole('button', { name: JUDGE_ROWS_COPY.setUp }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Set up a local model server' });
    const address = within(dialog).getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
    expect(address.value).toBe('http://127.0.0.1:11434');
    const turnOn = () => within(dialog).getByRole('button', { name: 'Turn on' }) as HTMLButtonElement;
    for (const wrong of [
      'http://localhost:11434',
      'http://192.168.1.20:11434',
      'https://127.0.0.1:11434',
      'http://127.0.0.1',
    ]) {
      fireEvent.change(address, { target: { value: wrong } });
      expect(
        await within(dialog).findByText('Give an address on this Mac, such as http://127.0.0.1:11434.'),
      ).toBeTruthy();
      expect(turnOn().disabled).toBe(true);
    }
    fireEvent.change(address, { target: { value: 'http://[::1]:8080' } });
    await waitFor(() => expect(turnOn().disabled).toBe(false));
    fireEvent.click(turnOn());
    await waitFor(() =>
      expect(cliCalls(bridge)).toContainEqual({
        kind: 'judgeSetup',
        judgeKind: 'local-endpoint',
        url: 'http://[::1]:8080',
        model: 'nimble',
      }),
    );
  });

  it('on Windows and Linux, Jev and a local model server are set up at the terminal: the app runs no setup', {
    timeout: SLOW,
  }, async () => {
    platform.mac = false;
    const bridge = setupBridge({ keys: { openrouter: true } });
    renderApp(bridge, { screen: 'events' });
    const section = await judges();
    fireEvent.click(
      within(row(section, JUDGE_ROWS_COPY.jev.name)).getByRole('button', { name: JUDGE_ROWS_COPY.setUp }),
    );
    let dialog = await screen.findByRole('dialog', { name: JEV_SETUP_COPY.title });
    await within(dialog).findByRole('radio', { name: /OpenRouter/ });
    expect(within(dialog).queryByRole('button', { name: JEV_SETUP_COPY.turnOn })).toBeNull();
    const terminal = () => bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Do it in Terminal' }));
    await waitFor(() =>
      expect(terminal()).toEqual([
        { kind: 'atTerminal', call: { kind: 'judgeSetup', judgeKind: 'typesafe', provider: 'openrouter' } },
      ]),
    );
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: JEV_SETUP_COPY.title })).toBeNull());
    fireEvent.click(
      within(row(section, JUDGE_ROWS_COPY.local.name)).getByRole('button', { name: JUDGE_ROWS_COPY.setUp }),
    );
    dialog = await screen.findByRole('dialog', { name: 'Set up a local model server' });
    expect(within(dialog).queryByRole('button', { name: 'Turn on' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Do it in Terminal' }));
    await waitFor(() =>
      expect(terminal()).toContainEqual({
        kind: 'atTerminal',
        call: { kind: 'judgeSetup', judgeKind: 'local-endpoint', url: 'http://127.0.0.1:11434', model: 'nimble' },
      }),
    );
    expect(cliKinds(bridge)).not.toContain('judgeSetup');
  });

  it('on macOS, a setup the event service refuses as unattested is offered at the terminal instead', {
    timeout: SLOW,
  }, async () => {
    const bridge = setupBridge({ keys: { openrouter: true } });
    const cli = bridge.cli.bind(bridge);
    bridge.cli = async (call) =>
      call.kind === 'judgeSetup'
        ? {
            status: 'failed',
            exit: 77,
            code: 'ORIGIN_UNATTESTED',
            message: 'the app could not be attested as yours',
            hint: null,
          }
        : cli(call);
    renderApp(bridge, { screen: 'events' });
    const section = await judges();
    fireEvent.click(
      within(row(section, JUDGE_ROWS_COPY.jev.name)).getByRole('button', { name: JUDGE_ROWS_COPY.setUp }),
    );
    const dialog = await screen.findByRole('dialog', { name: JEV_SETUP_COPY.title });
    await within(dialog).findByRole('radio', { name: /OpenRouter/ });
    fireEvent.click(within(dialog).getByRole('button', { name: JEV_SETUP_COPY.turnOn }));
    expect(await within(dialog).findByRole('button', { name: 'Do it in Terminal' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: JEV_SETUP_COPY.turnOn })).toBeNull();
  });

  it('an events service before judge setup keeps Turn on in Terminal', { timeout: SLOW }, async () => {
    renderApp(setupBridge({ version: '0.31.0' }), { screen: 'events' });
    const section = await judges();
    expect(
      within(row(section, JUDGE_ROWS_COPY.jev.name)).getByRole('button', { name: 'Turn on in Terminal' }),
    ).toBeTruthy();
    expect(within(section).queryByText(JUDGE_ROWS_COPY.intro)).toBeNull();
  });
});

const cliKinds = (bridge: FakeBridge): string[] => cliCalls(bridge).map((call) => call.kind);

describe('Settings → AI providers', () => {
  async function providers(): Promise<HTMLElement> {
    return screen.findByRole('region', { name: PROVIDERS_COPY.title }, { timeout: SLOW });
  }

  it('adds a key through provider_key_set alone, and empties the field', { timeout: SLOW }, async () => {
    const bridge = setupBridge();
    renderApp(bridge, { screen: 'settings' });
    const section = await providers();
    const openrouter = await within(section).findByRole('region', { name: 'OpenRouter' });
    expect(within(openrouter).getByText(PROVIDERS_COPY.noKey)).toBeTruthy();
    expect(within(openrouter).getByRole('link', { name: PROVIDERS_COPY.providers.openrouter.getKey })).toBeTruthy();
    fireEvent.click(within(openrouter).getByRole('button', { name: PROVIDERS_COPY.addKey }));
    const field = within(openrouter).getByLabelText('OpenRouter key') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: KEY } });
    fireEvent.click(within(openrouter).getByRole('button', { name: PROVIDERS_COPY.saveKey }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'providerKeySet').map((call) => call.args)).toEqual([
        ['openrouter', KEY],
      ]),
    );
    // The key never rides a `cli` call, and the field that held it is empty at once.
    expect(JSON.stringify(cliCalls(bridge))).not.toContain(KEY);
    expect(field.value).toBe('');
    await waitFor(() => expect(within(openrouter).queryByLabelText('OpenRouter key')).toBeNull());
  });

  it('removes a key after naming the judge that uses it', { timeout: SLOW }, async () => {
    const vector = at('typesafe-on-with-jev');
    vector.judges = [
      {
        judgeId: 'jev',
        version: 1,
        kind: 'typesafe',
        provider: 'openrouter',
        model: 'typesafe/jev-1.14',
        revokedAt: null,
      },
    ];
    const bridge = setupBridge({ vector, keys: { openrouter: true } });
    renderApp(bridge, { screen: 'settings' });
    const section = await providers();
    const openrouter = await within(section).findByRole('region', { name: 'OpenRouter' });
    expect(await within(openrouter).findByText(PROVIDERS_COPY.usedByJev)).toBeTruthy();
    expect(within(openrouter).getByRole('button', { name: PROVIDERS_COPY.replace })).toBeTruthy();
    fireEvent.click(within(openrouter).getByRole('button', { name: PROVIDERS_COPY.remove }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(PROVIDERS_COPY.removeBodyUsed('OpenRouter'))).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(cliCalls(bridge)).toContainEqual({ kind: 'providerKeyRemove', provider: 'openrouter' }));
  });

  it('on Windows and Linux, a key is added and removed at the terminal, which asks for it: the app never has it', {
    timeout: SLOW,
  }, async () => {
    platform.mac = false;
    const bridge = setupBridge({ keys: { openrouter: true } });
    renderApp(bridge, { screen: 'settings' });
    const section = await providers();
    const typesafe = await within(section).findByRole('region', { name: 'TypeSafe' });
    fireEvent.click(within(typesafe).getByRole('button', { name: PROVIDERS_COPY.addKey }));
    // No field to type a key into: the terminal asks for it.
    expect(within(typesafe).queryByLabelText('TypeSafe key')).toBeNull();
    expect(typesafe.textContent).toContain('The terminal asks for the key there, hidden: the app never sees it.');
    const terminal = () => bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args);
    fireEvent.click(within(typesafe).getByRole('button', { name: 'Do it in Terminal' }));
    await waitFor(() => expect(terminal()).toEqual([{ kind: 'providerKeySet', provider: 'typesafe' }]));
    fireEvent.click(await within(typesafe).findByRole('button', { name: 'Done' }));
    const openrouter = await within(section).findByRole('region', { name: 'OpenRouter' });
    fireEvent.click(await within(openrouter).findByRole('button', { name: PROVIDERS_COPY.remove }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(await within(openrouter).findByRole('button', { name: 'Do it in Terminal' }));
    await waitFor(() =>
      expect(terminal()).toContainEqual({
        kind: 'atTerminal',
        call: { kind: 'providerKeyRemove', provider: 'openrouter' },
      }),
    );
    expect(bridge.calls.some((call) => call.command === 'providerKeySet')).toBe(false);
    expect(cliKinds(bridge)).not.toContain('providerKeyRemove');
  });

  it('an events service before provider keys asks for an update and reads nothing', { timeout: SLOW }, async () => {
    const bridge = setupBridge({ version: '0.31.0' });
    renderApp(bridge, { screen: 'settings' });
    const section = await providers();
    expect(await within(section).findByText(COPY.updateToUse)).toBeTruthy();
    expect(cliKinds(bridge)).not.toContain('providerList');
  });
});
