import type { CatalogueEventV1, EventDefinition } from '../catalogue/types.ts';
import type { JsonValue } from '../json.ts';
import { expandPattern } from '../pattern.ts';
import { getPointer, relatePointers } from '../pointer.ts';
import type { MappedAddress, MappedClassification, MappedHandle, MappedUntrusted, MappedValue } from './types.ts';

const matched = (source: string, candidates: readonly string[]): boolean =>
  candidates.some((candidate) => relatePointers(source, candidate) !== 'disjoint');

function classifiedSources(
  mapped: MappedValue,
  data: JsonValue,
  sources: readonly string[],
): readonly { readonly pointer: string; readonly text: string }[] {
  const seen = new Set<string>();
  const values: { pointer: string; text: string }[] = [];
  for (const origin of mapped.provenance) {
    if (origin.kind !== 'source' || !matched(origin.source, sources) || seen.has(origin.output)) continue;
    const output = getPointer(data, origin.output);
    if (!output.found || typeof output.value !== 'string') continue;
    seen.add(origin.output);
    values.push({ pointer: origin.output, text: output.value });
  }
  return values;
}

/** Derive the D3/D7 taint facts for exactly one final mapped payload. */
export function classifyMapped<T extends CatalogueEventV1, S>(
  definition: EventDefinition<T, S>,
  event: T,
  mapped: MappedValue,
): MappedClassification {
  const source = event as unknown as JsonValue;
  const untrustedSources = definition.untrusted.flatMap((pattern) => expandPattern(pattern, source));
  const addressSources = definition.addresses.flatMap((pattern) => expandPattern(pattern, source));
  const untrusted: readonly MappedUntrusted[] = classifiedSources(mapped, mapped.data, untrustedSources);
  const addresses: readonly MappedAddress[] = classifiedSources(mapped, mapped.data, addressSources).map((entry) => ({
    pointer: entry.pointer,
    address: entry.text,
  }));
  const handles: MappedHandle[] = [];
  const handleSeen = new Set<string>();
  for (const handle of definition.handles) {
    const sources = expandPattern(handle.pattern, source);
    const workspacePointer = `/${handle.workspace.map((token) => (typeof token === 'string' ? token.replaceAll('~', '~0').replaceAll('/', '~1') : '')).join('/')}`;
    const workspace = getPointer(source, workspacePointer);
    if (!workspace.found || typeof workspace.value !== 'string') continue;
    for (const entry of classifiedSources(mapped, mapped.data, sources)) {
      if (handleSeen.has(entry.pointer)) continue;
      handleSeen.add(entry.pointer);
      handles.push({ pointer: entry.pointer, id: entry.text, workspace: workspace.value });
    }
  }
  return { untrusted, addresses, handles };
}
