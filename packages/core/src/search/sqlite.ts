import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '../errors.ts';

/**
 * Node's own SQLite, for Search alone (design 2026-10-26-local-search, S6 and §4): loaded only when a person's search
 * command or the indexer needs it — never by a channel's read, which only appends to the inbox (S8) — so a Node without
 * it, or one where it is behind a flag (22.12), runs every other command as before.
 *
 * Full-text search is probed, not inferred from the version (§10): Node 22.14's SQLite (3.47.2) has no FTS5, 22.18's
 * (3.50.2) and 24's do, with a contentless table that can delete (`contentless_delete=1`, SQLite 3.43) and the
 * `unicode61 remove_diacritics 2` tokenizer — so `factura` finds "Factură". Without it, Search says it needs Node 22.18
 * or newer, and nothing is kept.
 *
 * Node prints an ExperimentalWarning the first time the module loads; that one warning is swallowed here, by its text,
 * and only while the import runs, as the event service does.
 */

type SqliteModule = typeof import('node:sqlite');

/** The words Search says when this Node cannot hold its index. */
export const SEARCH_NEEDS_NODE = '22.18';

export const WORDS_TABLE_OPTIONS: string = "content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'";

function needsNewerNode(cause?: unknown): CommsError {
  return new CommsError(
    'CONFIG',
    `Search on this machine needs Node ${SEARCH_NEEDS_NODE} or newer: this Node (${process.versions.node}) has no SQLite with full-text search`,
    {
      hint: `Install a newer Node — the current 22 or 24 release — and run it again. Nothing has been kept.`,
      details: { reason: 'SEARCH_NODE_TOO_OLD', node: process.versions.node, needs: SEARCH_NEEDS_NODE },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

let loaded: Promise<SqliteModule> | null = null;

/** The module, imported once; refused, with what to do, where this Node has none. */
export function loadSearchSqlite(): Promise<SqliteModule> {
  if (!loaded) {
    loaded = (async () => {
      const original = process.emitWarning;
      process.emitWarning = function filtered(this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
        const text = typeof warning === 'string' ? warning : warning.message;
        if (text.includes('SQLite is an experimental feature')) return;
        return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
      } as typeof process.emitWarning;
      try {
        return await import('node:sqlite');
      } catch (error) {
        throw needsNewerNode(error);
      } finally {
        process.emitWarning = original;
      }
    })();
    // A failed load is not remembered: the next call says the same thing again rather than a stale rejection.
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

let probed: Promise<void> | null = null;

/**
 * Whether this Node's SQLite can hold the words index: a contentless FTS5 table that deletes, with the diacritics-
 * folding tokenizer, made, written, matched and deleted from in memory. Refuses with `needsNewerNode` when not.
 */
export function probeSearchSqlite(): Promise<void> {
  if (!probed) {
    probed = (async () => {
      const sqlite = await loadSearchSqlite();
      let db: DatabaseSync | undefined;
      try {
        db = new sqlite.DatabaseSync(':memory:');
        db.exec(`CREATE VIRTUAL TABLE probe USING fts5(subject, text, ${WORDS_TABLE_OPTIONS})`);
        db.prepare('INSERT INTO probe(rowid, subject, text) VALUES (1, ?, ?)').run('Factură', 'am înțeles');
        const found = db.prepare('SELECT rowid FROM probe WHERE probe MATCH ?').all('"factura"');
        db.prepare('DELETE FROM probe WHERE rowid = 1').run();
        if (found.length !== 1) throw new Error('the words index did not fold diacritics');
      } catch (error) {
        throw needsNewerNode(error);
      } finally {
        db?.close();
      }
    })();
    probed.catch(() => {
      probed = null;
    });
  }
  return probed;
}
