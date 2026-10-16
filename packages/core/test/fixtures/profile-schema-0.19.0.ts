import { z } from 'zod';
import { isDangerous } from '../../src/chars.ts';

/**
 * The organisation profile's schema as 0.19.0 — and every release from 0.13.0, which added profiles — parses it
 * (`git show d2517ef8:packages/core/src/organisations.ts`, lines 64–147), frozen, so a test can hold what this release
 * asks organisations to publish against what a member still on an older release reads.
 *
 * Published releases cannot change: a profile they refuse stays refused until the member updates. Every object in it is
 * a `z.strictObject`, so an unknown key anywhere — `slack.apps.agent` included — refuses the whole document, and with it
 * that member's `org add` and `org update`. Copied rather than imported, as `config-v2-0.12.1.ts` is: CI checks out
 * without tags, and the behaviour pinned here must not drift with the source. Only `isDangerous` is the source's: it
 * decides which characters a label may hold, not which keys a profile may have, and the question here is the keys.
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

const profileSchemaAsReleased0190 = z.strictObject({
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

/**
 * What 0.19.0's `parseProfile` does with a profile's text, up to the schema: the BOM dropped, the JSON parsed, the
 * strict schema applied. True when that release reads it; the issues when it refuses it.
 */
export function readAsReleased0190(text: string): { ok: true } | { ok: false; issues: string[] } {
  const parsed = profileSchemaAsReleased0190.safeParse(JSON.parse(text.startsWith('﻿') ? text.slice(1) : text));
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
