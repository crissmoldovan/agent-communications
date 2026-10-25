import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BehaviourReport } from '../cli-types.ts';
import { ACTS_HINT, CONVERSATION_HINT } from '../components/RuleForm.tsx';
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

/** Each section of the Agent screen, and the tab that shows it (D7): its name, then any count. */
const TABS = {
  'The label': /^Label/,
  'Behaviour rules': /^Behaviour rules/,
  'Standing approvals': /^Standing approvals/,
} as const;

/** The section of the Agent screen called `name`, shown by choosing its tab. */
async function section(name: keyof typeof TABS): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('tab', { name: TABS[name] }));
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
    // Cancel revokes the app's own approval, through the command that takes only a preview's, and the preview goes.
    fireEvent.click(within(rules).getByRole('button', { name: COPY.cancel }));
    await waitFor(() => expect(within(rules).queryByText(COPY.approveThisInTerminal)).toBeNull());
    expect(within(rules).getByText('Cancelled: nothing was changed.')).toBeTruthy();
    expect(bridge.calls).toContainEqual({ command: 'revokePreview', args: ID });

    // One that applies at once refreshes, as a tightening from the form does.
    const reads = count(bridge, 'behaviour');
    const slack = within(table).getByText('example/slack').closest('tr') as HTMLElement;
    fireEvent.click(within(slack).getByRole('button', { name: 'Remove' }));
    expect(await within(rules).findByText('Applied.')).toBeTruthy();
    expect(bridge.calls).toContainEqual({ command: 'cli', args: { kind: 'behaviourClear', account: 'example/slack' } });
    await waitFor(() => expect(count(bridge, 'behaviour')).toBe(reads + 1));
  });

  it('a preview replaced by the next change revokes its own approval, and a Cancel that did not revoke says so', async () => {
    const SECOND = 'ap_ZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    let next = ID;
    const bridge = createFakeBridge({
      cli: async (call) => {
        if (call.kind === 'behaviourAllow') return pending(next, `Allow ${next}`);
        return createFakeBridge().cli(call);
      },
      revokePreview: async () => failed('TRANSIENT', 'the approvals store is busy', 'Try again in a moment.', 75),
    });
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const form = await within(rules).findByRole('form', { name: 'Add or change a rule' });
    await fillRule(form, 'example/slack', ['post']);
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(rules).findByText(`Allow ${ID}`)).toBeTruthy();
    // The next change comes back waiting too: its preview takes the place of the first, whose approval goes.
    next = SECOND;
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(rules).findByText(`Allow ${SECOND}`)).toBeTruthy();
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'revokePreview').map((call) => call.args)).toEqual([ID]),
    );
    // Cancel, whose revoke did not happen: not "Cancelled", but what went wrong; the preview stays.
    fireEvent.click(within(rules).getByRole('button', { name: COPY.cancel }));
    expect(await within(rules).findByText(/the approvals store is busy/)).toBeTruthy();
    expect(within(rules).queryByText('Cancelled: nothing was changed.')).toBeNull();
    expect(within(rules).getByText(`Allow ${SECOND}`)).toBeTruthy();
  });

  it('opening a picker adds no inline style, which the content policy would refuse', async () => {
    // `style-src 'self'`: Base UI's Select writes a <style> to hide its scrollbar unless the app says not to.
    const before = document.querySelectorAll('style').length;
    renderApp(createFakeBridge(), { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const form = await within(rules).findByRole('form', { name: 'Add or change a rule' });
    fireEvent.click(within(form).getByRole('combobox', { name: 'Account' }));
    expect(await screen.findByRole('option', { name: 'example/slack' })).toBeTruthy();
    const added = [...document.querySelectorAll('style')].slice(before).map((style) => style.textContent ?? '');
    expect(added).toEqual([]);
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
    const approval = (await within(standing).findByText('ap_; rm -rf ~')).closest('li') as HTMLElement;
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
    const table = await within(standing).findByRole('list', { name: 'Standing approvals' });
    const active = within(table).getByText(STANDING).closest('li') as HTMLElement;
    // What it allows, where, how often, and until when.
    expect(within(active).getByText('example/slack')).toBeTruthy();
    expect(within(active).getByText('active')).toBeTruthy();
    expect(within(active).getByText('reaction: white_check_mark')).toBeTruthy();
    expect(within(active).getByText("reply: Thanks, I'll take a look.")).toBeTruthy();
    expect(within(active).getByText('general (C0EXAMPLE1)')).toBeTruthy();
    expect(within(active).getByText('2 today')).toBeTruthy();
    // An ended one is shown with why, and has nothing to revoke.
    const ended = within(table).getByText('ap_7F6E5D4C3B2A1Z0Y9X8W7V6T5S').closest('li') as HTMLElement;
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

  it('ending them all says what could not be done all the same', async () => {
    const note = `${STANDING} could not be written down as ended (EACCES); the raised standing epoch ends it.`;
    const bridge = createFakeBridge({}, { standingOff: { approvals: [], partial: [note] } });
    renderApp(bridge, { screen: 'agent' });
    const standing = await section('Standing approvals');
    await within(standing).findByRole('list', { name: 'Standing approvals' });
    fireEvent.click(within(standing).getByRole('button', { name: COPY.endEveryStanding }));
    const said = await within(standing).findByRole('status');
    expect(said.textContent).toContain('Every standing approval has ended.');
    expect(said.textContent).toContain(note);
  });

  it('a revoke that fails says why', async () => {
    const bridge = bridgeAnswering((call) =>
      call.kind === 'standingRevoke' ? failed('NOT_FOUND', 'there is no standing approval with that id') : undefined,
    );
    renderApp(bridge, { screen: 'agent' });
    const standing = await section('Standing approvals');
    const table = await within(standing).findByRole('list', { name: 'Standing approvals' });
    const active = within(table).getByText(STANDING).closest('li') as HTMLElement;
    fireEvent.click(within(active).getByRole('button', { name: COPY.revoke }));
    expect(await within(standing).findByText('there is no standing approval with that id')).toBeTruthy();
  });
});

/** The Agent screen's tab called `name` (its name, then any count). */
async function tab(name: RegExp): Promise<HTMLElement> {
  return screen.findByRole('tab', { name });
}

/** A tab's count, as it shows and as it is said: its number, its tone, and its words for a screen reader. */
function countOf(each: HTMLElement): { shown: string; tone: string | null; says: string } | null {
  const badge = each.querySelector<HTMLElement>('[data-slot="tab-count"]');
  if (badge === null) return null;
  return {
    shown: badge.querySelector('[aria-hidden="true"]')?.textContent ?? '',
    tone: badge.getAttribute('data-tone'),
    says: badge.querySelector('.sr-only')?.textContent ?? '',
  };
}

/** A tab's mark for a view this CLI is too old for: its tone, and its words for a screen reader. */
function gateOf(each: HTMLElement): { tone: string | null; says: string } | null {
  const mark = each.querySelector<HTMLElement>('[data-slot="tab-gate"]');
  if (mark === null) return null;
  return { tone: mark.getAttribute('data-tone'), says: mark.textContent ?? '' };
}

/** Opens the hint beside a label, as a pointer resting on it does, and gives its text. */
async function hintOf(trigger: HTMLElement): Promise<string> {
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  fireEvent.mouseEnter(trigger);
  fireEvent.mouseMove(trigger);
  return (await screen.findByRole('tooltip', {}, { timeout: 3000 })).textContent ?? '';
}

describe('Agent: the tabs (D7)', () => {
  it('three views, the label first and chosen; each read once, and only the chosen view shows', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'agent' });
    const list = await screen.findByRole('tablist', { name: 'Agent' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((each) => each.textContent?.replace(/\d.*$/, '').trim())).toEqual([
      'Label',
      'Behaviour rules',
      'Standing approvals',
    ]);
    expect(tabs.map((each) => each.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(await screen.findByRole('region', { name: 'The label' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Behaviour rules' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Standing approvals' })).toBeNull();
    // Every view is read when the screen opens, as on one page, so each tab can say what it holds.
    await waitFor(() => expect(count(bridge, 'standingList')).toBe(1));
    expect(count(bridge, 'label')).toBe(1);
    expect(count(bridge, 'behaviour')).toBe(1);

    fireEvent.click(await tab(/^Standing approvals/));
    expect(await screen.findByRole('region', { name: 'Standing approvals' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'The label' })).toBeNull();
    // Choosing a tab reads nothing again.
    expect(count(bridge, 'standingList')).toBe(1);
    expect(count(bridge, 'label')).toBe(1);
  });

  it('counts: the rules, and the standing approvals that have not ended; none on a label with nothing to look at', async () => {
    renderApp(createFakeBridge(), { screen: 'agent' });
    const rules = await tab(/^Behaviour rules/);
    await waitFor(() => expect(countOf(rules)).toEqual({ shown: '2', tone: 'neutral', says: '2 rules' }));
    // The fixture's two standing approvals: one active, one ended.
    await waitFor(() =>
      expect(countOf(screen.getByRole('tab', { name: /^Standing approvals/ }))).toEqual({
        shown: '1',
        tone: 'neutral',
        says: '1 active',
      }),
    );
    expect(countOf(screen.getByRole('tab', { name: /^Label/ }))).toBeNull();
    expect(screen.getByRole('tab', { name: /^Standing approvals/ }).textContent).toContain('1 active');
  });

  it('warn counts: a label rule that matches no account, and rules to look at; none when nothing is left', async () => {
    const bridge = createFakeBridge(
      {},
      {
        label: {
          word: 'agent',
          words: ['agent'],
          name: null,
          rules: [{ rule: { account: 'gone/gmail', as: 'me' }, text: 'gone/gmail: sent as you', matches: false }],
          accounts: [],
          ignored: [],
        },
        behaviour: {
          rules: [
            { account: 'example/slack', acts: ['reply'], orphan: false },
            { account: 'old/gmail', acts: [], orphan: true },
          ],
          unreadable: [{ account: null, reason: 'the behaviour rules are not a list' }],
          accounts: [],
        },
        standingList: {
          approvals: [
            {
              id: STANDING,
              workspace: 'example/slack',
              state: 'pending',
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
    await waitFor(() =>
      expect(countOf(screen.getByRole('tab', { name: /^Label/ }))).toEqual({
        shown: '1',
        tone: 'warn',
        says: '1 rule matches no account',
      }),
    );
    // One rule this release cannot read and one that names no connected account: two to look at, over the count.
    expect(countOf(screen.getByRole('tab', { name: /^Behaviour rules/ }))).toEqual({
      shown: '2',
      tone: 'warn',
      says: '2 rules to look at',
    });
    // One waiting for its approval at a terminal counts too.
    expect(countOf(screen.getByRole('tab', { name: /^Standing approvals/ }))).toEqual({
      shown: '1',
      tone: 'neutral',
      says: '1 pending',
    });
    // The warnings themselves are in the views.
    const rules = await section('Behaviour rules');
    expect(within(rules).getByText('not connected')).toBeTruthy();
    expect(within(rules).getByText('the behaviour rules are not a list')).toBeTruthy();
  });

  it('a read that failed is marked on its tab, and said in its view', async () => {
    const bridge = bridgeAnswering((call) =>
      call.kind === 'standingList' ? failed('CONFIG', 'the standing approvals cannot be read') : undefined,
    );
    renderApp(bridge, { screen: 'agent' });
    const standing = await tab(/^Standing approvals/);
    await waitFor(() => expect(within(standing).getByRole('status').textContent).toBe('could not be read'));
    expect(countOf(standing)).toBeNull();
    // The other tabs are not marked.
    expect(within(await tab(/^Behaviour rules/)).queryByRole('status')).toBeNull();
    const view = await section('Standing approvals');
    expect(within(view).getByText('the standing approvals cannot be read')).toBeTruthy();
    // There may be one to end: ending them all is still offered.
    expect(within(view).getByRole('button', { name: COPY.endEveryStanding })).toBeTruthy();
  });

  it('a preview waiting in one view stays, and keeps its approval, while another view is looked at', async () => {
    const bridge = bridgeAnswering((call) => (call.kind === 'behaviourAllow' ? pending() : undefined));
    renderApp(bridge, { screen: 'agent' });
    const rules = await section('Behaviour rules');
    const form = await within(rules).findByRole('form', { name: 'Add or change a rule' });
    await fillRule(form, 'example/slack', ['post']);
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(rules).findByText(COPY.approveThisInTerminal)).toBeTruthy();

    fireEvent.click(await tab(/^Standing approvals/));
    await screen.findByRole('region', { name: 'Standing approvals' });
    fireEvent.click(await tab(/^Behaviour rules/));
    const again = await screen.findByRole('region', { name: 'Behaviour rules' });
    expect(within(again).getByText(COPY.approveThisInTerminal)).toBeTruthy();
    expect(again.textContent).toContain(PREVIEW);
    // Nothing revoked it: it is still the person's to approve or cancel.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.calls.filter((call) => call.command === 'revokePreview')).toEqual([]);
  });

  it('a gated view says so behind its tab, and reads nothing', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...(await createFakeBridge().installation()), version: '0.22.0' }),
    });
    renderApp(bridge, { screen: 'agent' });
    const standing = await section('Standing approvals');
    expect(await within(standing).findByText(COPY.updateToUse)).toBeTruthy();
    expect(within(standing).getByText('Needs 0.23.0 or later; this machine has 0.22.0.')).toBeTruthy();
    // Its tab is marked, so the line is not hidden behind it: a warn dot, said as "needs an update".
    const standingTab = await tab(/^Standing approvals/);
    expect(countOf(standingTab)).toBeNull();
    expect(gateOf(standingTab)).toEqual({ tone: 'warn', says: 'needs an update' });
    expect(standingTab.textContent).toBe('Standing approvals needs an update');
    // The rules, which 0.22.0 has, are read and counted, and their tab is not marked.
    await waitFor(() => expect(countOf(screen.getByRole('tab', { name: /^Behaviour rules/ }))?.shown).toBe('2'));
    expect(gateOf(screen.getByRole('tab', { name: /^Behaviour rules/ }))).toBeNull();
    expect(cliKinds(bridge)).not.toContain('standingList');
  });

  it('on a CLI too old for both, each gated tab is marked "needs an update", and the label tab is not', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...(await createFakeBridge().installation()), version: '0.21.0' }),
    });
    renderApp(bridge, { screen: 'agent' });
    // The label, which every version has, is read; its tab carries no mark.
    await waitFor(() => expect(count(bridge, 'label')).toBe(1));
    expect(gateOf(await tab(/^Label/))).toBeNull();
    for (const [name, line] of [
      [/^Behaviour rules/, 'Needs 0.22.0 or later; this machine has 0.21.0.'],
      [/^Standing approvals/, 'Needs 0.23.0 or later; this machine has 0.21.0.'],
    ] as const) {
      const each = await tab(name);
      expect(gateOf(each)).toEqual({ tone: 'warn', says: 'needs an update' });
      expect(countOf(each)).toBeNull();
      // What the mark points at, behind the tab.
      fireEvent.click(each);
      expect(await screen.findByText(line)).toBeTruthy();
    }
    expect(screen.getByRole('tab', { name: 'Behaviour rules needs an update' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Standing approvals needs an update' })).toBeTruthy();
    expect(cliKinds(bridge).filter((kind) => kind === 'behaviour' || kind === 'standingList')).toEqual([]);
  });
});

describe('Agent: the hints', () => {
  it('what a conversation may be, and what the acts are, are a hover or focus away beside their labels', async () => {
    renderApp(createFakeBridge(), { screen: 'agent' });
    const form = await within(await section('Behaviour rules')).findByRole('form', { name: 'Add or change a rule' });
    // The lines that stay: what an empty conversation means, and what no acts ticked means.
    expect(within(form).getByText('Optional. Leave it empty for the whole account.')).toBeTruthy();
    expect(within(form).getByText('Tick none to allow nothing.')).toBeTruthy();
    // The fields keep their names: the hints sit beside the labels, not in them.
    expect(within(form).getByRole('textbox', { name: 'Conversation' })).toBeTruthy();
    expect(await hintOf(within(form).getByRole('button', { name: 'About the conversation' }))).toBe(CONVERSATION_HINT);
    expect(CONVERSATION_HINT).toBe('A Slack channel or person id, or an address or @domain.');
  });

  it('the acts hint', async () => {
    renderApp(createFakeBridge(), { screen: 'agent' });
    const form = await within(await section('Behaviour rules')).findByRole('form', { name: 'Add or change a rule' });
    expect(await hintOf(within(form).getByRole('button', { name: 'About the acts' }))).toBe(ACTS_HINT);
    expect(ACTS_HINT).toBe('What an agent may start there.');
  });
});
