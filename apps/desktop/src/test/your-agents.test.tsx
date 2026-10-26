import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LabelReport } from '../cli-types.ts';
import { COPY } from '../copy.ts';
import type { Call, CliResult, Installation } from '../ipc.ts';
import { takeDestination } from '../navigation.tsx';
import { YOUR_AGENTS_COPY } from '../screens/YourAgents.tsx';
import {
  cliKinds,
  createFakeBridge,
  EXAMPLE_INSTALLATION,
  type FakeBridge,
  type Fixture,
  failed,
  ok,
} from './fake-bridge.ts';
import label from './fixtures/label.populated.json';
import { renderApp } from './render.tsx';

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const AGAIN = 'ap_5S6T7V8W9X0Y1Z2A3B4C5D6E7F';
const AT_0340: Installation = { ...EXAMPLE_INSTALLATION, version: '0.34.0' };

/** The populated label with Slack's kinds in full, as core lists every kind a channel has. */
const LABEL: LabelReport = {
  ...(label as LabelReport),
  accounts: (label as LabelReport).accounts.map((account) =>
    account.platform === 'slack'
      ? {
          ...account,
          kinds: ['post', 'reply', 'reaction', 'edit', 'file'].map((kind) => ({
            kind,
            identity: 'agent' as const,
            source: 'default' as const,
            appearsAs: 'Jo Example (agent)',
          })),
        }
      : account,
  ),
};

function pending(
  approvalId = ID,
  preview = 'Change the label’s word\n  agent → assistant\n<img src=x onerror=alert(1)>',
): CliResult {
  return { status: 'approvalPending', approvalId, preview, expiresAt: '2026-10-26T23:10:00.000Z' };
}

/** A bridge at `installation`, whose `cli` answers `answer(call)` when it gives one, and from the fixtures otherwise. */
function bridgeAt(
  installation: Installation,
  answer: (call: Call) => CliResult | undefined = () => undefined,
  fixtures: Partial<Record<Call['kind'], Fixture>> = { label: LABEL },
): FakeBridge {
  const plain = createFakeBridge({}, fixtures);
  return createFakeBridge(
    { installation: async () => installation, cli: async (call) => answer(call) ?? plain.cli(call) },
    fixtures,
  );
}

function cliCalls(bridge: FakeBridge, kind: Call['kind']): Call[] {
  return bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === kind)
    .map((call) => call.args as Call);
}

async function region(name: string): Promise<HTMLElement> {
  return screen.findByRole('region', { name });
}

/** Chooses `option` in the picker named `name`, as a pointer does. */
async function choose(within_: HTMLElement, name: string, option: string): Promise<void> {
  fireEvent.click(within(within_).getByRole('combobox', { name }));
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerMove(item);
  fireEvent.mouseMove(item);
  fireEvent.click(item);
  await waitFor(() => expect(within(within_).getByRole('combobox', { name }).textContent).toContain(option));
}

describe('Your agents: what people see', () => {
  it('the sidebar names it, and the previews and facts are made from the label and the first Gmail address', async () => {
    const bridge = bridgeAt(AT_0340);
    renderApp(bridge, { screen: 'agent' });
    const seen = await region(YOUR_AGENTS_COPY.seen);
    expect(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Your agents' }),
    ).toBeTruthy();
    expect(within(seen).getByRole('figure', { name: 'In Slack' }).textContent).toContain(
      `Jo Example (agent): ${YOUR_AGENTS_COPY.sample}`,
    );
    const mail = within(seen).getByRole('figure', { name: 'In mail' });
    expect(within(mail).getByText('"Jo Example (agent)" <jo@example.com>')).toBeTruthy();
    expect(within(mail).getByText(YOUR_AGENTS_COPY.mailCaption)).toBeTruthy();
    expect(within(seen).getAllByText('Jo Example').length).toBeGreaterThan(0);
    expect(within(seen).getByRole('button', { name: `${YOUR_AGENTS_COPY.change} your name` })).toBeTruthy();
    expect(within(seen).getByRole('button', { name: `${YOUR_AGENTS_COPY.change} the word` })).toBeTruthy();
    // Read once each when it opens: the label, what agents may do, and the Gmail and Slack accounts.
    await waitFor(() => expect(cliKinds(bridge).filter((kind) => kind === 'accounts')).toHaveLength(2));
    expect(cliKinds(bridge).filter((kind) => kind === 'label')).toHaveLength(1);
    expect(cliKinds(bridge).filter((kind) => kind === 'behaviour')).toHaveLength(1);
    expect(screen.queryByText(COPY.updateToUse)).toBeNull();
  });

  it('with no name set, the mail line says the name is Gmail’s “Send mail as”; with no Gmail, a placeholder', async () => {
    const report: LabelReport = { ...(label as LabelReport), name: null };
    const bridge = createFakeBridge(
      { installation: async () => ({ ...AT_0340, present: ['core', 'slack'] }) },
      { label: report },
    );
    renderApp(bridge, { screen: 'agent' });
    const seen = await region(YOUR_AGENTS_COPY.seen);
    const mail = within(seen).getByRole('figure', { name: 'In mail' });
    expect(within(mail).getByText('"Your Gmail name (agent)" <your address>')).toBeTruthy();
    expect(within(mail).getByText(YOUR_AGENTS_COPY.mailNoName)).toBeTruthy();
    expect(within(seen).getByText(YOUR_AGENTS_COPY.notSet)).toBeTruthy();
    expect(
      bridge.calls.some(
        (call) =>
          (call.args as Call | undefined)?.kind === 'accounts' &&
          (call.args as { product?: string }).product === 'gmail',
      ),
    ).toBe(false);
  });

  it('an older core shows the label read-only, with the line that asks for an update, and changes nothing', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'agent' });
    const seen = await region(YOUR_AGENTS_COPY.seen);
    expect(screen.getByText(COPY.updateToUse)).toBeTruthy();
    expect(screen.getByText('Needs 0.34.0 or later; this machine has 0.24.0.')).toBeTruthy();
    expect(within(seen).queryByRole('button', { name: /Change/ })).toBeNull();
    const exceptions = await region(YOUR_AGENTS_COPY.exceptions);
    expect(within(exceptions).getByText('Every message on example/gmail goes as you, without the tag')).toBeTruthy();
    expect(within(exceptions).queryByRole('button', { name: YOUR_AGENTS_COPY.remove })).toBeNull();
    expect(within(exceptions).queryByRole('button', { name: YOUR_AGENTS_COPY.addException })).toBeNull();
  });
});

describe('Your agents: the name and the word', () => {
  it('a new word is prepared, its preview shown, and approved here with the approval the app prepared', async () => {
    const bridge = bridgeAt(AT_0340, (call) => {
      if (call.kind !== 'labelWord') return undefined;
      return call.appApproval === undefined
        ? pending()
        : ok({ change: 'word', changed: true, ...label, word: 'assistant' });
    });
    renderApp(bridge, { screen: 'agent' });
    const seen = await region(YOUR_AGENTS_COPY.seen);
    fireEvent.click(within(seen).getByRole('button', { name: `${YOUR_AGENTS_COPY.change} the word` }));
    const ask = within(seen).getByRole('region', { name: YOUR_AGENTS_COPY.everyone });
    await choose(ask, YOUR_AGENTS_COPY.wordField, 'assistant');
    expect(within(ask).getByText(`Jo Example (assistant): ${YOUR_AGENTS_COPY.sample}`)).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: YOUR_AGENTS_COPY.next }));
    // Core's preview, as text, under the question it answers.
    expect(await within(seen).findByText(YOUR_AGENTS_COPY.everyoneApprove)).toBeTruthy();
    expect(within(seen).getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
    expect(seen.querySelector('img')).toBeNull();
    expect(cliCalls(bridge, 'labelWord')).toEqual([{ kind: 'labelWord', word: 'assistant' }]);
    fireEvent.click(within(seen).getByRole('button', { name: YOUR_AGENTS_COPY.approve }));
    expect(
      await within(seen).findByText('Approved. From now on, agents’ messages read “Jo Example (assistant)”.'),
    ).toBeTruthy();
    expect(cliCalls(bridge, 'labelWord')).toEqual([
      { kind: 'labelWord', word: 'assistant' },
      { kind: 'labelWord', word: 'assistant', appApproval: ID },
    ]);
    await waitFor(() => expect(cliKinds(bridge).filter((kind) => kind === 'label')).toHaveLength(2));
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  it('a name the label cannot carry, or the one there already, asks nothing', async () => {
    const bridge = bridgeAt(AT_0340);
    renderApp(bridge, { screen: 'agent' });
    const seen = await region(YOUR_AGENTS_COPY.seen);
    fireEvent.click(within(seen).getByRole('button', { name: `${YOUR_AGENTS_COPY.change} your name` }));
    const ask = within(seen).getByRole('region', { name: YOUR_AGENTS_COPY.everyone });
    const field = within(ask).getByRole('textbox', { name: YOUR_AGENTS_COPY.yourName });
    fireEvent.change(field, { target: { value: 'Jo (agent)' } });
    fireEvent.click(within(ask).getByRole('button', { name: YOUR_AGENTS_COPY.next }));
    expect(
      await within(ask).findByText('A name can’t hold ( ) < > " @ , ; : or \\. Nothing was changed.'),
    ).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Jo Example' } });
    fireEvent.click(within(ask).getByRole('button', { name: YOUR_AGENTS_COPY.next }));
    expect(await within(ask).findByText('Nothing to change: that is your name already.')).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: COPY.cancel }));
    expect(await within(seen).findByText(YOUR_AGENTS_COPY.cancelled)).toBeTruthy();
    expect(cliCalls(bridge, 'labelName')).toEqual([]);
  });

  it('a voided approval prepares the change again and shows its new preview', async () => {
    let prepared = 0;
    const bridge = bridgeAt(AT_0340, (call) => {
      if (call.kind !== 'labelName') return undefined;
      if (call.appApproval === undefined) {
        prepared += 1;
        return pending(prepared === 1 ? ID : AGAIN, `Set the label's name\n  Jo Example → Jo Q${prepared}`);
      }
      return failed('APPROVAL_VOID', 'that approval was prepared for another change, and is void now', null, 10);
    });
    renderApp(bridge, { screen: 'agent' });
    const seen = await region(YOUR_AGENTS_COPY.seen);
    fireEvent.click(within(seen).getByRole('button', { name: `${YOUR_AGENTS_COPY.change} your name` }));
    const ask = within(seen).getByRole('region', { name: YOUR_AGENTS_COPY.everyone });
    fireEvent.change(within(ask).getByRole('textbox', { name: YOUR_AGENTS_COPY.yourName }), {
      target: { value: 'Jo Q' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: YOUR_AGENTS_COPY.next }));
    expect(await within(seen).findByText(/Jo Q1/)).toBeTruthy();
    fireEvent.click(within(seen).getByRole('button', { name: YOUR_AGENTS_COPY.approve }));
    expect(await within(seen).findByText(/Jo Q2/)).toBeTruthy();
    expect(within(seen).getByText(YOUR_AGENTS_COPY.voided)).toBeTruthy();
    expect(cliCalls(bridge, 'labelName')).toEqual([
      { kind: 'labelName', name: 'Jo Q' },
      { kind: 'labelName', name: 'Jo Q', appApproval: ID },
      { kind: 'labelName', name: 'Jo Q' },
    ]);
    // Never the terminal: a voided approval is prepared again, not sent there.
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });
});

describe('Your agents: the exceptions', () => {
  it('removing one that sends messages as you applies at once, and never carries an approval', async () => {
    const bridge = bridgeAt(AT_0340, (call) =>
      call.kind === 'labelRuleRemove'
        ? ok({ change: 'removeRule', changed: true, note: null, ...label, rules: [] })
        : undefined,
    );
    renderApp(bridge, { screen: 'agent' });
    const exceptions = await region(YOUR_AGENTS_COPY.exceptions);
    const line = (
      await within(exceptions).findByText('Every message on example/gmail goes as you, without the tag')
    ).closest('li') as HTMLElement;
    fireEvent.click(within(line).getByRole('button', { name: YOUR_AGENTS_COPY.remove }));
    expect(await within(exceptions).findByText(YOUR_AGENTS_COPY.removedAtOnce)).toBeTruthy();
    expect(cliCalls(bridge, 'labelRuleRemove')).toEqual([
      { kind: 'labelRuleRemove', account: 'example/gmail', as: 'me' },
    ]);
    await waitFor(() => expect(cliKinds(bridge).filter((kind) => kind === 'label')).toHaveLength(2));
    expect(within(exceptions).queryByText(YOUR_AGENTS_COPY.takeAway)).toBeNull();
  });

  it('adding one checks the kind against the account, then asks for approval; refused as unattested, it goes to Terminal', async () => {
    const bridge = bridgeAt(AT_0340, (call) => {
      if (call.kind !== 'labelRuleAdd') return undefined;
      if (call.appApproval === undefined) return pending(ID, 'Send reaction from example/slack as you, with no label');
      return failed(
        'APPROVAL_REQUIRED',
        'nothing on this platform attests that the app started this command',
        'In the app, press Approve in Terminal.',
        10,
      );
    });
    renderApp(bridge, { screen: 'agent' });
    const exceptions = await region(YOUR_AGENTS_COPY.exceptions);
    fireEvent.click(within(exceptions).getByRole('button', { name: YOUR_AGENTS_COPY.addException }));
    const ask = within(exceptions).getByRole('region', { name: YOUR_AGENTS_COPY.asYou });
    // Reactions, on the first account that labels: mail has none.
    fireEvent.click(within(ask).getByRole('button', { name: YOUR_AGENTS_COPY.next }));
    expect(
      await within(ask).findByText('Gmail has no reactions for agents to send. Choose replies, or every message.'),
    ).toBeTruthy();
    expect(cliCalls(bridge, 'labelRuleAdd')).toEqual([]);
    await choose(ask, YOUR_AGENTS_COPY.in, 'example/slack');
    expect(
      within(ask).getByText(
        'People will read agents’ reactions on example/slack as if you wrote them yourself, with no “(agent)”.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: YOUR_AGENTS_COPY.next }));
    expect(await within(exceptions).findByText(YOUR_AGENTS_COPY.asYouApprove)).toBeTruthy();
    fireEvent.click(within(exceptions).getByRole('button', { name: YOUR_AGENTS_COPY.approve }));
    // Refused here: the same change, approved in Terminal instead.
    fireEvent.click(await within(exceptions).findByRole('button', { name: COPY.approveInTerminal }));
    await waitFor(() => expect(bridge.calls.map((call) => call.command)).toContain('openInTerminal'));
    const prepared = { kind: 'labelRuleAdd', account: 'example/slack', as: 'me', kinds: 'reaction' };
    expect(cliCalls(bridge, 'labelRuleAdd')).toEqual([prepared, { ...prepared, appApproval: ID }]);
    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([
      { command: 'openInTerminal', args: { kind: 'change', call: prepared, revoke: ID } },
    ]);
    expect(await within(exceptions).findByText(YOUR_AGENTS_COPY.confirmInTerminal)).toBeTruthy();
  });
});

describe('Your agents: per account', () => {
  it('one line per account says what agents may do and how they look, and opens that account in Accounts', async () => {
    const bridge = bridgeAt(AT_0340);
    renderApp(bridge, { screen: 'agent' });
    const per = await region(YOUR_AGENTS_COPY.perAccount);
    const slack = await within(per).findByRole('button', { name: 'example/slack: open in Accounts' });
    await waitFor(() => expect(slack.textContent).toContain('Agents may reply and react.'));
    expect(slack.textContent).toContain('Slack · Example');
    expect(slack.textContent).toContain('as the Agent Comms app, with Slack’s APP badge');
    const gmail = within(per).getByRole('button', { name: 'example/gmail: open in Accounts' });
    expect(gmail.textContent).toContain('Gmail · jo@example.com');
    expect(gmail.textContent).toContain('Agents may do anything this account allows; in @example.com, nothing.');
    expect(gmail.textContent).toContain('Their messages go as you, with no tag.');
    fireEvent.click(slack);
    expect(await screen.findByRole('heading', { name: 'Accounts', level: 1 })).toBeTruthy();
    expect(takeDestination('accounts')).toEqual({ screen: 'accounts', account: 'example/slack' });
  });
});
