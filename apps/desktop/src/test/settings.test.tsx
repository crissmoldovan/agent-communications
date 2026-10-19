import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppSettings, FolderOverrides, Folders, UpdaterState } from '../ipc.ts';
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

const settings = (folders: FolderOverrides, resolved: Folders, more: Partial<AppSettings> = {}): AppSettings => ({
  folders,
  resolved,
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
    const folders = await screen.findByRole('region', { name: 'Folders' });
    await within(folders).findByRole('region', { name: 'Folders in use' });
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
