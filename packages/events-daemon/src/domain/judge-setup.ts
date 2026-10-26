import { CommsError } from '@agentcomms/core';
import { parseIpLiteral } from '../network/address-policy.ts';
import { type CanonicalJudgeBudgetDocument, JEV_PROVIDER_ROUTES, type JevProvider, JUDGE_BUDGET_ID } from './judges.ts';
import { JUDGE_KIND_LOCAL_ENDPOINT, JUDGE_KIND_TYPESAFE } from './lifecycle.ts';

/*
 * `judge setup` (owner decision 2026-10-26): the person sets up and turns on Jev, or a model server on this machine, in
 * one step, from the desktop app or their own terminal. These are the step's fixed choices, shared by the CLI, which
 * checks its words before it reaches the owner, and the owner, which checks them again.
 */

/**
 * The origins the person's own setup commands carry (owner decision 2026-10-26): `judge setup`, `provider key set` and
 * `provider key remove`, each saying where the CLI found the person (after the release's security review, 2026-10-26):
 * - `desktop-app`: started by the Agent Comms release app, as core's `desktopAppOrigin` found (macOS);
 * - `desktop-app-test-build`: started by the local test build, for its own marked test profile only (macOS);
 * - `desktop-app-unattested`: on Windows and Linux, which attest nothing — a process without an agent's marker;
 * - `terminal`: an interactive terminal, where a key is the person's hidden input.
 * The CLI refuses an agent's shell, the event service's MCP server, and on macOS a pipe the app did not start, before it
 * ever sends one; the owner accepts these operations from no other origin, and audits which it was. Like every client
 * name it is a caller's label, not a capability: same-user token holders stay inside the owner's trust boundary.
 */
export type PersonSetupOrigin =
  | 'person-setup:desktop-app'
  | 'person-setup:desktop-app-test-build'
  | 'person-setup:desktop-app-unattested'
  | 'person-setup:terminal';

export const PERSON_SETUP_ORIGINS: Readonly<{
  desktopApp: 'person-setup:desktop-app';
  desktopAppTestBuild: 'person-setup:desktop-app-test-build';
  desktopAppUnattested: 'person-setup:desktop-app-unattested';
  terminal: 'person-setup:terminal';
}> = Object.freeze({
  desktopApp: 'person-setup:desktop-app',
  desktopAppTestBuild: 'person-setup:desktop-app-test-build',
  desktopAppUnattested: 'person-setup:desktop-app-unattested',
  terminal: 'person-setup:terminal',
} as const);

/** Who the person's setup was approved by, as its audit line says: the attested app, the app unattested, or a terminal. */
export type PersonSetupApprover = 'desktop-app' | 'desktop-app (test build)' | 'desktop-app (unattested)' | 'terminal';

/**
 * The approvers a person-only change's result may name (0.33.0, the second look): an unattested origin changes nothing —
 * it is sent to the terminal — so only the attested app, its test build, or a terminal.
 */
export const PERSON_CHANGE_APPROVERS: readonly PersonSetupApprover[] = Object.freeze([
  'desktop-app',
  'desktop-app (test build)',
  'terminal',
] as const);

/** The approver an origin names, or null for any other client. */
export function personSetupApprover(origin: string | undefined): PersonSetupApprover | null {
  switch (origin) {
    case PERSON_SETUP_ORIGINS.desktopApp:
      return 'desktop-app';
    case PERSON_SETUP_ORIGINS.desktopAppTestBuild:
      return 'desktop-app (test build)';
    case PERSON_SETUP_ORIGINS.desktopAppUnattested:
      return 'desktop-app (unattested)';
    case PERSON_SETUP_ORIGINS.terminal:
      return 'terminal';
    default:
      return null;
  }
}

const APPROVAL_ID_WORD = /^ap_[0-9A-HJKMNP-TV-Z]{26}$/u;

/**
 * Why a person-only change is sent to the terminal (security reviews of 0.33.0, finding 2 and its second look): on
 * Windows and Linux nothing attests that the Agent Comms app started the command, so a process without an agent's
 * marker is not enough to make the person's change — approve a standing disclosure, set up a judge, set or remove a
 * key, repoint the relay. The refusal is `APPROVAL_REQUIRED` (exit 10) — the app reads it as "do it in the terminal" —
 * with its own reason, `ORIGIN_UNATTESTED`, and names the event service's own words to type there. (The suite never
 * spells its binary in a runtime message: the app opens the located command itself, as Bind in Terminal does.)
 */
export function changeAtTerminal(
  what: string,
  words: string,
  details: Readonly<Record<string, string>> = {},
): CommsError {
  return new CommsError(
    'APPROVAL_REQUIRED',
    `nothing on this platform attests that the Agent Comms app started this, so ${what} at your terminal, with the event service's ${words}`,
    {
      details: { reason: 'ORIGIN_UNATTESTED', ...details },
      hint: 'In the app, press Do it in Terminal; or run the event service’s command at your own terminal.',
    },
  );
}

/** The words `rule approve` sends the person to type: the approval's own `approve <approval-id>`. */
export function ruleApprovalWords(approvalId: unknown): string {
  const id = typeof approvalId === 'string' && APPROVAL_ID_WORD.test(approvalId) ? approvalId : '<approval-id>';
  return `approve ${id}, which shows its preview and asks for its challenge`;
}

/** `rule approve`'s refusal of an unattested origin, as the owner gives it. */
export function ruleApprovalAtTerminal(approvalId: unknown): CommsError {
  return changeAtTerminal('approve a rule', ruleApprovalWords(approvalId), {
    approvalId: typeof approvalId === 'string' && APPROVAL_ID_WORD.test(approvalId) ? approvalId : '<approval-id>',
  });
}

/** The two kinds `judge setup` sets up. Laya is not one: no release offers it yet. */
export type SetupJudgeKind = typeof JUDGE_KIND_TYPESAFE | typeof JUDGE_KIND_LOCAL_ENDPOINT;
export const SETUP_JUDGE_KINDS: readonly SetupJudgeKind[] = Object.freeze([
  JUDGE_KIND_TYPESAFE,
  JUDGE_KIND_LOCAL_ENDPOINT,
]);

export function isSetupJudgeKind(value: unknown): value is SetupJudgeKind {
  return typeof value === 'string' && (SETUP_JUDGE_KINDS as readonly string[]).includes(value);
}

/** The judge each kind's setup makes and keeps: Jev, as the README names it, and the person's local model server. */
export const SETUP_JUDGE_IDS: Readonly<Record<SetupJudgeKind, string>> = Object.freeze({
  typesafe: 'jev',
  [JUDGE_KIND_LOCAL_ENDPOINT]: 'local-model',
});

/** The prompt templates the two judges are made with, as the README's Jev document and the local examples name them. */
export const SETUP_PROMPT_TEMPLATES: Readonly<Record<SetupJudgeKind, string>> = Object.freeze({
  typesafe: 'typesafe-jev-noul-v1',
  [JUDGE_KIND_LOCAL_ENDPOINT]: 'local-noul-v1',
});

/** Ollama's System One path, the only one a local `noul` judge is called at (provider record, read 2026-10-10). */
export const LOCAL_SYSTEM_ONE_PATH = '/v1/systemone';

/** The model a local server's judge names when the person names none: the first Ollama's decision page lists. */
export const DEFAULT_LOCAL_MODEL = 'nimble';

/**
 * The daemon-wide ceilings setup approves when there is no judge budget yet, overall and for the judge's provider: 60
 * calls in any rolling hour, a million input tokens in any rolling 30 days, two calls at a time. The README's budget.
 */
export const DEFAULT_SETUP_LIMITS: Readonly<{
  callsPerRollingHour: number;
  inputTokensPerRolling30Days: number;
  concurrency: number;
}> = Object.freeze({
  callsPerRollingHour: 60,
  inputTokensPerRolling30Days: 1_000_000,
  concurrency: 2,
});

/** The person's words for a local model server: `http://127.0.0.1:<port>` or `http://[::1]:<port>`, and nothing else. */
export interface LocalSetupEndpoint {
  /** The System One URL the judge calls: the server's origin and `/v1/systemone`. */
  readonly endpoint: string;
  readonly address: '127.0.0.1' | '::1';
}

/**
 * Reads a local model server's URL: plain HTTP to the literal `127.0.0.1` or `[::1]`, an explicit port, and no path but
 * `/` or `/v1/systemone`. A hostname (`localhost` too), HTTPS, another address, a user, a query or a fragment is
 * refused, with the reason. The refusal is a usage error: the person's words are wrong, nothing ran.
 */
export function localSetupEndpoint(value: unknown): LocalSetupEndpoint {
  const refuse = (why: string): never => {
    throw new CommsError(
      'USAGE',
      `the local model server's URL ${why}; give http://127.0.0.1:<port> or http://[::1]:<port>`,
    );
  };
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return refuse('is required');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('is not a URL');
  }
  if (url.protocol !== 'http:') refuse('must be plain http, on this machine');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || value.includes('?'))
    refuse('has a user, a query or a fragment');
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  let address: string;
  try {
    address = parseIpLiteral(hostname).address;
  } catch {
    return refuse('must name the address 127.0.0.1 or ::1, not a hostname');
  }
  if (address !== '127.0.0.1' && address !== '::1') refuse('must be on this machine: 127.0.0.1 or ::1');
  if (url.port === '') refuse('needs its port');
  if (url.pathname !== '/' && url.pathname !== LOCAL_SYSTEM_ONE_PATH)
    refuse(`has a path other than ${LOCAL_SYSTEM_ONE_PATH}`);
  const host = address === '::1' ? '[::1]' : '127.0.0.1';
  return {
    endpoint: `http://${host}:${url.port}${LOCAL_SYSTEM_ONE_PATH}`,
    address: address === '::1' ? '::1' : '127.0.0.1',
  };
}

/** A local model name, as a judge document holds it: 1 to 128 of letters, digits and `._:/-`. */
export function localSetupModel(value: unknown): string {
  if (value === undefined) return DEFAULT_LOCAL_MODEL;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value))
    throw new CommsError('USAGE', "the local model's name is 1 to 128 letters, digits and . _ : / -");
  return value;
}

/** The judge document setup wants, without its version: Jev from the chosen provider, or the local server's. */
export function setupJudgeDocument(
  input:
    | { readonly kind: typeof JUDGE_KIND_TYPESAFE; readonly provider: JevProvider }
    | {
        readonly kind: typeof JUDGE_KIND_LOCAL_ENDPOINT;
        readonly endpoint: LocalSetupEndpoint;
        readonly model: string;
      },
): Record<string, unknown> {
  if (input.kind === JUDGE_KIND_TYPESAFE) {
    const route = JEV_PROVIDER_ROUTES[input.provider];
    return {
      judgeId: SETUP_JUDGE_IDS.typesafe,
      kind: JUDGE_KIND_TYPESAFE,
      provider: input.provider,
      model: route.model,
      endpoint: route.endpoint,
      promptTemplate: SETUP_PROMPT_TEMPLATES.typesafe,
      protocol: 'noul',
    };
  }
  return {
    judgeId: SETUP_JUDGE_IDS[JUDGE_KIND_LOCAL_ENDPOINT],
    kind: JUDGE_KIND_LOCAL_ENDPOINT,
    provider: 'ollama',
    model: input.model,
    endpoint: input.endpoint.endpoint,
    approvedAddressSet: [input.endpoint.address],
    promptTemplate: SETUP_PROMPT_TEMPLATES[JUDGE_KIND_LOCAL_ENDPOINT],
    protocol: 'noul',
  };
}

/**
 * The budget setup approves for `provider`: the default when there is none, or the active one with the provider's
 * default ceiling added when it has none for it. `null` when the active budget already covers the provider.
 */
export function setupBudgetDocument(
  active: CanonicalJudgeBudgetDocument | null,
  provider: string,
  nextVersion: number,
): CanonicalJudgeBudgetDocument | null {
  if (active?.providers.some((entry) => entry.provider === provider)) return null;
  const providers = [...(active?.providers ?? []), { provider, ...DEFAULT_SETUP_LIMITS }].sort((left, right) =>
    left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0,
  );
  return {
    budgetId: JUDGE_BUDGET_ID,
    version: nextVersion,
    global: active?.global ?? { ...DEFAULT_SETUP_LIMITS },
    providers,
  };
}
