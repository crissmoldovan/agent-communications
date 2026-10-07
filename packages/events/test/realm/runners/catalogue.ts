import type { Runner } from './types.ts';

interface CatalogueVector {
  readonly name: string;
  readonly type: string;
  readonly example: number;
}

export const catalogueRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly CatalogueVector[]) {
    const definition = library.CATALOGUE.find((candidate) => candidate.type === vector.type);
    const result =
      definition === undefined
        ? undefined
        : library.validateEvent(definition as never, definition.examples[vector.example]);
    results.push({ name: vector.name, ok: result?.ok ?? false });
    if (result?.ok !== true) failures.push(`${vector.name}: the catalogue example did not validate`);
  }
  return { results, failures };
};
