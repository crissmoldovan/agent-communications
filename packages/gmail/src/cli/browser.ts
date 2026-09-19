import { spawn } from 'node:child_process';

/**
 * Opens the consent link in the user's browser. Best effort by design: if it fails, the link has already been
 * printed, and a sign-in that cannot start a browser is not a failed sign-in — it is a link the user opens by hand.
 *
 * Never used for the agent-driven flow, where the link is returned for the agent to show and nothing local opens.
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
