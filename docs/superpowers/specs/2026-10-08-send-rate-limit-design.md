# A send the provider throttled waits and tries again; a quota stops and says when it lifts

Status: approved by the owner for implementation on 2026-10-08 ("sort this generically"), on `fix/send-rate-limit`.

## The problem

The owner saw Gmail sends rate-limited on another machine. Today a throttled send is never retried — every send runs
with `mode: 'never'` (`packages/gmail/src/gmail-api/transport.ts:546-560`), because a repeat can deliver the mail
twice — and a refusal that proves nothing was sent completes the approval `failed` (design 2026-10-05 §D2,
`packages/gmail/src/operations/send.ts:1051`). So a few seconds of throttling cost the person a new preview and a new
approval, and the hint always says "Wait a minute and retry", even for a daily sending cap no minute fixes. Resend
spends the approval the same way on a `429` that arrives after the claim (`packages/resend/src/operations/send.ts`);
Slack posts, reactions, edits and deletions do it on `ratelimited` (`packages/slack/src/api/call.ts`).

## What the providers say (read 2026-10-08)

| Provider | Answer | Means | Documented advice |
|---|---|---|---|
| Gmail | `403 rateLimitExceeded`, `403 userRateLimitExceeded` | per-user request rate | exponential backoff |
| Gmail | `429` (no "Mail sending") | per-user concurrent requests or bandwidth | retry |
| Gmail | `429 … User-rate limit exceeded (Mail sending)`, with a retry time | the account's daily sending limit; "might result in these errors for multiple hours" | wait for the time given |
| Gmail | `403 dailyLimitExceeded` | the Cloud project's daily API quota | raise the quota |
| Resend | `429 rate_limit_exceeded` | requests per second | read the headers, slow down |
| Resend | `429 daily_quota_exceeded` | the plan's daily sending quota | resets at midnight UTC |
| Resend | `429 monthly_quota_exceeded` | the plan's monthly sending quota | upgrade the plan |

Sources: developers.google.com/workspace/gmail/api/guides/handle-errors; resend.com/docs/api-reference/errors.

## Decisions

**R1. Only a refusal that proves nothing was sent, and says "later", is retried.** Gmail: `429`, or `403` with
`rateLimitExceeded`/`userRateLimitExceeded`. Resend: `429` named `rate_limit_exceeded` (or with no name). Both are in
each channel's existing "refused before acting" allowlist, so a retry cannot deliver twice. Everything else keeps
today's behaviour: an uncertain answer is `SEND_OUTCOME_UNKNOWN` at once and never retried (2026-10-05 §D2), and any
other certain refusal completes the approval `failed`.

**R2. The wait is bounded, and is the provider's when it gives one.** Core's `sendPacing` allows at most 3 retries
and 45 seconds of waiting in all. Each wait is the provider's own (`Retry-After`; Gmail's "Retry after <time>" in its
message; Resend's `retry-after` or `ratelimit-reset`), else exponential backoff from one second with jitter. A wait
the provider asks for that runs past what is left of the budget is not started: the send stops at once. 45 seconds sits
well inside the two-minute sending lease, which `withSendingLease` renews every thirty seconds while the send runs.

**R3. Every retry repeats the send's last look and fence.** Before each new attempt the channel reads the draft (or
reloads the message) again and checks it is still exactly what was approved, then runs `fenceOrStop` with
`stepsStarted: 0` (nothing has been sent). A draft changed during the wait, or a lost lease, stops the send the way it
stops the first attempt. The retry is the same request for the same approval: no new claim, no new approval.

**R4. A quota stops at once and says which, and when it lifts.** Gmail's mail-sending limit, Resend's daily and
monthly quotas, and Gmail's project quota are never waited on in a call. The refusal still says nothing was sent and
the approval is completed `failed` as today, but its words name the limit: "Gmail's sending limit for this account is
reached; Google accepts mail from it again after <time>", "this Resend team's daily sending quota is used up; it resets
at midnight UTC (<time>)", "…monthly sending quota is used up; upgrade the plan", "this Google Cloud project's daily
Gmail API quota is used up; raise it in the Cloud console". `details` carry `limit` and, when known, `retryAt`.

**R5. A throttle that outlasts the budget says when to try again.** Stopped by R2, the refusal is `TRANSIENT`, says
nothing was sent and gives `retryAt` when the provider named a time; the approval is completed `failed`, as today.

**R6. Gmail's project quota is not "sign in again".** `403 dailyLimitExceeded` was reported as `AUTH_REQUIRED`, which
sends people to re-authorise. It becomes `CONFIG` with R4's words, on every Gmail call.

**R7. Core paces; each channel classifies.** `sendPacing` (`packages/core/src/send-pacing.ts`) knows budgets and
delays and nothing about providers. Each channel says what a refusal is (`sendThrottleOf` in Gmail's
`gmail-api/errors.ts`, Resend's in `api/client.ts`) and owns its last look and fence. Slack's posts, reactions, edits
and deletions take the same pacing in a second pull request, so this one stays within the email sends.

## Not changed

The approval lifecycle (a certain refusal still completes it `failed`; keeping it claimable is a separate design),
the "never retry an uncertain send" rule, Resend's refusal before claiming when a stop is already known, and every
read path's existing retry (`packages/gmail/src/gmail-api/retry.ts`).
