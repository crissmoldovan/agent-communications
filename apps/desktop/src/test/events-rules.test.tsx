/*
 * Events → Rules (owner feedback 0.32.0, §3.4): one card per rule, in plain words, and a rule's page — its sentence,
 * six panels, its last 7 days, its versions and, collapsed, the ids. Every answer is a fixture written to the spec's
 * shapes (`rules list`, `rule show`), until the event service's own output replaces them.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import { cliKinds, createFakeBridge, type FakeBridge, type Fixture, failed } from './fake-bridge.ts';
import deliveries from './fixtures/events-deliveries.v032.json';
import shows from './fixtures/events-rule-show.v032.json';
import rules from './fixtures/events-rules.v032.json';
import { renderApp } from './render.tsx';

type Shows = Record<string, unknown[]>;

/** `rule show <rule>` from the fixtures: each rule's versions, and NOT_FOUND for any other. */
function ruleShow(answers: Shows = shows as Shows) {
  return (call: Call) => answers[(call as Extract<Call, { kind: 'eventsRuleShow' }>).ruleId] ?? [];
}

function rulesBridge(fixtures: Partial<Record<Call['kind'], Fixture>> = {}, handlers = {}): FakeBridge {
  return createFakeBridge(handlers, {
    eventsRules: rules,
    eventsRuleShow: ruleShow(),
    eventsDeliveries: deliveries,
    eventsRuleDisable: (call: Call) => ({
      ruleId: (call as Extract<Call, { kind: 'eventsRuleDisable' }>).ruleId,
      disabled: true,
    }),
    eventsRuleRemove: (call: Call) => ({
      ruleId: (call as Extract<Call, { kind: 'eventsRuleRemove' }>).ruleId,
      disabled: true,
    }),
    ...fixtures,
  });
}

async function openRulesTab(): Promise<HTMLElement> {
  const tab = await screen.findByRole('tab', { name: /^Workflows\b/ });
  fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
  return screen.findByRole('region', { name: 'Workflows' });
}

/** A rule's card, once its versions are read. */
async function card(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-rule="${id}"]`);
    if (found === null) throw new Error(`no card for ${id}`);
    return found;
  });
}

/** A card's sentence, once `rule show` has answered. */
async function sentence(id: string): Promise<HTMLElement> {
  return waitFor(async () => {
    const found = (await card(id)).querySelector<HTMLElement>('[data-slot="rule-sentence"]');
    if (found === null) throw new Error(`no sentence for ${id}`);
    return found;
  });
}

const cards = (view: HTMLElement) =>
  [...view.querySelectorAll<HTMLElement>('[data-rule]')].map((each) => each.dataset.rule);

/** The words the Events screens never use outside the collapsed technical details (§3.8). */
const RAW_WORDS = ['approval id', 'activation', 'digest', 'superseded', 'retryable', 'dead-lettered'];

function rawWordsIn(element: HTMLElement): string[] {
  const said = (element.textContent ?? '').toLowerCase();
  return RAW_WORDS.filter((word) => said.includes(word));
}

async function openRule(id: string): Promise<HTMLElement> {
  fireEvent.click(await card(id));
  return screen.findByRole('region', { name: `Workflow ${id}` });
}

describe('Events → Rules', () => {
  it('shows one card per rule, not per version: its name, its state, its sentence and its facts', async () => {
    const bridge = rulesBridge();
    renderApp(bridge, { screen: 'events' });
    // The tab counts rules: invoices has two versions and is one rule.
    expect(await screen.findByRole('tab', { name: 'Workflows 6' })).toBeTruthy();
    const view = await openRulesTab();
    expect(
      within(view).getByText(/A workflow watches one account, picks out the messages it cares about/),
    ).toBeTruthy();
    await card('newsletters');
    // On first, then the one not switched on, then the one off; each group by name.
    expect(cards(view)).toEqual([
      'build-alerts',
      'david-on-slack',
      'invoices',
      'mail-subject',
      'deploy-alerts',
      'newsletters',
    ]);
    // Each rule's versions are read once, with its id.
    await waitFor(() =>
      expect(
        bridge.calls
          .filter((each) => each.command === 'cli' && (each.args as Call).kind === 'eventsRuleShow')
          .map((each) => (each.args as Extract<Call, { kind: 'eventsRuleShow' }>).ruleId)
          .sort(),
      ).toEqual(['build-alerts', 'david-on-slack', 'deploy-alerts', 'invoices', 'mail-subject', 'newsletters']),
    );

    const invoices = await card('invoices');
    expect(within(invoices).getByText('invoices')).toBeTruthy();
    expect(within(invoices).getByText('On')).toBeTruthy();
    const said = await sentence('invoices');
    // The event service's own sentence (`describeRule`), its account named as the Accounts screen names it; the
    // author's words are boxed as theirs; values stand out.
    expect(said.textContent).toBe(
      "When mail arrives in example/gmail with 'invoice' or 'payment' in the subject, ask Jev 'Is this asking me to pay or send something?'. If it says yes, put it in the Queue, lane billing.",
    );
    expect([...said.querySelectorAll('[data-part="untrusted"]')].map((each) => each.textContent)).toEqual([
      'invoice',
      'payment',
      'Is this asking me to pay or send something?',
    ]);
    expect([...said.querySelectorAll('[data-part="value"]')].map((each) => each.textContent)).toEqual([
      'example/gmail',
      'Jev',
      'Queue',
      'billing',
    ]);
    // Both versions' last 7 days, added up, and when it was switched on.
    expect(invoices.textContent).toContain('15 matched in the last 7 days');
    expect(invoices.querySelector('[data-slot="rule-facts"] time')).not.toBeNull();

    // A dry run says so beside its state; an account no list names shows as its id.
    const dry = await card('mail-subject');
    expect(within(dry).getByText('On')).toBeTruthy();
    expect(within(dry).getByText('Dry run')).toBeTruthy();
    expect((await sentence('mail-subject')).textContent).toContain('in_01EXAMPLE0000000000000099');
    expect(within(await card('invoices')).queryByText('Dry run')).toBeNull();

    expect(within(await card('deploy-alerts')).getByText('Not switched on')).toBeTruthy();
    expect((await card('deploy-alerts')).textContent).toContain('Its approval is in Approvals');
    expect(within(await card('newsletters')).getByText('Off')).toBeTruthy();
    expect((await card('newsletters')).textContent).toContain('Turned off');

    // Every card opens: it is a button, with a "›".
    for (const id of cards(view)) {
      const each = await card(id ?? '');
      expect(each.tagName, id).toBe('BUTTON');
      expect(each.querySelector('[data-slot="opens"]'), id).not.toBeNull();
    }
    expect(rawWordsIn(view)).toEqual([]);
  });

  it('filters by All, On, Not switched on and Off, each with its count', async () => {
    renderApp(rulesBridge(), { screen: 'events' });
    const view = await openRulesTab();
    const show = within(view).getByRole('group', { name: 'Show' });
    expect(
      within(show)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['All 6', 'On 4', 'Not switched on 1', 'Off 1']);
    await card('invoices');
    fireEvent.click(within(show).getByRole('button', { name: 'Not switched on 1' }));
    await waitFor(() => expect(cards(view)).toEqual(['deploy-alerts']));
    fireEvent.click(within(show).getByRole('button', { name: 'Off 1' }));
    await waitFor(() => expect(cards(view)).toEqual(['newsletters']));
    fireEvent.click(within(show).getByRole('button', { name: 'On 4' }));
    await waitFor(() => expect(cards(view)).toEqual(['build-alerts', 'david-on-slack', 'invoices', 'mail-subject']));
    fireEvent.click(within(show).getByRole('button', { name: 'All 6' }));
    await waitFor(() => expect(cards(view)).toHaveLength(6));
  });

  it("a rule's page: its sentence, six panels, its last 7 days, its versions, and the ids collapsed", async () => {
    renderApp(rulesBridge(), { screen: 'events' });
    await openRulesTab();
    const page = await openRule('invoices');
    expect(within(page).getByRole('heading', { name: 'invoices' })).toBeTruthy();
    expect(within(page).getByText('On')).toBeTruthy();
    const words = within(page).getByRole('region', { name: 'In plain words' });
    expect(words.textContent).toContain(
      "When mail arrives in example/gmail with 'invoice' or 'payment' in the subject",
    );

    const panel = (name: string) => within(page).getByRole('region', { name });
    expect(panel('What it watches').textContent).toBe('What it watchesGmail · example/gmailNew mail in the inbox');
    expect(panel('Which messages').textContent).toBe('Which messagesThe subject contains invoice or payment');
    expect(
      [...panel('Which messages').querySelectorAll('[data-part="untrusted"]')].map((each) => each.textContent),
    ).toEqual(['invoice', 'payment']);
    expect(panel('The judge').textContent).toBe(
      'The judgeJev, through OpenRouterAsks: Is this asking me to pay or send something? · yes when 0.70 sure or more',
    );
    expect(panel('Where they go').textContent).toBe(
      'Where they goQueue, lane billingWakes the agent window bound to that lane',
    );
    expect(panel("What's kept").textContent).toBe(
      "What's keptIt keeps the sender, the subject, the preview, the message idIn the Queue for 30 days, then deleted",
    );
    expect(panel('The limit').textContent).toBe(
      'The limitAt most 60 an hourThe limit you approved with the workflow · its judge is asked at most 30 times an hour',
    );

    const week = panel('The last 7 days');
    const stat = (label: string) =>
      within(week).getByText(label).closest('[data-slot="rule-count"]')?.querySelector('[data-slot="rule-count-value"]')
        ?.textContent;
    expect(stat('matched')).toBe('15');
    expect(stat('Jev said yes')).toBe('10');
    expect(stat('Jev said no')).toBe('5');
    expect(stat('delivered')).toBe('10');
    expect(stat('problems')).toBe('0');

    const versions = panel('Versions');
    expect(within(versions).getByText('Version 2 · on')).toBeTruthy();
    expect(within(versions).getByText('Version 1 · replaced')).toBeTruthy();
    expect(versions.textContent).toContain('Changed from version 1: which messages.');
    expect(versions.querySelectorAll('time').length).toBeGreaterThanOrEqual(3);

    // The ids, collapsed: none of them is on the page until it is opened.
    expect(page.textContent).not.toContain('ap_1A2B3C4D5E6F7G8H9J0K1M2N3P');
    expect(rawWordsIn(page)).toEqual([]);
    fireEvent.click(within(page).getByRole('button', { name: 'Technical details' }));
    const details = await within(page).findByRole('region', { name: 'Technical details' });
    expect(details.textContent).toContain('ap_1A2B3C4D5E6F7G8H9J0K1M2N3P');
    expect(details.textContent).toContain('act_example_invoices_2');
    expect(details.textContent).toContain('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0');
    expect(details.textContent).toContain('the record of your yes to this exact version');
    expect(details.textContent).toContain('superseded');

    // No Edit…, no Try it: those come later.
    expect(within(page).queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(within(page).queryByRole('button', { name: /Try it/ })).toBeNull();

    // Back to the list, as it was.
    fireEvent.click(within(page).getByRole('button', { name: 'All workflows' }));
    expect(await card('invoices')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Workflow invoices' })).toBeNull();
  });

  it('a rule without a judge, a webhook, a dry run and one never switched on each say so in plain words', async () => {
    renderApp(rulesBridge(), { screen: 'events' });
    await openRulesTab();
    let page = await openRule('build-alerts');
    expect(within(page).getByRole('region', { name: 'The judge' }).textContent).toBe(
      'The judgeNo judgeEvery message that matches is passed on.',
    );
    expect(within(page).getByRole('region', { name: 'Which messages' }).textContent).toBe(
      "Which messagesThe sender's address is at ci.example",
    );
    expect(within(page).getByRole('region', { name: 'Where they go' }).textContent).toBe(
      'Where they goWebhook, hooks.ci.exampleSigned with the target’s key · tries up to 5 times',
    );
    fireEvent.click(within(page).getByRole('button', { name: 'All workflows' }));

    page = await openRule('mail-subject');
    expect(within(page).getByText('Dry run')).toBeTruthy();
    expect(within(page).getByRole('region', { name: 'Where they go' }).textContent).toBe(
      'Where they goDry-run log on this MacNothing is sent anywhere.',
    );
    expect(within(page).getByRole('region', { name: "What's kept" }).textContent).toContain(
      'The dry-run log keeps each entry for 24 hours',
    );
    fireEvent.click(within(page).getByRole('button', { name: 'All workflows' }));

    page = await openRule('deploy-alerts');
    expect(within(page).getByText('Not switched on')).toBeTruthy();
    expect(within(page).getByRole('region', { name: 'Where they go' }).textContent).toContain(
      'Webhook, hooks.ops.example',
    );
    expect(within(page).getByRole('region', { name: 'Versions' }).textContent).toContain('Version 1 · not switched on');
    // It never ran: no week to count, and nothing that keeps running while a new version waits.
    expect(within(page).queryByRole('region', { name: 'The last 7 days' })).toBeNull();
    expect(page.textContent).not.toContain('keeps running');
    // Nothing to turn off: it never ran.
    expect(within(page).queryByRole('button', { name: 'Turn off' })).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Remove…' })).toBeNull();
    // Its approval, if an agent asked for it, waits in Approvals.
    fireEvent.click(within(page).getByRole('button', { name: 'Open Approvals' }));
    expect(await screen.findByRole('heading', { name: 'Approvals', level: 1 })).toBeTruthy();
  });

  it('Turn off applies at once and the rules are read again; Remove… asks first, and only its Remove runs it', async () => {
    let state: 'active' | 'revoked' = 'active';
    const live = () =>
      (rules as { rule_id: string; state: string | null }[]).map((row) =>
        row.rule_id === 'build-alerts' ? { ...row, state } : row,
      );
    const showLive = (call: Call) => {
      const id = (call as Extract<Call, { kind: 'eventsRuleShow' }>).ruleId;
      const answer = (shows as Shows)[id] ?? [];
      return id === 'build-alerts'
        ? answer.map((entry) => ({
            ...(entry as object),
            state,
            revokedAt: state === 'revoked' ? 1792930000000 : null,
          }))
        : answer;
    };
    const bridge = rulesBridge({
      eventsRules: () => live(),
      eventsRuleShow: showLive,
      eventsRuleDisable: (call: Call) => {
        state = 'revoked';
        return { ruleId: (call as Extract<Call, { kind: 'eventsRuleDisable' }>).ruleId, disabled: true };
      },
    });
    renderApp(bridge, { screen: 'events' });
    await openRulesTab();
    const page = await openRule('build-alerts');
    const before = cliKinds(bridge).filter((kind) => kind === 'eventsRules').length;
    fireEvent.click(within(page).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(bridge.calls.filter((each) => each.command === 'cli').map((each) => each.args)).toContainEqual({
        kind: 'eventsRuleDisable',
        ruleId: 'build-alerts',
      }),
    );
    // No dialog: a tightening applies at once. The list is read again, and the rule says Off.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(cliKinds(bridge).filter((kind) => kind === 'eventsRules').length).toBe(before + 1));
    const after = await screen.findByRole('region', { name: 'Workflow build-alerts' });
    await waitFor(() => expect(within(after).getByText('Off')).toBeTruthy());
    expect(within(after).queryByRole('button', { name: 'Turn off' })).toBeNull();
  });

  it('Remove… asks first: Cancel runs nothing, and Remove runs rule remove for that rule', async () => {
    const bridge = rulesBridge();
    renderApp(bridge, { screen: 'events' });
    await openRulesTab();
    const page = await openRule('invoices');
    const removes = () =>
      bridge.calls.filter((each) => each.command === 'cli' && (each.args as Call).kind === 'eventsRuleRemove');
    fireEvent.click(within(page).getByRole('button', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Remove invoices?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(removes()).toEqual([]);
    fireEvent.click(within(page).getByRole('button', { name: 'Remove…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(removes().map((each) => each.args)).toEqual([{ kind: 'eventsRuleRemove', ruleId: 'invoices' }]),
    );
  });

  it("a turn-off the event service refused says why, as text, and the rule's page stays", async () => {
    const inner = rulesBridge();
    const bridge = rulesBridge(
      {},
      {
        cli: (call: Call) =>
          call.kind === 'eventsRuleDisable'
            ? Promise.resolve(failed('NOT_FOUND', 'the rule has no active version to disable', null, 66))
            : inner.cli(call),
      },
    );
    renderApp(bridge, { screen: 'events' });
    await openRulesTab();
    const page = await openRule('invoices');
    fireEvent.click(within(page).getByRole('button', { name: 'Turn off' }));
    expect((await within(page).findByRole('alert')).textContent).toBe('the rule has no active version to disable');
    expect(within(page).getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it("hostile author text stays text: in the sentence, a condition's operand, the judge's question", async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const answers = structuredClone(shows) as Shows;
    const [entry] = answers['deploy-alerts'] as Record<string, unknown>[];
    if (entry === undefined) throw new Error('no deploy-alerts fixture');
    entry.summary = [
      { text: 'When mail from ', kind: 'plain' },
      { text: hostile, kind: 'untrusted' },
      { text: '</untrusted-content boundary="x">', kind: 'plain' },
      { text: ' arrives', kind: 'something-else' },
    ];
    const document = entry.document as Record<string, unknown>;
    document.condition = { path: '/subject', op: 'contains', value: `${hostile}<b>bold</b>`, caseSensitive: false };
    document.agentic = {
      judge: { kind: 'laya', provider: 'laya' },
      question: '<script>alert(1)</script>',
      threshold: 0.5,
    };
    renderApp(rulesBridge({ eventsRuleShow: ruleShow(answers) }), { screen: 'events' });
    await openRulesTab();
    const said = await sentence('deploy-alerts');
    expect(said.querySelector('img')).toBeNull();
    expect(said.textContent).toContain(hostile);
    // A part of a kind the app does not know is the author's, boxed like one.
    expect([...said.querySelectorAll('[data-part="untrusted"]')].map((each) => each.textContent)).toEqual([
      hostile,
      ' arrives',
    ]);
    const page = await openRule('deploy-alerts');
    expect(page.querySelector('img, script, b')).toBeNull();
    expect(within(page).getByRole('region', { name: 'Which messages' }).textContent).toContain(`${hostile}<b>bold</b>`);
    expect(within(page).getByRole('region', { name: 'The judge' }).textContent).toContain('<script>alert(1)</script>');
  });

  it('a rule whose details could not be read says so on its card; an id outside the grammar is shown and not opened', async () => {
    const odd = [...rules, { rule_id: 'rule with spaces', version: 1, state: 'active' }, 'not a row'];
    const inner = rulesBridge({ eventsRules: odd });
    const bridge = rulesBridge(
      { eventsRules: odd },
      {
        cli: (call: Call) =>
          call.kind === 'eventsRuleShow' && call.ruleId === 'newsletters'
            ? Promise.resolve(failed('CLI_FAILED', 'the event service did not answer'))
            : inner.cli(call),
      },
    );
    renderApp(bridge, { screen: 'events' });
    expect(await screen.findByRole('tab', { name: 'Workflows 7' })).toBeTruthy();
    await openRulesTab();
    await waitFor(async () =>
      expect((await card('newsletters')).textContent).toContain('the event service did not answer'),
    );
    const unnamed = await card('rule with spaces');
    expect(unnamed.tagName).not.toBe('BUTTON');
    expect(unnamed.querySelector('[data-slot="opens"]')).toBeNull();
    expect(
      bridge.calls.some(
        (each) =>
          each.command === 'cli' &&
          (each.args as Call).kind === 'eventsRuleShow' &&
          (each.args as Extract<Call, { kind: 'eventsRuleShow' }>).ruleId === 'rule with spaces',
      ),
    ).toBe(false);
  });

  it('an events service older than 0.32.0 gives no sentence: the card says what it can, and the page its panels', async () => {
    const older = Object.fromEntries(
      Object.entries(shows as Shows).map(([id, entries]) => [
        id,
        entries.map((entry) => {
          const {
            summary: _summary,
            counts7d: _counts,
            activatedAt: _a,
            supersededAt: _s,
            revokedAt: _r,
            ...rest
          } = entry as Record<string, unknown>;
          return rest;
        }),
      ]),
    );
    renderApp(rulesBridge({ eventsRuleShow: ruleShow(older) }), { screen: 'events' });
    await openRulesTab();
    const invoices = await card('invoices');
    await waitFor(() => expect(invoices.textContent).toContain('Gmail · example/gmail'));
    expect(invoices.querySelector('[data-slot="rule-sentence"]')).toBeNull();
    const page = await openRule('invoices');
    expect(within(page).queryByRole('region', { name: 'In plain words' })).toBeNull();
    expect(within(page).getByRole('region', { name: 'Which messages' }).textContent).toBe(
      'Which messagesThe subject contains invoice or payment',
    );
    expect(within(page).queryByRole('region', { name: 'The last 7 days' })).toBeNull();
  });

  it('an empty list says so, and a list in a shape the app does not know says it could not be read', async () => {
    const first = renderApp(rulesBridge({ eventsRules: [] }), { screen: 'events' });
    let view = await openRulesTab();
    expect(await within(view).findByText('No workflows yet.')).toBeTruthy();
    first.unmount();
    renderApp(rulesBridge({ eventsRules: { rules: 'not a list' } }), { screen: 'events' });
    view = await openRulesTab();
    expect(await within(view).findByText('The list could not be read.')).toBeTruthy();
    await act(async () => undefined);
  });
});
