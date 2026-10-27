import { createHash } from 'node:crypto';
import { compareUtf8, getPointer, type JsonValue, type RouteCandidate } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../../domain/activation-documents.ts';
import type { ProjectHintsV1, ProjectV1 } from '../../../domain/projects.ts';
import { routeCandidateOf } from '../../../domain/projects.ts';
import { hasSenderAddress, isKeptSenderDomain } from '../../../domain/sender-domain.ts';
import type { Output, StepContext, StepExecutor, StepResult } from '../contracts.ts';

/**
 * Which project? — the route step (workflows design §6.1, §8.3, W12, W13). It chooses one of the projects its approved
 * version names, never another: the candidates are bound into the document by value (id, name, folders, worktree
 * root), and a candidate whose folders or worktree root are no longer the project's takes `none` with
 * `PROJECT_CHANGED`, for the person to review the workflow again.
 *
 * The person's hints come first, and are deterministic and free: the sender's address domain, the Slack conversation,
 * and a person the project lists (a Slack user id, or an email address). One project hinted is `chosen`; several go to
 * the judge, one yes-or-no per project — "Is this message about the project <name>: <profile>?" — on the step's own
 * judge, its budget and its bar. The highest yes is chosen; two yeses within 0.05 of each other are `unsure`, and so
 * is a judge that said unsure or failed; no yes is `none`. At most 8 calls per attempt (a route names at most 8).
 *
 * Hints and profiles are read as the project is now: they change at once, with no approval. The output is closed:
 * ids, the project's name (the person's words), a reason word, a score and the profile's SHA-256. It never quotes the
 * message: what a sender wrote reaches only the judge, inside its own envelope, and only through the step's inputs.
 */

/** Two yeses closer than this are too close to call. */
export const ROUTE_UNSURE_MARGIN = 0.05;
/** Judge calls per attempt, at most. */
export const ROUTE_JUDGE_CALLS_MAX = 8;

/** Why a route chose, or the closed code when it could not: a candidate the project no longer matches. */
export type RouteReason =
  | 'hint:sender-domain'
  | 'hint:slack-conversation'
  | 'hint:person'
  | 'judge'
  | 'PROJECT_CHANGED';

export interface RouteExecutorDeps {
  /** A project as it is now, or null when it is gone. */
  readonly project: (projectId: string) => ProjectV1 | null;
}

/** What a message says about who sent it and where, from the run's mapped fields: ids and a domain, never its words. */
export interface RouteFacts {
  readonly senderDomain: string | null;
  readonly slackConversation: string | null;
  readonly people: readonly string[];
}

/** The output pointers at which a rule's mapping puts the source value at `source`. */
function mappedAt(template: JsonValue, source: string, at = ''): string[] {
  if (template === null || typeof template !== 'object') return [];
  if (Array.isArray(template))
    return template.flatMap((item, index) => mappedAt(item as JsonValue, source, `${at}/${index}`));
  const record = template as Readonly<Record<string, JsonValue>>;
  if (typeof record.$path === 'string') {
    const path = record.$path;
    if (path === source) return [at];
    if (source.startsWith(`${path}/`)) return [`${at}${source.slice(path.length)}`];
    return [];
  }
  return Object.entries(record).flatMap(([key, value]) =>
    mappedAt(value, source, `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`),
  );
}

function mappedText(rule: CanonicalFullRuleDocument, fields: JsonValue, source: string): string | null {
  for (const pointer of mappedAt(rule.mapping, source)) {
    const found = getPointer(fields, pointer);
    if (found.found && typeof found.value === 'string' && found.value.length > 0) return found.value;
  }
  return null;
}

/**
 * What the hints are matched against: the sender's address domain (an email event that keeps `from.address`), the
 * Slack conversation id and the Slack author's user id (a Slack event that keeps them), and the sender's address.
 */
export function routeFacts(rule: CanonicalFullRuleDocument, fields: Readonly<Record<string, JsonValue>>): RouteFacts {
  const data = fields as JsonValue;
  const people: string[] = [];
  let senderDomain: string | null = null;
  if (hasSenderAddress(rule.event.type, rule.event.version)) {
    const address = mappedText(rule, data, '/from/address')?.toLowerCase() ?? null;
    if (address !== null) {
      const domain = address.slice(address.lastIndexOf('@') + 1);
      if (address.lastIndexOf('@') > 0 && isKeptSenderDomain(domain)) {
        senderDomain = domain;
        people.push(address);
      }
    }
  }
  let slackConversation: string | null = null;
  if (rule.event.type.startsWith('slack.')) {
    slackConversation = mappedText(rule, data, '/channel/id')?.toUpperCase() ?? null;
    const author = mappedText(rule, data, '/author/userId')?.toUpperCase() ?? null;
    if (author !== null) people.push(author);
  }
  return { senderDomain, slackConversation, people };
}

/** The first hint of `hints` the facts meet, in the person's order of trust: domain, conversation, person. */
function hinted(hints: ProjectHintsV1 | undefined, facts: RouteFacts): RouteReason | null {
  if (hints === undefined) return null;
  if (facts.senderDomain !== null && hints.senderDomains.includes(facts.senderDomain)) return 'hint:sender-domain';
  if (facts.slackConversation !== null && hints.slackConversations.includes(facts.slackConversation))
    return 'hint:slack-conversation';
  if (facts.people.some((person) => hints.people.includes(person))) return 'hint:person';
  return null;
}

/** Whether a candidate is no longer the project as it is now: gone, or its folders or worktree root moved. */
export function candidateChanged(candidate: RouteCandidate, project: ProjectV1 | null): boolean {
  if (project === null) return true;
  const now = routeCandidateOf(project);
  const folders = [...candidate.folders].sort(compareUtf8);
  return (
    now.worktreeRoot !== candidate.worktreeRoot ||
    now.folders.length !== folders.length ||
    now.folders.some((folder, index) => folder !== folders[index])
  );
}

/** The one question the judge is asked of each project: its name and the person's profile of it. */
export function routeQuestion(name: string, profile: string): string {
  return profile.trim().length === 0
    ? `Is this message about the project ${name}?`
    : `Is this message about the project ${name}: ${profile}?`;
}

/** SHA-256, hex, of a profile's UTF-8 bytes: which words the route chose by, without them. */
export function profileHash(profile: string): string {
  return createHash('sha256').update(profile, 'utf8').digest('hex');
}

function settled(outcome: 'chosen' | 'none' | 'unsure', output: Output): StepResult {
  return { kind: 'settled', outcome, output };
}

function unchosen(outcome: 'none' | 'unsure', reason: RouteReason | null, score: number | null): StepResult {
  return settled(outcome, { project: null, projectName: null, reason, score, profileHash: null });
}

async function route(ctx: StepContext, deps: RouteExecutorDeps): Promise<StepResult> {
  const step = ctx.step;
  if (step.kind !== 'route') return { kind: 'failed', code: 'STEP_KIND' };
  const projects = new Map(
    step.candidates.map((candidate) => [candidate.projectId, deps.project(candidate.projectId)]),
  );
  const choose = (candidate: RouteCandidate, reason: RouteReason, score: number | null): StepResult => {
    const project = projects.get(candidate.projectId) ?? null;
    if (project === null || candidateChanged(candidate, project)) return unchosen('none', 'PROJECT_CHANGED', score);
    return settled('chosen', {
      project: candidate.projectId,
      projectName: candidate.name,
      reason,
      score,
      profileHash: profileHash(project.profile),
    });
  };
  const fields = await ctx.fields();
  let remaining: readonly RouteCandidate[] = step.candidates;
  if (step.by.includes('hints')) {
    const facts = routeFacts(ctx.rule, fields);
    const matched = step.candidates.flatMap((candidate) => {
      const reason = hinted(projects.get(candidate.projectId)?.hints, facts);
      return reason === null ? [] : [{ candidate, reason }];
    });
    const [only] = matched;
    if (matched.length === 1 && only !== undefined) return choose(only.candidate, only.reason, null);
    if (!step.by.includes('judge')) return unchosen(matched.length > 1 ? 'unsure' : 'none', null, null);
    if (matched.length > 1) remaining = matched.map((entry) => entry.candidate);
  }
  const ask = step.judge;
  if (ask === undefined) return unchosen('none', null, null);
  const inputs: Record<string, JsonValue> = {};
  for (const pointer of step.inputs) {
    const found = getPointer(fields as JsonValue, pointer);
    if (found.found) inputs[pointer] = found.value as JsonValue;
  }
  // What reaches the judge leaves the event service: the version's authority is checked again first.
  await ctx.fence();
  const answers: { candidate: RouteCandidate; said: 'yes' | 'no' | 'unsure'; score: number | null }[] = [];
  for (const candidate of remaining.slice(0, ROUTE_JUDGE_CALLS_MAX)) {
    const profile = projects.get(candidate.projectId)?.profile ?? '';
    const answer = await ctx.judge(ask, inputs, routeQuestion(candidate.name, profile));
    if (answer.kind === 'wait') return { kind: 'wait', wait: 'limit', key: null, wakeAt: answer.until };
    if (answer.kind === 'failed') return unchosen('unsure', 'judge', null);
    answers.push({ candidate, said: answer.said, score: answer.score });
  }
  const yeses = answers
    .filter((answer) => answer.said === 'yes')
    .map((answer) => ({ ...answer, score: answer.score ?? ask.threshold }))
    .sort(
      (left, right) => right.score - left.score || compareUtf8(left.candidate.projectId, right.candidate.projectId),
    );
  const best = yeses[0];
  const scores = answers.flatMap((answer) => (answer.score === null ? [] : [answer.score]));
  const top = scores.length === 0 ? null : Math.max(...scores);
  if (best === undefined)
    return unchosen(answers.some((answer) => answer.said === 'unsure') ? 'unsure' : 'none', 'judge', top);
  const second = yeses[1];
  // A hair's width for the subtraction's rounding: 0.9 and 0.85 are within 0.05 of each other.
  if (second !== undefined && best.score - second.score <= ROUTE_UNSURE_MARGIN + 1e-9)
    return unchosen('unsure', 'judge', best.score);
  return choose(best.candidate, 'judge', best.score);
}

/** The route step's executor. A wait for the judge's budget starts the step again when it frees. */
export function createRouteExecutor(deps: RouteExecutorDeps): StepExecutor<'route'> {
  return {
    kind: 'route',
    run: (ctx) => route(ctx, deps),
    resume: (ctx) => route(ctx, deps),
  };
}
