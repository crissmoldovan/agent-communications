/** Whether the window runs on macOS, where the title bar's traffic lights sit over the app's header. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent);
}
