import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, classifyChange } from '@agentcomms/core';
import { SlackContext } from '../src/context.ts';
import { connectWorkspace, policyChange, policyWanted } from '../src/operations/changes.ts';
import { newHarness, TEST_CLIENT_ID } from './support/harness.ts';

/**
 * The operations behind every changing command and tool, below both surfaces.
 *
 * `mcp-changes.test.ts` and `cli.test.ts` drive them end to end. These hold the parts neither surface can reach on its
 * own: what a change is measured as before anything happens, and what an apply does when the configuration moved
 * between the approval and the write.
 */

function contextFor(harness: Awaited<ReturnType<typeof newHarness>>): SlackContext {
  return new SlackContext({ core: harness.core, env: harness.env, exchange: (params) => harness.exchange(params) });
}

test('a workspace being connected is measured from read, never as an account already connected', async () => {
  /*
   * Before the sign-in nobody knows who the new account is, and the approval must not guess. If the account the plan
   * adds could be taken for the same person in the same workspace as one already connected, the classifier would
   * measure it from that account's mode — `send` here, so connecting `other` in `send` would loosen nothing and ask
   * nobody — and bind the approval to that account's id.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const config = await harness.core.config.load();
  const plan = await connectWorkspace(contextFor(harness), {
    alias: 'other',
    mode: 'send',
    clientId: TEST_CLIENT_ID,
    port: 51234,
    detached: true,
  }).plan(config);
  assert.deepEqual(classifyChange(plan.before, plan.after).changes, [
    { path: 'accounts.other.mode', before: 'read', after: 'send' },
  ]);
  assert.deepEqual(plan.effects, [
    `signs in to Slack through the app with Client ID ${TEST_CLIENT_ID} and stores a token for other that can post, upload and react`,
  ]);
});

test('a policy is set on the account that was approved, and refused if that account is gone by the time it is written', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const change = policyChange(contextFor(harness), 'acme', { send: 'never' });
  const request = await change.plan(await harness.core.config.load());

  // Removed, and connected again under the same name: another account, with another id.
  await harness.core.config.update((config) => {
    const { acme: _gone, ...rest } = config.accounts;
    return { ...config, accounts: rest };
  });
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0009', userId: 'U0009' });
  await assert.rejects(change.apply(undefined, request), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'CONFIG');
    assert.match(error.message, /"acme" changed while its policy was being set, so nothing was set/);
    return true;
  });
  assert.equal((await harness.core.config.load()).accounts.acme?.sendPolicy, undefined, 'set on somebody else');
});

test('a policy that is not one is refused in the same words from either surface', () => {
  assert.throws(() => policyWanted({ send: 'loud' }), /"loud" is not a send policy/);
  assert.throws(() => policyWanted({ change: 'never' }), /"never" is not a change policy/);
  assert.deepEqual(policyWanted({ send: 'confirm', change: 'chat' }), { send: 'confirm', change: 'chat' });
  assert.deepEqual(policyWanted({}), {});
});
