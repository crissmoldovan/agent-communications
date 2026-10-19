import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BehaviourReport } from '../cli-types.ts';
import { COPY } from '../copy.ts';
import type { Call, CliResult } from '../ipc.ts';
import { cliKinds, createFakeBridge, type FakeBridge, failed, ok } from './fake-bridge.ts';
import behaviour from './fixtures/behaviour.json';
import { renderApp } from './render.tsx';

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const STANDING = 'ap_5S6T7V8W9X0Y1Z2A3B4C5D6E7F';
const PREVIEW =
  'Let an agent only post in example/slack\n  example/slack: reply, reaction → post\n<img src=x onerror=alert(1)>';

/** A fake bridge whose `cli` answers `answer(call)` when it gives one, and from the fixtures otherwise. */
function bridgeAnswering(answer: (call: Call) => CliResult | undefined): FakeBridge {
  const fixtures = createFakeBridge();
  return createFakeBridge({ cli: async (call) => answer(call) ?? fixtures.cli(call) });
}

function pending(approvalId = ID, preview = PREVIEW): CliResult {
  return { status: 'approvalPending', approvalId, preview, expiresAt: '2026-10-19T09:10:00.000Z' };
}

/** What `behaviour allow|clear` prints when it applied: the report as it reads after, and what it did. */
function applied(note: string | null = null): CliResult {
  return ok({ change: 'setRule', changed: true, note, ...(behaviour as BehaviourReport) });
}

/** The section of the Agent screen called `name`. */
async function section(name: string): Promise<HTMLElement> {
  return screen.findByRole('region', { name });
}

function count(bridge: FakeBridge, kind: Call['kind']): number {
  return cliKinds(bridge).filter((each) => each === kind).length;
}

/** Fills the rule form: an account, a conversation if given, and the acts ticked. */
async function fillRule(form: HTMLElement, account: string, acts: string[], conversation?: string): Promise<void> {
  fireEvent.click(within(form).getByRole('combobox', { name: 'Account' }));
  // As a pointer does: over the option, which highlights it, then the click that chooses it.
  const option = await screen.findByRole('option', { name: account });
  fireEvent.pointerMove(option);
  fireEvent.mouseMove(option);
  fireEvent.click(option);
  await waitFor(() => expect(within(form).getByRole('combobox', { name: 'Account' }).textContent).toContain(account));
  if (conversation !== undefined) {
    fireEvent.change(within(form).getByRole('textbox', { name: 'Conversation' }), { target: { value: conversation } });
  }
  for (const act of acts) fireEvent.click(within(form).getByRole('checkbox', { name: act }));
}

describe('Agent: the label', () => {
  it('the label shows word, name, rules and Slack style', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'agent' });
    const label = await section('The label');
    expect(await within(label).findByText('agent')).toBeTruthy();
    expect(within(label).getByText('Jo Example')).toBeTruthy();
    expect(within(label).getByText('example/gmail: sent as Jo Example')).toBeTruthy();
    const styles = within(label).getByRole('table', { name: 'Slack style' });
    const slack = within(styles).getByText('example/slack').closest('tr') as HTMLElement;
    expect(within(slack).getByText('app')).toBeTruthy();
    // Gmail has no Slack style.
    expect(within(styles).queryByText('example/gmail')).toBeNull();
    expect(count(bridge, 'label')).toBe(1);
  });

  it('a rule that matches nothing says so, and no name says it is not set', async () => {
    const bridge = createFakeBridge(
      {},
      {
        label: {
          word: 'assistant',
          words: ['agent', 'assistant'],
          name: null,
          rules: [{ rule: { account: 'gone/gmail', as: 'me' }, text: 'gone/gmail: sent as you', matches: false }],
          accounts: [],
          ignored: [],
        },
      },
    );
    renderApp(bridge, { screen: 'agent' });
    const label = await section('The label');
    expect(await within(label).findByText('assistant')).toBeTruthy();
    expect(within(label).getByText('Not set')).toBeTruthy();
    expect(within(label).getByText('matches no account')).toBeTruthy();
    expect(within(label).getByText('No Slack workspace is connected.')).toBeTruthy();
  });
});

describe('Agent: the behaviour rules', () => {
  it('lists each rule: its account, conversation and acts', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'agent' });
    // The table renders once the rules are read, which may be after the section shows.
    const rules = await within(await section('Behaviour rules')).findByRole('table', { name: 'Rules' });
    const slack = (await within(rules).findByText('example/slack')).closest('tr') as HTMLElement;
    expect(within(slack).getByText('reply, reaction')).toBeTruthy();
    const gmail = within(rules).getByText('example/gmail').closest('tr') as HTMLElement;
    expect(within(gmail).getByText('@example.com')).toBeTruthy();
    expect(within(gmail).getByText('nothing')).toBeTruthy();
  });

  it('a tightening rule applies and refreshes', async () => {
    const bridge = bridgeAnswering((call) =>
      call.kind === 'behaviourAllow'
        ? applied('It replaced example/slack: reply, reaction: one place has one rule.')
        : undefined,
    );
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const form = await within(rules).findByRole('form', { name: 'Add or change a rule' });
    await waitFor(() => expect(count(bridge, 'behaviour')).toBe(1));
    await fillRule(form, 'example/slack', ['reply']);
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(
      await within(rules).findByText('Applied. It replaced example/slack: reply, reaction: one place has one rule.'),
    ).toBeTruthy();
    expect(
      bridge.calls.filter((call) => call.command === 'cli' && (call.args as Call).kind === 'behaviourAllow'),
    ).toEqual([{ command: 'cli', args: { kind: 'behaviourAllow', account: 'example/slack', acts: 'reply' } }]);
    // Applied at once, and the rules read again; nothing was opened.
    await waitFor(() => expect(count(bridge, 'behaviour')).toBe(2));
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
    expect(within(rules).queryByText(COPY.approveThisInTerminal)).toBeNull();
  });

  it('no acts ticked allows nothing, and a conversation is passed on', async () => {
    const bridge = bridgeAnswering((call) => (call.kind === 'behaviourAllow' ? applied() : undefined));
    renderApp(bridge, { screen: 'agent' });
    const form = await within(await section('Behaviour rules')).findByRole('form', { name: 'Add or change a rule' });
    await fillRule(form, 'example/gmail', [], '@example.org');
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(bridge.calls).toContainEqual({
        command: 'cli',
        args: { kind: 'behaviourAllow', account: 'example/gmail', acts: 'none', conversation: '@example.org' },
      }),
    );
  });

  it('a form that names no account, or a conversation that is not one, sends nothing', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'agent' });
    const form = await within(await section('Behaviour rules')).findByRole('form', { name: 'Add or change a rule' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(form).findByText('Choose an account.')).toBeTruthy();
    await fillRule(form, 'example/slack', ['post'], '#general');
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(form).findByText('A Slack channel or person id, or an address or @domain.')).toBeTruthy();
    expect(cliKinds(bridge)).not.toContain('behaviourAllow');
  });

  it('a loosening rule shows its preview under Approve this in Terminal, and the button revokes then opens the change', async () => {
    const bridge = bridgeAnswering((call) => (call.kind === 'behaviourAllow' ? pending() : undefined));
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const form = await within(rules).findByRole('form', { name: 'Add or change a rule' });
    await fillRule(form, 'example/slack', ['post']);
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));

    expect(await within(rules).findByText(COPY.approveThisInTerminal)).toBeTruthy();
    // The preview, as text: nothing in it is markup.
    expect(rules.textContent).toContain(PREVIEW);
    expect(rules.querySelector('img,a,script,iframe')).toBeNull();
    const before = bridge.calls.length;
    fireEvent.click(within(rules).getByRole('button', { name: COPY.approveInTerminal }));
    expect(await within(rules).findByText('Opened in Terminal.')).toBeTruthy();
    // One command: the app's own approval revoked first, then the change opened, both by Rust, in that order (DA10).
    expect(bridge.calls.slice(before, before + 1)).toEqual([
      {
        command: 'openInTerminal',
        args: {
          kind: 'change',
          call: { kind: 'behaviourAllow', account: 'example/slack', acts: 'post' },
          revoke: ID,
        },
      },
    ]);
    // The app approved nothing, and never ran the change again.
    expect(cliKinds(bridge).filter((kind) => kind === 'behaviourAllow')).toHaveLength(1);
    expect(cliKinds(bridge)).not.toContain('approvalRevoke');
  });

  it('Remove runs behaviourClear through the same flow', async () => {
    const bridge = bridgeAnswering((call) => {
      if (call.kind !== 'behaviourClear') return undefined;
      // Removing the rule that holds Gmail to nothing at example.com loosens it; removing Slack's narrows nothing.
      return call.account === 'example/gmail'
        ? pending(ID, 'Remove the behaviour rule for example/gmail in @example.com')
        : applied();
    });
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const table = await within(rules).findByRole('table', { name: 'Rules' });
    const gmail = (await within(table).findByText('example/gmail')).closest('tr') as HTMLElement;
    fireEvent.click(within(gmail).getByRole('button', { name: 'Remove' }));
    expect(await within(rules).findByText(COPY.approveThisInTerminal)).toBeTruthy();
    expect(within(rules).getByText('Remove the behaviour rule for example/gmail in @example.com')).toBeTruthy();
    expect(bridge.calls).toContainEqual({
      command: 'cli',
      args: { kind: 'behaviourClear', account: 'example/gmail', conversation: '@example.com' },
    });
    // Cancel revokes the app's own approval, and the preview goes.
    fireEvent.click(within(rules).getByRole('button', { name: COPY.cancel }));
    await waitFor(() => expect(within(rules).queryByText(COPY.approveThisInTerminal)).toBeNull());
    expect(bridge.calls).toContainEqual({ command: 'cli', args: { kind: 'approvalRevoke', approvalId: ID } });

    // One that applies at once refreshes, as a tightening from the form does.
    const reads = count(bridge, 'behaviour');
    const slack = within(table).getByText('example/slack').closest('tr') as HTMLElement;
    fireEvent.click(within(slack).getByRole('button', { name: 'Remove' }));
    expect(await within(rules).findByText('Applied.')).toBeTruthy();
    expect(bridge.calls).toContainEqual({ command: 'cli', args: { kind: 'behaviourClear', account: 'example/slack' } });
    await waitFor(() => expect(count(bridge, 'behaviour')).toBe(reads + 1));
  });

  it('a refused change says why, with its hint', async () => {
    const bridge = bridgeAnswering((call) =>
      call.kind === 'behaviourAllow'
        ? failed('USAGE', 'example/gmail does not post', 'Its acts are: reply, send.')
        : undefined,
    );
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const form = await within(rules).findByRole('form', { name: 'Add or change a rule' });
    await fillRule(form, 'example/gmail', ['post']);
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(rules).findByText('example/gmail does not post')).toBeTruthy();
    expect(within(rules).getByText('Its acts are: reply, send.')).toBeTruthy();
  });

  it('no rules, and rules that cannot be read, say so', async () => {
    const bridge = createFakeBridge(
      {},
      {
        behaviour: {
          rules: [],
          unreadable: [{ account: null, reason: 'the behaviour rules are not a list' }],
          accounts: [{ account: 'example/slack', allowed: [], conversations: [] }],
        },
      },
    );
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    expect(await within(rules).findByText('No rules: agents may do whatever each account allows.')).toBeTruthy();
    expect(within(rules).getByText('the behaviour rules are not a list')).toBeTruthy();
  });

  it('a failed read says what went wrong', async () => {
    const bridge = bridgeAnswering((call) =>
      call.kind === 'behaviour' ? failed('CONFIG', 'the configuration cannot be read') : undefined,
    );
    renderApp(bridge, { screen: 'agent' });
    expect(await within(await section('Behaviour rules')).findByText('the configuration cannot be read')).toBeTruthy();
  });
});

describe('Agent: what the grammar refuses', () => {
  it('a rule or a standing approval the grammar refuses never reaches the bridge', async () => {
    const bridge = createFakeBridge(
      {},
      {
        behaviour: {
          rules: [{ account: 'Not A Name', acts: [], orphan: true }],
          unreadable: [],
          accounts: [],
        },
        standingList: {
          approvals: [
            {
              id: 'ap_; rm -rf ~',
              workspace: 'example/slack',
              state: 'active',
              contents: [],
              places: { kind: 'threads-i-am-in' },
              limits: { perThread: 1, perHour: 10, perDay: 30, expiresDays: 7 },
              expiresAt: null,
              usesToday: 0,
            },
          ],
        },
      },
    );
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const rule = (await within(rules).findByText('Not A Name')).closest('tr') as HTMLElement;
    fireEvent.click(within(rule).getByRole('button', { name: 'Remove' }));
    expect(await within(rules).findByText('This rule names a place that cannot be passed on safely.')).toBeTruthy();
    const standing = await section('Standing approvals');
    const approval = (await within(standing).findByText('ap_; rm -rf ~')).closest('tr') as HTMLElement;
    fireEvent.click(within(approval).getByRole('button', { name: COPY.revoke }));
    expect(
      await within(standing).findByText('This standing approval has an id that cannot be passed on safely.'),
    ).toBeTruthy();
    expect(cliKinds(bridge).filter((kind) => kind === 'behaviourClear' || kind === 'standingRevoke')).toEqual([]);
  });
});

describe('Agent: standing approvals', () => {
  it('standing: revoke one, end them all', async () => {
    const bridge = createFakeBridge({}, { standingRevoke: { approvals: [] }, standingOff: { approvals: [] } });
    renderApp(bridge, { screen: 'agent' });
    const standing = await section('Standing approvals');
    const table = await within(standing).findByRole('table', { name: 'Standing approvals' });
    const active = within(table).getByText(STANDING).closest('tr') as HTMLElement;
    // What it allows, where, how often, and until when.
    expect(within(active).getByText('example/slack')).toBeTruthy();
    expect(within(active).getByText('active')).toBeTruthy();
    expect(within(active).getByText('reaction: white_check_mark')).toBeTruthy();
    expect(within(active).getByText("reply: Thanks, I'll take a look.")).toBeTruthy();
    expect(within(active).getByText('general (C0EXAMPLE1)')).toBeTruthy();
    expect(within(active).getByText('2 today')).toBeTruthy();
    // An ended one is shown with why, and has nothing to revoke.
    const ended = within(table).getByText('ap_7F6E5D4C3B2A1Z0Y9X8W7V6T5S').closest('tr') as HTMLElement;
    expect(within(ended).getByText('revoked by the person')).toBeTruthy();
    expect(within(ended).getByText('threads I am in')).toBeTruthy();
    expect(within(ended).queryByRole('button', { name: COPY.revoke })).toBeNull();

    fireEvent.click(within(active).getByRole('button', { name: COPY.revoke }));
    await waitFor(() =>
      expect(bridge.calls).toContainEqual({ command: 'cli', args: { kind: 'standingRevoke', id: STANDING } }),
    );
    await waitFor(() => expect(count(bridge, 'standingList')).toBe(2));

    fireEvent.click(within(standing).getByRole('button', { name: COPY.endEveryStanding }));
    await waitFor(() => expect(cliKinds(bridge)).toContain('standingOff'));
    await waitFor(() => expect(count(bridge, 'standingList')).toBe(3));
    // Each only takes away: applied at once, nothing sent to Terminal.
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  it('none, and a failed read, say so', async () => {
    const bridge = createFakeBridge({}, { standingList: { approvals: [] } });
    renderApp(bridge, { screen: 'agent' });
    const standing = await section('Standing approvals');
    expect(await within(standing).findByText('No standing approvals.')).toBeTruthy();
    expect(within(standing).queryByRole('button', { name: COPY.endEveryStanding })).toBeNull();
  });

  it('a revoke that fails says why', async () => {
    const bridge = bridgeAnswering((call) =>
      call.kind === 'standingRevoke' ? failed('NOT_FOUND', 'there is no standing approval with that id') : undefined,
    );
    renderApp(bridge, { screen: 'agent' });
    const standing = await section('Standing approvals');
    const table = await within(standing).findByRole('table', { name: 'Standing approvals' });
    const active = within(table).getByText(STANDING).closest('tr') as HTMLElement;
    fireEvent.click(within(active).getByRole('button', { name: COPY.revoke }));
    expect(await within(standing).findByText('there is no standing approval with that id')).toBeTruthy();
  });
});
