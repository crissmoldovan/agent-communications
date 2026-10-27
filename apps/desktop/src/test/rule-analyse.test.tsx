/*
 * Analyse (0.33.0, design 2026-10-26-rules-that-act-0330 §3.3, the prototype's RuleAnalyse): it runs only when the
 * person presses it — on the rule, or on the draft being edited, from stdin — shows each suggestion's before, after and
 * why, to apply or skip, and says where the model ran and that only the rule and its counts were sent. Apply and
 * review… puts the applied ones into the editor; nothing is approved. Its fixture is written to the spec's shape.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import { renderApp } from './render.tsx';
import { ANALYSE, editorBridge } from './rule-editor-bridge.ts';

async function editInvoices(): Promise<HTMLElement> {
  const tab = await screen.findByRole('tab', { name: /^Workflows\b/ });
  fireEvent.click(tab);
  const card = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-rule="invoices"]');
    if (found === null) throw new Error('no card');
    return found;
  });
  fireEvent.click(card);
  const page = await screen.findByRole('region', { name: 'Workflow invoices' });
  fireEvent.click(await within(page).findByRole('button', { name: 'Edit…' }));
  return screen.findByRole('region', { name: 'Edit invoices' });
}

const suggestion = (view: HTMLElement, where: string) => within(view).getByRole('region', { name: where });

describe('Analyse', () => {
  it('runs only when pressed, on the stored rule, and shows each suggestion, where it ran and what was sent', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    expect(service.calls('eventsRuleAnalyse')).toEqual([]);
    fireEvent.click(within(editor).getByRole('button', { name: 'Analyse this workflow' }));
    const view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await within(view).findByText('3 suggestions');
    // The rule is the version that runs, unchanged: nothing is sent but its id.
    expect(service.calls('eventsRuleAnalyse')).toEqual([{ kind: 'eventsRuleAnalyse', ruleId: 'invoices' }]);
    expect(view.querySelector('[data-slot="ran-on"]')?.textContent).toBe(
      'Ran on OpenRouter, anthropic/claude-sonnet-5.5.',
    );
    // What was sent, in the event service's own words.
    expect(view.querySelector('[data-slot="sent"]')?.textContent).toBe(
      "The rule's own text — its question, a session's text and a Linear title as you wrote them, and its condition with each address and domain replaced by <address> or <domain> — and content-free counts of its last 30 days. Never a message or anything from one: no sender, subject, body or address.",
    );
    // Only OpenRouter has a key: there is no other provider to run it on.
    expect(within(view).queryByRole('group', { name: 'Run on' })).toBeNull();
    // The sending domains are the senders' words: outside text, never markup.
    const domains = within(view).getByRole('list', { name: 'Sending domains the judge was asked about' });
    expect(domains.querySelectorAll('[data-slot="from-outside"]')).toHaveLength(2);
    expect(domains.querySelector('img')).toBeNull();
    expect(domains.textContent).toContain('<img src=x onerror=alert(1)>.example');
    expect(domains.textContent).toContain('judged 4: yes 0, no 4');
    const question = suggestion(view, 'The judge’s question');
    expect(question.querySelector('[data-slot="before"]')?.textContent).toBe(
      'Is this asking me to pay or send something?',
    );
    expect(question.querySelector('[data-slot="after"]')?.textContent).toBe(
      'Is the sender asking me to pay them, or to send them an invoice?',
    );
    expect(within(question).getByText('Written by a model')).toBeTruthy();
    // A model's words are text: its markup is never read as markup.
    expect(question.querySelector('img')).toBeNull();
    expect(question.querySelector('[data-slot="why"]')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(suggestion(view, 'The judge’s bar').querySelector('[data-slot="after"]')?.textContent).toBe(
      'yes at 0.79, if unsure drop',
    );
    expect(suggestion(view, 'Which messages').querySelector('[data-slot="after"]')?.textContent).toContain(
      'not from.address has domain "bank.example"',
    );
    // A note is only to read: no Apply or Skip.
    const note = suggestion(view, 'About this workflow');
    expect(within(note).queryByRole('group', { name: 'Keep this change' })).toBeNull();
    expect(view.textContent).toContain('3 of 3 will be applied. Nothing changes until you approve the new version.');
  });

  it('reads an unsaved draft from the editor, and applies only the suggestions kept, approving nothing', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    let editor = await editInvoices();
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Question' }), {
      target: { value: 'Is this asking me to pay or send something?' },
    });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'At most' }), { target: { value: '50' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Analyse' }));
    const view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await within(view).findByText('3 suggestions');
    const [asked] = service.calls('eventsRuleAnalyse') as Extract<Call, { kind: 'eventsRuleAnalyse' }>[];
    expect(asked?.ruleId).toBe('invoices');
    expect(asked?.draft?.deliveryRateCap).toBe(50);
    // Skip the bar; keep the question and which messages.
    fireEvent.click(
      within(within(suggestion(view, 'The judge’s bar')).getByRole('group', { name: 'Keep this change' })).getByRole(
        'button',
        { name: 'Skip' },
      ),
    );
    await waitFor(() => expect(view.textContent).toContain('2 of 3 will be applied.'));
    fireEvent.click(within(view).getByRole('button', { name: 'Apply and review…' }));
    editor = await screen.findByRole('region', { name: 'Edit invoices' });
    expect((within(editor).getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).value).toBe(
      'Is the sender asking me to pay them, or to send them an invoice?',
    );
    expect(editor.textContent).toContain('0.70');
    // The new condition has no control here: it is edited as text, and the text says it.
    const which = within(editor).getByRole('region', { name: 'Which messages' });
    expect(which.querySelector('[data-slot="edited-as-text"]')).not.toBeNull();
    fireEvent.click(
      within(within(editor).getByRole('group', { name: 'Edit as' })).getByRole('button', { name: 'Text' }),
    );
    const text = (await within(editor).findByRole('textbox', { name: 'The workflow as text' })) as HTMLTextAreaElement;
    expect(text.value).toContain('not from.address has domain "bank.example"');
    expect(text.value).toContain('at most 50 an hour');
    for (const kind of ['eventsRuleUpdate', 'eventsRuleEnable', 'eventsRuleApprove'] as const)
      expect(service.calls(kind), kind).toEqual([]);
  });

  it('a suggestion whose part changed since is not applied; with no key it says so; with both, the person picks', async () => {
    const service = editorBridge({
      fixtures: {
        eventsRuleAnalyse: (call: Call) => ({
          ruleId: 'invoices',
          suggestions: [
            {
              part: 'judge.question',
              before: 'Something else entirely',
              after: 'A new question',
              why: 'w',
              evidence: { by: 'model' },
            },
          ],
          model: {
            provider: (call as Extract<Call, { kind: 'eventsRuleAnalyse' }>).provider ?? 'openrouter',
            name:
              (call as Extract<Call, { kind: 'eventsRuleAnalyse' }>).provider === 'anthropic'
                ? 'Anthropic'
                : 'OpenRouter',
            model: null,
            noKey: [],
            sent: 'The rule only.',
            ran: true,
            reason: null,
            parts: [],
          },
          counts: { windowDays: 30, decisions: 0, domains: [] },
        }),
      },
    });
    renderApp(service.bridge, { screen: 'events' });
    let editor = await editInvoices();
    fireEvent.click(within(editor).getByRole('button', { name: 'Analyse this workflow' }));
    let view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await within(view).findByText('1 suggestion');
    // Both have keys: the person picks where it runs, and it runs again there.
    const runOn = within(view).getByRole('group', { name: 'Run on' });
    fireEvent.click(within(runOn).getByRole('button', { name: 'Anthropic' }));
    await waitFor(() =>
      expect(service.calls('eventsRuleAnalyse')).toEqual([
        { kind: 'eventsRuleAnalyse', ruleId: 'invoices' },
        { kind: 'eventsRuleAnalyse', ruleId: 'invoices', provider: 'anthropic' },
      ]),
    );
    view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await waitFor(() => expect(view.querySelector('[data-slot="ran-on"]')?.textContent).toBe('Ran on Anthropic.'));
    fireEvent.click(within(view).getByRole('button', { name: 'Apply and review…' }));
    editor = await screen.findByRole('region', { name: 'Edit invoices' });
    expect(editor.textContent).toContain('One suggestion was not applied: its part changed since Analyse read it.');
    expect((within(editor).getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).value).toBe(
      'Is this asking me to pay or send something?',
    );
  });

  it('with no key, no model ran, and the counts suggestions still come', async () => {
    const service = editorBridge({
      fixtures: {
        eventsRuleAnalyse: {
          ...ANALYSE,
          suggestions: ANALYSE.suggestions.filter((each) => each.evidence.by === 'counts'),
          model: {
            ...ANALYSE.model,
            provider: null,
            name: null,
            model: null,
            ran: false,
            reason: 'NO_KEY',
            noKey: ['openrouter', 'anthropic'],
          },
        },
      },
    });
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    fireEvent.click(within(editor).getByRole('button', { name: 'Analyse this workflow' }));
    const view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await within(view).findByText('2 suggestions');
    expect(view.querySelector('[data-slot="ran-on"]')?.textContent).toContain(
      'No model ran: there is no OpenRouter or Anthropic key on this Mac.',
    );
    expect(within(view).getByRole('link', { name: 'Add a key' })).toBeTruthy();
  });
});
