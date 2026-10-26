/**
 * A rule in plain words (owner feedback 0.32.0, §3.4): "When mail arrives in cue/gmail with 'invoice' in the subject,
 * ask Jev '…'. If it says yes, put it in the Queue, lane billing."
 *
 * The sentence comes back as parts, so a renderer never has to guess which words are whose:
 * - `plain`: this module's own words;
 * - `value`: an account, a judge, a target, a lane or a host, from the rule's validated ids;
 * - `untrusted`: rule-author text — every condition operand, the judge's question, Gmail label ids, Slack conversation
 *   and WhatsApp chat ids, and a pointer the catalogue does not declare. A renderer shows these as outside text and
 *   never as instructions; their text is exactly the document's, unchanged.
 *
 * Pure and isomorphic, like the rest of this package: no I/O, and nothing read but the document, the catalogue and the
 * labels given.
 */
import { catalogueEntry, describeFields } from '../catalogue/index.ts';
import type { CatalogueEventV1, EventDefinition } from '../catalogue/types.ts';
import type { CanonicalCondition, Scalar } from '../conditions/types.ts';
import { canonicalJson } from '../json.ts';
import { matchesPattern } from '../pattern.ts';
import { parsePointer } from '../pointer.ts';

export interface RulePart {
  readonly text: string;
  readonly kind: 'plain' | 'value' | 'untrusted';
}

/** What the reader knows things by: a label per JSON pointer, over the catalogue's, and an alias per account id. */
export interface FieldLabels {
  readonly fields?: Readonly<Record<string, string>> | undefined;
  /** The alias the Accounts screen shows for an account id, for example `cue/gmail`; the id is shown where none is. */
  readonly accounts?: Readonly<Record<string, string>> | undefined;
}

/** The part of a target document a sentence names. */
export interface DescribableTarget {
  readonly targetId: string;
  readonly kind: string;
  readonly lane?: { readonly name: string } | undefined;
  readonly url?: unknown;
  readonly subscriberId?: string | undefined;
  readonly [field: string]: unknown;
}

/**
 * The part of a canonical rule document (the event service's `CanonicalFullRuleDocument`) a sentence describes. It is
 * structural, so this package needs no type from the event service, and every stored rule document satisfies it.
 */
export interface DescribableRuleDocument {
  readonly source: {
    readonly channel: string;
    readonly accountIds: readonly string[];
    readonly options?: unknown;
  };
  readonly event: { readonly type: string; readonly version: number };
  readonly condition: CanonicalCondition;
  readonly agentic?:
    | {
        readonly judge: { readonly judgeId: string; readonly kind?: unknown; readonly [field: string]: unknown };
        readonly question: string;
        readonly onUncertain?: string | undefined;
        readonly [field: string]: unknown;
      }
    | undefined;
  readonly targets: readonly DescribableTarget[];
  readonly [field: string]: unknown;
}

const plain = (text: string): RulePart => ({ text, kind: 'plain' });
const value = (text: string): RulePart => ({ text, kind: 'value' });
const untrusted = (text: string): RulePart => ({ text, kind: 'untrusted' });

/** How each catalogue event begins its sentence; an event this list does not know names its type. */
const OPENINGS: Readonly<Record<string, string>> = {
  'gmail.message.received': 'When mail arrives in ',
  'gmail.message.sent': 'When mail is sent from ',
  'gmail.message.labelled': 'When mail is labelled in ',
  'slack.message.posted': 'When a message is posted in ',
  'resend.email.received': 'When an email arrives in ',
  'resend.email.status_changed': "When an email's status changes in ",
  'whatsapp.message.received': 'When a WhatsApp message arrives in ',
};

/** Friendlier names for the catalogue's common fields; any other declared field reads as its own words. */
const FIELD_NAMES: Readonly<Record<string, string>> = {
  '/subject': 'the subject',
  '/body': 'the body',
  '/snippet': 'the preview',
  '/text': 'the text',
  '/date': 'the date',
  '/occurredAt': 'the time it happened',
  '/from/address': "the sender's address",
  '/from/name': "the sender's name",
  '/to': 'the recipients',
  '/cc': 'the copied recipients',
  '/bcc': 'the blind-copied recipients',
  '/replyTo': 'the reply-to addresses',
  '/labels': 'the labels',
  '/added': 'the labels added',
  '/removed': 'the labels removed',
  '/unread': 'the unread flag',
  '/hasAttachments': 'the attachments flag',
  '/attachments': 'the attachments',
  '/threadId': 'the thread',
  '/messageId': 'the message id',
  '/emailId': 'the email id',
  '/previous': 'the old status',
  '/current': 'the new status',
  '/receivedFor': 'the addresses it was received for',
  '/channel/id': 'the channel',
  '/channel/name': "the channel's name",
  '/channel/kind': 'the kind of channel',
  '/author/userId': 'the author',
  '/author/botId': 'the bot',
  '/author/name': "the author's name",
  '/author/app': 'the app-author flag',
  '/author/external': 'the external-author flag',
  '/threadTs': 'the thread',
  '/mentions': 'the mentions',
  '/files': 'the files',
  '/chat/id': 'the chat',
  '/chat/name': "the chat's name",
  '/chat/kind': 'the kind of chat',
  '/sender/id': 'the sender',
  '/sender/name': "the sender's name",
  '/kind': 'the kind of message',
};

/** A judge as a person knows it: Jev by TypeSafe, a local model server, Laya, or the judge's id. */
function judgeName(judge: { readonly judgeId: string; readonly kind?: unknown }): string {
  switch (judge.kind) {
    case 'typesafe':
      return 'Jev';
    case 'local-endpoint':
      return 'the local model';
    case 'laya':
      return 'Laya';
    default:
      return judge.judgeId;
  }
}

/** A field token's words, ASCII-lowercased with no host locale: `replyToDiffers` reads `reply to differs`. */
function words(token: string): string {
  return token
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]+/gu, ' ')
    .replaceAll(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** A pointer's label: the reader's own, then the catalogue's, then the pointer itself as rule-author text. */
function fieldPart(pointer: string, rule: DescribableRuleDocument, labels: FieldLabels | undefined): RulePart {
  const given = labels?.fields?.[pointer];
  if (given !== undefined) return plain(given);
  const entry = catalogueEntry(rule.event.type, rule.event.version);
  const declared =
    entry.ok &&
    describeFields(entry.value as EventDefinition<CatalogueEventV1, unknown>).some((field) =>
      matchesPattern(field.pattern, pointer),
    );
  if (!declared) return untrusted(pointer);
  const named = FIELD_NAMES[pointer];
  if (named !== undefined) return plain(named);
  const tokens = parsePointer(pointer);
  if (!tokens.ok || tokens.value.length === 0) return untrusted(pointer);
  return plain(`the ${tokens.value.map(words).join(' ')}`);
}

const operand = (scalar: Scalar): RulePart => untrusted(typeof scalar === 'string' ? scalar : canonicalJson(scalar));
const quoted = (scalar: Scalar): readonly RulePart[] => [plain("'"), operand(scalar), plain("'")];
const caseText = (caseSensitive: boolean): readonly RulePart[] => (caseSensitive ? [plain(' (matching case)')] : []);

function list(items: readonly (readonly RulePart[])[], last: string): readonly RulePart[] {
  return items.flatMap((item, index) => [
    ...(index === 0 ? [] : [plain(index === items.length - 1 ? last : ', ')]),
    ...item,
  ]);
}

type Leaf = Extract<CanonicalCondition, { readonly path: string }>;

function comparison(op: 'gt' | 'gte' | 'lt' | 'lte', operandValue: number | string): string {
  const dated = typeof operandValue === 'string';
  switch (op) {
    case 'gt':
      return dated ? ' is after ' : ' is more than ';
    case 'gte':
      return dated ? ' is on or after ' : ' is at least ';
    case 'lt':
      return dated ? ' is before ' : ' is less than ';
    case 'lte':
      return dated ? ' is on or before ' : ' is at most ';
  }
}

/** One leaf as a predicate: "the subject contains 'invoice'". */
function leaf(condition: Leaf, rule: DescribableRuleDocument, labels: FieldLabels | undefined): readonly RulePart[] {
  const field = fieldPart(condition.path, rule, labels);
  switch (condition.op) {
    case 'exists':
      return [field, plain(' is present')];
    case 'equals':
      return [field, plain(' is '), ...quoted(condition.value), ...caseText(condition.caseSensitive)];
    case 'notEquals':
      return [field, plain(' is not '), ...quoted(condition.value), ...caseText(condition.caseSensitive)];
    case 'contains':
      return [field, plain(' contains '), ...quoted(condition.value), ...caseText(condition.caseSensitive)];
    case 'startsWith':
      return [field, plain(' starts with '), ...quoted(condition.value), ...caseText(condition.caseSensitive)];
    case 'endsWith':
      return [field, plain(' ends with '), ...quoted(condition.value), ...caseText(condition.caseSensitive)];
    case 'in':
      return [field, plain(' is one of '), ...list(condition.values.map(quoted), ', ')];
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return [field, plain(comparison(condition.op, condition.value)), ...quoted(condition.value)];
    case 'domainIs':
      return [
        field,
        plain(' is at '),
        ...quoted(condition.value),
        ...(condition.includeSubdomains ? [plain(' or a subdomain')] : []),
      ];
    default:
      return [field, plain(' matches a condition this release cannot name')];
  }
}

function predicate(
  condition: CanonicalCondition,
  rule: DescribableRuleDocument,
  labels: FieldLabels | undefined,
  nested = false,
): readonly RulePart[] {
  const group = (parts: readonly RulePart[]) => (nested ? [plain('('), ...parts, plain(')')] : parts);
  if ('all' in condition)
    return group(
      list(
        condition.all.map((child) => predicate(child, rule, labels, true)),
        ' and ',
      ),
    );
  if ('any' in condition)
    return group(
      list(
        condition.any.map((child) => predicate(child, rule, labels, true)),
        ' or ',
      ),
    );
  if ('not' in condition) return [plain('not ('), ...predicate(condition.not, rule, labels), plain(')')];
  return leaf(condition, rule, labels);
}

/** "with 'invoice' or 'receipt' in the subject": a contains, or any/all of contains on one field. */
function containsPhrase(
  condition: CanonicalCondition,
  rule: DescribableRuleDocument,
  labels: FieldLabels | undefined,
): readonly RulePart[] | undefined {
  const leaves = 'any' in condition ? condition.any : 'all' in condition ? condition.all : [condition];
  const contains = leaves.flatMap((child) =>
    'path' in child && child.op === 'contains' ? [child as Extract<Leaf, { readonly op: 'contains' }>] : [],
  );
  const first = contains[0];
  if (first === undefined || contains.length !== leaves.length) return undefined;
  if (contains.some((child) => child.path !== first.path || child.caseSensitive !== first.caseSensitive))
    return undefined;
  return [
    plain(' with '),
    ...list(
      contains.map((child) => quoted(child.value)),
      'any' in condition ? ' or ' : ' and ',
    ),
    plain(' in '),
    fieldPart(first.path, rule, labels),
    ...caseText(first.caseSensitive),
  ];
}

function record(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

/** What the source's options narrow it to: Gmail labels, Slack conversations, WhatsApp chats. */
function scope(rule: DescribableRuleDocument): readonly RulePart[] {
  const options = record(rule.source.options);
  const ids = (key: string): readonly string[] | undefined => {
    const entries = options?.[key];
    return Array.isArray(entries) && entries.every((entry) => typeof entry === 'string') ? entries : undefined;
  };
  switch (rule.source.channel) {
    case 'gmail': {
      const labels = ids('labels');
      return [
        ...(options?.labels === 'any' ? [plain(' (any label)')] : []),
        ...(labels === undefined
          ? []
          : [
              plain(' (labelled '),
              ...list(
                labels.map((label) => quoted(label)),
                ' or ',
              ),
              plain(')'),
            ]),
        ...(options?.includeSpamTrash === true ? [plain(' (spam and trash too)')] : []),
      ];
    }
    case 'slack': {
      const conversations = ids('conversations');
      return conversations === undefined
        ? []
        : [
            plain(' (in '),
            ...list(
              conversations.map((id) => [untrusted(id)]),
              ' or ',
            ),
            plain(')'),
          ];
    }
    case 'whatsapp': {
      const chats = ids('chats');
      return chats === undefined
        ? []
        : [
            plain(' (in '),
            ...list(
              chats.map((id) => [untrusted(id)]),
              ' or ',
            ),
            plain(')'),
          ];
    }
    default:
      return [];
  }
}

/** A webhook's host: from its plain URL, or a secret URL's stored host; never a path, a query or a digest. */
function webhookHost(target: DescribableTarget): string | undefined {
  const url = record(target.url);
  if (url?.kind === 'secret') return typeof url.host === 'string' && url.host !== '' ? url.host : undefined;
  if (url?.kind !== 'plain' || typeof url.value !== 'string') return undefined;
  // The stored URL is the canonical one the person approved (its host already lowercase): scheme, user part, host.
  const host = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]/?#]+\]|[^:/?#]+)/u.exec(url.value)?.[1];
  return host === undefined || host === '' ? undefined : host;
}

function target(entry: DescribableTarget): readonly RulePart[] {
  switch (entry.kind) {
    case 'dry-run':
      return [plain('record it in the '), value('Dry-run log')];
    case 'queue':
      return [
        plain('put it in the '),
        value('Queue'),
        ...(entry.lane === undefined ? [] : [plain(', lane '), value(entry.lane.name)]),
      ];
    case 'webhook':
      return [plain('send it to '), value(webhookHost(entry) ?? entry.targetId)];
    case 'sse':
      return [plain('stream it to '), value(entry.subscriberId ?? entry.targetId)];
    default:
      return [plain('deliver it to '), value(entry.targetId)];
  }
}

/** The rule's sentence, as parts whose texts joined are the sentence a person reads. */
export function describeRule(rule: DescribableRuleDocument, labels?: FieldLabels): RulePart[] {
  const accounts = rule.source.accountIds.map((id) => [value(labels?.accounts?.[id] ?? id)]);
  const opening = OPENINGS[rule.event.type];
  const parts: RulePart[] = [
    ...(opening === undefined
      ? [plain('When a '), untrusted(rule.event.type), plain(' event happens in ')]
      : [plain(opening)]),
    ...list(accounts, ' or '),
    ...scope(rule),
    ...(containsPhrase(rule.condition, rule, labels) ?? [plain(' where '), ...predicate(rule.condition, rule, labels)]),
  ];
  const targets = list(rule.targets.map(target), ' and ');
  const agentic = rule.agentic;
  if (agentic === undefined) {
    parts.push(plain(', '), ...targets, plain('.'));
    return parts;
  }
  parts.push(
    plain(', ask '),
    value(judgeName(agentic.judge)),
    plain(" '"),
    untrusted(agentic.question),
    plain("'. If it says yes, "),
    ...targets,
    plain('.'),
  );
  if (agentic.onUncertain === 'hold') parts.push(plain(' If it is not sure, it is held for you to decide.'));
  return parts;
}
