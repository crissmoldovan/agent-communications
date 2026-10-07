/**
 * `@agentcomms/events`: the event catalogue, conditions, mapping and wire format of local event emission (design
 * 2026-10-05, D1 and D3), with no I/O and nothing but ECMAScript and zod. One entry; internal modules are not reachable.
 */

export { UNICODE_VERSION } from '../vendor/unicode-15.1.0/generated/version.ts';
export * from './catalogue/index.ts';
export * from './formats/index.ts';
export * from './identity/event-id.ts';
export * from './idna/domain.ts';
export * from './json.ts';
export * from './mapping/index.ts';
export { expandPattern, matchesPattern, type PointerPattern, type PointerPatternToken } from './pattern.ts';
export { formatPointer, getPointer, parsePointer, relatePointers } from './pointer.ts';
export * from './result.ts';
export * from './text.ts';
export * from './unicode/fold.ts';
export * from './unicode/nfc.ts';
export * from './wire/index.ts';
