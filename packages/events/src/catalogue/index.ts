import { isJsonValue, type JsonValue } from '../json.ts';
import { EventsError, type Result } from '../result.ts';
import { type JsonSchema, toRootJsonSchema } from '../schema/to-json-schema.ts';
import { gmailMessageLabelledV1, gmailMessageReceivedV1, gmailMessageSentV1 } from './definitions/gmail.ts';
import { resendEmailReceivedV1, resendEmailStatusChangedV1 } from './definitions/resend.ts';
import { slackMessagePostedV1 } from './definitions/slack.ts';
import { whatsappMessageReceivedV1 } from './definitions/whatsapp.ts';
import { checkInvariants } from './invariants.ts';
import type {
  CatalogueEventV1,
  DefinitionInternal,
  EventDefinition,
  GmailMessageLabelledV1,
  GmailMessageReceivedV1,
  GmailMessageSentV1,
  ResendEmailReceivedV1,
  ResendEmailStatusChangedV1,
  SlackMessagePostedV1,
  WhatsAppMessageReceivedV1,
} from './types.ts';

export { checkDefinition } from './check.ts';
export { describeFields, type FieldInfo } from './fields.ts';
export { whatsappMessageKey } from './keys.ts';
export { canonicalRiskFlags, normaliseResendBody, RESEND_BODY_MAX_CODE_POINTS } from './resend.ts';
export type {
  AddressV1,
  AnyEventDefinition,
  CatalogueEventV1,
  CommonEventV1,
  EventDefinition,
  EventTypeV1,
  GmailAttachmentV1,
  GmailMessageEventV1,
  GmailMessageLabelledV1,
  GmailMessageReceivedV1,
  GmailMessageSentV1,
  ResendEmailReceivedV1,
  ResendEmailStatusChangedV1,
  ResendReceivedAttachmentV1,
  ResendStatusV1,
  RiskFlagV1,
  SlackMessagePostedV1,
  WhatsAppChatKindV1,
  WhatsAppMessageKindV1,
  WhatsAppMessageReceivedV1,
} from './types.ts';
export {
  gmailMessageLabelledV1,
  gmailMessageReceivedV1,
  gmailMessageSentV1,
  resendEmailReceivedV1,
  resendEmailStatusChangedV1,
  slackMessagePostedV1,
  whatsappMessageReceivedV1,
};

export const CATALOGUE: readonly [
  DefinitionInternal<GmailMessageReceivedV1, { historyRecordId: string }>,
  DefinitionInternal<GmailMessageSentV1, { historyRecordId: string }>,
  DefinitionInternal<GmailMessageLabelledV1, { historyRecordId: string }>,
  DefinitionInternal<SlackMessagePostedV1, Record<string, never>>,
  DefinitionInternal<ResendEmailReceivedV1, Record<string, never>>,
  DefinitionInternal<ResendEmailStatusChangedV1, Record<string, never>>,
  DefinitionInternal<WhatsAppMessageReceivedV1, Record<string, never>>,
] = [
  gmailMessageReceivedV1,
  gmailMessageSentV1,
  gmailMessageLabelledV1,
  slackMessagePostedV1,
  resendEmailReceivedV1,
  resendEmailStatusChangedV1,
  whatsappMessageReceivedV1,
] as const;

type CatalogueDefinition = (typeof CATALOGUE)[number];

const issue = (
  code: 'EVENT_INVALID' | 'EVENT_TYPE_NOT_SELECTABLE' | 'EVENT_TYPE_UNKNOWN' | 'EVENT_VERSION_UNKNOWN',
  message: string,
) => ({ ok: false as const, issues: [{ code, message }] });

/** The reserved prefix of the daemon's operational record names (spec D3): never a selectable source event. */
const OPERATIONAL_RECORD_TYPE = /^agentcomms\./u;

/** A selectable source-event definition, never a daemon operational record. */
export function catalogueEntry(type: string, version: number): Result<CatalogueDefinition> {
  if (OPERATIONAL_RECORD_TYPE.test(type))
    return issue('EVENT_TYPE_NOT_SELECTABLE', 'operational records are not catalogue source events');
  const typeMatch = CATALOGUE.find((definition) => definition.type === type);
  if (typeMatch === undefined) return issue('EVENT_TYPE_UNKNOWN', 'the event type is not in the version-1 catalogue');
  if (version !== typeMatch.version)
    return issue('EVENT_VERSION_UNKNOWN', 'the event type has no definition at this version');
  return { ok: true, value: typeMatch };
}

/** The exact source JSON Schema generated from a definition's schema description. */
export function sourceSchema(definition: { readonly type: string; readonly version: number }): JsonSchema {
  const internal = definition as unknown as DefinitionInternal;
  if (internal.description === undefined)
    throw new EventsError('DEFINITION_INVALID', 'the definition was not made by the catalogue');
  return toRootJsonSchema(
    internal.description,
    `urn:agentcomms:schema:source:${definition.type}:v${definition.version}`,
  );
}

/** Validate JSON through the generated Zod schema and Appendix A's named cross-field invariants. */
export function validateEvent<T extends CatalogueEventV1, S>(
  definition: EventDefinition<T, S>,
  value: unknown,
): Result<T> {
  if (!isJsonValue(value)) return issue('EVENT_INVALID', 'the event is not a JSON value');
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((problem) => {
        const pointer =
          problem.path.length === 0
            ? undefined
            : `/${problem.path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
        return pointer === undefined
          ? { code: 'EVENT_INVALID' as const, message: problem.message }
          : { code: 'EVENT_INVALID' as const, pointer, message: problem.message };
      }),
    };
  }
  const invariantIssues = checkInvariants(parsed.data as unknown as JsonValue, definition.invariants);
  return invariantIssues.length === 0 ? { ok: true, value: parsed.data } : { ok: false, issues: invariantIssues };
}
