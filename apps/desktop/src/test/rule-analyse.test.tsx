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
import { editorBridge } from './rule-editor-bridge.ts';

async function editInvoices(): Promise<HTMLElement> {
  const tab = await screen.findByRole('tab', { name: /^Rules\b/ });
  fireEvent.click(tab);
  const card = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-rule="invoices"]');
    if (found === null) throw new Error('no card');
    return found;
  });
  fireEvent.click(card);
  const page = await screen.findByRole('region', { name: 'Rule invoices' });
  fireEvent.click(await within(page).findByRole('button', { name: 'Edit…' }));
  return screen.findByRole('region', { name: 'Edit invoices' });
}

const suggestion = (view: HTMLElement, where: string) => within(view).getByRole('region', { name: where });

describe('Analyse', () => {
  it('runs only when pressed, on the stored rule, and shows each suggestion with where it ran', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    expect(service.calls('eventsRuleAnalyse')).toEqual([]);
    fireEvent.click(within(editor).getByRole('button', { name: 'Analyse this rule' }));
    const view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await within(view).findByText('3 suggestions');
    // The rule is the version that runs, unchanged: nothing is sent but its id.
    expect(service.calls('eventsRuleAnalyse')).toEqual([{ kind: 'eventsRuleAnalyse', ruleId: 'invoices' }]);
    expect(view.querySelector('[data-slot="ran-on"]')?.textContent).toBe(
      'Ran on OpenRouter, anthropic/claude-sonnet · sent the rule and its counts only',
    );
    expect(view.textContent).toContain('never the messages themselves');
    const question = suggestion(view, 'The judge’s question');
    expect(question.querySelector('[data-slot="before"]')?.textContent).toBe(
      'Is this asking me to pay or send something?',
    );
    expect(question.querySelector('[data-slot="after"]')?.textContent).toBe(
      'Is the sender asking me to pay them, or to send them an invoice?',
    );
    expect(question.querySelector('[data-slot="why"]')?.textContent).toContain('names who asks and for what');
    expect(suggestion(view, 'The judge’s bar').querySelector('[data-slot="after"]')?.textContent).toBe('Yes at 0.75');
    // What the event service wrote is text: its markup is never read as markup.
    const inputs = suggestion(view, 'What the judge looks at');
    expect(inputs.querySelector('img')).toBeNull();
    expect(inputs.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(view.textContent).toContain('3 of 3 will be applied. Nothing changes until you approve the new version.');
  });

  it('reads an unsaved draft from the editor, and applies only the suggestions kept, approving nothing', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    let editor = await editInvoices();
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Value 2' }), { target: { value: 'receipt' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Analyse' }));
    const view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await within(view).findByText('3 suggestions');
    const [asked] = service.calls('eventsRuleAnalyse') as Extract<Call, { kind: 'eventsRuleAnalyse' }>[];
    expect(asked?.ruleId).toBe('invoices');
    expect(JSON.stringify(asked?.draft)).toContain('"receipt"');
    // Skip the bar; keep the question and the inputs.
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
    const looks = within(editor).getByRole('button', { name: "Sender's address" });
    expect(looks.getAttribute('aria-pressed')).toBe('true');
    // The draft keeps its own edit, and nothing was stored, prepared or approved.
    expect((within(editor).getByRole('textbox', { name: 'Value 2' }) as HTMLInputElement).value).toBe('receipt');
    for (const kind of ['eventsRuleUpdate', 'eventsRuleEnable', 'eventsRuleApprove'] as const)
      expect(service.calls(kind), kind).toEqual([]);
  });

  it('a suggestion whose part changed since is not applied, and the editor says so', async () => {
    const service = editorBridge({
      fixtures: {
        eventsRuleAnalyse: {
          suggestions: [
            {
              part: '/agentic/question',
              before: 'Something else entirely',
              after: 'A new question',
              why: 'w',
              evidence: null,
            },
          ],
          provider: 'anthropic',
          model: null,
        },
      },
    });
    renderApp(service.bridge, { screen: 'events' });
    let editor = await editInvoices();
    fireEvent.click(within(editor).getByRole('button', { name: 'Analyse this rule' }));
    const view = await screen.findByRole('region', { name: 'Analyse invoices' });
    await within(view).findByText('1 suggestion');
    expect(view.querySelector('[data-slot="ran-on"]')?.textContent).toBe(
      'Ran on Anthropic · sent the rule and its counts only',
    );
    fireEvent.click(within(view).getByRole('button', { name: 'Apply and review…' }));
    editor = await screen.findByRole('region', { name: 'Edit invoices' });
    expect(editor.textContent).toContain('One suggestion was not applied: its part changed since Analyse read it.');
    expect((within(editor).getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement).value).toBe(
      'Is this asking me to pay or send something?',
    );
  });
});
