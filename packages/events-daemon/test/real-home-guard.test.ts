import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventControlClient } from '../src/control/client.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { relayHomeCandidates } from '../src/runtime/relay-client.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

/*
 * The real-home guard in the event service (the second look at 0.33.0): `b3-contract-type-drift` started an owner
 * without a temporary home and asked it where the claude-stream relay is, so it read the person's relay token. Under the
 * test preload the relay is never looked for under the account's own home: an owner given no home seam refuses the
 * question, and one given a temporary home answers it from there. Only paths are compared; each refusal this file causes on purpose is taken back from the count
 * the preload reads at exit.
 */

const ATTEMPTS = Symbol.for('agentcomms.test.real-home-attempts.v1');

function taken(): string[] {
  const store = globalThis as unknown as Record<symbol, string[] | undefined>;
  return store[ATTEMPTS]?.splice(0) ?? [];
}

test('REAL-HOME: the relay is never looked for under the account’s own home; under a temporary one it is', () => {
  const settings = { relayHome: null, relayPort: null };
  assert.throws(
    () => relayHomeCandidates(settings, userInfo().homedir),
    /the claude-stream relay would have been looked for in the account's real home folder/u,
  );
  const home = join('/example/home', 'no-relay');
  assert.ok(relayHomeCandidates(settings, home).every((candidate) => candidate.home.startsWith(home)));
  assert.deepEqual(taken(), ['the claude-stream relay']);
});

test('REAL-HOME: an owner given no home finds the relay nowhere in the account’s own home; given a temporary one it answers', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-real-home-');
  const configDir = await emptyConfigDir(stateDir);
  // No seam: the owner starts — it looks the home up only when the relay is first asked for — and that is refused.
  const bare = await startEventOwner({ stateDir, configDir, tickMs: 60_000 });
  try {
    const person = new EventControlClient({ stateDir, clientName: 'person-setup:terminal' });
    await assert.rejects(person.request('integration-show', { integration: 'agent-sessions' }));
  } finally {
    await bare.stop();
  }
  assert.deepEqual(taken(), ['the claude-stream relay']);
  // With the seam, the same question is answered from the temporary home, where no relay is.
  const owner = await startEventOwner({ ...noRealHome(stateDir), stateDir, configDir, tickMs: 60_000 });
  try {
    const person = new EventControlClient({ stateDir, clientName: 'person-setup:terminal' });
    const shown = (await person.request('integration-show', { integration: 'agent-sessions' })) as {
      relay: { found: boolean };
    };
    assert.equal(shown.relay.found, false, 'no relay in the temporary home');
  } finally {
    await owner.stop();
  }
  assert.deepEqual(taken(), []);
});
