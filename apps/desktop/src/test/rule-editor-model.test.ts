// @vitest-environment node
/*
 * The rule editor's model (0.33.0): the text the app shows is the event package's own, and round-trips every rule the
 * app reads; each section writes back only what it has a control for; a changed target becomes its id's next version;
 * an applied suggestion goes in only where its part still holds what Analyse read; and what leaves this Mac is said
 * for each place a rule's fields go.
 */
import { describe, expect, it } from 'vitest';
import { insideAny, readAgentSessions, readLinear } from '../integrations.ts';
import { applySuggestions, readAnalyse } from '../rule-editor/analyse.ts';
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

  it('applies a suggestion only where its part still holds what Analyse read, the rule text parts through the text', () => {
    const read = readAnalyse(analyse);
    expect(read?.model).toMatchObject({ provider: 'openrouter', name: 'OpenRouter', ran: true, noKey: ['anthropic'] });
    expect(read?.counts.domains).toHaveLength(2);
    const suggestions = read?.suggestions ?? [];
    expect(suggestions.map((each) => each.part)).toEqual(['condition', 'judge.threshold', 'judge.question', 'general']);
    const { document, notApplied } = applySuggestions(invoices, suggestions.slice(0, 3));
    expect(notApplied).toEqual([]);
    const agentic = document.agentic as JsonObject;
    expect(agentic.question).toBe('Is the sender asking me to pay them, or to send them an invoice?');
    expect(agentic.threshold).toBe(0.79);
    expect(document.condition).toEqual({
      all: [
        {
          any: [
            { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
            { path: '/subject', op: 'contains', value: 'payment', caseSensitive: false },
          ],
        },
        { not: { path: '/from/address', op: 'domainIs', value: 'bank.example', includeSubdomains: false } },
      ],
    });
    // Nothing else of the rule moved.
    expect(canonical({ ...document, condition: invoices.condition, agentic: invoices.agentic })).toBe(
      canonical(invoices),
    );
    // A part that no longer holds its before is left, and given back; a note is never applied.
    const stale = applySuggestions(invoices, [
      { part: 'judge.question', before: 'x', after: 'y', why: '', evidence: {} },
      {
        part: 'judge.threshold',
        before: 'yes at 0.5, if unsure drop',
        after: 'yes at 0.6, if unsure drop',
        why: '',
        evidence: {},
      },
      { part: 'linear.title', before: 'a', after: 'b', why: '', evidence: { targetId: 'no-such-target' } },
      { part: 'general', before: null, after: null, why: 'note', evidence: {} },
    ]);
    expect(stale.notApplied).toHaveLength(4);
    expect(canonical(stale.document)).toBe(canonical(invoices));
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
    expect(lines[1]).toContain('go to a Claude Code session in /example/home/work/acme, where it asks before it acts.');
    expect(lines[2]).toBe('The file /example/home/work/acme/HOW.md goes to the session.');
    const quiet = {
      ...invoices,
      agentic: undefined,
      targets: [{ targetId: 'd', version: 1, kind: 'dry-run', retentionMs: 1 }],
    } as unknown as JsonObject;
    expect(text(whatLeaves(quiet))).toEqual(['Nothing leaves this Mac.']);
  });

  it('reads Integrations, and tells a folder inside the relay’s from one outside it', () => {
    expect(readLinear(linear)).toMatchObject({ connected: true, workspace: 'Example Co', usedBy: null });
    expect(readLinear({ connected: true, workspace: { name: 'Old shape' }, teams: [] })?.workspace).toBe('Old shape');
    expect(readLinear({ connected: 'yes' })).toBeNull();
    const relay = readAgentSessions(sessions);
    expect(relay).toMatchObject({
      relayHome: null,
      ready: true,
      source: 'default',
      allowedRoots: ['/example/home/work'],
      allowedFolders: ['/example/home/notes'],
      waiting: 2,
    });
    expect(readAgentSessions({ home: '/example/home' })).toBeNull();
    const roots = ['/example/home/work'];
    expect(insideAny('/example/home/work/acme', roots, null)).toBe(true);
    expect(insideAny('~/work/acme/notes.md', roots, '/example/home')).toBe(true);
    expect(insideAny('/example/home/workshop', roots, null)).toBe(false);
    expect(insideAny('/example/home/work/../secrets', roots, null)).toBe(false);
    expect(insideAny('work/acme', roots, null)).toBe(false);
  });
});
