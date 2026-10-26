import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { EventControlClient } from '../src/control/client.ts';
import { linearIssueId } from '../src/domain/linear-target.ts';
import { FAKE_LABELS, FAKE_LINEAR_KEY, FAKE_TEAM, FAKE_VIEWER_ID, startFakeLinear } from './support/fake-linear.ts';
import { cli, readDatabase, SENDER, setUp, withLaneOwner } from './support/lane-harness.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * The Linear target through a real owner (0.33.0 design §3.4): the person keeps a Linear key, approves a rule whose
 * target adds an issue, and a mail that matches becomes one issue in the loopback fake of Linear, with what the sender
 * wrote quoted as from outside. `deliveries list` and `delivery show` name the issue, content-free.
 */

const LINEAR = {
  targetId: 'billing-issues',
  version: 1,
  kind: 'linear',
  team: { id: FAKE_TEAM.id, key: FAKE_TEAM.key },
  title: { text: 'Mail from {{from.address}}: {{subject}}' },
  description: { text: 'Check it against Stripe.\n\n{{subject}}' },
  labels: [FAKE_LABELS[0]],
  assignee: 'me',
};

test('E3: a matching mail becomes one Linear issue, its sender’s words quoted, and its delivery names the issue', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fake = await startFakeLinear();
  try {
    await withLaneOwner(
      async (harness) => {
        // The person keeps the key, as the app sends it.
        await new EventControlClient({ stateDir: harness.stateDir, clientName: 'person-setup:desktop-app' }).request(
          'provider-key-set',
          { provider: 'linear', hidden: FAKE_LINEAR_KEY },
        );
        await setUp(harness, [LINEAR]);
        harness.mailbox.send('Invoice 42 — pay at https://linear.app/example/profiles/ceo @ceo');
        let state: string | undefined;
        for (let index = 0; index < 10 && state !== 'delivered'; index += 1) {
          await harness.tick();
          state = readDatabase(
            harness.stateDir,
            (database) =>
              (
                database.prepare("SELECT state FROM deliveries WHERE target_kind = 'linear'").get() as
                  | { state: string }
                  | undefined
              )?.state,
          );
        }
        assert.equal(state, 'delivered');
        assert.equal(fake.issues.length, 1);
        const [issue] = fake.issues;
        const deliveryId = readDatabase(
          harness.stateDir,
          (database) =>
            (database.prepare("SELECT id FROM deliveries WHERE target_kind = 'linear'").get() as { id: string }).id,
        );
        assert.equal(issue?.input.id, linearIssueId(deliveryId));
        assert.equal(issue?.input.teamId, FAKE_TEAM.id);
        assert.equal(issue?.input.assigneeId, FAKE_VIEWER_ID);
        assert.deepEqual(issue?.input.labelIds, [FAKE_LABELS[0].id]);
        assert.equal(
          issue?.input.title,
          `Mail from ${SENDER}: Invoice 42 — pay at https://linear.app/example/profiles/ceo @ceo`,
        );
        const description = String(issue?.input.description);
        assert.match(
          description,
          /^Check it against Stripe\.\n\n> \*\*From outside: written by the sender, not checked\*\* \(`subject`\)\n>\n> ```text\n> Invoice 42/u,
        );
        for (const line of description.split('\n').filter((entry) => entry.includes('linear.app/example/profiles')))
          assert.match(line, /^> Invoice 42/u, 'the profile address is only inside the quoted code block');

        const listed = await cli(harness.stateDir, ['--json', 'deliveries', 'list']);
        assert.equal(listed.code, 0, listed.err);
        const row = (JSON.parse(listed.out) as { targetKind: string; linear?: unknown }[]).find(
          (entry) => entry.targetKind === 'linear',
        );
        assert.deepEqual(row?.linear, { identifier: 'CUE-1', url: 'https://linear.app/example/issue/CUE-1' });
        const shown = await cli(harness.stateDir, ['--json', 'delivery', 'show', deliveryId]);
        assert.equal(shown.code, 0, shown.err);
        const show = JSON.parse(shown.out) as { delivery: { linear?: unknown }; target: unknown };
        assert.deepEqual(show.delivery.linear, { identifier: 'CUE-1', url: 'https://linear.app/example/issue/CUE-1' });
        assert.deepEqual(show.target, { kind: 'linear', id: 'billing-issues', version: 1 });
        assert.doesNotMatch(`${listed.out}${shown.out}`, /Invoice 42|evil|profiles/u, 'nothing the issue says');
      },
      { linearClient: fake.clientOptions() },
    );
  } finally {
    await fake.close();
  }
});
