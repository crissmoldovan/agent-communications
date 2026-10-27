import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

/** How long a file part's read may take before it is left out: a file is local and at most 64 KB. */
export const CONTEXT_FILE_READ_MS = 2_000;

async function realpaths(folders: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const folder of folders) {
    try {
      found.push(await realpath(folder));
    } catch {
      // A folder that is not there allows, or denies, nothing.
    }
  }
  return found;
}

function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'late'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('late'), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Reads a file part's file (0.33.0 design §3.6), as the person, refusing anything that is not plainly one of their files
 * inside a folder it may be read from (security review of 0.33.0, finding 4):
 * - its path and its realpath lie under one of `roots` — so a symbolic link out of the folder is refused — and under
 *   none of `denied`, Agent Comms' own configuration, state and data folders;
 * - it is opened without following a link and without blocking, so a FIFO or a device never stalls the service;
 * - on the open handle it is a regular file that this user owns, with exactly one link — a hard link could name a file
 *   anywhere — and the same device and inode as the realpath it was found by;
 * - it is at most 64 KB, read within `CONTEXT_FILE_READ_MS`, and its text UTF-8.
 */
export async function readContextFile(
  path: string,
  roots: readonly string[],
  denied: readonly string[] = [],
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: FileFailure }> {
  if (!roots.some((root) => isInside(path, root))) return { ok: false, reason: 'outside' };
  if (denied.some((folder) => isInside(path, folder))) return { ok: false, reason: 'outside' };
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!(await realpaths(roots)).some((root) => isInside(real, root))) return { ok: false, reason: 'outside' };
  if ((await realpaths(denied)).some((folder) => isInside(real, folder))) return { ok: false, reason: 'outside' };
  let found: Awaited<ReturnType<typeof lstat>>;
  try {
    found = await lstat(real);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!found.isFile()) return { ok: false, reason: 'not-a-file' };
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: 'not-a-file' };
    // The file opened is the one found, and nothing else names it.
    if (info.dev !== found.dev || info.ino !== found.ino) return { ok: false, reason: 'unreadable' };
    if (info.nlink !== 1) return { ok: false, reason: 'outside' };
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return { ok: false, reason: 'unreadable' };
    if (info.size > CONTEXT_LIMITS.fileBytes) return { ok: false, reason: 'too-large' };
    const buffer = Buffer.alloc(CONTEXT_LIMITS.fileBytes + 1);
    const read = await withinDeadline(handle.read(buffer, 0, buffer.length, 0), CONTEXT_FILE_READ_MS);
    if (read === 'late') return { ok: false, reason: 'unreadable' };
    if (read.bytesRead > CONTEXT_LIMITS.fileBytes) return { ok: false, reason: 'too-large' };
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read.bytesRead)) };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Whether a file part read earlier may still be sent: its folder is still under one of `roots` and under none of
 * `denied`, as its path and as its realpath — a file since gone is judged by its folder's (security review of 0.33.0,
 * second look, 2). Its text is not read again.
 */
export async function fileStillAllowed(
  path: string,
  roots: readonly string[],
  denied: readonly string[] = [],
): Promise<boolean> {
  if (!roots.some((root) => isInside(path, root))) return false;
  if (denied.some((folder) => isInside(path, folder))) return false;
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    try {
      real = join(await realpath(dirname(path)), basename(path));
    } catch {
      return false;
    }
  }
  if (!(await realpaths(roots)).some((root) => isInside(real, root))) return false;
  return !(await realpaths(denied)).some((folder) => isInside(real, folder));
}

/** Resolves each part in order: its text, its mapped values, its model's words, its file — or the note for each. */
export async function resolveContextParts(input: {
  readonly parts: readonly ContextPart[];
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly fileRoots: readonly string[];
  /** Agent Comms' own configuration, state and data folders: never read, whatever the roots. */
  readonly deniedFolders?: readonly string[] | undefined;
  readonly generate: ContextGenerator;
  /**
   * A workflow run's settled step outputs, for a `{ step, field }` part (workflows design §6.4): the closed value, or
   * undefined when the step has none of that name. Only a flow has steps, so outside one there is nothing to read.
   */
  readonly stepOutput?: ((step: string, field: string) => JsonValue | undefined) | undefined;
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
    } else if ('step' in part) {
      const value = input.stepOutput?.(part.step, part.field);
      resolved.push({ kind: 'step', step: part.step, field: part.field, ...(value === undefined ? {} : { value }) });
    } else {
      const file = await readContextFile(part.file, input.fileRoots, input.deniedFolders ?? []);
      resolved.push(
        file.ok
          ? { kind: 'file', path: part.file, text: file.text }
          : { kind: 'file-missing', path: part.file, reason: file.reason },
      );
    }
  }
  return resolved;
}
