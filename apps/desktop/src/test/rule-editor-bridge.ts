/**
 * A fake event service for the rule editor's tests (0.33.0): the 0.32.0 rules, deliveries and accounts, the editor's
 * reads — judges, lanes, Linear and agent sessions, target versions — and its steps, each answered as the event service
 * answers it (`events-rule-approval.v033.json` holds what a real owner printed): a target or a rule stored from the
 * document it was given, an activation prepared for it, its approval view — as Rust hands it to the window, without
 * its challenges — and the approval. Every call is recorded; nothing runs.
 */
import type { Call } from '../ipc.ts';
import { createFakeBridge, type FakeBridge, type Fixture } from './fake-bridge.ts';
import deliveries from './fixtures/events-deliveries.v032.json';
import analyse from './fixtures/events-rule-analyse.v033.json';
import approval from './fixtures/events-rule-approval.v033.json';
import shows from './fixtures/events-rule-show.v032.json';
import rules from './fixtures/events-rules.v032.json';
import sessions from './fixtures/integration-show-agent-sessions.v033.json';
import linearConnected from './fixtures/integration-show-linear.connected.v033.json';
import linearDisconnected from './fixtures/integration-show-linear.disconnected.v033.json';
import laneList from './fixtures/lane-list.json';

export const APPROVAL = approval.ruleEnable.approvalId;
export const DIGEST = approval.ruleEnable.binding.digest;

/** The judges `judges list` names: invoices' own Jev, whose document the rules carry, and one no rule carries yet. */
export const JUDGES = [
  { judgeId: 'jev-billing', version: 1, kind: 'typesafe', provider: 'openrouter', model: 'jev-1', revokedAt: null },
  { judgeId: 'jev', version: 4, kind: 'typesafe', provider: 'typesafe', model: 'jev-1.13.0', revokedAt: null },
];

export const LINEAR = { connected: linearConnected, disconnected: linearDisconnected } as const;
export const SESSIONS = sessions;
export const ANALYSE = analyse;

type Stored = Record<string, unknown>;

/** What the fake event service was given and made, for a test to read. */
export interface EditorService {
  bridge: FakeBridge;
  /** The documents each step was given, in order. */
  stored: { kind: Call['kind']; document: Stored }[];
  /** Every call of a kind, as the window made it. */
  calls(kind: Call['kind']): Call[];
}

export function editorBridge(
  options: { linear?: 'connected' | 'disconnected'; fixtures?: Partial<Record<Call['kind'], Fixture>> } = {},
): EditorService {
  const stored: EditorService['stored'] = [];
  let lastRule: Stored | null = null;
  const pending = (kind: string, document: Stored) => ({
    id: `${String(document.targetId ?? document.ruleId)}@${String(document.version)}`,
    kind,
    objectId: document.targetId ?? document.ruleId,
    version: document.version,
    document,
    digest: '8cfb7d4576a43b4cb999e1be67824ffabfc974e729d5891edc7e9444b024c0f8',
    state: null,
  });
  const store = (kind: 'target' | 'rule') => (call: Call) => {
    const document = (call as Extract<Call, { document: unknown }>).document as Stored;
    stored.push({ kind: call.kind, document });
    if (kind === 'rule') lastRule = document;
    return pending(kind, document);
  };
  const bridge = createFakeBridge(
    {},
    {
      version: '0.33.0',
      eventsRules: rules,
      eventsRuleShow: (call: Call) =>
        (shows as Record<string, unknown[]>)[(call as Extract<Call, { kind: 'eventsRuleShow' }>).ruleId] ?? [],
      eventsDeliveries: deliveries,
      judgesList: JUDGES,
      laneList,
      integrationShow: (call: Call) =>
        (call as Extract<Call, { kind: 'integrationShow' }>).integration === 'linear'
          ? LINEAR[options.linear ?? 'connected']
          : SESSIONS,
      eventsTargetsList: approval.targetsList,
      eventsTargetAdd: store('target'),
      eventsTargetUpdate: store('target'),
      eventsRuleCreate: store('rule'),
      eventsRuleUpdate: store('rule'),
      eventsRuleEnable: (call: Call) => {
        const { ruleId, version } = call as Extract<Call, { kind: 'eventsRuleEnable' }>;
        return {
          ...approval.ruleEnable,
          binding: {
            ...approval.ruleEnable.binding,
            versions: [{ kind: 'rule', id: ruleId, version }],
          },
        };
      },
      // As Rust hands it to the window: the view's own challenge and its selectors' taken out.
      eventsApprovalView: () => ({
        kind: 'READY',
        approvalId: APPROVAL,
        digest: DIGEST,
        preview: { documentVersion: 1, kind: 'rule', rule: lastRule },
        pendingTargetSelectors: [],
        challenge: { approvalId: APPROVAL, digest: DIGEST, expiresAt: 1793001434137 },
      }),
      eventsRuleApprove: (call: Call) => ({
        ...approval.ruleApprove,
        version: (lastRule?.version as number | undefined) ?? approval.ruleApprove.version,
        ruleId:
          (call as Extract<Call, { kind: 'eventsRuleApprove' }>).approvalId === APPROVAL ? lastRule?.ruleId : null,
      }),
      eventsRuleAnalyse: analyse,
      integrationSetAgentSessions: (call: Call) => ({
        ...SESSIONS,
        settings: {
          ...SESSIONS.settings,
          relayHome: (call as Extract<Call, { kind: 'integrationSetAgentSessions' }>).relayHome,
        },
      }),
      providerKeyRemove: (call: Call) => ({
        provider: (call as Extract<Call, { kind: 'providerKeyRemove' }>).provider,
        hasKey: false,
        judges: 0,
      }),
      ...options.fixtures,
    },
  );
  return {
    bridge,
    stored,
    calls: (kind) =>
      bridge.calls
        .filter((each) => each.command === 'cli' && (each.args as Call).kind === kind)
        .map((each) => each.args as Call),
  };
}
