import type { TestContext } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import type { SlackContext } from '../../src/context.ts';
import { type FakeSlack, type SlackWorld, startFakeSlack } from './fake-slack.ts';
import { type Harness, newHarness } from './harness.ts';

/**
 * A workspace that can post, a stateful Slack on a loopback port, and a way to write the behaviour rules — for the tests
 * of what an agent may do there (design 2026-10-19-agent-behaviour-rules, B2–B4). Nothing here reaches the real Slack:
 * the fake is the loopback one, and the gate reaches it only through the guard.
 *
 * The rooms: `#eng` ({@link ENG}), which this account has joined; a DM with Sam ({@link SAM_DM}, Sam is {@link SAM});
 * and a DM with Ana ({@link ANA_DM}, Ana is {@link ANA}). Ids as Slack writes them, long enough to be read as ids: a rule
 * naming one too short to be a Slack id is a rule the rules cannot read, and its account allows nothing. This account's
 * own message sits in `#eng` at {@link MINE}, for an edit or a deletion to act on.
 */

export const MINE = '1700000000.000100';
export const ENG = 'C0ENG';
export const SAM = 'U0SAM';
export const SAM_DM = 'D0SAM';
export const ANA = 'U0ANA';
export const ANA_DM = 'D0ANA';

export interface BehaviourWorld {
  readonly harness: Harness;
  readonly context: SlackContext;
  readonly fake: FakeSlack;
  readonly world: SlackWorld;
  readonly slack: { fetch: FakeSlack['fetch'] };
  /** How many times Slack was asked `method`. */
  asked(method: string): number;
}

export async function behaviourWorld(
  t: TestContext,
  options: { sendPolicy?: 'chat' | 'confirm' } = {},
): Promise<BehaviourWorld> {
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    ...(options.sendPolicy === undefined ? {} : { sendPolicy: options.sendPolicy }),
  });
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  const world = fake.world({
    users: { U0001: { display_name: 'Jo' }, [SAM]: { display_name: 'Sam' }, [ANA]: { display_name: 'Ana' } },
    rooms: {
      [ENG]: { name: 'eng', members: ['U0001', SAM, ANA] },
      [SAM_DM]: { is_im: true, user: SAM, members: ['U0001', SAM] },
      [ANA_DM]: { is_im: true, user: ANA, members: ['U0001', ANA] },
    },
    messages: [{ channel: ENG, ts: MINE, text: 'shipping in ten minuets', user: 'U0001', via: 'user' }],
  });
  const context = harness.context({ platform: 'darwin', surface: 'mcp' });
  return {
    harness,
    context,
    fake,
    world,
    slack: { fetch: fake.fetch },
    asked: (method) => fake.requests.filter((request) => request.method === method).length,
  };
}

/** A rule as the configuration holds it: an account by name, and what it may do there. */
export interface PlantedRule {
  readonly conversation?: string;
  readonly acts: readonly string[];
}

/**
 * Replaces the behaviour rules for `acme` with `rules`, bound to its id as a rule added through the core is. With the
 * person's consent, so a test can loosen as well as tighten: a tightening needs none, and is not refused for having it.
 */
export async function setRules(harness: Harness, rules: readonly PlantedRule[]): Promise<void> {
  await harness.core.config.update(
    (config) => {
      const accountId = config.accounts.acme?.id;
      return {
        ...config,
        behaviour: {
          rules: rules.map((rule) => ({
            account: 'acme',
            ...(accountId === undefined ? {} : { accountId }),
            ...(rule.conversation === undefined ? {} : { conversation: rule.conversation }),
            acts: [...rule.acts],
          })),
        },
      };
    },
    { consent: { kind: 'loosening-consent', paths: ['behaviour.rules'] } },
  );
}

/** How many approvals the store holds, whatever their state: a refusal at prepare makes none. */
export async function approvalCount(harness: Harness): Promise<number> {
  return (await harness.core.approvals.list()).length;
}

/** The refusal a promise rejects with — failing the test, with `what`, if it resolves. */
export async function refusedWith(work: Promise<unknown>, what: string): Promise<CommsError> {
  return work.then(
    (value) => {
      throw new Error(`${what}: it went through — ${JSON.stringify(value)}`);
    },
    (error: unknown) => error as CommsError,
  );
}
