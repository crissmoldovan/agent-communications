import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOOKS, prepaintSource, STORAGE_KEY } from '../theme.ts';
import { createFakeBridge } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/*
 * The look the app opens in, on the first frame and after the provider has restored what is stored (cue-ui 0.34.0):
 * soft with its set, pairing and pack when nothing is stored; a stored cue or terminal with theirs, never soft's; and
 * what 0.28 to 0.33 stored, under the key before this one, not read at all.
 */

const AXES = ['data-theme', 'data-density', 'data-mode', 'data-font', 'data-style', 'data-paint'] as const;
const html = document.documentElement;

/** What `<html>` is stamped with: the axes the pre-paint script and the provider both write. */
function stamped(element: Element = html) {
  return {
    theme: element.getAttribute('data-theme'),
    style: element.getAttribute('data-style'),
    font: element.getAttribute('data-font'),
    paint: element.getAttribute('data-paint'),
  };
}

/** Runs the pre-paint script as `index.html` does, before anything else. */
function prepaint(): void {
  new Function(prepaintSource())();
}

const SOFT = { theme: 'soft', style: 'soft', font: 'inter', paint: 'glaze' };

beforeEach(() => {
  for (const axis of AXES) html.removeAttribute(axis);
});

afterEach(() => {
  for (const axis of AXES) html.removeAttribute(axis);
});

describe('the look the app opens in', () => {
  it('with nothing stored, the first frame is the soft look at the normal rung, and the provider holds it', async () => {
    prepaint();
    expect(stamped()).toEqual(SOFT);
    expect(html.getAttribute('data-density')).toBe('normal');
    expect(html.getAttribute('data-mode')).toBe('system');

    renderApp(createFakeBridge());
    await screen.findByRole('button', { name: 'Appearance' });
    // The provider's own element carries the set and the pack (the font pairing lives only on <html>).
    const provider = document.querySelector('[data-cue-root]');
    await waitFor(() => expect(provider?.getAttribute('data-style')).toBe('soft'));
    expect(provider?.getAttribute('data-paint')).toBe('glaze');
    expect(provider?.getAttribute('data-theme')).toBe('soft');
    expect(stamped()).toEqual(SOFT);
  });

  for (const theme of ['cue', 'terminal'] as const) {
    it(`a stored ${theme} opens with its own look, on the first frame and after the restore, never soft's`, async () => {
      const { styleSet: style, font, paint } = LOOKS[theme];
      // What the appearance menu writes when the person picks it (foundations.test.tsx).
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ theme, density: 'compact', mode: 'dark', font, style, paint }),
      );
      prepaint();
      expect(stamped()).toEqual({ theme, style, font, paint });
      expect(style).not.toBe('soft');
      expect(paint).not.toBe('glaze');

      renderApp(createFakeBridge());
      await screen.findByRole('button', { name: 'Appearance' });
      const provider = document.querySelector('[data-cue-root]');
      await waitFor(() => expect(provider?.getAttribute('data-theme')).toBe(theme));
      expect(provider?.getAttribute('data-style')).toBe(style);
      expect(provider?.getAttribute('data-paint')).toBe(paint);
      expect(stamped()).toEqual({ theme, style, font, paint });
      expect(html.getAttribute('data-density')).toBe('compact');
    });
  }

  it('what 0.28 to 0.33 stored is not read: the app opens once on the soft look', async () => {
    window.localStorage.setItem(
      'agent-comms.look',
      JSON.stringify({ theme: 'cue', density: 'compact', font: 'system', mode: 'dark' }),
    );
    prepaint();
    expect(stamped()).toEqual(SOFT);

    renderApp(createFakeBridge());
    await screen.findByRole('button', { name: 'Appearance' });
    await waitFor(() => expect(document.querySelector('[data-cue-root]')?.getAttribute('data-style')).toBe('soft'));
    expect(stamped()).toEqual(SOFT);
    expect(html.getAttribute('data-density')).toBe('normal');
  });
});

describe('the typeface under the soft look', () => {
  /** Opens the appearance menu, unless a choice left it open, and returns its checkbox items. */
  async function openMenu() {
    if (screen.queryAllByRole('menuitemcheckbox').length === 0) {
      fireEvent.click(await screen.findByRole('button', { name: 'Appearance' }));
    }
    return screen.findAllByRole('menuitemcheckbox');
  }

  it('offers Inter and SF Pro, keeps the one chosen, and keeps it when soft is picked again', async () => {
    localStorage.clear();
    renderApp(createFakeBridge());
    const items = await openMenu();
    const names = items.map((item) => item.textContent);
    expect(names).toEqual(expect.arrayContaining(['Inter', 'SF Pro']));
    expect(screen.getByText('Typeface')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'SF Pro' }));
    await waitFor(() => expect(html.getAttribute('data-font')).toBe('apple'));

    // cue has no typeface choice: its own system pairing comes back, and the group is gone.
    await openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'cue' }));
    await waitFor(() => expect(html.getAttribute('data-font')).toBe(LOOKS.cue.font));
    await openMenu();
    expect(screen.queryByText('Typeface')).toBeNull();

    // Picking soft again brings back the face chosen for it.
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'soft' }));
    await waitFor(() => expect(html.getAttribute('data-font')).toBe('apple'));
  });
});
