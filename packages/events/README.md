# @agentcomms/events

`@agentcomms/events` is the isomorphic library behind agent-communications’ local event emission: the version-1
event catalogue, pointer patterns, semantic formats, deterministic conditions, mapping templates and CloudEvents wire
format. [Appendix A of the event-emission design](../../docs/superpowers/specs/2026-10-05-local-event-emission-design.md#appendix-a-version-1-event-catalogue-normative)
is its normative contract.

It has no I/O. The same build runs in Node and browser webviews, imports no `node:` module, and makes no network,
file-system, clock or randomness call. Sanitising, untrusted-content envelopes, signing and delivery belong to the
daemon that uses this library; this package reports source-field and mapped-value provenance instead.

This package is held back from release until the first package that depends on it ships. Its first version is then
published by hand; see [the release guide](../../docs/RELEASING.md#A-package-held-back-from-release).

## API

Import the pieces you need from the package root. The barrel is the complete supported surface; internal modules are
not public API.

### JSON, text and errors

`canonicalJson` is byte-identical to core’s canonical JSON. It sorts object keys by UTF-16 code units, drops
`undefined` object members and refuses non-JSON input with `EventsError`; validators otherwise return `Result<T>` with
closed `IssueCode` values.

```ts
import { canonicalJson, codePointLength, isJsonValue } from '@agentcomms/events';

const value = { second: undefined, first: ['é'] };
if (isJsonValue(value)) {
  canonicalJson(value); // '{"first":["é"]}'
  codePointLength('🛰'); // 1
}
```

### Event identity

`eventId` derives D3’s stable, account-scoped 32-character ID through WebCrypto. Keep its canonical preimage with
the ID so `compareEventIdentities` can distinguish a repeat from the theoretical truncated-hash collision.

```ts
import { eventId, eventIdPreimage } from '@agentcomms/events';

const identity = {
  installationId: 'installation-id',
  accountId: 'account-id',
  eventType: 'gmail.message.received',
  typeVersion: 1,
  dedupeKey: '["provider-occurrence","message","received"]',
};
const preimage = eventIdPreimage(identity);
const id = await eventId(identity);
```

### Unicode, domains and semantic formats

The library pins NFC, full case folding and IDNA handling to Unicode 15.1. `toAsciiDomain` returns a `Result`; use
`isFormat` for the catalogue’s five semantic formats.

```ts
import { UNICODE_VERSION, caseFold, isFormat, toAsciiDomain } from '@agentcomms/events';

UNICODE_VERSION; // '15.1.0'
caseFold('STRASSE'); // 'strasse'
toAsciiDomain('Bücher.example'); // { ok: true, value: 'xn--bcher-kva.example' }
isFormat('date-time', '2026-10-07T12:00:00Z'); // true
```

### JSON Pointers and patterns

Pointers follow RFC 6901. Patterns add `{ any: true }` only for array indices and expand to the concrete non-null
values present in an event.

```ts
import { expandPattern, getPointer } from '@agentcomms/events';

const source = { recipients: [{ address: 'recipient@example.test' }] };
getPointer(source, '/recipients/0/address'); // { found: true, value: 'recipient@example.test' }
expandPattern(['recipients', { any: true }, 'address'], source); // ['/recipients/0/address']
```

### Catalogue and source schemas

`CATALOGUE` contains precisely the seven version-1 definitions. A definition owns its Zod schema, metadata patterns,
examples, source JSON Schema and named invariants.

```ts
import { CATALOGUE, catalogueEntry, sourceSchema, validateEvent } from '@agentcomms/events';

const found = catalogueEntry('gmail.message.received', 1);
if (found.ok) {
  const event = found.value.examples[0];
  validateEvent(found.value, event); // { ok: true, value: event }
  sourceSchema(found.value); // JSON Schema 2020-12 for this exact source type
}
CATALOGUE.length; // 7
```

### Conditions

Canonicalise a condition against the selected definition before persisting it. The omitted case-sensitivity flag
becomes explicit `false`, so canonical JSON and rule digests are stable.

```ts
import { CATALOGUE, canonicaliseCondition, evaluateCondition } from '@agentcomms/events';

const definition = CATALOGUE[0];
const condition = canonicaliseCondition(definition, { path: '/subject', op: 'contains', value: 'status' });
if (condition.ok) evaluateCondition(definition, condition.value, definition.examples[0]);
```

`canonicaliseAgenticCondition` checks the static agentic form and its deterministic content-field prefilter. It does
not execute a judge.

### Mapping and provenance

Mapping copies clean, typed source values; constants never inherit provenance. Classifying the mapped result tells a
daemon exactly which output pointers are untrusted, addresses or scoped handles before it applies its chosen
representation.

```ts
import { CATALOGUE, classifyMapped, compileMapping, evaluateMapping } from '@agentcomms/events';

const definition = CATALOGUE[0];
const mapped = compileMapping(definition, { subject: { $path: '/subject' } });
if (mapped.ok) {
  const value = evaluateMapping(mapped.value, definition.examples[0]);
  classifyMapped(definition, definition.examples[0], value);
}
```

`deliverySchema` and `deliverySchemaId` describe the exact plain or enveloped delivery representation. The daemon
selects that representation and its transport boundary; this package supplies the deterministic mapping primitives.

### CloudEvents wire format

After mapping and representation, the daemon supplies stable delivery fields to `buildCloudEvent`. The library derives
the non-overridable type, subject, time and canonical `agentcommsuntrusted` extension; `cloudEventBytes` gives the
canonical JSON string to UTF-8 encode for transport.

```ts
import { CATALOGUE, buildCloudEvent, cloudEventBytes } from '@agentcomms/events';

const definition = CATALOGUE[0];
const event = definition.examples[0];
const envelope = buildCloudEvent(definition, event, {
  deliveryId: 'delivery-id',
  installationId: 'installation-id',
  ruleId: 'rule-id',
  ruleVersion: 1,
  targetId: 'target-id',
  targetVersion: 1,
  data: { subject: event.subject },
  untrusted: ['/subject'],
});
cloudEventBytes(envelope);
```

`TEST_CLOUD_EVENT`, `TEST_CLOUD_EVENT_BYTES` and `JUDGE_TEST_INPUT` are fixed test-only contract values, not source
events and not caller-configurable templates.

## Unicode data and licence

The generated tables and their pinned sources are Unicode 15.1.0. In a repository checkout, run
`pnpm sync:unicode` to regenerate the checked-in tables from the pinned vendor files. The Unicode Character Database
is licensed under Unicode-3.0; its complete notice is in [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).

## Licence

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
