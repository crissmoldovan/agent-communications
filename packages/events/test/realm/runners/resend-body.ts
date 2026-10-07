import type { Runner } from './types.ts';

interface ResendBodyVector {
  readonly name: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly body: string;
  readonly bodyTruncated: boolean;
}

export const resendBodyRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  for (const vector of file.vectors as readonly ResendBodyVector[]) {
    const result = library.normaliseResendBody({ text: vector.text, truncated: vector.truncated });
    results.push({ name: vector.name, ...result });
    if (result.body !== vector.body || result.bodyTruncated !== vector.bodyTruncated)
      failures.push(`${vector.name}: normalisation differs`);
  }
  return { results, failures };
};
