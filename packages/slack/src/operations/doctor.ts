import type { Config } from '@agentcomms/core';
import { scopeMismatch } from '../auth/authorize.ts';
import { REFRESH_EXPIRY_WARNING_MS, type TokenBundle } from '../auth/bundle.ts';
import type { InstallMode } from '../manifest.ts';
import { listWorkspaces } from './workspaces.ts';

/**
 * What has to be true for this to work, and the one command that fixes each thing that is not.
 *
 * Every check here is answerable from what is already on disk or from one cheap call. That is a constraint
 * rather than an accident — see `rate-limit` below, which is the check that taught it.
 */

/**
 * `unknown` is not a shade of `ok`.
 *
 * Three states made every check that had not been performed print green, because green was the only thing left
 * to print. A reader takes green as "checked, and fine" — so a diagnostic with nothing to say has to say that,
 * and a warning would be worse: something that warns on every healthy install is something people stop reading.
 */
export interface Check {
  readonly id: string;
  readonly title: string;
  readonly status: 'ok' | 'unknown' | 'warn' | 'fail';
  readonly detail: string;
  readonly fix: string | null;
  readonly workspace: string | null;
}

export interface DoctorResult {
  readonly healthy: boolean;
  readonly summary: { ok: number; unknown: number; warn: number; fail: number };
  readonly checks: readonly Check[];
}

export interface DoctorInput {
  readonly config: Config;
  readonly now: Date;
  /**
   * The stored credential per alias, already read.
   *
   * Three outcomes, not two. `null` means the secret store holds nothing under that reference; `'unreadable'`
   * means it holds something this cannot parse. Collapsing the second into the first sent somebody to
   * `workspace add` — connect it, it is not connected — when the truthful answer is that it *is* connected and
   * the credential is corrupt, which `reauth` repairs and `add` refuses outright as a duplicate.
   */
  readonly bundles: ReadonlyMap<string, TokenBundle | null | 'unreadable'>;
  /**
   * What ordinary traffic has already observed about rate limiting. Empty until S3 does any reading.
   *
   * Passed in rather than measured here, for the reason in the check itself.
   */
  readonly rateEvidence?:
    | { readonly lastThrottledAt?: string | undefined; readonly retryAfterSeconds?: number }
    | undefined;
  /**
   * Other Slack MCP servers registered on this machine, by client name.
   *
   * Absent and empty are different answers and are reported differently. Nothing scans for these yet — the
   * command that registers MCP servers arrives with the MCP surface — and printing "none registered" for a scan
   * that never happened would be a clean bill of health for something nobody looked at.
   */
  readonly otherSlackServers?: readonly string[] | undefined;
}

export function doctor(input: DoctorInput): DoctorResult {
  const checks: Check[] = [];
  const workspaces = listWorkspaces(input.config);

  if (workspaces.length === 0) {
    checks.push({
      id: 'workspaces',
      title: 'Workspaces',
      status: 'warn',
      detail: 'none connected yet',
      // The first step, not the last: `workspace add` needs a Client ID that does not exist until an app does,
      // and a fix somebody cannot run is not a fix.
      fix: 'agent-slack manifest --port 51234, then agent-slack workspace add <name> --client-id <id> --port 51234',
      workspace: null,
    });
  }

  for (const workspace of workspaces) {
    const bundle = input.bundles.get(workspace.alias) ?? null;

    if (bundle === null || bundle === 'unreadable') {
      checks.push({
        id: 'credential',
        title: `Credential for ${workspace.alias}`,
        status: 'fail',
        detail:
          bundle === 'unreadable'
            ? 'the stored credential cannot be read; it is corrupt or from a newer version'
            : 'the configuration names a workspace with no stored token',
        fix: `agent-slack workspace reauth ${workspace.alias}`,
        workspace: workspace.alias,
      });
      continue;
    }

    /*
     * The token's own state, which is the one thing a person cannot see any other way.
     *
     * `refresh-uncertain` is not a transient error to retry past: it means a refresh token may already have been
     * spent, and the only safe recovery is a new authorisation. Saying so here is the difference between a
     * puzzling failure in a week and an instruction now.
     */
    if (bundle.state === 'refresh-uncertain') {
      checks.push({
        id: 'credential-state',
        title: `Sign-in for ${workspace.alias}`,
        status: 'fail',
        detail: 'a token refresh was interrupted, and Slack refresh tokens cannot be retried safely',
        fix: `agent-slack workspace reauth ${workspace.alias}`,
        workspace: workspace.alias,
      });
    } else if (bundle.state === 'refreshing') {
      checks.push({
        id: 'credential-state',
        title: `Sign-in for ${workspace.alias}`,
        status: 'warn',
        detail: 'a refresh is in flight',
        fix: null,
        workspace: workspace.alias,
      });
    } else {
      /*
       * An expired or unreadable expiry is not "valid until".
       *
       * This printed the stored string whatever it said, so a token that expired last week reported as valid
       * until last week — in the one command somebody runs to find out why nothing works.
       */
      const expiresAt = Date.parse(bundle.accessExpiresAt);
      checks.push({
        id: 'credential-state',
        title: `Sign-in for ${workspace.alias}`,
        status: Number.isFinite(expiresAt) ? (expiresAt > input.now.getTime() ? 'ok' : 'warn') : 'fail',
        detail: !Number.isFinite(expiresAt)
          ? `the stored expiry is not a date: ${bundle.accessExpiresAt}`
          : expiresAt > input.now.getTime()
            ? `access token valid until ${bundle.accessExpiresAt}`
            : `the access token expired ${bundle.accessExpiresAt}; it is renewed on the next call`,
        fix: Number.isFinite(expiresAt) ? null : `agent-slack workspace reauth ${workspace.alias}`,
        workspace: workspace.alias,
      });
    }

    /*
     * The 30-day one, warned about before it bites.
     *
     * Slack expires refresh tokens issued to a PKCE app after 30 days. A workspace nobody has touched for a
     * month simply stops working, and the failure gives no hint that the clock was the cause — so the warning
     * has to arrive while re-authorising is still a choice.
     */
    if (bundle.refreshExpiresAt) {
      const remaining = Date.parse(bundle.refreshExpiresAt) - input.now.getTime();
      if (remaining <= 0) {
        checks.push({
          id: 'refresh-expiry',
          title: `Re-authorisation for ${workspace.alias}`,
          status: 'fail',
          detail: 'the refresh token expired; Slack expires them 30 days after they are issued',
          fix: `agent-slack workspace reauth ${workspace.alias}`,
          workspace: workspace.alias,
        });
      } else if (remaining <= REFRESH_EXPIRY_WARNING_MS) {
        checks.push({
          id: 'refresh-expiry',
          title: `Re-authorisation for ${workspace.alias}`,
          status: 'warn',
          detail: `the refresh token expires ${bundle.refreshExpiresAt}`,
          fix: `agent-slack workspace reauth ${workspace.alias}`,
          workspace: workspace.alias,
        });
      }
    }

    /*
     * Scope drift, checked with the same function `add` and `reauth` use.
     *
     * The scopes on a token can change under us: an admin can narrow an app, and Slack's optional scopes let a
     * person grant less than was asked for. `read` claiming to be unable to post is only true while this holds.
     */
    const mode = (workspace.mode ?? 'read') as InstallMode;
    const { missing, extra } = scopeMismatch(mode, workspace.grantedScopes);
    if (missing.length > 0 || extra.length > 0) {
      checks.push({
        id: 'scopes',
        title: `Permissions for ${workspace.alias}`,
        status: 'fail',
        detail: [
          missing.length > 0 ? `missing ${missing.join(', ')}` : '',
          extra.length > 0 ? `more than "${mode}" allows: ${extra.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
        fix: `agent-slack workspace reauth ${workspace.alias} --mode ${mode}`,
        workspace: workspace.alias,
      });
    } else {
      checks.push({
        id: 'scopes',
        title: `Permissions for ${workspace.alias}`,
        status: 'ok',
        detail: `${mode}: ${workspace.grantedScopes.length} scopes, exactly as recorded at sign-in`,
        fix: null,
        workspace: workspace.alias,
      });
    }
  }

  /*
   * The rate-limit tier: expected, and observed only from evidence already gathered.
   *
   * This wanted to be a probe, and it cannot be one. Slack publishes no remaining/limit headers, states burst
   * tolerance deliberately loosely, and says `conversations.history` may return fewer items than asked for even
   * when more remain — so a short page proves nothing and a single 429 proves throttling rather than a tier. The
   * only way to observe the cap is to spend the budget being measured, and a diagnostic that degrades what it
   * diagnoses is worse than one that says it does not know.
   *
   * So: what an internal customer-built app should have, and whatever ordinary reads have already seen. Until
   * S3 does any reading there is nothing in the second half, and it says so rather than implying health.
   */
  const evidence = input.rateEvidence;
  checks.push({
    id: 'rate-limit',
    title: 'Rate limit',
    status: evidence?.lastThrottledAt ? 'warn' : 'unknown',
    detail: evidence?.lastThrottledAt
      ? `expected Tier 3; throttled at ${evidence.lastThrottledAt}${
          evidence.retryAfterSeconds ? ` (Retry-After ${evidence.retryAfterSeconds}s)` : ''
        }`
      : 'expected Tier 3 for an internal app; not yet observed',
    fix: evidence?.lastThrottledAt
      ? 'If this repeats, check the app is still internal to your workspace rather than distributed.'
      : null,
    workspace: null,
  });

  /*
   * Another Slack server on this machine is the Gmail finding repeated.
   *
   * Six other Gmail MCP servers were registered on the author's own machine, any of which could send with no
   * approval step. Everything here assumes it owns the only route to Slack's posting methods; a second server
   * holding a `chat:write` token does not break that guarantee so much as stand beside it.
   */
  const others = input.otherSlackServers;
  checks.push({
    id: 'other-slack-servers',
    title: 'Other Slack MCP servers',
    status: others === undefined ? 'unknown' : others.length > 0 ? 'warn' : 'ok',
    detail:
      others === undefined
        ? 'not checked on this machine'
        : others.length > 0
          ? `also registered: ${others.join(', ')}`
          : 'none registered',
    fix:
      others && others.length > 0
        ? 'An agent can post through those without any approval here. Remove them if this is meant to be the only route.'
        : null,
    workspace: null,
  });

  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    unknown: checks.filter((check) => check.status === 'unknown').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  };
  return { healthy: summary.fail === 0, summary, checks };
}
