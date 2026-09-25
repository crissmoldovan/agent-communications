/**
 * Preloaded into every sign-in listener a test starts: ends the listener once the process that started it has gone.
 *
 * The product must not do this. `--start` exists so that the listener outlives the command that started it — the
 * agent's shell call returns in seconds and the person takes minutes over the consent screen. In a test the parent
 * is the test file's process, and when that dies nobody is ever coming back for the listener.
 *
 * Asked two ways, because each platform answers only one of them. On POSIX an orphan is re-parented, so its parent
 * id changes. Windows never re-parents, so the id stays the same and only asking whether that process still exists
 * tells. Any error from that question counts as gone: `EPERM` means the id now belongs to someone else's process,
 * which is the same answer.
 */

const parent = process.ppid;

function parentGone(): boolean {
  if (process.ppid !== parent) return true;
  try {
    process.kill(parent, 0);
    return false;
  } catch {
    return true;
  }
}

const watch = setInterval(() => {
  if (parentGone()) process.exit(0);
}, 250);
// Never the reason a listener stays up: one that has finished its sign-in must still be free to exit.
watch.unref();

export {};
