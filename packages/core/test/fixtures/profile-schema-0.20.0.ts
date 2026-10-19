import { z } from 'zod';
import { isDangerous } from '../../src/chars.ts';

/**
 * The organisation profile's schema as 0.20.0 parses it, and the two files it reads beside a profile — the agent app's
 * and the update caps' (`git show b5e7322e:packages/core/src/organisations.ts`, lines 94–147, 553–563 and 1328–1336),
 * frozen, so a test can hold what this release asks organisations to publish against what a member still on 0.20.0
 * reads (design 2026-10-19, §4).
 *
 * The profile's schema is the one every release since 0.13.0 has had (`profile-schema-0.19.0.ts`): every object a
 * `z.strictObject`, so a key it does not know anywhere — `extensions` included — refuses the whole document, and with
 * it that member's `org add` and `org update`. That is the one generation that pays once for `extensions` (§6): a
 * member on 0.20.0 or older keeps the last profile they approved until they update.
 *
 * The two files beside the profile are frozen too (X5): their shapes stay exactly as 0.20.0 reads them, and a test
 * holds this release's reading of them to these.
 *
 * Copied rather than imported, as `config-v2-0.12.1.ts` is: CI checks out without tags, and the behaviour pinned here
 * must not drift with the source. Only `isDangerous` is the source's: it decides which characters a label may hold,
 * not which keys a document may have, and the question here is the keys.
 */

const WINDOWS_RESERVED = [
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
];
const ORGANISATION_PATTERN = new RegExp(
  `^(?!(?:${WINDOWS_RESERVED.join('|')})(?:/|$))([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$`,
);
const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]{1,30}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SLACK_WORKSPACE_ID_PATTERN = /^T[A-Z0-9]{2,20}$/;
const SLACK_CLIENT_ID_PATTERN = /^[0-9]{1,20}\.[0-9]{1,20}$/;
const SLACK_APP_ID_PATTERN = /^A[A-Z0-9]{2,20}$/;
const PROFILE_ORGANISATION_MAX = 28;

function oneLine(max: number, what: string) {
  return z.string().refine(
    (value) => {
      const chars = [...value];
      return (
        chars.length >= 1 &&
        chars.length <= max &&
        value.trim() !== '' &&
        chars.every((char) => char !== '\n' && char !== '\t' && !isDangerous(char.codePointAt(0) ?? 0))
      );
    },
    { message: `${what} is 1–${max} characters on one line: no line break, tab or other control character` },
  );
}

const slackAppSchema = z.strictObject({
  clientId: z.string().regex(SLACK_CLIENT_ID_PATTERN, 'a Slack client id is two runs of digits around a dot'),
  appId: z
    .string()
    .regex(SLACK_APP_ID_PATTERN, 'a Slack app id is A followed by 2–20 capital letters or digits')
    .optional(),
});

const profileSchemaAsReleased0200 = z.strictObject({
  agentcomms: z.literal('organisation-profile'),
  version: z.literal(1),
  organisation: z
    .string()
    .refine((word) => ORGANISATION_PATTERN.test(word) && word.length <= PROFILE_ORGANISATION_MAX, {
      message: `the organisation is the first half of an account name — lowercase letters, digits and hyphens — at most ${PROFILE_ORGANISATION_MAX} characters, and not a word Windows reserves`,
    }),
  label: oneLine(64, 'the label'),
  gmail: z
    .strictObject({
      clientId: z
        .string()
        .regex(GOOGLE_CLIENT_ID_PATTERN, 'a Google client id is digits, a hyphen, then .apps.googleusercontent.com'),
      clientSecret: z.string().regex(/^[\x20-\x7e]{1,256}$/, 'the client secret is 1–256 printable ASCII characters'),
      projectId: z
        .string()
        .regex(
          /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
          'a Google Cloud project id is 6–30 lowercase letters, digits or hyphens',
        )
        .optional(),
      serves: z.union([
        z.literal('any'),
        z.strictObject({
          domains: z.array(z.string().regex(DOMAIN_PATTERN, 'each domain is a lower-case host name')).min(1).max(50),
        }),
      ]),
    })
    .optional(),
  slack: z
    .strictObject({
      workspace: z
        .string()
        .regex(SLACK_WORKSPACE_ID_PATTERN, 'a Slack workspace id is T followed by capital letters or digits'),
      workspaceName: oneLine(80, 'the workspace name'),
      redirectPort: z.number().int().min(1024).max(65535),
      apps: z.strictObject({ read: slackAppSchema.optional(), send: slackAppSchema.optional() }),
    })
    .optional(),
});

const agentAppSchemaAsReleased0200 = z.strictObject({
  agentcomms: z.literal('organisation-agent-app'),
  version: z.literal(1),
  organisation: z.string(),
  slack: z.strictObject({
    workspace: z
      .string()
      .regex(SLACK_WORKSPACE_ID_PATTERN, 'a Slack workspace id is T followed by capital letters or digits'),
    appId: z.string().regex(SLACK_APP_ID_PATTERN, 'a Slack app id is A followed by 2–20 capital letters or digits'),
  }),
});

const updatesSchemaAsReleased0200 = z.strictObject({
  organisation: z.string(),
  max: z
    .enum(['every-14-days', 'never'], {
      message: 'max is every-14-days or never: a cap only ever makes updates less frequent',
    })
    .optional(),
  background: z
    .literal(false, { message: 'background is false or left out: a cap can only turn background updates off' })
    .optional(),
});

type Read = { ok: true } | { ok: false; issues: string[] };

/** The BOM dropped, the JSON parsed, the strict schema applied — what 0.20.0 does with each file, up to its schema. */
function readWith(schema: z.ZodType, text: string): Read {
  const parsed = schema.safeParse(JSON.parse(text.startsWith('\ufeff') ? text.slice(1) : text));
  if (parsed.success) return { ok: true };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) =>
      issue.code === 'unrecognized_keys'
        ? `${issue.path.join('.')}: ${issue.keys.join(', ')} is not a key a profile has`
        : `${issue.path.join('.')}: ${issue.message}`,
    ),
  };
}

/** Whether 0.20.0 reads a profile's text: true when it does, the issues when it refuses it. */
export function readAsReleased0200(text: string): Read {
  return readWith(profileSchemaAsReleased0200, text);
}

/** Whether 0.20.0 reads `<profile>.agent-app.json`, up to its schema (it then holds it to the profile beside it). */
export function readAgentAppAsReleased0200(text: string): Read {
  return readWith(agentAppSchemaAsReleased0200, text);
}

/** Whether 0.20.0 reads `<profile>.updates.json`, up to its schema (it then holds it to the profile beside it). */
export function readUpdatesAsReleased0200(text: string): Read {
  return readWith(updatesSchemaAsReleased0200, text);
}
