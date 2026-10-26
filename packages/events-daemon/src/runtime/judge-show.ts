import { CommsError, canonicalJson, sha256Hex } from '@agentcomms/core';
import { type CanonicalJudgeDocument, canonicalJudge } from '../domain/judges.ts';
import type { EventDatabase } from '../store/database.ts';

/**
 * `judge show <judgeId> [--version <n>]` (0.33.0): one judge version's exact canonical document, so the app's rule
 * editor can embed it in a rule as the event service will approve it, and its digest and state.
 *
 * A judge document is configuration and nothing else: its kind, provider, model, endpoint (a hosted judge's fixed URL,
 * or a local server's loopback address), prompt template and protocol. No key is part of it — a hosted judge's key is
 * a separate secret generation, in the secret store — so nothing secret can be in what this returns. It reads only
 * `judge_versions`, checks each document against its stored digest, and writes nothing. CLI and MCP alike, as
 * `judges list` is.
 */

export type JudgeShowState = 'live' | 'revoked';

export interface JudgeShowResultV1 {
  readonly judgeId: string;
  readonly version: number;
  readonly document: CanonicalJudgeDocument;
  readonly digest: string;
  /** `revoked` once the judge was removed: a rule can no longer be made active with it. */
  readonly state: JudgeShowState;
}

const JUDGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function usage(message: string): never {
  throw new CommsError('USAGE', message);
}

/** `judge show`'s arguments, read strictly: a judge id and, when given, a positive version. */
export function parseJudgeShowArguments(args: Readonly<Record<string, unknown>>): {
  readonly judgeId: string;
  readonly version: number | undefined;
} {
  for (const key of Object.keys(args))
    if (key !== 'judgeId' && key !== 'version') usage(`judge show takes no ${key.slice(0, 40)}`);
  const { judgeId, version } = args;
  if (typeof judgeId !== 'string' || !JUDGE_ID.test(judgeId))
    usage('a judge id is a word of letters, digits and . _ : -');
  if (version !== undefined && (!Number.isSafeInteger(version) || (version as number) < 1))
    usage('a judge version is a positive whole number');
  return { judgeId, version: version as number | undefined };
}

interface JudgeVersionRow {
  readonly version: number;
  readonly document: string;
  readonly digest: string;
  readonly revoked_at: number | null;
}

export class JudgeReader {
  readonly #store: EventDatabase;

  constructor(input: { readonly store: EventDatabase }) {
    this.#store = input.store;
  }

  /** The version asked for, or else the newest live one, or else the newest; not found when the judge has none. */
  show(args: Readonly<Record<string, unknown>>): JudgeShowResultV1 {
    const { judgeId, version } = parseJudgeShowArguments(args);
    const rows = this.#store.database
      .prepare(
        'SELECT version, document, digest, revoked_at FROM judge_versions WHERE judge_id = ? ORDER BY version DESC',
      )
      .all(judgeId) as unknown as JudgeVersionRow[];
    const row =
      version === undefined
        ? (rows.find((candidate) => candidate.revoked_at === null) ?? rows[0])
        : rows.find((candidate) => candidate.version === version);
    if (row === undefined)
      throw new CommsError(
        'NOT_FOUND',
        version === undefined ? 'the requested judge does not exist' : 'the requested judge version does not exist',
        { hint: 'judges list gives every judge version, by id and version.' },
      );
    let document: CanonicalJudgeDocument;
    try {
      const parsed = JSON.parse(row.document) as unknown;
      if (sha256Hex(canonicalJson(parsed as never)) !== row.digest) throw new Error('digest drift');
      document = canonicalJudge(parsed);
      // The stored document is already canonical: what is returned is exactly what was approved, byte for byte.
      if (canonicalJson(document as never) !== canonicalJson(parsed as never)) throw new Error('not canonical');
    } catch {
      throw new CommsError('CONFIG', 'the stored judge version cannot be read as its approved document');
    }
    return {
      judgeId,
      version: row.version,
      document,
      digest: row.digest,
      state: row.revoked_at === null ? 'live' : 'revoked',
    };
  }
}
