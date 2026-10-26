/** `printRuleText`: a rule document as the rule text. */
import { canonicalJson, type JsonValue } from '../json.ts';
import { EventsError } from '../result.ts';
import { parseRuleText } from './parse.ts';
import {
  CHANNELS,
  DEFAULTED_FIELDS,
  EVENT_PHRASES,
  fieldPointer,
  formatDuration,
  formatField,
  formatName,
  formatNames,
  hasKeys,
  isCount,
  isFieldText,
  isRecord,
  isStringArray,
  REQUIRED_SECTIONS,
} from './vocabulary.ts';

type Doc = Readonly<Record<string, JsonValue>>;

/**
 * Writes a rule document as the rule text, which `parseRuleText` reads back to the same document. Each part the
 * readable form can say is written that way; anything else — a field it has no words for, an odd shape — is written as
 * `raw` JSON in its place, so nothing is ever dropped. The same document always gives the same text.
 *
 * @throws EventsError `NOT_JSON` when `doc` is not a JSON object.
 */
export function printRuleText(doc: object): string {
  const json = canonicalJson(doc);
  const record = JSON.parse(json) as JsonValue;
  if (!isRecord(record)) throw new EventsError('NOT_JSON', 'a rule document is a JSON object');
  const natural = writeDocument(record, true);
  if (roundTrips(natural, json)) return natural;
  // A safety net, never the plan: the readable form is checked by the tests to cover every canonical shape.
  const raw = writeDocument(record, false);
  if (roundTrips(raw, json)) return raw;
  throw new EventsError('NOT_JSON', 'the rule document cannot be written as rule text');
}

function roundTrips(text: string, json: string): boolean {
  const parsed = parseRuleText(text);
  return parsed.ok && canonicalJson(parsed.doc) === json;
}

function writeDocument(doc: Doc, readable: boolean): string {
  const said = new Set<string>();
  const blocks: string[][] = [];
  if (readable) {
    if (typeof doc.ruleId === 'string' && isCount(doc.version)) {
      blocks.push([`rule ${formatName(doc.ruleId)}, version ${doc.version}`]);
      said.add('ruleId').add('version');
    }
    const head: string[] = [];
    const when = whenLine(doc.source, doc.event);
    if (when !== undefined) {
      head.push(when);
      said.add('source').add('event');
    }
    if (Object.hasOwn(doc, 'condition')) {
      head.push(...conditionLines(doc.condition as JsonValue, 0, 'match '));
      said.add('condition');
    }
    if (head.length > 0) blocks.push(head);
    if (Array.isArray(doc.targets) && doc.targets.length > 0) {
      blocks.push(thenLines(doc.targets));
      said.add('targets');
    }
    const subscribers = Array.isArray(doc.subscribers) ? subscriberLines(doc.subscribers) : undefined;
    if (subscribers !== undefined) {
      if (subscribers.length > 0) blocks.push(subscribers);
      said.add('subscribers');
    }
    if (Array.isArray(doc.judges) && doc.judges.length === 0) said.add('judges');
  }
  const raw = rawLines(doc, said);
  if (raw.length > 0) blocks.push(raw);
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `raw` lines for every field not said otherwise, and `absent` for a field the parser would otherwise expect or fill. */
function rawLines(doc: Doc, said: ReadonlySet<string>): string[] {
  const expected = [...REQUIRED_SECTIONS.flatMap((section) => section.fields), ...DEFAULTED_FIELDS];
  const fields = new Set([
    ...Object.keys(doc).filter((field) => !said.has(field)),
    ...expected.filter((field) => !Object.hasOwn(doc, field)),
  ]);
  return [...fields]
    .sort(compareText)
    .map((field) =>
      Object.hasOwn(doc, field)
        ? `raw ${fieldPointer(field)} = ${canonicalJson(doc[field] as JsonValue)}`
        : `raw ${fieldPointer(field)} absent`,
    );
}

function whenLine(source: JsonValue | undefined, event: JsonValue | undefined): string | undefined {
  if (!isRecord(event) || !hasKeys(event, ['type', 'version'])) return undefined;
  if (typeof event.type !== 'string' || !isCount(event.version)) return undefined;
  const channel = event.type.split('.')[0] as string;
  if (!CHANNELS.includes(channel)) return undefined;
  if (!isRecord(source) || !hasKeys(source, ['channel', 'accountIds', 'options'])) return undefined;
  if (source.channel !== channel || !isStringArray(source.accountIds)) return undefined;
  const options = optionClauses(channel, source.options);
  if (options === undefined) return undefined;
  const phrase = event.version === 1 ? EVENT_PHRASES.find((entry) => entry.type === event.type) : undefined;
  const what =
    phrase === undefined ? `event ${JSON.stringify(event.type)} version ${event.version}` : phrase.words.join(' ');
  return `when ${what} in ${formatNames(source.accountIds)}${options.map((clause) => `, ${clause}`).join('')}`;
}

function listed(singular: string, plural: string, values: readonly string[]): string {
  return `${values.length === 1 ? singular : plural} ${formatNames(values)}`;
}

function optionClauses(channel: string, options: JsonValue | undefined): string[] | undefined {
  if (!isRecord(options) || options.channel !== channel) return undefined;
  switch (channel) {
    case 'gmail': {
      if (!hasKeys(options, ['channel', 'labels', 'includeSpamTrash'])) return undefined;
      if (typeof options.includeSpamTrash !== 'boolean') return undefined;
      const labels = options.labels;
      const where =
        labels === 'inbox'
          ? 'in the inbox'
          : labels === 'any'
            ? 'in any label'
            : isStringArray(labels)
              ? `in ${listed('label', 'labels', labels)}`
              : undefined;
      if (where === undefined) return undefined;
      return options.includeSpamTrash ? [where, 'including spam and trash'] : [where];
    }
    case 'slack':
      if (!hasKeys(options, ['channel', 'conversations']) || !isStringArray(options.conversations)) return undefined;
      return [`in ${listed('conversation', 'conversations', options.conversations)}`];
    case 'resend':
      if (!hasKeys(options, ['channel', 'kinds']) || !isStringArray(options.kinds)) return undefined;
      return [listed('kind', 'kinds', options.kinds)];
    case 'whatsapp':
      if (!hasKeys(options, ['channel', 'chats'])) return undefined;
      if (options.chats === 'all-allowed') return ['in all allowed chats'];
      return isStringArray(options.chats) ? [`in ${listed('chat', 'chats', options.chats)}`] : undefined;
    default:
      return undefined;
  }
}

function isScalar(value: JsonValue | undefined): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

const matchingCase = (caseSensitive: boolean) => (caseSensitive ? ', matching case' : '');

const COMPARISONS: Readonly<Record<string, string>> = {
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
};

/** One condition's words after its field, or undefined when the readable form has none for it. */
function leafText(condition: Doc): string | undefined {
  if (!isFieldText(condition.path)) return undefined;
  const field = formatField(condition.path);
  const { op, value } = condition;
  switch (op) {
    case 'exists':
      return hasKeys(condition, ['path', 'op']) ? `${field} exists` : undefined;
    case 'equals':
    case 'notEquals':
    case 'contains': {
      if (!hasKeys(condition, ['path', 'op', 'value', 'caseSensitive'])) return undefined;
      if (!isScalar(value) || typeof condition.caseSensitive !== 'boolean') return undefined;
      const verb = op === 'equals' ? 'is' : op === 'notEquals' ? 'is not' : 'contains';
      return `${field} ${verb} ${canonicalJson(value as JsonValue)}${matchingCase(condition.caseSensitive)}`;
    }
    case 'startsWith':
    case 'endsWith': {
      if (!hasKeys(condition, ['path', 'op', 'value', 'caseSensitive'])) return undefined;
      if (typeof value !== 'string' || typeof condition.caseSensitive !== 'boolean') return undefined;
      const verb = op === 'startsWith' ? 'starts with' : 'ends with';
      return `${field} ${verb} ${JSON.stringify(value)}${matchingCase(condition.caseSensitive)}`;
    }
    case 'in': {
      const values = condition.values;
      if (!hasKeys(condition, ['path', 'op', 'values']) || !Array.isArray(values) || values.length === 0)
        return undefined;
      if (!values.every(isScalar)) return undefined;
      return `${field} is one of ${values.map((entry) => canonicalJson(entry)).join(', ')}`;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!hasKeys(condition, ['path', 'op', 'value'])) return undefined;
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return undefined;
      return `${field} ${COMPARISONS[op]} ${canonicalJson(value)}`;
    }
    case 'domainIs':
      if (!hasKeys(condition, ['path', 'op', 'value', 'includeSubdomains'])) return undefined;
      if (typeof value !== 'string' || typeof condition.includeSubdomains !== 'boolean') return undefined;
      return `${field} has domain ${JSON.stringify(value)}${condition.includeSubdomains ? ' or a subdomain' : ''}`;
    default:
      return undefined;
  }
}

/** A condition at `level`, after `lead` (`match `, `not `, or nothing), with any group's members indented below it. */
function conditionLines(condition: JsonValue, level: number, lead: string): string[] {
  const indent = '  '.repeat(level);
  if (isRecord(condition)) {
    for (const group of ['any', 'all'] as const) {
      const members = condition[group];
      if (hasKeys(condition, [group]) && Array.isArray(members) && members.length > 0)
        return [`${indent}${lead}${group}`, ...members.flatMap((member) => conditionLines(member, level + 1, ''))];
    }
    if (hasKeys(condition, ['not'])) return conditionLines(condition.not as JsonValue, level, `${lead}not `);
    const leaf = leafText(condition);
    if (leaf !== undefined) return [`${indent}${lead}${leaf}`];
  }
  return [`${indent}${lead}raw ${canonicalJson(condition)}`];
}

function thenLines(targets: readonly JsonValue[]): string[] {
  return ['then', ...targets.flatMap((target, index) => [...(index > 0 ? [''] : []), ...targetLines(target)])];
}

const keep = (retentionMs: JsonValue | undefined) =>
  retentionMs === undefined ? '' : `, keep ${formatDuration(retentionMs as number)}`;

const isRepresentation = (value: JsonValue | undefined) =>
  value === undefined || value === 'plain' || value === 'enveloped';

const times = (count: number) => `${count} ${count === 1 ? 'time' : 'times'}`;

function webhookUrl(url: JsonValue | undefined): string | undefined {
  if (!isRecord(url)) return undefined;
  if (url.kind === 'plain' && hasKeys(url, ['kind', 'value']) && typeof url.value === 'string')
    return `to ${formatName(url.value)}`;
  if (url.kind === 'secret' && hasKeys(url, ['kind', 'scheme', 'host', 'port', 'sha256'])) {
    const { scheme, host, port, sha256 } = url;
    if (typeof scheme !== 'string' || typeof host !== 'string' || !isCount(port) || typeof sha256 !== 'string')
      return undefined;
    return `to secret ${formatName(scheme)} URL on ${formatName(host)} port ${port}, fingerprint ${formatName(sha256)}`;
  }
  return undefined;
}

/** One target's lines at level 1, its options indented at level 2; a target the readable form cannot say is `raw`. */
function targetLines(target: JsonValue): string[] {
  const raw = [`  raw ${canonicalJson(target)}`];
  if (!isRecord(target) || typeof target.targetId !== 'string' || !isCount(target.version)) return raw;
  const head = `${formatName(target.targetId)}, version ${target.version}`;
  const { retentionMs } = target;
  if (retentionMs !== undefined && !isCount(retentionMs)) return raw;
  switch (target.kind) {
    case 'dry-run':
      if (!hasKeys(target, ['targetId', 'version', 'kind'], ['retentionMs'])) return raw;
      return [`  dry run ${head}${keep(retentionMs)}`];
    case 'queue': {
      if (!hasKeys(target, ['targetId', 'version', 'kind', 'show'], ['retentionMs', 'lane'])) return raw;
      const { show, lane } = target;
      if (typeof show !== 'string') return raw;
      if (lane !== undefined && !(isRecord(lane) && hasKeys(lane, ['name']) && typeof lane.name === 'string'))
        return raw;
      const inLane = lane === undefined ? '' : `, in lane ${formatName(lane.name as string)}`;
      const shown = show === 'summary' ? '' : `, show ${formatName(show)}`;
      return [`  queue ${head}${inLane}${keep(retentionMs)}${shown}`];
    }
    case 'webhook': {
      const optional = ['url', 'approvedAddressSet', 'retryLimit', 'representation'];
      if (!hasKeys(target, ['targetId', 'version', 'kind', 'signing', 'ordering'], optional)) return raw;
      const { url, approvedAddressSet, retryLimit, representation, signing, ordering } = target;
      if (typeof signing !== 'string' || typeof ordering !== 'string' || !isRepresentation(representation)) return raw;
      if (retryLimit !== undefined && !isCount(retryLimit)) return raw;
      if (approvedAddressSet !== undefined && !isStringArray(approvedAddressSet)) return raw;
      const to = url === undefined ? undefined : webhookUrl(url);
      if (url !== undefined && to === undefined) return raw;
      return [
        `  webhook ${head}${representation === undefined ? '' : `, ${representation}`}${
          retryLimit === undefined ? '' : `, retrying up to ${times(retryLimit)}`
        }`,
        ...(to === undefined ? [] : [`    ${to}`]),
        ...(approvedAddressSet === undefined
          ? []
          : [
              `    approved ${approvedAddressSet.length === 1 ? 'address' : 'addresses'} ${formatNames(approvedAddressSet)}`,
            ]),
        ...(signing === 'standard-webhooks' ? [] : [`    signed ${formatName(signing)}`]),
        ...(ordering === 'strict' ? [] : [`    ordering ${formatName(ordering)}`]),
      ];
    }
    case 'sse': {
      if (!hasKeys(target, ['targetId', 'version', 'kind'], ['subscriberId', 'subscriberVersion', 'representation']))
        return raw;
      const { subscriberId, subscriberVersion, representation } = target;
      if (!isRepresentation(representation)) return raw;
      if ((subscriberId === undefined) !== (subscriberVersion === undefined)) return raw;
      if (subscriberId !== undefined && (typeof subscriberId !== 'string' || !isCount(subscriberVersion))) return raw;
      const to =
        subscriberId === undefined ? '' : `, to subscriber ${formatName(subscriberId)} version ${subscriberVersion}`;
      return [`  stream ${head}${to}${representation === undefined ? '' : `, ${representation}`}`];
    }
    default:
      return raw;
  }
}

/** Each subscriber's lines, `[]` for none, or undefined when one of them has a shape the readable form cannot say. */
function subscriberLines(subscribers: readonly JsonValue[]): string[] | undefined {
  const lines: string[] = [];
  for (const subscriber of subscribers) {
    if (!isRecord(subscriber) || subscriber.kind !== 'sse') return undefined;
    if (!hasKeys(subscriber, ['subscriberId', 'version', 'kind'], ['authority', 'origins', 'retentionMs']))
      return undefined;
    const { subscriberId, version, authority, origins, retentionMs } = subscriber;
    if (typeof subscriberId !== 'string' || !isCount(version)) return undefined;
    if (retentionMs !== undefined && !isCount(retentionMs)) return undefined;
    if (origins !== undefined && !isStringArray(origins)) return undefined;
    if (authority !== undefined) {
      if (!isRecord(authority) || !hasKeys(authority, ['host', 'port'])) return undefined;
      if (typeof authority.host !== 'string' || !isCount(authority.port)) return undefined;
    }
    const on = authority === undefined ? '' : `, on ${formatName(authority.host as string)} port ${authority.port}`;
    lines.push(`subscriber ${formatName(subscriberId)}, version ${version}${on}${keep(retentionMs)}`);
    if (origins !== undefined) lines.push(`  ${origins.length === 1 ? 'origin' : 'origins'} ${formatNames(origins)}`);
  }
  return lines;
}
