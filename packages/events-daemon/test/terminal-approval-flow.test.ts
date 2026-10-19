import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { runTerminalApprovalFlow } from '../src/cli/program.ts';

/** A start with one pending target and one pending rule judge, and the challenge a person types. */
const START = {
  challenge: 'ABCD',
  pendingTargetSelectors: [{ kind: 'pending-activation', targetId: 'log', targetVersion: 1 } as never],
  pendingRuleJudgeTestSelectors: [{ kind: 'pending-rule-judge', judgeId: 'j', judgeVersion: 1 } as never],
};

test('CUE-475: a refused optional test is reported, and the approval still asks for its challenge', async () => {
  const prompts: string[] = [];
  const printed: unknown[] = [];
  const approved: [string, string][] = [];
  await runTerminalApprovalFlow({
    approvalId: 'ap_TEST',
    terminal: {
      async question(prompt) {
        prompts.push(prompt);
        return prompt.startsWith('Type this approval challenge') ? 'ABCD' : 'y';
      },
    },
    start: async () => START,
    testPendingTarget: async () => {
      throw new CommsError('USAGE', 'collection is switched off, so a target cannot be tested yet');
    },
    testPendingRuleJudge: async () => {
      throw new CommsError('USAGE', 'the judge test could not run');
    },
    approve: async (approvalId, answer) => {
      approved.push([approvalId, answer]);
      return { status: 'completed' };
    },
    print: (result) => printed.push(result),
  });
  assert.equal(prompts.length, 3, 'both optional tests are offered, then the challenge');
  assert.match(prompts[2] ?? '', /^Type this approval challenge: ABCD/, 'the challenge is still asked for');
  assert.deepEqual(approved, [['ap_TEST', 'ABCD']], 'and the approval goes ahead on the typed challenge');
  assert.deepEqual(
    printed,
    [
      {
        pendingTarget: 1,
        test: 'not run',
        reason: 'collection is switched off, so a target cannot be tested yet',
      },
      { pendingRuleJudge: 1, test: 'not run', reason: 'the judge test could not run' },
      { status: 'completed' },
    ],
    'each refused test says why it did not run, and the approval result follows',
  );
});

test('CUE-475: a person can still decline after a refused test, by not typing the challenge', async () => {
  const approved: string[] = [];
  await assert.rejects(
    runTerminalApprovalFlow({
      approvalId: 'ap_TEST',
      terminal: {
        async question(prompt) {
          return prompt.startsWith('Type this approval challenge') ? 'WRONG' : 'y';
        },
      },
      start: async () => ({ ...START, pendingRuleJudgeTestSelectors: [] }),
      testPendingTarget: async () => {
        throw new CommsError('USAGE', 'collection is switched off, so a target cannot be tested yet');
      },
      approve: async (_approvalId, answer) => {
        approved.push(answer);
        throw new CommsError('APPROVAL_REQUIRED', 'the challenge did not match');
      },
      print: () => undefined,
    }),
    /the challenge did not match/,
    'a wrong challenge is refused as before',
  );
  assert.deepEqual(approved, ['WRONG'], 'the typed answer, and only it, went to the approval');
});
