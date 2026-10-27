// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Call, CliResult } from '../ipc.ts';
import {
  envelopedText,
  foundBy,
  handleParts,
  joinStories,
  namedPeople,
  questionProblem,
  readIndexRun,
  readPeople,
  readPerson,
  readSearchResult,
  readSearchStatus,
  readSettingsChange,
  windowSince,
} from '../search.ts';
import { createFakeBridge, ok } from './fake-bridge.ts';
import activityItems from './fixtures/activity-items.json';
import searchPeople from './fixtures/search-people.json';
import searchPerson from './fixtures/search-person.json';
import searchQuery from './fixtures/search-query.json';
import statusNever from './fixtures/search-status.never.json';
import statusOn from './fixtures/search-status.on.json';

/*
 * What Search on this machine answers, read (0.35.0, design 2026-10-26-local-search §6–§8): core's `search … --json`, in
 * the shapes recorded from core against a stand-in machine (fixtures `search-*.json`, every sender's word enveloped by
 * core's own `wrapUntrusted`), and the join that gives each found message its story (S4).
 */

describe('Search’s answers, read', () => {
  it('status says on or off, what is kept by count, the model and where things are, and never a message', () => {
    const on = readSearchStatus(statusOn);
    expect(on?.on).toBe(true);
    expect(on?.accounts.map((account) => account.alias)).toEqual(['example/gmail', 'example/slack']);
    expect(on?.kept).toEqual({
      messages: 4,
      asked: 3,
      answered: 1,
      people: 3,
      waiting: 0,
      bytes: 135199,
      oldestDay: '2026-10-24',
    });
    expect(on?.model).toMatchObject({ name: 'qwen3-embedding:0.6b', state: 'running', localOnly: false });
    expect(on?.models.map((model) => model.name)).toEqual([
      'qwen3-embedding:0.6b',
      'embeddinggemma:latest',
      'bge-m3:latest',
    ]);
    expect(on?.notes[0]).toMatch(/^Treat this folder like your mail/);
    const never = readSearchStatus(statusNever);
    expect(never?.on).toBe(false);
    expect(never?.model).toBeNull();
    // A state core may add later reads as the most careful word, never as running.
    expect(readSearchStatus({ ...statusOn, model: { ...statusOn.model, state: 'sideways' } })?.model?.state).toBe(
      'unexpected',
    );
    expect(readSearchStatus({ on: 'yes' })).toBeNull();
    expect(readSearchStatus(null)).toBeNull();
  });

  it('a search keeps every hit with its ids, its envelopes as they came, its flags and its ranks', () => {
    const result = readSearchResult(searchQuery);
    expect(result?.mode).toBe('hybrid');
    expect(result?.pending).toBe(2);
    expect(result?.hits.map((hit) => hit.sourceId)).toEqual([
      'D0EXAMPLE1/1792927860.000100',
      '18c2f0a1b2c3d4e5',
      '18c2f0a1b2c3e000',
    ]);
    const [slack, gmail, hostile] = result?.hits ?? [];
    expect(slack?.flags).toEqual(['mismatch']);
    expect(gmail?.answeredBy).toEqual([{ sourceId: '18c2f0a1b2c3d4f0', at: 1792928713000 }]);
    expect(hostile?.partial).toBe(true);
    // The sender's words stay in their envelope, a closing tag inside them defused by core.
    expect(hostile?.subject?.startsWith('<untrusted-content boundary="')).toBe(true);
    expect(envelopedText(hostile?.subject ?? '')).toContain('&lt;/untrusted-content');
    expect(foundBy(slack?.rank ?? { words: null, meaning: null })).toBe('both');
    expect(foundBy(hostile?.rank ?? { words: null, meaning: null })).toBe('meaning');
    expect(foundBy({ words: 4, meaning: null })).toBe('words');
    // A hit with no id, an account or a time is left out rather than guessed at.
    const broken = readSearchResult({ ...searchQuery, hits: [{ ...searchQuery.hits[0], sourceId: '' }, { at: 1 }] });
    expect(broken?.hits).toEqual([]);
    expect(readSearchResult({ mode: 'hybrid' })).toBeNull();
  });

  it('people and one person keep their handles, names and counts; index runs and changes read their numbers', () => {
    const people = readPeople(searchPeople) ?? [];
    expect(people.map((person) => person.id)).toEqual([
      'p_K19FVJ41QS08HPWN3XC3RQ2K7B',
      'p_8GE1HWF42A0071A07VARPJWX1D',
      'p_0B6F0RV3TG2X85D5K95WQFESA3',
    ]);
    expect(people[0]?.handles.map((handle) => handle.handle)).toEqual(['email:david@example.com']);
    const one = readPerson(searchPerson);
    expect(one?.person.count).toBe(1);
    expect(one?.messages.map((message) => message.sourceId)).toEqual(['18c2f0a1b2c3d4e5']);
    expect(readPerson({ messages: [] })).toBeNull();
    expect(
      readIndexRun({ ran: true, busy: false, taken: 4, embedded: 4, pending: 0, pruned: 0, model: null }),
    ).toMatchObject({ ran: true, embedded: 4, pending: 0 });
    expect(readIndexRun({ ran: 'yes' })).toBeNull();
    expect(
      readSettingsChange({ changed: true, on: true, accounts: [], model: null, deleted: 2, next: null }),
    ).toMatchObject({
      on: true,
      deleted: 2,
    });
  });

  it('a handle reads as its channel and what a person knows it by', () => {
    expect(handleParts('email:david@example.com')).toEqual({ channel: 'gmail', shown: 'david@example.com' });
    expect(handleParts('slack:T0EXAMPLE/U0DAVID')).toEqual({ channel: 'slack', shown: 'U0DAVID in T0EXAMPLE' });
    expect(handleParts('<untrusted-content …>').channel).toBeNull();
  });
});

describe('a name in a question', () => {
  const people = readPeople(searchPeople) ?? [];

  it('is a suggestion of everyone whose name is a run of its words, case-folded and without accents', () => {
    expect(namedPeople('what did David Example ask about invoices?', people).map((person) => person.id)).toEqual([
      'p_K19FVJ41QS08HPWN3XC3RQ2K7B',
      'p_8GE1HWF42A0071A07VARPJWX1D',
    ]);
    expect(namedPeople('DAVID EXAMPLE', people)).toHaveLength(2);
    expect(namedPeople('what did David ask', people)).toEqual([]);
    expect(namedPeople('invoices', people)).toEqual([]);
    // The person's own name for someone counts as theirs.
    const labelled = [{ ...people[0], label: 'Dávid' }] as typeof people;
    expect(namedPeople('what did david ask', labelled)).toHaveLength(1);
  });
});

describe('what a question may be', () => {
  it('is 1 to 500 characters with none core refuses, and may start with a dash', () => {
    expect(questionProblem('invoices')).toBeNull();
    expect(questionProblem('-draft')).toBeNull();
    expect(questionProblem('')).not.toBeNull();
    expect(questionProblem('   ')).not.toBeNull();
    expect(questionProblem('a\nb')).toMatch(/line break/);
    expect(questionProblem('a‮b')).toMatch(/bidi/);
    expect(questionProblem('é'.repeat(500))).toBeNull();
    expect(questionProblem('é'.repeat(501))).toMatch(/at most 500/);
  });

  it('looks through everything kept, the last 7 days, or today', () => {
    const now = new Date(2026, 9, 27, 15, 30);
    expect(windowSince('kept', now)).toBeUndefined();
    expect(windowSince('week', now)).toBe(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(windowSince('today', now)).toBe(new Date(2026, 9, 27).getTime());
  });
});

describe('the join a found message’s story comes from', () => {
  it('reads the messages’ activity by id, then their replies’ drafts, and joins as Messages does', async () => {
    const asked: Call[] = [];
    const bridge = createFakeBridge({
      cli: async (call): Promise<CliResult> => {
        asked.push(call);
        if (call.kind !== 'activityItems') return ok({});
        const wanted = new Set(call.ids ?? []);
        const items = Object.fromEntries(Object.entries(activityItems.items).filter(([id]) => wanted.has(id)));
        return ok({ items });
      },
    });
    const stories = await joinStories(
      bridge,
      [
        { sourceId: '18c2f0a1b2c3d4e5', eventId: null },
        { sourceId: 'D0EXAMPLE1/1792927860.000100', eventId: null },
        { sourceId: '18c2f0a1b2c3e000', eventId: null },
        { sourceId: 'nothing-recorded', eventId: null },
      ],
      { since: 1_792_000_000_000, withEvents: false },
    );
    expect(asked).toEqual([
      {
        kind: 'activityItems',
        since: 1_792_000_000_000,
        ids: ['18c2f0a1b2c3d4e5', 'D0EXAMPLE1/1792927860.000100', '18c2f0a1b2c3e000', 'nothing-recorded'],
      },
      // The Gmail reply's send is listed under its draft: read too, so the message reads Replied.
      { kind: 'activityItems', since: 1_792_000_000_000, ids: ['r-2000000000000000001'] },
    ]);
    expect(stories.bySource.get('18c2f0a1b2c3d4e5')?.status.kind).toBe('replied');
    expect(stories.bySource.get('D0EXAMPLE1/1792927860.000100')?.status.kind).toBe('acknowledged');
    expect(stories.bySource.get('18c2f0a1b2c3e000')?.status.kind).toBe('read');
    expect(stories.bySource.has('nothing-recorded')).toBe(false);
    expect(stories.problem).toBeNull();
  });

  it('reads a message the event service saw with message show, at most four at once, and only when asked to', async () => {
    let running = 0;
    let most = 0;
    const shown: string[] = [];
    const bridge = createFakeBridge({
      cli: async (call): Promise<CliResult> => {
        if (call.kind === 'activityItems') return ok({ items: {} });
        if (call.kind !== 'eventsMessageShow') return ok({});
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        shown.push(call.eventId);
        return ok({ message: { eventId: call.eventId, channel: 'gmail', source: { messageId: `m${call.eventId}` } } });
      },
    });
    const events = Array.from({ length: 9 }, (_, index) => `${index}`.repeat(32).slice(0, 32));
    const messages = events.map((eventId) => ({ sourceId: `m${eventId}`, eventId }));
    const stories = await joinStories(bridge, messages, { since: 1_792_000_000_000, withEvents: true });
    expect(shown.sort()).toEqual([...events].sort());
    expect(most).toBeLessThanOrEqual(4);
    expect(stories.events).toHaveLength(9);
    const without = await joinStories(bridge, messages, { since: 1_792_000_000_000, withEvents: false });
    expect(without.events).toEqual([]);
  });

  it('names at most 50 ids, each once, and only ids the allow-list takes', async () => {
    const asked: Call[] = [];
    const bridge = createFakeBridge({
      cli: async (call): Promise<CliResult> => {
        asked.push(call);
        return ok({ items: {} });
      },
    });
    const messages = [
      ...Array.from({ length: 60 }, (_, index) => ({ sourceId: `id${index}`, eventId: null })),
      { sourceId: 'id0', eventId: null },
      { sourceId: '../etc', eventId: null },
    ];
    await joinStories(bridge, messages, { since: 1_792_000_000_000, withEvents: false });
    const ids = (asked[0] as Extract<Call, { kind: 'activityItems' }>).ids ?? [];
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    expect(ids).not.toContain('../etc');
  });
});
