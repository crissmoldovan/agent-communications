// @vitest-environment node
/*
 * The rule editor's model (0.33.0): the text the app shows is the event package's own, and round-trips every rule the
 * app reads; each section writes back only what it has a control for; a changed target becomes its id's next version;
 * an applied suggestion goes in only where its part still holds what Analyse read; and what leaves this Mac is said
 * for each place a rule's fields go.
 */
import { describe, expect, it } from 'vitest';
import { insideAny, readAgentSessions, readLinear } from '../integrations.ts';
import { applySuggestions, readAnalyse, valueAt } from '../rule-editor/analyse.ts';
import {
  canonical,
  type JsonObject,
  setJudge,
  setTargets,
  setWhich,
  whenView,
  whichView,
} from '../rule-editor/model.ts';
import { knownTargets, readActivation, targetSteps, whatLeaves, withStoredTargets } from '../rule-editor/submit.ts';
import { parseRuleText, printRuleText } from '../rule-text.ts';
import analyse from './fixtures/events-rule-analyse.v033.json';
import approval from './fixtures/events-rule-approval.v033.json';
import shows from './fixtures/events-rule-show.v032.json';
import sessions from './fixtures/integration-show-agent-sessions.v033.json';
import linear from './fixtures/integration-show-linear.connected.v033.json';

const documents = Object.values(shows as Record<string, { document: JsonObject }[]>).flatMap((versions) =>
  versions.map((version) => version.document),
);
const invoices = (shows as Record<string, { document: JsonObject }[]>).invoices?.[1]?.document as JsonObject;

const text = (lines: { text: string }[][]) => lines.map((line) => line.map((part) => part.text).join(''));

describe('the rule editor model', () => {
  it('prints and parses every rule the app reads, exactly, with the event package’s own language', () => {
    expect(documents.length).toBeGreaterThan(5);
    for (const document of documents) {
      const parsed = parseRuleText(printRuleText(document));
      expect(parsed.ok, String(document.ruleId)).toBe(true);
      if (parsed.ok) expect(canonical(parsed.doc)).toBe(canonical(document));
    }
  });

  it('reads the sections it has controls for, and leaves the rest as text', () => {
    expect(whichView(invoices)).toEqual({
      match: 'any',
      lines: [
        { path: '/subject', op: 'contains', value: 'invoice' },
        { path: '/subject', op: 'contains', value: 'payment' },
      ],
    });
    expect(whenView(invoices)).toMatchObject({
      channel: 'gmail',
      accountId: 'in_01EXAMPLE0000000000000000',
      asText: false,
    });
    // A case-sensitive test, a `not`, and a number have no control: edited as text.
    for (const condition of [
      { path: '/subject', op: 'contains', value: 'x', caseSensitive: true },
      { not: { path: '/subject', op: 'exists' } },
      { path: '/size', op: 'gt', value: 3 },
    ])
      expect(whichView({ ...invoices, condition } as JsonObject), JSON.stringify(condition)).toBeNull();
    // One line written back is that line; two are any or all of them.
    const one = setWhich(invoices, { match: 'all', lines: [{ path: '/subject', op: 'equals', value: 'Hi' }] });
    expect(one.condition).toEqual({ path: '/subject', op: 'equals', value: 'Hi', caseSensitive: false });
    expect(canonical({ ...one, condition: invoices.condition })).toBe(canonical(invoices));
  });

  it('a judge turned off takes its copy from judges too; a queue target brings its retention', () => {
    const none = setJudge(invoices, null);
    expect(none.agentic).toBeUndefined();
    expect(none.judges).toEqual([]);
    const back = setJudge(none, (invoices.agentic as JsonObject).judge as JsonObject);
    expect((back.agentic as JsonObject).threshold).toBe(0.7);
    expect(back.judges).toEqual([(invoices.agentic as JsonObject).judge]);
    const noQueue = setTargets(invoices, [{ targetId: 'log', version: 1, kind: 'dry-run', retentionMs: 3_600_000 }]);
    expect((noQueue.retention as JsonObject).queueMs).toBeUndefined();
    const queued = setTargets(noQueue, [{ targetId: 'q', version: 1, kind: 'queue', retentionMs: 86_400_000 }]);
    expect((queued.retention as JsonObject).queueMs).toBe(86_400_000);
  });

  it('stores a changed target as its next version, a new one at its own, and an unchanged one not at all', () => {
    const known = knownTargets(documents);
    const versions = new Map([
      ['billing-queue', 1],
      ['ci-hook', 1],
    ]);
    expect(targetSteps(invoices, known, versions)).toEqual([]);
    const target = (invoices.targets as JsonObject[])[0] as JsonObject;
    const changed = {
      ...invoices,
      targets: [
        { ...target, lane: { name: 'accounts' } },
        { targetId: 'inv-log', version: 1, kind: 'dry-run', retentionMs: 3_600_000 },
      ],
    };
    const steps = targetSteps(changed, known, versions);
    expect(steps.map((step) => [step.index, step.call, step.document.version])).toEqual([
      [0, 'eventsTargetUpdate', 2],
      [1, 'eventsTargetAdd', 1],
    ]);
    const stored = withStoredTargets(changed, new Map([[0, { ...target, version: 2, show: 'summary' }]]));
    expect((stored.targets as JsonObject[])[0]).toMatchObject({ version: 2 });
    expect(readActivation(approval.ruleEnable)).toEqual({
      approvalId: approval.ruleEnable.approvalId,
      digest: approval.ruleEnable.binding.digest,
    });
    expect(readActivation({ approvalId: 'ap_x', binding: { digest: 'short' } })).toBeNull();
  });

  it('applies a suggestion only where its part still holds what Analyse read', () => {
    const read = readAnalyse(analyse);
    expect(read?.provider).toBe('openrouter');
    expect(read?.suggestions).toHaveLength(3);
    const { document, notApplied } = applySuggestions(invoices, read?.suggestions ?? []);
    expect(valueAt(document, '/agentic/question')).toBe(
      'Is the sender asking me to pay them, or to send them an invoice?',
    );
    expect(valueAt(document, '/agentic/threshold')).toBe(0.75);
    expect(notApplied).toEqual([]);
    const stale = applySuggestions(invoices, [
      { part: '/agentic/question', before: 'x', after: 'y', why: '', evidence: null },
    ]);
    expect(stale.notApplied).toHaveLength(1);
    expect(canonical(stale.document)).toBe(canonical(invoices));
    // A pointer that leaves the document, or names no parent, changes nothing.
    expect(
      applySuggestions(invoices, [{ part: '/nope/deeper', before: null, after: 1, why: '', evidence: null }])
        .notApplied,
    ).toHaveLength(1);
  });

  it('says what leaves this Mac for a hosted judge, Linear and a session, and nothing for the dry-run log', () => {
    expect(text(whatLeaves(invoices))).toEqual([
      'To judge them: the subject and the first 300 characters of matching mail go to OpenRouter (openrouter.ai), which passes it to TypeSafe.',
    ]);
    const acting = {
      ...invoices,
      agentic: undefined,
      targets: [
        {
          targetId: 'l',
          version: 1,
          kind: 'linear',
          team: { id: 't', key: 'CUE' },
          title: '{{subject}}',
          labels: [],
          assignee: 'me',
        },
        {
          targetId: 's',
          version: 1,
          kind: 'session',
          find: { folder: '/example/home/work/acme' },
          ifNone: 'start',
          provider: 'claude',
          ifBusy: 'queue',
          context: [{ file: '/example/home/work/acme/HOW.md' }],
        },
      ],
    } as unknown as JsonObject;
    const lines = text(whatLeaves(acting));
    expect(lines[0]).toContain('An issue is added in Linear (api.linear.app), team CUE');
    expect(lines[1]).toContain('go to a Claude Code session in /example/home/work/acme, which can act');
    expect(lines[2]).toBe('The file /example/home/work/acme/HOW.md goes to the session.');
    const quiet = {
      ...invoices,
      agentic: undefined,
      targets: [{ targetId: 'd', version: 1, kind: 'dry-run', retentionMs: 1 }],
    } as unknown as JsonObject;
    expect(text(whatLeaves(quiet))).toEqual(['Nothing leaves this Mac.']);
  });

  it('reads Integrations, and tells a folder inside the relay’s from one outside it', () => {
    expect(readLinear(linear)).toMatchObject({ connected: true, workspace: 'Example Co' });
    expect(readLinear({ connected: 'yes' })).toBeNull();
    const relay = readAgentSessions(sessions);
    expect(relay).toMatchObject({ home: 'claude-stream', relay: 'running', allowedRoots: ['/example/home/work'] });
    expect(readAgentSessions({ home: '/example/home' })).toBeNull();
    const roots = ['/example/home/work'];
    expect(insideAny('/example/home/work/acme', roots, null)).toBe(true);
    expect(insideAny('~/work/acme/notes.md', roots, '/example/home')).toBe(true);
    expect(insideAny('/example/home/workshop', roots, null)).toBe(false);
    expect(insideAny('/example/home/work/../secrets', roots, null)).toBe(false);
    expect(insideAny('work/acme', roots, null)).toBe(false);
  });
});
