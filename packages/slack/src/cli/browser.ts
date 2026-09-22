import { spawn } from 'node:child_process';

/**
 * Opens the authorisation link in the user's browser.
 *
 * Best effort by design: the link has already been printed, and a sign-in that cannot start a browser is not a
 * failed sign-in — it is a link somebody opens by hand. Identical to the Gmail package's, because the reasoning
 * is identical and two different answers to "how do I open a URL" would be two things to maintain.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? // `start` is a shell builtin, and the empty string is the window title `start` expects first.
          ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
