/**
 * The checks the editor makes as the person types (0.33.0, design §3.2): the text's own mistakes, by line and column;
 * an account this Mac does not have; a lane that does not exist yet; an integration that is not connected; a folder
 * or a file a session may not read. Each is a line of parts, so whatever the rule's author wrote stays boxed as theirs.
 * None of them is the event service's word: it checks the document again when it is submitted.
 */
import type { AccountNames } from '../account-aliases.ts';
import type { RulePart } from '../events-rules.ts';
import { insideAny, type LinearState, type SessionsState } from '../integrations.ts';
import type { RuleTextError } from '../rule-text.ts';
import { isObject, type JsonObject, targetsIn, whichView } from './model.ts';
import { linearView, sessionView } from './targets.ts';

export interface Check {
  tone: 'ok' | 'warn' | 'error';
  parts: RulePart[];
  /** Where the person fixes it, when that is elsewhere in the app. */
  fix?: 'integrations';
}

const plain = (text: string): RulePart => ({ text, kind: 'plain' });
const authored = (text: string): RulePart => ({ text, kind: 'untrusted' });

/** What the editor knows of this Mac, to check a draft against. Each is null while it is not read. */
export interface CheckContext {
  accounts: AccountNames;
  lanes: readonly string[] | null;
  linear: LinearState | null;
  sessions: SessionsState | null;
  home: string | null;
}

/** The text's mistakes: each with its line and column, as the parser found them, in order. */
export function parseChecks(errors: readonly RuleTextError[]): Check[] {
  return errors.map((error) => ({
    tone: 'error',
    parts: [plain(`Line ${error.line}, column ${error.column}: `), authored(error.message)],
  }));
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The checks of a document the text parsed to, or the visual editor holds. */
export function draftChecks(document: JsonObject, context: CheckContext): Check[] {
  const checks: Check[] = [];
  const source = isObject(document.source) ? document.source : {};
  const accounts = Array.isArray(source.accountIds)
    ? source.accountIds.filter((id): id is string => typeof id === 'string')
    : [];
  const which = whichView(document);
  const conditions = which === null ? null : which.lines.length;
  const targets = targetsIn(document);
  const judge = isObject(document.agentic);
  checks.push({
    tone: 'ok',
    parts: [
      plain(
        `Understood: ${count(accounts.length, 'account', 'accounts')}, ${
          conditions === null ? 'a condition written as text' : count(conditions, 'condition', 'conditions')
        }, ${judge ? 'a judge' : 'no judge'} and ${count(targets.length, 'action', 'actions')}.`,
      ),
    ],
  });
  if (accounts.length === 0) checks.push({ tone: 'error', parts: [plain('Name the account it watches.')] });
  for (const id of accounts) {
    const known = context.accounts.get(id);
    if (known === undefined && context.accounts.size > 0)
      checks.push({ tone: 'warn', parts: [plain('This Mac has no account '), authored(id), plain('.')] });
  }
  if (targets.length === 0) checks.push({ tone: 'error', parts: [plain('Add at least one action under then.')] });
  if (judge && typeof (document.agentic as JsonObject).question === 'string') {
    if (((document.agentic as JsonObject).question as string).trim() === '')
      checks.push({ tone: 'error', parts: [plain("Write the judge's question.")] });
  }
  for (const target of targets) {
    if (target.kind === 'queue' && isObject(target.lane) && typeof target.lane.name === 'string') {
      const lane = target.lane.name;
      if (context.lanes === null) continue;
      checks.push(
        context.lanes.includes(lane)
          ? { tone: 'ok', parts: [authored(lane), plain(' is a lane that exists.')] }
          : {
              tone: 'warn',
              parts: [authored(lane), plain(' is a new lane: an agent window reads it once you bind one to it.')],
            },
      );
    }
    const linear = linearView(target);
    if (linear !== null) {
      if (context.linear !== null && !context.linear.connected)
        checks.push({
          tone: 'warn',
          parts: [plain("Linear isn't connected. Connect it before you approve.")],
          fix: 'integrations',
        });
      if (linear.teamId === '') checks.push({ tone: 'error', parts: [plain('Choose the Linear team.')] });
      else if (context.linear?.connected === true && !context.linear.teams.some((team) => team.id === linear.teamId))
        checks.push({
          tone: 'warn',
          parts: [plain('Your Linear key cannot see the team '), authored(linear.teamKey || linear.teamId), plain('.')],
        });
    }
    const session = sessionView(target);
    if (session !== null) checks.push(...sessionChecks(session, context));
  }
  return checks;
}

function sessionChecks(session: NonNullable<ReturnType<typeof sessionView>>, context: CheckContext): Check[] {
  const checks: Check[] = [];
  if (session.where.trim() === '') {
    checks.push({
      tone: 'error',
      parts: [
        plain(session.findBy === 'lane' ? 'Name the lane of the session.' : 'Name the folder the session works in.'),
      ],
    });
    return checks;
  }
  if (session.windowOnly) return checks;
  const sessions = context.sessions;
  if (sessions !== null && sessions.relay !== 'running')
    checks.push({
      tone: 'warn',
      parts: [plain("Agent sessions aren't ready: claude-stream isn't running here.")],
      fix: 'integrations',
    });
  const roots = sessions?.allowedRoots ?? [];
  if (session.findBy === 'folder' && sessions !== null && !insideAny(session.where, roots, context.home))
    checks.push({
      tone: 'warn',
      parts: [plain('The folder '), authored(session.where), plain(' is outside the folders claude-stream allows.')],
    });
  for (const part of session.context ?? []) {
    if (part.kind !== 'file') continue;
    if (sessions !== null && !insideAny(part.path, roots, context.home))
      checks.push({
        tone: 'warn',
        parts: [plain('The file '), authored(part.path), plain(' is outside the folders a session may be given.')],
      });
    else
      checks.push({
        tone: 'warn',
        parts: [plain('The file is read when the session starts, so changes to it reach later sessions.')],
      });
  }
  return checks;
}

/** Whether the checks let the person go on to the review: no mistake left, only cautions. */
export function blocking(checks: readonly Check[]): boolean {
  return checks.some((check) => check.tone === 'error');
}
