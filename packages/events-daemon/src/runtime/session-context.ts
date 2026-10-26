import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import {
  CONTEXT_LIMITS,
  type ContextGenerate,
  type ContextPart,
  type FileFailure,
  type GenerateFailure,
  type JsonValue,
  type ResolvedContextPart,
} from '@agentcomms/events';
import { isInside } from './agent-sessions.ts';

/**
 * The I/O half of a target's context (0.33.0 design §3.6), at dispatch: a file part is read, under a folder it may be
 * read from, and a generate part asks a model. Each failure leaves a note in the part's place, from a closed set, so
 * no error text reaches a prompt. The fixed frame itself is `@agentcomms/events`' `buildSessionPrompt`.
 */

/** What a generate part's model call is given: the part, and the mapped values it reads, by pointer. */
export interface GenerateCall {
  readonly part: ContextGenerate;
  readonly values: Readonly<Record<string, JsonValue>>;
}

export type GenerateOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: GenerateFailure };

/** A generate part's model call; the owner composes OpenRouter's, tests a fake. It never throws. */
export type ContextGenerator = (call: GenerateCall) => Promise<GenerateOutcome>;

/**
 * Reads a file part's file: its realpath must lie under one of `roots`' realpaths — so a link that leaves the folder is
 * refused — it must be a regular file of at most 64 KB, and its text UTF-8.
 */
export async function readContextFile(
  path: string,
  roots: readonly string[],
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: FileFailure }> {
  if (!roots.some((root) => isInside(path, root))) return { ok: false, reason: 'outside' };
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // A root that is not there allows nothing.
    }
  }
  if (!realRoots.some((root) => isInside(real, root))) return { ok: false, reason: 'outside' };
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // The realpath has no link left in it; O_NOFOLLOW refuses one that appeared since.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'not-a-file' };
    if (info.size > CONTEXT_LIMITS.fileBytes) return { ok: false, reason: 'too-large' };
    const buffer = Buffer.alloc(CONTEXT_LIMITS.fileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CONTEXT_LIMITS.fileBytes) return { ok: false, reason: 'too-large' };
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)) };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    await handle.close();
  }
}

/** Resolves each part in order: its text, its mapped values, its model's words, its file — or the note for each. */
export async function resolveContextParts(input: {
  readonly parts: readonly ContextPart[];
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly fileRoots: readonly string[];
  readonly generate: ContextGenerator;
}): Promise<readonly ResolvedContextPart[]> {
  const resolved: ResolvedContextPart[] = [];
  for (const part of input.parts) {
    if ('text' in part) resolved.push({ kind: 'text', text: part.text });
    else if ('fields' in part) {
      const values: Record<string, JsonValue> = {};
      for (const pointer of part.fields)
        if (Object.hasOwn(input.values, pointer))
          Object.defineProperty(values, pointer, { value: input.values[pointer], enumerable: true });
      resolved.push({ kind: 'fields', fields: part.fields, values });
    } else if ('generate' in part) {
      const values: Record<string, JsonValue> = {};
      for (const pointer of part.generate.from)
        if (Object.hasOwn(input.values, pointer))
          Object.defineProperty(values, pointer, { value: input.values[pointer], enumerable: true });
      let outcome: GenerateOutcome;
      try {
        outcome = await input.generate({ part: part.generate, values });
      } catch {
        outcome = { ok: false, reason: 'failed' };
      }
      resolved.push(
        outcome.ok
          ? { kind: 'generated', provider: part.generate.provider, model: part.generate.model, text: outcome.text }
          : {
              kind: 'generate-failed',
              provider: part.generate.provider,
              model: part.generate.model,
              reason: outcome.reason,
            },
      );
    } else {
      const file = await readContextFile(part.file, input.fileRoots);
      resolved.push(
        file.ok
          ? { kind: 'file', path: part.file, text: file.text }
          : { kind: 'file-missing', path: part.file, reason: file.reason },
      );
    }
  }
  return resolved;
}
