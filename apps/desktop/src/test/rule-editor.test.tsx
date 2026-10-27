/*
 * Editing a rule in the app (0.33.0, design 2026-10-26-rules-that-act-0330 §3.1–§3.2): Edit… and New rule… open the
 * editor; its visual and text modes edit one canonical document, kept in step; the text is checked as the person
 * types; and Review and approve… stores the version and prepares its activation, but nothing is approved until the
 * person types the rule's name and presses Approve and switch on. Every answer is a fixture written to the spec, the
 * activation's from what a real owner printed.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '../ipc.ts';
import { renderApp } from './render.tsx';
import { APPROVAL, DIGEST, editorBridge, JUDGE_SHOWS } from './rule-editor-bridge.ts';

// The app attests the person in the app only on macOS; elsewhere the review offers Approve in Terminal. These tests run
// as macOS unless one says otherwise.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

async function openRulesTab(): Promise<void> {
  const tab = await screen.findByRole('tab', { name: /^Rules\b/ });
  fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

async function card(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-rule="${id}"]`);
    if (found === null) throw new Error(`no card for ${id}`);
    return found;
  });
}

/** Opens invoices' page, then Edit…, and gives the editor's region. */
async function editInvoices(): Promise<HTMLElement> {
  await openRulesTab();
  fireEvent.click(await card('invoices'));
  const page = await screen.findByRole('region', { name: 'Rule invoices' });
  fireEvent.click(await within(page).findByRole('button', { name: 'Edit…' }));
  return screen.findByRole('region', { name: 'Edit invoices' });
}

function mode(editor: HTMLElement, name: 'Visual' | 'Text' | 'Advanced: JSON'): void {
  fireEvent.click(within(within(editor).getByRole('group', { name: 'Edit as' })).getByRole('button', { name }));
}

const textArea = (editor: HTMLElement) =>
  within(editor).getByRole('textbox', { name: 'The rule as text' }) as HTMLTextAreaElement;

const fieldValue = (editor: HTMLElement, name: string) =>
  (within(editor).getByRole('textbox', { name }) as HTMLInputElement | HTMLTextAreaElement).value;

describe('the rule editor', () => {
  it('Edit… opens the next version in five sections, each read from the document, with the rule in plain words', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    expect(within(editor).getByText('Version 3, not saved')).toBeTruthy();
    for (const section of ['When', 'Which messages', 'Ask a judge', 'Then do', "What's kept, and the limit"])
      expect(within(editor).getByRole('region', { name: section }), section).toBeTruthy();
    // Which messages: any of the two subject lines the document holds.
    expect(fieldValue(editor, 'Value 1')).toBe('invoice');
    expect(fieldValue(editor, 'Value 2')).toBe('payment');
    // The judge's question, as its author wrote it, in a field — never as markup.
    expect(fieldValue(editor, 'Question')).toBe('Is this asking me to pay or send something?');
    expect(within(editor).getByRole('switch', { name: 'Ask a judge' }).getAttribute('aria-checked')).toBe('true');
    // Then do: the Queue, lane billing; and the five ways to add an action, a webhook's left for later.
    const queue = editor.querySelector<HTMLElement>('[data-action="queue"]');
    expect(queue).not.toBeNull();
    expect((within(queue as HTMLElement).getByRole('textbox', { name: 'Lane' }) as HTMLInputElement).value).toBe(
      'billing',
    );
    const then = within(editor).getByRole('region', { name: 'Then do' });
    expect((within(then).getByRole('button', { name: 'Webhook' }) as HTMLButtonElement).disabled).toBe(true);
    for (const kind of ['Queue', 'Agent session', 'Linear issue', 'Dry-run log'])
      expect((within(then).getByRole('button', { name: kind }) as HTMLButtonElement).disabled, kind).toBe(false);
    // The plain words beside it say the same rule.
    const words = within(editor).getByRole('region', { name: 'In plain words' });
    expect(words.textContent).toContain('The subject contains invoice or payment');
    expect(words.textContent).toContain('Queue, lane billing');
    expect(editor.textContent).toContain(
      'Saving makes version 3. Version 2 keeps running until you approve version 3.',
    );
    // Nothing was stored or prepared by opening it.
    for (const kind of ['eventsRuleUpdate', 'eventsRuleEnable', 'eventsRuleApprove', 'eventsTargetUpdate'] as const)
      expect(service.calls(kind), kind).toEqual([]);
  });

  it('keeps the visual and text modes on one document, and shows its canonical JSON read-only', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Value 2' }), { target: { value: 'receipt' } });
    mode(editor, 'Text');
    const text = await waitFor(() => textArea(editor));
    expect(text.value).toContain('subject contains "receipt"');
    expect(text.value).toMatch(/^workflow invoices, version 3$/m);
    // An edit to the text is the visual editor's too.
    fireEvent.change(text, { target: { value: text.value.replace('"receipt"', '"refund"') } });
    mode(editor, 'Visual');
    await waitFor(() => expect(fieldValue(editor, 'Value 2')).toBe('refund'));
    mode(editor, 'Advanced: JSON');
    const json = await within(editor).findByRole('region', { name: 'Advanced: JSON' });
    expect(json.textContent).toContain('"value": "refund"');
    expect(within(json).queryByRole('textbox')).toBeNull();
    // And back, unchanged by looking.
    mode(editor, 'Visual');
    await waitFor(() => expect(fieldValue(editor, 'Value 1')).toBe('invoice'));
  });

  it('checks the text as it is typed: a mistake by line and column holds Visual and the review', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    mode(editor, 'Text');
    const text = await waitFor(() => textArea(editor));
    fireEvent.change(text, { target: { value: text.value.replace(/^then$/m, 'thne') } });
    const checks = await within(editor).findByRole('region', { name: 'Checks, as you type' });
    await waitFor(() =>
      expect(checks.textContent).toMatch(/Line \d+, column 1: unknown keyword "thne"; did you mean "then"\?/),
    );
    expect(checks.querySelectorAll('[data-check="error"]').length).toBeGreaterThan(0);
    const group = within(editor).getByRole('group', { name: 'Edit as' });
    expect((within(group).getByRole('button', { name: 'Visual' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(editor).getByRole('button', { name: 'Review and approve…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Fixed, it reads again: the checks say what they understood.
    fireEvent.change(text, { target: { value: text.value.replace(/^thne$/m, 'then') } });
    await waitFor(() =>
      expect(checks.textContent).toContain('Understood: 1 account, 2 conditions, a judge and 1 action.'),
    );
    expect(checks.textContent).toContain('billing is a lane that exists.');
    expect((within(group).getByRole('button', { name: 'Visual' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('checks an account this Mac lacks, a new lane, Linear not connected and a file a session may not read', async () => {
    const service = editorBridge({ linear: 'disconnected' });
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    const then = within(editor).getByRole('region', { name: 'Then do' });
    fireEvent.change(within(then).getByRole('textbox', { name: 'Lane' }), { target: { value: 'newlane' } });
    fireEvent.click(within(then).getByRole('button', { name: 'Linear issue' }));
    const linear = await waitFor(() => {
      const found = editor.querySelector<HTMLElement>('[data-action="linear"]');
      if (found === null) throw new Error('no Linear card');
      return found;
    });
    expect(within(linear).getByText("Linear isn't connected")).toBeTruthy();
    fireEvent.click(within(then).getByRole('button', { name: 'Agent session' }));
    const session = await waitFor(() => {
      const found = editor.querySelector<HTMLElement>('[data-action="session"]');
      if (found === null) throw new Error('no session card');
      return found;
    });
    fireEvent.change(within(session).getByRole('textbox', { name: 'Folder' }), {
      target: { value: '/example/home/work/acme' },
    });
    fireEvent.click(within(session).getByRole('button', { name: 'A file' }));
    fireEvent.change(await within(session).findByRole('textbox', { name: 'Path 2' }), {
      target: { value: '/example/elsewhere/notes.md' },
    });
    mode(editor, 'Text');
    const text = await waitFor(() => textArea(editor));
    fireEvent.change(text, {
      target: { value: text.value.replace('in_01EXAMPLE0000000000000000', 'in_01EXAMPLE0000000000000077') },
    });
    const checks = await within(editor).findByRole('region', { name: 'Checks, as you type' });
    await waitFor(() => expect(checks.textContent).toContain('This Mac has no account in_01EXAMPLE0000000000000077.'));
    expect(checks.textContent).toContain('newlane is a new lane');
    expect(checks.textContent).toContain("Linear isn't connected. Connect it before you approve.");
    expect(within(checks).getByRole('link', { name: 'Connect it' })).toBeTruthy();
    expect(checks.textContent).toContain(
      'The file /example/elsewhere/notes.md is outside the folders a session may be given.',
    );
    // The folder is inside the relay's own: no word about it.
    expect(checks.textContent).not.toContain('The folder /example/home/work/acme');
    // A new Linear issue names no team yet: that is a mistake, and the review waits for it.
    expect(checks.textContent).toContain('Choose the Linear team.');
    // The author's words are boxed as theirs.
    expect([...checks.querySelectorAll('[data-part="untrusted"]')].map((each) => each.textContent)).toContain(
      'newlane',
    );
  });

  it('a part with no control is edited as text and left as it was', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    mode(editor, 'Text');
    const text = await waitFor(() => textArea(editor));
    // A `not` around the two subject lines: the visual editor has no control for it.
    fireEvent.change(text, {
      target: {
        value: text.value.replace(
          /match any\n {2}subject contains "invoice"\n {2}subject contains "payment"/,
          'match not any\n  subject contains "invoice"\n  subject contains "payment"',
        ),
      },
    });
    mode(editor, 'Visual');
    const which = await within(editor).findByRole('region', { name: 'Which messages' });
    expect(which.querySelector('[data-slot="edited-as-text"]')).not.toBeNull();
    expect(within(which).queryByRole('textbox')).toBeNull();
    // Editing another section keeps it exactly.
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Question' }), { target: { value: 'Is it a bill?' } });
    mode(editor, 'Text');
    await waitFor(() => expect(textArea(editor).value).toContain('match not any'));
    expect(textArea(editor).value).toContain('question "Is it a bill?"');
  });

  it('nothing is approved until the person types the name and presses Approve; Back revokes; Approve switches it on', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    let editor = await editInvoices();
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Value 2' }), { target: { value: 'receipt' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Review and approve…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Approve version 3 of invoices' });
    // Stored on stdin's way, in order: the versions there are, the rule's next version, its activation and preview.
    expect(service.calls('eventsTargetsList').length).toBeGreaterThan(0);
    expect(service.calls('eventsTargetUpdate')).toEqual([]);
    const [update] = service.calls('eventsRuleUpdate') as Extract<Call, { kind: 'eventsRuleUpdate' }>[];
    expect(update?.document.version).toBe(3);
    expect(JSON.stringify(update?.document)).toContain('"receipt"');
    expect(service.calls('eventsRuleEnable')).toEqual([{ kind: 'eventsRuleEnable', ruleId: 'invoices', version: 3 }]);
    expect(service.calls('eventsApprovalView')).toEqual([
      { kind: 'eventsApprovalView', approvalId: APPROVAL, digest: DIGEST },
    ]);
    expect(service.calls('eventsRuleApprove')).toEqual([]);
    // The preview: what changes, and what leaves this Mac, from the activation's own document.
    expect(within(dialog).getByText('Version 2 keeps running until you approve.')).toBeTruthy();
    const changes = within(dialog).getByRole('region', { name: 'What changes' });
    expect(changes.textContent).toContain('The subject contains invoice or receipt');
    expect(changes.textContent).not.toContain('Queue, lane billing');
    const leaves = within(dialog).getByRole('region', { name: 'What leaves this Mac:' });
    expect(leaves.textContent).toContain('the subject and the first 300 characters of matching mail go to OpenRouter');
    expect(dialog.textContent).toContain(DIGEST);
    const approve = within(dialog).getByRole('button', { name: 'Approve and switch on' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type invoices to approve' }), {
      target: { value: 'invoice' },
    });
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(service.calls('eventsRuleApprove')).toEqual([]);
    // Back: the approval is revoked, nothing is switched on, and the editor stays.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(service.bridge.calls.filter((each) => each.command === 'revokePreview').map((each) => each.args)).toEqual([
        APPROVAL,
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    editor = await screen.findByRole('region', { name: 'Edit invoices' });
    expect(editor.textContent).toContain('Not approved: the new version was not switched on.');
    expect(service.calls('eventsRuleApprove')).toEqual([]);

    // Again, and this time the person approves.
    fireEvent.click(within(editor).getByRole('button', { name: 'Review and approve…' }));
    dialog = await screen.findByRole('dialog', { name: /^Approve version \d+ of invoices$/ });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type invoices to approve' }), {
      target: { value: 'invoices' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and switch on' }));
    await waitFor(() =>
      expect(service.calls('eventsRuleApprove')).toEqual([
        { kind: 'eventsRuleApprove', approvalId: APPROVAL, digest: DIGEST },
      ]),
    );
    // The editor closes on the rule's page; the approval it answered is not revoked.
    expect(await screen.findByRole('region', { name: 'Rule invoices' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Edit invoices' })).toBeNull();
    expect(service.bridge.calls.filter((each) => each.command === 'revokePreview')).toHaveLength(1);
  });

  it('on Windows and Linux the review offers Approve in Terminal: the terminal takes the challenge, the app none', async () => {
    platform.mac = false;
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Value 2' }), { target: { value: 'receipt' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Review and approve…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve version 3 of invoices' });
    // The same preview; no name to type and no in-app press.
    expect(within(dialog).getByRole('region', { name: 'What changes' })).toBeTruthy();
    expect(within(dialog).queryByRole('textbox', { name: 'Type invoices to approve' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Approve and switch on' })).toBeNull();
    expect(dialog.textContent).toContain('you approve it in a terminal: it shows this preview again');
    const terminal = () => service.bridge.calls.filter((each) => each.command === 'openInTerminal');
    expect(terminal()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve in Terminal' }));
    await waitFor(() =>
      expect(terminal().map((each) => each.args)).toEqual([{ kind: 'ruleApprove', approvalId: APPROVAL }]),
    );
    expect(await within(dialog).findByText(/^Finish in the terminal: type the challenge it shows\./u)).toBeTruthy();
    expect(service.calls('eventsRuleApprove')).toEqual([]);
    // Done leaves it to the terminal: nothing is revoked, and the rule's page reads it again.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('region', { name: 'Rule invoices' })).toBeTruthy();
    expect(service.bridge.calls.filter((each) => each.command === 'revokePreview')).toEqual([]);
    expect(service.calls('eventsRuleApprove')).toEqual([]);
  });

  it('on macOS, an approval the event service refuses as unattested is offered at the terminal instead', async () => {
    const service = editorBridge();
    // The event service's refusal of an approval from a process it cannot attest as the person's app.
    const cli = service.bridge.cli.bind(service.bridge);
    service.bridge.cli = async (call) =>
      call.kind === 'eventsRuleApprove'
        ? {
            status: 'failed',
            exit: 77,
            code: 'APPROVAL_REQUIRED',
            message: 'the app could not be attested as yours on this computer',
            hint: null,
          }
        : cli(call);
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Value 2' }), { target: { value: 'receipt' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Review and approve…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve version 3 of invoices' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Type invoices to approve' }), {
      target: { value: 'invoices' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and switch on' }));
    expect(await within(dialog).findByRole('button', { name: 'Approve in Terminal' })).toBeTruthy();
    expect(dialog.textContent).toContain('It was not switched on: the app could not be attested as yours');
    expect(within(dialog).queryByRole('button', { name: 'Approve and switch on' })).toBeNull();
    // Back still revokes it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(service.bridge.calls.filter((each) => each.command === 'revokePreview').map((each) => each.args)).toEqual([
        APPROVAL,
      ]),
    );
  });

  it('a changed target becomes its next version, and the rule carries the copy the event service stored', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    const then = within(editor).getByRole('region', { name: 'Then do' });
    fireEvent.change(within(then).getByRole('textbox', { name: 'Lane' }), { target: { value: 'accounts' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Review and approve…' }));
    await screen.findByRole('dialog', { name: 'Approve version 3 of invoices' });
    const [target] = service.calls('eventsTargetUpdate') as Extract<Call, { kind: 'eventsTargetUpdate' }>[];
    expect(target?.document).toMatchObject({ targetId: 'billing-queue', version: 2, lane: { name: 'accounts' } });
    const [update] = service.calls('eventsRuleUpdate') as Extract<Call, { kind: 'eventsRuleUpdate' }>[];
    const targets = (update?.document.targets ?? []) as unknown[];
    expect(targets[0]).toEqual(service.stored[0]?.document);
  });

  it('New rule… names the rule, then writes version 1 with a new target of its own', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    await openRulesTab();
    fireEvent.click(await screen.findByRole('button', { name: 'New rule…' }));
    const naming = await screen.findByRole('dialog', { name: 'New rule' });
    const name = within(naming).getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'invoices' } });
    expect(naming.textContent).toContain('A rule has this name already.');
    fireEvent.change(name, { target: { value: 'bad name' } });
    expect((within(naming).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'receipts-log' } });
    fireEvent.click(within(naming).getByRole('button', { name: 'Start' }));
    const editor = await screen.findByRole('region', { name: 'New rule receipts-log' });
    expect(within(editor).getByText('Version 1, not saved')).toBeTruthy();
    expect(editor.textContent).toContain('Saving makes version 1. Nothing runs until you approve it.');
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Value 1' }), { target: { value: 'receipt' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Review and approve…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve version 1 of receipts-log' });
    expect(within(dialog).getByText('Nothing runs until you approve.')).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'What leaves this Mac:' }).textContent).toBe(
      'What leaves this Mac:Nothing leaves this Mac.',
    );
    const [added] = service.calls('eventsTargetAdd') as Extract<Call, { kind: 'eventsTargetAdd' }>[];
    expect(added?.document).toMatchObject({ targetId: 'receipts-log-log', version: 1, kind: 'dry-run' });
    const [created] = service.calls('eventsRuleCreate') as Extract<Call, { kind: 'eventsRuleCreate' }>[];
    expect(created?.document).toMatchObject({ ruleId: 'receipts-log', version: 1 });
    expect(service.calls('eventsRuleUpdate')).toEqual([]);
    expect(service.calls('eventsRuleApprove')).toEqual([]);
  });

  it('the judge picker offers every live judge, and embeds the one chosen exactly as judge show gives it', async () => {
    const service = editorBridge();
    renderApp(service.bridge, { screen: 'events' });
    const editor = await editInvoices();
    // Both judges `judges list` names are offered, the one no rule carries yet among them; none is held back.
    fireEvent.click(within(editor).getByRole('combobox', { name: 'Judge' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((each) => each.textContent)).toEqual(['Jev, through OpenRouter, version 1', 'Jev, version 4']);
    expect(options.every((each) => each.getAttribute('aria-disabled') !== 'true')).toBe(true);
    expect(service.calls('judgeShow')).toEqual([]);
    const jev = await screen.findByRole('option', { name: 'Jev, version 4' });
    fireEvent.pointerMove(jev);
    fireEvent.mouseMove(jev);
    fireEvent.click(jev);
    await waitFor(() =>
      expect(service.calls('judgeShow')).toEqual([{ kind: 'judgeShow', judgeId: 'jev', version: 4 }]),
    );
    await waitFor(() =>
      expect(within(editor).getByRole('combobox', { name: 'Judge' }).textContent).toContain('Jev, version 4'),
    );
    // The question, inputs and bar the rule had stay; the judge is the shown document, byte for byte.
    expect(fieldValue(editor, 'Question')).not.toBe('');
    fireEvent.click(within(editor).getByRole('button', { name: 'Review and approve…' }));
    await screen.findByRole('dialog', { name: 'Approve version 3 of invoices' });
    const [update] = service.calls('eventsRuleUpdate') as Extract<Call, { kind: 'eventsRuleUpdate' }>[];
    const agentic = update?.document.agentic as Record<string, unknown>;
    expect(JSON.stringify(agentic.judge)).toBe(JSON.stringify(JUDGE_SHOWS['jev@4']?.document));
    const judges = update?.document.judges as unknown[] | undefined;
    expect(judges?.[0]).toEqual(JUDGE_SHOWS['jev@4']?.document);
  });

  it('a judge whose answer is not the live version asked for is not embedded, and the editor says so', async () => {
    for (const answer of [
      { ...JUDGE_SHOWS['jev@4'], state: 'revoked' },
      { ...JUDGE_SHOWS['jev@4'], version: 5 },
      { ...JUDGE_SHOWS['jev@4'], document: { ...JUDGE_SHOWS['jev@4']?.document, judgeId: 'jev-billing' } },
      { ...JUDGE_SHOWS['jev@4'], digest: 'not-a-digest' },
    ]) {
      const service = editorBridge({ fixtures: { judgeShow: answer } });
      const { unmount } = renderApp(service.bridge, { screen: 'events' });
      const editor = await editInvoices();
      fireEvent.click(within(editor).getByRole('combobox', { name: 'Judge' }));
      const jev = await screen.findByRole('option', { name: 'Jev, version 4' });
      fireEvent.pointerMove(jev);
      fireEvent.mouseMove(jev);
      fireEvent.click(jev);
      expect(await within(editor).findByText('That judge’s details could not be read.')).toBeTruthy();
      expect(within(editor).getByRole('combobox', { name: 'Judge' }).textContent).toContain(
        'Jev, through OpenRouter, version 1',
      );
      unmount();
    }
  }, 15_000);

  it('before 0.33.0 a rule page has no Edit…, and Rules no New rule…', async () => {
    const service = editorBridge({ fixtures: { version: '0.32.0' } });
    renderApp(service.bridge, { screen: 'events' });
    await openRulesTab();
    await card('invoices');
    expect(screen.queryByRole('button', { name: 'New rule…' })).toBeNull();
    fireEvent.click(await card('invoices'));
    const page = await screen.findByRole('region', { name: 'Rule invoices' });
    expect(within(page).queryByRole('button', { name: 'Edit…' })).toBeNull();
    expect(page.textContent).toContain('To change a rule, ask an agent to write a new version.');
  });
});
