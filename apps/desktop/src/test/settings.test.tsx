import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppSettings, FolderOverrides, Folders, UpdaterState } from '../ipc.ts';
import { LOGIN_ITEM_UNKNOWN, SETTINGS_COPY } from '../screens/Settings.tsx';
import { createFakeBridge, EXAMPLE_FOLDERS, EXAMPLE_INSTALLATION } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

const OFF = 'Updates for this app are off: this copy was built without the updater key.';

const ELSEWHERE: Folders = {
  configDir: '/example/home/elsewhere/config',
  stateDir: '/example/home/elsewhere/config/state',
  dataDir: EXAMPLE_FOLDERS.dataDir,
  secretsDir: '/example/home/elsewhere/config/secrets',
};

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

const CHANGE = 'Change folders…';

/** Opens the folder fields, which wait behind "Change folders…" for the few who keep the folders elsewhere. */
async function changeFolders(): Promise<HTMLElement> {
  const folders = await screen.findByRole('region', { name: 'Folders' });
  const toggle = await within(folders).findByRole('button', { name: CHANGE });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  await within(folders).findByLabelText('Config folder');
  return folders;
}

/** What a hint says, once its "i" has the keyboard's focus: a hint reachable without a pointer. */
async function hint(trigger: HTMLElement): Promise<string> {
  await act(async () => {
    trigger.focus();
  });
  return (await screen.findByRole('tooltip')).textContent ?? '';
}

const settings = (folders: FolderOverrides, resolved: Folders, more: Partial<AppSettings> = {}): AppSettings => ({
  folders,
  resolved,
  launcher: `${resolved.dataDir}/launch/core`,
  launcherProblem: null,
  loginItem: false,
  loginItemAvailable: true,
  ...more,
});

describe('Settings', () => {
  it('Settings: saving a config folder re-reads the installation and shows the four folders; the updater says when it is off', async () => {
    const bridge = createFakeBridge({
      setFolders: async (folders) => settings(folders, folders.configDir ? ELSEWHERE : EXAMPLE_FOLDERS),
    });
    renderApp(bridge, { screen: 'settings' });
    const folders = await screen.findByRole('region', { name: 'Folders' });
    // The four folders in use, read-only, before anything is saved.
    const inUse = await within(folders).findByRole('region', { name: 'Folders in use' });
    for (const folder of Object.values(EXAMPLE_FOLDERS)) expect(within(inUse).getByText(folder)).toBeTruthy();
    expect(within(inUse).queryByRole('textbox')).toBeNull();
    const installations = () => bridge.calls.filter((call) => call.command === 'installation').length;
    const before = installations();

    await changeFolders();
    fireEvent.change(within(folders).getByLabelText('Config folder'), {
      target: { value: '/example/home/elsewhere/config' },
    });
    fireEvent.click(within(folders).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'setFolders')).toEqual([
        {
          command: 'setFolders',
          args: { configDir: '/example/home/elsewhere/config', stateDir: null, dataDir: null },
        },
      ]),
    );
    // The installation is read again, through the folders just saved, and the four folders now in use show.
    await waitFor(() => expect(installations()).toBeGreaterThan(before));
    const now = within(region('Folders')).getByRole('region', { name: 'Folders in use' });
    for (const folder of Object.values(ELSEWHERE)) expect(within(now).getByText(folder)).toBeTruthy();
    expect(within(region('Folders')).getByText('Saved.')).toBeTruthy();

    // The app's own updater, built without its key: it says so, and offers nothing to check.
    const updater = region('Updates for this app');
    expect(await within(updater).findByText(OFF)).toBeTruthy();
    expect((within(updater).getByRole('button', { name: 'Check for Updates' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(within(updater).queryByRole('button', { name: 'Install and restart' })).toBeNull();
  });

  it('a folder that is not a whole path is refused before anything is saved', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'settings' });
    const folders = await changeFolders();
    fireEvent.change(within(folders).getByLabelText('State folder'), { target: { value: 'relative/state' } });
    fireEvent.click(within(folders).getByRole('button', { name: 'Save' }));
    expect(await within(folders).findByText(/Give the whole path/)).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'setFolders')).toEqual([]);
    // A Windows path is a whole path too, and an emptied field is left to the environment and the defaults.
    fireEvent.change(within(folders).getByLabelText('State folder'), { target: { value: 'C:\\example\\home\\state' } });
    fireEvent.change(within(folders).getByLabelText('Data folder'), { target: { value: '   ' } });
    fireEvent.click(within(folders).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'setFolders').map((call) => call.args)).toEqual([
        { configDir: null, stateDir: 'C:\\example\\home\\state', dataDir: null },
      ]),
    );
  });

  it('a network share is never taken as a folder, in any of its forms', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'settings' });
    const folders = await changeFolders();
    for (const share of [
      '\\\\server\\share\\data',
      '//server/share/data',
      '\\\\?\\UNC\\server\\share',
      'smb://server/x',
    ]) {
      fireEvent.change(within(folders).getByLabelText('Data folder'), { target: { value: share } });
      fireEvent.click(within(folders).getByRole('button', { name: 'Save' }));
      expect(await within(folders).findByText(/never a network share/), share).toBeTruthy();
    }
    expect(bridge.calls.filter((call) => call.command === 'setFolders')).toEqual([]);
  });

  it('shows the launcher every call starts, and why the app would not run it', async () => {
    const bridge = createFakeBridge({
      getSettings: async () =>
        settings({}, EXAMPLE_FOLDERS, {
          launcherProblem: `the core launcher at ${EXAMPLE_FOLDERS.dataDir}/launch/core can be changed by other users (its mode is 777), so the app will not run it`,
        }),
    });
    renderApp(bridge, { screen: 'settings' });
    const inUse = await screen.findByRole('region', { name: 'Folders in use' });
    expect(within(inUse).getByText('Launcher')).toBeTruthy();
    expect(within(inUse).getByText(`${EXAMPLE_FOLDERS.dataDir}/launch/core`)).toBeTruthy();
    expect(within(inUse).getByRole('alert').textContent).toMatch(/can be changed by other users/);
  });

  it('Start at login switches through the app, and is disabled with a note where it is not offered', async () => {
    const bridge = createFakeBridge();
    const view = renderApp(bridge, { screen: 'settings' });
    const login = await screen.findByRole('switch', { name: 'Start at login' });
    await waitFor(() => expect(login.getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(login);
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'setLoginItem')).toEqual([
        { command: 'setLoginItem', args: true },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Start at login' }).getAttribute('aria-checked')).toBe('true'),
    );
    view.unmount();

    const unavailable = createFakeBridge({
      getSettings: async () => settings({}, EXAMPLE_FOLDERS, { loginItemAvailable: false }),
    });
    renderApp(unavailable, { screen: 'settings' });
    expect(await screen.findByText("Starting at login isn't offered here.")).toBeTruthy();
    const off = screen.getByRole('switch', { name: 'Start at login' });
    expect(off.getAttribute('aria-disabled') === 'true' || off.hasAttribute('data-disabled')).toBe(true);
  });

  it('when macOS does not answer about the login item, Settings still open and say so, with the switch off and disabled', async () => {
    // On 2026-10-24 a Mac whose login-items service had stopped answering froze the whole window on opening Settings.
    const silent = createFakeBridge({
      getSettings: async () => settings({}, EXAMPLE_FOLDERS, { loginItem: null }),
    });
    renderApp(silent, { screen: 'settings' });
    expect(await screen.findByText(LOGIN_ITEM_UNKNOWN)).toBeTruthy();
    const login = screen.getByRole('switch', { name: 'Start at login' });
    expect(login.getAttribute('aria-checked')).toBe('false');
    expect(login.getAttribute('aria-disabled') === 'true' || login.hasAttribute('data-disabled')).toBe(true);
    // Why, in its hint beside the line.
    expect(await hint(screen.getByRole('button', { name: SETTINGS_COPY.loginItemUnknownLabel }))).toBe(
      "macOS's login-items service is not responding, so whether Agent Comms starts at login can't be read or changed.",
    );
    // The rest of Settings is there as usual.
    expect(region('Folders')).toBeTruthy();
  });

  it('the updater checks when asked, and installs only an update that is available', async () => {
    const idle: UpdaterState = { on: true, status: 'idle', version: null, message: null };
    const available: UpdaterState = { on: true, status: 'available', version: '0.25.0', message: null };
    const bridge = createFakeBridge({
      updaterState: async () => idle,
      checkForUpdates: async () => ({ on: true, status: 'none', version: null, message: null }),
    });
    renderApp(bridge, { screen: 'settings' });
    const updater = await screen.findByRole('region', { name: 'Updates for this app' });
    const check = await within(updater).findByRole('button', { name: 'Check for Updates' });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    expect(within(updater).queryByRole('button', { name: 'Install and restart' })).toBeNull();
    fireEvent.click(check);
    expect(await within(updater).findByText('This is the latest version.')).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'checkForUpdates')).toHaveLength(1);

    // The silent check found one: the event says so, and only then is there something to install.
    await act(async () => bridge.emit('updater', available));
    expect(await within(updater).findByText('Agent Comms 0.25.0 is available.')).toBeTruthy();
    fireEvent.click(within(updater).getByRole('button', { name: 'Install and restart' }));
    await waitFor(() => expect(bridge.calls.filter((call) => call.command === 'installUpdate')).toHaveLength(1));
  });

  it('This app comes first, with the updater then Start at login; the folders in use follow', async () => {
    renderApp(createFakeBridge(), { screen: 'settings' });
    const app = await screen.findByRole('region', { name: 'This app' });
    const updater = within(app).getByRole('region', { name: 'Updates for this app' });
    const login = await within(app).findByRole('switch', { name: 'Start at login' });
    expect(within(updater).getByRole('button', { name: 'Check for Updates' })).toBeTruthy();
    // In the page's order: the updater, Start at login, then the folders.
    const folders = region('Folders');
    expect(updater.compareDocumentPosition(login) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(app.compareDocumentPosition(folders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The appearance menu stays in the window's bar, not on the screen.
    expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy();
    expect(within(screen.getByRole('main')).queryByRole('button', { name: 'Appearance' })).toBeNull();
  });

  it('Change folders… keeps the folder fields closed until asked, and opens on them when one is set', async () => {
    const view = renderApp(createFakeBridge(), { screen: 'settings' });
    const folders = await screen.findByRole('region', { name: 'Folders' });
    const inUse = await within(folders).findByRole('region', { name: 'Folders in use' });
    for (const folder of Object.values(EXAMPLE_FOLDERS)) expect(within(inUse).getByText(folder)).toBeTruthy();
    // Each path is a literal value, set in mono.
    expect(within(inUse).getByText(EXAMPLE_FOLDERS.configDir).closest('.font-mono')).not.toBeNull();
    const toggle = within(folders).getByRole('button', { name: CHANGE });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(folders).queryByRole('textbox')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(folders).getAllByRole('textbox')).toHaveLength(3);
    for (const label of ['Config folder', 'State folder', 'Data folder']) {
      expect(within(folders).getByLabelText(label)).toBeTruthy();
    }
    // Its two explanations are hints, each beside what it explains.
    expect(await hint(within(folders).getByRole('button', { name: SETTINGS_COPY.elsewhereLabel }))).toBe(
      'An app started from the Dock or the Start menu sees no shell variables, so it needs the same folders named here.',
    );
    fireEvent.click(toggle);
    expect(within(folders).queryByRole('textbox')).toBeNull();
    view.unmount();

    // Someone who has named a folder sees it from the start.
    const named = createFakeBridge({
      getSettings: async () => settings({ stateDir: '/example/home/elsewhere/state' }, EXAMPLE_FOLDERS),
    });
    renderApp(named, { screen: 'settings' });
    const shown = await screen.findByRole('region', { name: 'Folders' });
    expect(within(shown).getByRole('button', { name: CHANGE }).getAttribute('aria-expanded')).toBe('true');
    expect((within(shown).getByLabelText('State folder') as HTMLInputElement).value).toBe(
      '/example/home/elsewhere/state',
    );
  });

  it('what the folders in use are is a hint beside their heading', async () => {
    renderApp(createFakeBridge(), { screen: 'settings' });
    const inUse = await screen.findByRole('region', { name: 'Folders in use' });
    expect(await hint(within(inUse).getByRole('button', { name: SETTINGS_COPY.inUseLabel }))).toBe(
      'Every call pins these four folders, and starts the launcher in the data folder.',
    );
  });

  it('settings that cannot be read say so, and Settings runs no CLI call when nothing is installed', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, installed: false, version: null, present: [] }),
      getSettings: async () => {
        throw { code: 'APP_NOT_BUILT', message: 'get_settings is not built yet' };
      },
    });
    renderApp(bridge);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Settings' }));
    expect(await screen.findAllByText('get_settings is not built yet')).not.toHaveLength(0);
    expect(bridge.calls.filter((call) => call.command === 'cli')).toEqual([]);
  });
});
