/*
 * Describe it in the designer (0.36.0, plan F5, spec §11.4, W21): the box says what is sent before anything is sent;
 * the draft comes into the three views like any edit, each step with the person's words it came from or "Added by the
 * model, not from your words."; its questions come back with choices, and an answer goes into the next round with the
 * current draft; everything the model wrote is outside text; and nothing is saved until Save, which prepares a version
 * and opens Approve…. Every answer is a fixture; no model is asked.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Call, DescribeRequest } from '../ipc.ts';
import { printRuleText } from '../rule-text.ts';
import { DESCRIBE_COPY } from '../screens/workflows/Describe.tsx';
import { failed } from './fake-bridge.ts';
import { renderApp } from './render.tsx';
import { box, DESIGNER_SLOW, openDesigner, polyfillCanvas, REMINDERS, workflowService } from './workflow-bridge.ts';

const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

beforeAll(polyfillCanvas);

const WORDS = 'When a reminder comes in, wait an hour and then tell me to look at it again.';

/** The model's draft: reminders, its notice reworded, as the text says it. */
const DRAFTED = (() => {
  const document = JSON.parse(JSON.stringify(REMINDERS)) as typeof REMINDERS & {
    flow: { steps: { tell: { text: string } } };
  };
  document.flow.steps.tell.text = 'Look at the reminder again';
  return printRuleText(document);
})();

const ANSWER = {
  text: DRAFTED,
  notes: [{ step: 'wait', words: 'wait an hour' }],
  unnoted: ['tell'],
  questions: [{ step: 'tell', question: 'Should it tell you on Slack too?', choices: ['Only here', 'Slack too'] }],
  parse: { ok: true, errors: [] },
  check: { ok: true, problems: [] },
  model: { provider: 'claude-cli', model: 'claude-opus-5-5' },
};

function service(answer: unknown = ANSWER) {
  return workflowService(undefined, { eventsWorkflowDescribe: answer });
}

const describeCalls = (fake: ReturnType<typeof service>) =>
  fake.calls('eventsWorkflowDescribe') as Extract<Call, { kind: 'eventsWorkflowDescribe' }>[];

async function openDescribe(editor: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(within(editor).getByRole('button', { name: DESCRIBE_COPY.open }));
  return within(editor).findByRole('region', { name: DESCRIBE_COPY.title });
}

async function draft(box: HTMLElement): Promise<void> {
  fireEvent.change(within(box).getByRole('textbox', { name: DESCRIBE_COPY.words }), { target: { value: WORDS } });
  fireEvent.click(within(box).getByRole('button', { name: DESCRIBE_COPY.draft }));
  await within(box).findByRole('region', { name: DESCRIBE_COPY.steps });
}

describe('Describe it', () => {
  it('the box says what is sent before anything is sent', DESIGNER_SLOW, async () => {
    const fake = service();
    renderApp(fake.bridge, { screen: 'events' });
    const editor = await openDesigner('reminders');
    const panel = await openDescribe(editor);
    expect(panel.textContent).toContain(DESCRIBE_COPY.lead);
    const sent = within(panel).getByRole('region', { name: DESCRIBE_COPY.sent });
    expect(sent.textContent).toContain(DESCRIBE_COPY.sentLine);
    expect(sent.textContent).toContain(DESCRIBE_COPY.neverLine);
    // Your Claude first, and nothing asked until Draft it.
    expect(
      within(panel).getByRole('radio', { name: DESCRIBE_COPY.providers['claude-cli'] }).getAttribute('aria-checked'),
    ).toBe('true');
    expect((within(panel).getByRole('button', { name: DESCRIBE_COPY.draft }) as HTMLButtonElement).disabled).toBe(true);
    expect(describeCalls(fake)).toEqual([]);
  });

  it(
    'the draft opens in the three views; each step shows its words or "Added by the model, not from your words."',
    DESIGNER_SLOW,
    async () => {
      const fake = service();
      renderApp(fake.bridge, { screen: 'events' });
      const editor = await openDesigner('reminders');
      const panel = await openDescribe(editor);
      fireEvent.change(within(panel).getByRole('textbox', { name: DESCRIBE_COPY.example }), {
        target: { value: 'Reminder: renew the domain' },
      });
      await draft(panel);
      expect(describeCalls(fake)).toEqual([
        {
          kind: 'eventsWorkflowDescribe',
          request: { words: WORDS, example: 'Reminder: renew the domain' },
          provider: 'claude-cli',
        },
      ]);
      const steps = within(panel).getByRole('region', { name: DESCRIBE_COPY.steps });
      expect(steps.querySelector('[data-describe-step="wait"]')?.textContent).toContain('wait an hour');
      expect(steps.querySelector('[data-describe-step="tell"]')?.textContent).toContain(DESCRIBE_COPY.added);
      // In the canvas, and in the text, with this workflow's name and its next version.
      await box(editor, 'tell');
      fireEvent.click(
        within(within(editor).getByRole('group', { name: 'View as' })).getByRole('button', { name: 'Text' }),
      );
      const text = (await within(editor).findByRole('textbox', {
        name: 'The workflow as text',
      })) as HTMLTextAreaElement;
      await waitFor(() => expect(text.value).toContain('tell me "Look at the reminder again"'));
      expect(text.value).toMatch(/^workflow reminders, version 2$/m);
    },
  );

  it(
    'questions come back with choices; an answer goes into the description and the current draft goes along',
    DESIGNER_SLOW,
    async () => {
      const fake = service();
      renderApp(fake.bridge, { screen: 'events' });
      const editor = await openDesigner('reminders');
      const panel = await openDescribe(editor);
      await draft(panel);
      const questions = within(panel).getByRole('region', { name: DESCRIBE_COPY.questions });
      expect(questions.textContent).toContain('Should it tell you on Slack too?');
      fireEvent.click(within(questions).getByRole('button', { name: /Slack too/ }));
      expect(panel.textContent).toContain(DESCRIBE_COPY.answered(1));
      fireEvent.click(within(panel).getByRole('button', { name: DESCRIBE_COPY.again }));
      await waitFor(() => expect(describeCalls(fake)).toHaveLength(2));
      const asked = describeCalls(fake)[1]?.request as DescribeRequest;
      expect(asked.words).toBe(WORDS);
      expect(asked.answers).toEqual([{ question: 'Should it tell you on Slack too?', answer: 'Slack too' }]);
      // The current draft goes along, as its text.
      expect(typeof asked.draft).toBe('string');
      expect(asked.draft).toContain('tell me "Look at the reminder again"');
    },
  );

  it(
    'a note counts as your words only when it quotes your description or an answer you typed, never a choice it offered',
    DESIGNER_SLOW,
    async () => {
      // Security review of 0.36.0, L7: a two-letter quote, or the words of a choice the model itself offered, showed as
      // "From your words" in place of the warning-coloured "Added by the model".
      const choice = 'Slack too, and by email as well';
      const rounds = [
        {
          ...ANSWER,
          questions: [
            { step: 'tell', question: 'Should it tell you on Slack too?', choices: ['Only here', choice] },
            { step: 'wait', question: 'How long should it wait?', choices: [] },
          ],
        },
        {
          ...ANSWER,
          text: (() => {
            const document = JSON.parse(JSON.stringify(REMINDERS)) as typeof REMINDERS & {
              flow: { steps: Record<string, unknown> };
            };
            document.flow.steps.tell = { kind: 'notify', text: 'Time to look at it again', next: { sent: 'remind' } };
            document.flow.steps.remind = { kind: 'notify', text: 'Remind me', next: { sent: 'again' } };
            document.flow.steps.again = { kind: 'notify', text: 'And again', next: {} };
            return printRuleText(document);
          })(),
          notes: [
            { step: 'wait', words: 'wait an hour' },
            { step: 'tell', words: choice },
            { step: 'remind', words: 'to' },
            { step: 'again', words: 'ninety minutes, I think' },
          ],
          unnoted: [],
          questions: [],
        },
      ];
      let round = 0;
      const fake = service(() => rounds[Math.min(round++, rounds.length - 1)]);
      renderApp(fake.bridge, { screen: 'events' });
      const editor = await openDesigner('reminders');
      const panel = await openDescribe(editor);
      await draft(panel);
      const questions = within(panel).getByRole('region', { name: DESCRIBE_COPY.questions });
      fireEvent.click(within(questions).getByRole('button', { name: /Slack too, and by email as well/ }));
      fireEvent.change(
        within(questions).getByRole('textbox', { name: `${DESCRIBE_COPY.answer}: How long should it wait?` }),
        { target: { value: 'About ninety minutes, I think' } },
      );
      fireEvent.click(within(panel).getByRole('button', { name: DESCRIBE_COPY.again }));
      await waitFor(() => expect(describeCalls(fake)).toHaveLength(2));
      const said = async (step: string) => {
        const steps = await within(panel).findByRole('region', { name: DESCRIBE_COPY.steps });
        await waitFor(() => expect(steps.querySelector(`[data-describe-step="${step}"]`)).not.toBeNull());
        return steps.querySelector(`[data-describe-step="${step}"]`)?.textContent ?? '';
      };
      await waitFor(async () => expect(await said('remind')).toContain(DESCRIBE_COPY.added));
      expect(await said('wait')).toContain(DESCRIBE_COPY.fromWords);
      expect(await said('tell')).toContain(DESCRIBE_COPY.added);
      expect(await said('again')).toContain(DESCRIBE_COPY.fromWords);
    },
  );

  it('the draft, notes and questions render as outside text', DESIGNER_SLOW, async () => {
    const broken = {
      ...ANSWER,
      text: 'workflow reminders, version 1\nwhen <b>something</b> happens',
      parse: { ok: false, errors: [{ line: 2, column: 1, message: 'a when section names an account' }] },
      check: null,
    };
    const fake = service(broken);
    renderApp(fake.bridge, { screen: 'events' });
    const editor = await openDesigner('reminders');
    const panel = await openDescribe(editor);
    await draft(panel);
    const outside = (region: string) =>
      within(panel).getByRole('region', { name: region }).querySelectorAll('[data-slot="from-outside"]');
    expect(outside(DESCRIBE_COPY.steps).length).toBeGreaterThan(0);
    expect(outside(DESCRIBE_COPY.questions).length).toBeGreaterThanOrEqual(3);
    const mistakes = within(panel).getByRole('region', { name: DESCRIBE_COPY.mistakes });
    expect(mistakes.textContent).toContain('Line 2:');
    expect(mistakes.querySelector('[data-slot="from-outside"]')?.textContent).toContain('<b>something</b>');
    expect(mistakes.querySelector('b')).toBeNull();
    // A draft that does not read is shown, not put into the canvas.
    await box(editor, 'tell');
    expect(within(panel).queryByRole('status')).toBeNull();
  });

  it('nothing is saved until Save; Save prepares a version and opens Approve…', DESIGNER_SLOW, async () => {
    const fake = service();
    renderApp(fake.bridge, { screen: 'events' });
    const editor = await openDesigner('reminders');
    const panel = await openDescribe(editor);
    await draft(panel);
    for (const kind of ['eventsRuleUpdate', 'eventsRuleCreate', 'eventsRuleEnable', 'eventsTargetAdd'] as const)
      expect(fake.calls(kind), kind).toEqual([]);
    const approve = within(editor).getByRole('button', { name: 'Review and approve…' }) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    fireEvent.click(approve);
    expect(
      await screen.findByRole('dialog', { name: 'Approve version 2 of reminders' }, { timeout: 15_000 }),
    ).toBeTruthy();
    const saved = fake.calls('eventsRuleUpdate') as Extract<Call, { kind: 'eventsRuleUpdate' }>[];
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved[0]?.document)).toContain('Look at the reminder again');
    expect(fake.calls('eventsRuleEnable')).toHaveLength(1);
  });

  it('a Claude Code that is not found says so, and another provider can be picked', DESIGNER_SLOW, async () => {
    const fake = workflowService(undefined, {});
    const cli = fake.bridge.cli;
    fake.bridge.cli = async (call) => {
      if (!(call.kind === 'eventsWorkflowDescribe' && call.provider === 'claude-cli')) return cli(call);
      fake.bridge.calls.push({ command: 'cli', args: call });
      return failed(
        'PROVIDER_UNAVAILABLE',
        'Claude Code was not found on this Mac',
        'Install and sign in to Claude Code, or describe it with a key kept for Analyse.',
        69,
      );
    };
    renderApp(fake.bridge, { screen: 'events' });
    const editor = await openDesigner('reminders');
    const panel = await openDescribe(editor);
    fireEvent.change(within(panel).getByRole('textbox', { name: DESCRIBE_COPY.words }), { target: { value: WORDS } });
    fireEvent.click(within(panel).getByRole('button', { name: DESCRIBE_COPY.draft }));
    expect(await within(panel).findByText(/Claude Code was not found on this Mac/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('radio', { name: DESCRIBE_COPY.providers.openrouter }));
    fireEvent.click(within(panel).getByRole('button', { name: DESCRIBE_COPY.draft }));
    await waitFor(() =>
      expect(
        fake.bridge.calls
          .filter((each) => each.command === 'cli' && (each.args as Call).kind === 'eventsWorkflowDescribe')
          .map((each) => (each.args as Extract<Call, { kind: 'eventsWorkflowDescribe' }>).provider),
      ).toEqual(['claude-cli', 'openrouter']),
    );
  });
});
