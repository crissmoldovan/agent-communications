/**
 * Where Search may send a message's words to be made searchable by meaning (design 2026-10-26-local-search, S9): a model
 * server on this machine, and nowhere else.
 *
 * The rule is the event service's for a judge of kind local-endpoint (`localSetupEndpoint` in
 * `events-daemon/src/domain/judge-setup.ts`), copied here because core cannot depend on the event service, and pinned by
 * the same test vectors (`test/fixtures/search-endpoint-vectors.json`): plain HTTP, to the literal address `127.0.0.1`
 * or `[::1]`, with its port written out, and nothing else in the URL. A host name — `localhost` included — is refused,
 * since a name is looked up and a lookup can answer anything. Ollama's API sits at the server's root, so the only path
 * taken is `/`.
 *
 * Read as typed, before any URL parser can tidy it: `http://127.1:11434` and `http://[0:0:0:0:0:0:0:1]:11434` are the
 * same addresses to a parser, and refused here, so what is stored and shown is exactly what is called.
 *
 * Imports only the error registry: the settings reader, which `config.ts` imports, uses it.
 */

import { CommsError } from '../errors.ts';

export interface SearchEndpoint {
  /** The server's root as stored and shown: `http://127.0.0.1:11434` or `http://[::1]:11434`. */
  readonly address: string;
  /** The literal address a connection is made to — never a name. */
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})\/?$/;

/**
 * `value` as a local model server's address, or a refusal: `http://127.0.0.1:<port>` or `http://[::1]:<port>`, with
 * at most a trailing `/`. Anything else — https, a host name, another address, no port, a path, a query, a user, a
 * fragment — is refused before anything is called.
 */
export function searchEndpoint(value: unknown): SearchEndpoint {
  const refuse = (why: string): never => {
    throw new CommsError(
      'USAGE',
      `the local model server's URL ${why}; give http://127.0.0.1:<port> or http://[::1]:<port>`,
    );
  };
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return refuse('is required');
  if (!value.startsWith('http://')) return refuse('must be plain http, on this machine');
  if (/[@?#]/.test(value)) return refuse('has a user, a query or a fragment');
  const match = LOOPBACK.exec(value);
  if (match === null) {
    const rest = value.slice('http://'.length);
    if (/^(127\.0\.0\.1|\[::1\])\/?$/.test(rest)) return refuse('needs its port');
    if (/^(127\.0\.0\.1|\[::1\]):[0-9]{1,5}\//.test(rest)) return refuse('has a path; Ollama is called at its root');
    return refuse('must be on this machine: 127.0.0.1 or ::1, written as an address, not a name');
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== match[2]) {
    return refuse('needs a port from 1 to 65535');
  }
  const host = match[1] === '[::1]' ? '::1' : '127.0.0.1';
  return { address: `http://${host === '::1' ? '[::1]' : host}:${port}`, host, port };
}
