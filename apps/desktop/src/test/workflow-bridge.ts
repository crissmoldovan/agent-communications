/**
 * A fake event service at 0.36.0 for the designer's tests: the rule editor's (`rule-editor-bridge.ts`) — 0.32.0's rules
 * and deliveries, the editor's reads, its steps stored from the documents they are given — with workflows beside them:
 * the spec's owner example (§4.4) as `client-asks`, and any others a test adds. Every call is recorded; nothing runs.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import owner from '../../../../packages/events/test/fixtures/flows/owner-example.json';
import type { Call } from '../ipc.ts';
import type { Fixture } from './fake-bridge.ts';
import shows from './fixtures/events-rule-show.v032.json';
import rules from './fixtures/events-rules.v032.json';
import { type EditorService, editorBridge } from './rule-editor-bridge.ts';

/** The owner's example, as the event service holds it. */
export const OWNER = owner as unknown as Record<string, unknown>;

/** A small workflow with no events yet: wait an hour, then tell me, on acme's Slack. */
export const REMINDERS: Record<string, unknown> = {
  ruleId: 'reminders',
  version: 1,
  source: {
    channel: 'slack',
    accountIds: ['acme/slack'],
    options: { channel: 'slack', conversations: ['C0123'] },
  },
  event: { type: 'slack.message.posted', version: 1 },
  condition: { path: '/text', op: 'exists' },
  mapping: { text: { $path: '/text' } },
  targets: [],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: (owner as unknown as { retention: Record<string, unknown> }).retention,
  flow: {
    flowVersion: 1,
    start: 'wait',
    steps: {
      wait: { kind: 'wait', for: { time: { afterMs: 3600000 } }, timeoutMs: 3600000, next: { elapsed: 'tell' } },
      tell: { kind: 'notify', text: 'Time to look at it again', next: {} },
    },
    limits: (owner as unknown as { flow: { limits: Record<string, unknown> } }).flow.limits,
  },
};

const row = (ruleId: string, version: number) => ({
  ...(rules[0] as Record<string, unknown>),
  rule_id: ruleId,
  version,
  state: 'active',
});

const show = (document: Record<string, unknown>) => [
  {
    ...((shows as Record<string, Record<string, unknown>[]>).invoices?.[1] ?? {}),
    document,
    summary: null,
  },
];

/** The rule editor's fake service with the event service at 0.36.0, and `workflows` beside the rules. */
export function workflowService(
  workflows: readonly Record<string, unknown>[] = [OWNER, REMINDERS],
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
): EditorService {
  const held = new Map(workflows.map((document) => [String(document.ruleId), document]));
  return editorBridge({
    fixtures: {
      version: (call: Call) => (call.kind === 'version' && call.product === 'events-daemon' ? '0.36.0' : '0.33.0'),
      eventsRules: [...rules, ...workflows.map((document) => row(String(document.ruleId), Number(document.version)))],
      eventsRuleShow: (call: Call) => {
        const { ruleId } = call as Extract<Call, { kind: 'eventsRuleShow' }>;
        const document = held.get(ruleId);
        return document === undefined ? ((shows as Record<string, unknown[]>)[ruleId] ?? []) : show(document);
      },
      eventsProjectsList: { projects: [] },
      ...fixtures,
    },
  });
}

/** Opens Events → Rules, the workflow's page, then Edit…, and gives the designer's region. */
export async function openDesigner(ruleId: string): Promise<HTMLElement> {
  const tab = await screen.findByRole('tab', { name: /^(?:Rules|Workflows)\b/ });
  fireEvent.click(tab);
  const card = await waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-rule="${ruleId}"]`);
    if (found === null) throw new Error(`no card for ${ruleId}`);
    return found;
  });
  fireEvent.click(card);
  const page = await screen.findByRole('region', {
    name: new RegExp(`^(?:Rule|Workflow) ${ruleId.replace('.', '\\.')}$`),
  });
  fireEvent.click(await within(page).findByRole('button', { name: 'Edit…' }));
  return screen.findByRole('region', { name: `Edit ${ruleId}` });
}

/** A box on the canvas, once it is drawn. */
export async function box(editor: HTMLElement, stepId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = editor.querySelector<HTMLElement>(`[data-step="${stepId}"]`);
    if (found === null) throw new Error(`${stepId} is not drawn yet`);
    return found;
  });
}

/** Selects a box, as a click on it does, and gives its settings. */
export async function select(editor: HTMLElement, stepId: string): Promise<HTMLElement> {
  const drawn = await box(editor, stepId);
  fireEvent.click(drawn.closest('.react-flow__node') ?? drawn);
  return waitFor(() => {
    const found = editor.querySelector<HTMLElement>(`[data-settings="${stepId}"]`);
    if (found === null) throw new Error(`${stepId}'s settings are not open`);
    return found;
  });
}

/** What React Flow reads of the page, which jsdom does not have: call it before rendering a canvas. */
export function polyfillCanvas(): void {
  globalThis.DOMMatrixReadOnly ??= class {
    m22 = 1;
  } as unknown as typeof DOMMatrixReadOnly;
  // jsdom has no DragEvent, so a drop would carry no pointer: one that is a mouse event, as a browser's is.
  globalThis.DragEvent ??= class extends MouseEvent {} as unknown as typeof DragEvent;
}
