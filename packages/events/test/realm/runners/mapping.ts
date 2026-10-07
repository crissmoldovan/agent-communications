import type { Runner } from './types.ts';

interface MappingVector {
  readonly name: string;
  readonly type: string;
  readonly example: number;
  readonly template: unknown;
  readonly data?: unknown;
  readonly compileCode?: string;
  readonly evaluationCode?: string;
  readonly representation?: 'plain' | 'enveloped';
}

export const mappingRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly MappingVector[]) {
    const definition = library.CATALOGUE.find((candidate) => candidate.type === vector.type);
    const compiled =
      definition === undefined ? undefined : library.compileMapping(definition as never, vector.template);
    if (definition === undefined || compiled === undefined) {
      failures.push(`${vector.name}: definition is unavailable`);
      continue;
    }
    if (!compiled.ok) {
      if (compiled.issues[0]?.code !== vector.compileCode)
        failures.push(`${vector.name}: mapping compile result differs`);
      continue;
    }
    if (vector.compileCode !== undefined) {
      failures.push(`${vector.name}: mapping compiled`);
      continue;
    }
    const example = definition.examples[vector.example];
    if (example === undefined) {
      failures.push(`${vector.name}: example is unavailable`);
      continue;
    }
    let data: unknown;
    try {
      const mapped = library.evaluateMapping(compiled.value, example);
      const classified = library.classifyMapped(definition as never, example, mapped);
      data =
        vector.representation === 'enveloped'
          ? library.applyRepresentation(mapped.data, classified, {
              kind: 'enveloped',
              envelope: (text: string, pointer: string) => `<test pointer="${pointer}">${text}</test>`,
            })
          : mapped.data;
    } catch (error) {
      if (
        error instanceof library.EventsError &&
        vector.evaluationCode !== undefined &&
        error.code === vector.evaluationCode
      )
        continue;
      failures.push(`${vector.name}: evaluation failed`);
      continue;
    }
    if (vector.evaluationCode !== undefined) {
      failures.push(`${vector.name}: mapping evaluated`);
      continue;
    }
    results.push({ name: vector.name, data });
    if (JSON.stringify(data) !== JSON.stringify(vector.data)) failures.push(`${vector.name}: data differs`);
  }
  return { results, failures };
};
