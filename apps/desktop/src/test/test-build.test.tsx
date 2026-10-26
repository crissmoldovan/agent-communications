import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { builtTime, profileFolder, readAppBuild, splitCommit, TEST_BUILD_COPY } from '../app-build.ts';
import type { AppBuild, Folders, Installation } from '../ipc.ts';
import { createFakeBridge, EXAMPLE_FOLDERS, EXAMPLE_INSTALLATION } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/** The test profile's folders, as `local-test-release.sh` writes them into the test app's settings. */
const TEST_FOLDERS: Folders = {
  configDir: '/example/home/.agentcomms-test/config',
  stateDir: '/example/home/.agentcomms-test/state',
  dataDir: '/example/home/.agentcomms-test/data',
  secretsDir: '/example/home/.agentcomms-test/config/secrets',
};

const TEST_INSTALLATION: Installation = { ...EXAMPLE_INSTALLATION, folders: TEST_FOLDERS };

const TEST_BUILD: AppBuild = {
  identifier: 'com.cueplusplus.agentcomms.test',
  isTest: true,
  commit: 'a1b2c3d feat/0.32',
  builtAt: '2026-10-26T14:05:00Z',
};

function render(build: AppBuild | (() => Promise<AppBuild>), installation = TEST_INSTALLATION) {
  const bridge = createFakeBridge({
    installation: async () => installation,
    appBuild: typeof build === 'function' ? build : async () => build,
  });
  renderApp(bridge);
  return bridge;
}

const brand = () => document.querySelector('[data-slot="app-shell-brand"]') as HTMLElement;

describe('the test build, told apart (spec §3.7)', () => {
  it('a release build looks as it did: no band, the brand Agent Comms, and no profile at the foot', async () => {
    const bridge = render(
      { identifier: 'com.cueplusplus.agentcomms', isTest: false, commit: null, builtAt: null },
      {
        ...EXAMPLE_INSTALLATION,
      },
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    await waitFor(() => expect(bridge.calls.some((call) => call.command === 'appBuild')).toBe(true));
    expect(screen.queryByRole('note', { name: TEST_BUILD_COPY.band })).toBeNull();
    expect(brand().textContent).toBe('AAgent Comms');
    expect(brand().querySelector('[data-slot="brand-chip"]')?.className).toContain('bg-accent');
    expect(screen.queryByText(TEST_BUILD_COPY.profile)).toBeNull();
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    expect(navigation.textContent).not.toContain('.agentcomms-test');
  });

  it('when the app cannot say which build it is, it looks like a release', async () => {
    render(() => Promise.reject({ code: 'APP_NOT_BUILT', message: 'app_build is not in this scenario' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    expect(screen.queryByRole('note', { name: TEST_BUILD_COPY.band })).toBeNull();
    expect(brand().textContent).toBe('AAgent Comms');
  });

  it('a test build has the band, the brand Agent Comms Test with an orange chip, and its profile at the foot', async () => {
    render(TEST_BUILD);
    const band = await screen.findByRole('note', { name: TEST_BUILD_COPY.band });
    expect(band.textContent).toBe(
      `TEST BUILD · feat/0.32 · a1b2c3d · built ${builtTime('2026-10-26T14:05:00Z')} · Uses the test profile, not your real accounts`,
    );
    expect(band.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-26T14:05:00.000Z');
    // Orange, from the theme's own warn tokens.
    expect(band.className).toContain('bg-warn');
    expect(band.className).toContain('text-warn-fg');
    // It is the window's top: it comes before the header, and drags the window as the header does.
    const shell = document.querySelector('[data-slot="app-shell"]') as HTMLElement;
    expect(shell.firstElementChild).toBe(band);
    expect(band.hasAttribute('data-tauri-drag-region')).toBe(true);

    expect(brand().textContent).toBe('TAgent Comms Test');
    const chip = brand().querySelector('[data-slot="brand-chip"]');
    expect(chip?.className).toContain('bg-warn');
    expect(chip?.className).not.toContain('bg-accent');

    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    const foot = within(navigation).getByText(TEST_BUILD_COPY.profile).parentElement as HTMLElement;
    expect(foot.textContent).toBe(`${TEST_BUILD_COPY.profile}~/.agentcomms-test`);
  });

  it('says only what it was built with: a commit with no branch, or neither commit nor time', async () => {
    render({ ...TEST_BUILD, commit: 'a1b2c3d' });
    expect((await screen.findByRole('note', { name: TEST_BUILD_COPY.band })).textContent).toBe(
      `TEST BUILD · a1b2c3d · built ${builtTime('2026-10-26T14:05:00Z')} · Uses the test profile, not your real accounts`,
    );
  });

  it('a test build made without the script says it is one, and nothing more', async () => {
    render({ ...TEST_BUILD, commit: null, builtAt: null });
    expect((await screen.findByRole('note', { name: TEST_BUILD_COPY.band })).textContent).toBe(
      'TEST BUILD · Uses the test profile, not your real accounts',
    );
  });

  it('a time it cannot read is shown as the text it is', async () => {
    render({ ...TEST_BUILD, commit: null, builtAt: '<b>Monday</b>' });
    const band = await screen.findByRole('note', { name: TEST_BUILD_COPY.band });
    expect(band.textContent).toBe('TEST BUILD · built <b>Monday</b> · Uses the test profile, not your real accounts');
    expect(band.querySelector('b')).toBeNull();
  });
});

describe("the test build's words", () => {
  it('reads app_build, and nothing that is not its answer', () => {
    expect(readAppBuild(TEST_BUILD)).toEqual(TEST_BUILD);
    expect(readAppBuild({ identifier: 'x', isTest: false })).toEqual({
      identifier: 'x',
      isTest: false,
      commit: null,
      builtAt: null,
    });
    for (const bad of [null, 'test', [], { isTest: true }, { identifier: 'x', isTest: 'yes' }]) {
      expect(readAppBuild(bad)).toBeNull();
    }
  });

  it('splits the compiled-in commit into the commit and the branch pointing at it', () => {
    expect(splitCommit('a1b2c3d feat/0.32')).toEqual({ commit: 'a1b2c3d', branch: 'feat/0.32' });
    expect(splitCommit('a1b2c3d')).toEqual({ commit: 'a1b2c3d', branch: null });
    expect(splitCommit('  a1b2c3d   main ')).toEqual({ commit: 'a1b2c3d', branch: 'main' });
    expect(splitCommit(null)).toEqual({ commit: null, branch: null });
    expect(splitCommit('')).toEqual({ commit: null, branch: null });
  });

  it("names the test profile's folder: the one its folders share, with the home as `~`", () => {
    expect(profileFolder(TEST_FOLDERS, '/example/home')).toBe('~/.agentcomms-test');
    expect(profileFolder(TEST_FOLDERS, null)).toBe('/example/home/.agentcomms-test');
    // Folders that share only the home, or nothing, name the config folder instead.
    expect(profileFolder(EXAMPLE_FOLDERS, '/example/home')).toBe('~/.config/agent-communications');
    expect(
      profileFolder(
        { configDir: '/a/config', stateDir: '/b/state', dataDir: '/c/data', secretsDir: '/a/config/secrets' },
        '/example/home',
      ),
    ).toBe('/a/config');
    expect(
      profileFolder(
        {
          configDir: 'C:\\Users\\example\\.agentcomms-test\\config',
          stateDir: 'C:\\Users\\example\\.agentcomms-test\\state',
          dataDir: 'C:\\Users\\example\\.agentcomms-test\\data',
          secretsDir: 'C:\\Users\\example\\.agentcomms-test\\config\\secrets',
        },
        'C:\\Users\\example',
      ),
    ).toBe('~\\.agentcomms-test');
  });
});
