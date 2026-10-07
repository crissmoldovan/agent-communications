import type { z } from 'zod';
import type { PointerPattern } from '../pattern.ts';
import type { ObjectNode, SchemaFormat } from '../schema/describe.ts';

export interface AddressV1 {
  readonly address: string;
  readonly name: string | null;
}

export type RiskFlagV1 =
  | 'executable'
  | 'script'
  | 'macro-enabled'
  | 'macro-capable'
  | 'markup'
  | 'archive'
  | 'disk-image'
  | 'double-extension'
  | 'bidi-filename'
  | 'auto-read'
  | 'saved-as-download'
  | 'html-or-svg'
  | 'hidden-characters-in-name';

export interface CommonEventV1<TType extends string, TChannel extends string, TAccountId extends string = string> {
  readonly id: string;
  readonly type: TType;
  readonly version: 1;
  readonly occurredAt: string;
  readonly observedAt: string;
  readonly account: { readonly name: string; readonly id: TAccountId; readonly channel: TChannel };
}

export interface GmailAttachmentV1 {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly inline: boolean;
  readonly riskFlags: readonly RiskFlagV1[];
}

export interface GmailMessageEventV1<T extends 'gmail.message.received' | 'gmail.message.sent'>
  extends CommonEventV1<T, 'gmail'> {
  readonly messageId: string;
  readonly threadId: string;
  readonly labels: readonly string[];
  readonly from: AddressV1 | null;
  readonly replyTo: readonly AddressV1[];
  readonly to: readonly AddressV1[];
  readonly cc: readonly AddressV1[];
  readonly subject: string;
  readonly snippet: string;
  readonly date: string;
  readonly unread: boolean;
  readonly authentication: {
    readonly evaluatedBy: string | null;
    readonly spf: string | null;
    readonly dkim: string | null;
    readonly dkimDomain: string | null;
    readonly dmarc: string | null;
    readonly aligned: boolean | null;
    readonly ignoredHeaders: number;
  };
  readonly warnings: {
    readonly replyToDiffers: boolean;
    readonly replyToDomains: readonly string[];
    readonly displayNameContainsOtherAddress: boolean;
    readonly fromDomain: string | null;
  };
  readonly hasAttachments?: boolean;
  readonly attachments?: readonly GmailAttachmentV1[];
  readonly body?: string;
}

export type GmailMessageReceivedV1 = GmailMessageEventV1<'gmail.message.received'>;
export type GmailMessageSentV1 = GmailMessageEventV1<'gmail.message.sent'>;

export interface GmailMessageLabelledV1 extends CommonEventV1<'gmail.message.labelled', 'gmail'> {
  readonly messageId: string;
  readonly threadId: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface SlackMessagePostedV1 extends CommonEventV1<'slack.message.posted', 'slack'> {
  readonly workspaceId: string;
  readonly ts: string;
  readonly threadTs: string | null;
  readonly channel: {
    readonly id: string;
    readonly name: string | null;
    readonly kind: 'public_channel' | 'private_channel' | 'im' | 'mpim';
  };
  readonly author: {
    readonly userId?: string;
    readonly botId?: string;
    readonly name: string | null;
    readonly app: boolean;
    readonly external: boolean;
  };
  readonly text: string;
  readonly truncated: boolean;
  readonly mismatch: boolean;
  readonly unrenderable: boolean;
  readonly editedTs: string | null;
  readonly mentions: readonly {
    readonly kind: 'user' | 'channel' | 'usergroup';
    readonly id: string;
    readonly label: string | null;
  }[];
  readonly files: readonly { readonly id: string; readonly name: string | null; readonly mimeType: string | null }[];
}

export interface ResendReceivedAttachmentV1 {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly size: number | null;
  readonly inline: boolean;
  readonly riskFlags: readonly RiskFlagV1[];
}

export interface ResendEmailReceivedV1 extends CommonEventV1<'resend.email.received', 'resend'> {
  readonly emailId: string;
  readonly receivedAt: string;
  readonly from: AddressV1 | null;
  readonly replyTo: readonly AddressV1[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly receivedFor: readonly string[];
  readonly subject: string;
  readonly messageId: string | null;
  readonly attachmentCount: number;
  readonly authentication: {
    readonly spf: string | null;
    readonly dkim: string | null;
    readonly dmarc: string | null;
    readonly evaluatedBy: 'resend' | null;
  };
  readonly attachments?: readonly ResendReceivedAttachmentV1[];
  readonly body?: string;
  readonly bodyTruncated?: boolean;
}

export type ResendStatusV1 =
  | 'scheduled'
  | 'sent'
  | 'delivered'
  | 'delivery_delayed'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'failed'
  | 'suppressed'
  | 'canceled'
  | 'queued';

export interface ResendEmailStatusChangedV1 extends CommonEventV1<'resend.email.status_changed', 'resend'> {
  readonly emailId: string;
  readonly from: AddressV1 | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly createdAt: string | null;
  readonly scheduledAt: string | null;
  readonly messageId: string | null;
  readonly previous: ResendStatusV1;
  readonly current: ResendStatusV1;
  readonly at: string;
}

export type WhatsAppChatKindV1 = 'direct' | 'hidden-number' | 'group' | 'status' | 'broadcast' | 'channel' | 'unknown';
export type WhatsAppMessageKindV1 =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'contact'
  | 'location'
  | 'group-event'
  | 'link'
  | 'document'
  | 'system'
  | 'gif'
  | 'waiting'
  | 'deleted'
  | 'sticker'
  | 'poll'
  | 'video-note'
  | 'call'
  | 'album'
  | 'unknown'
  | `unknown:${number}`;

export interface WhatsAppMessageReceivedV1 extends CommonEventV1<'whatsapp.message.received', 'whatsapp'> {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly chat: { readonly id: string; readonly name: string | null; readonly kind: WhatsAppChatKindV1 };
  readonly sender: { readonly id: string; readonly name: string | null };
  readonly text: string | null;
  readonly at: string;
  readonly fromMe: false;
  readonly kind: WhatsAppMessageKindV1;
  readonly viewOnce: boolean;
  readonly groupEvent: number | null;
  readonly media: {
    readonly type: WhatsAppMessageKindV1;
    readonly mime: string | null;
    readonly size: number | null;
    readonly name: string | null;
  } | null;
}

export type CatalogueEventV1 =
  | GmailMessageReceivedV1
  | GmailMessageSentV1
  | GmailMessageLabelledV1
  | SlackMessagePostedV1
  | ResendEmailReceivedV1
  | ResendEmailStatusChangedV1
  | WhatsAppMessageReceivedV1;
export type EventTypeV1 = CatalogueEventV1['type'];

export type CatalogueInvariant =
  | { readonly rule: 'sorted-utf8'; readonly pattern: PointerPattern }
  | {
      readonly rule:
        | 'same-instant'
        | 'identical'
        | 'slack-ts-instant'
        | 'non-empty-either'
        | 'disjoint'
        | 'length-equals'
        | 'differs'
        | 'whatsapp-message-key';
      readonly pointers: readonly string[];
    };

export interface EventDefinition<T extends CatalogueEventV1 = CatalogueEventV1, S = Record<string, never>> {
  readonly type: T['type'];
  readonly version: 1;
  readonly channel: T['account']['channel'];
  readonly schema: z.ZodType<T>;
  readonly untrusted: readonly PointerPattern[];
  readonly content: readonly PointerPattern[];
  readonly addresses: readonly PointerPattern[];
  readonly handles: readonly { pattern: PointerPattern; workspace: PointerPattern }[];
  readonly formats: readonly { pattern: PointerPattern; format: SchemaFormat }[];
  readonly invariants: readonly CatalogueInvariant[];
  readonly subject: (event: T) => string;
  readonly dedupeKey: (event: T, staging: S) => string;
  readonly examples: readonly T[];
}

export interface DefinitionInternal<T extends CatalogueEventV1 = CatalogueEventV1, S = Record<string, never>>
  extends EventDefinition<T, S> {
  readonly description: ObjectNode;
}

export type AnyEventDefinition = Omit<
  EventDefinition<never, never>,
  'type' | 'channel' | 'schema' | 'subject' | 'dedupeKey' | 'examples'
> & {
  readonly type: string;
  readonly channel: 'gmail' | 'slack' | 'resend' | 'whatsapp';
  readonly schema: z.ZodType;
  readonly subject: (event: never) => string;
  readonly dedupeKey: (event: never, staging: never) => string;
  readonly examples: readonly CatalogueEventV1[];
};
