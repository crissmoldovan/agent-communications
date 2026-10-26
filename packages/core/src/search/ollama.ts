import { request } from 'node:http';
import { CommsError } from '../errors.ts';
import { type SearchEndpoint, searchEndpoint } from './endpoint-rule.ts';
import { isCloudModelName, type SearchModelProfile, searchModelProfile } from './models.ts';

/**
 * The one way Search talks to anything (design 2026-10-26-local-search, S9): the person's Ollama, on this machine.
 *
 * - **Where:** the address `searchEndpoint` accepted — a literal `127.0.0.1` or `::1` and its port — called with
 *   `node:http` and `agent: false`, by that address and port. Nothing reads `HTTP_PROXY`, and no name is looked up, so
 *   no proxy or resolver can carry the words elsewhere.
 * - **Which model:** one on the reviewed list (`models.ts`), and only once `/api/tags` lists it as a local model: an
 *   entry with `remote_model` or `remote_host`, or a name ending in `cloud`, is refused, before any message is sent.
 *   The model's digest is what a vector set is made with: a new one starts a new set (`indexer.ts`).
 * - **Nothing is downloaded.** A model the server does not have is `missing`, and the person is shown
 *   `ollama pull <model>`.
 */

/** What a check of the model found, in a word a screen can show. */
export type SearchModelState =
  /** Listed, local, on the list: vectors can be made. */
  | 'running'
  /** The server answers and does not have it: `ollama pull` it. */
  | 'missing'
  /** Listed as one Ollama runs elsewhere — `remote_model`, `remote_host`, or a `…cloud` name. Never used. */
  | 'remote-refused'
  /** Nothing answered at the address. */
  | 'unreachable'
  /** The server answered with something that is not Ollama's API. */
  | 'unexpected';

export interface SearchModelCheck {
  readonly state: SearchModelState;
  /** The model's digest, when it is listed locally. */
  readonly digest?: string | undefined;
  /** One sentence about it. */
  readonly detail: string;
}

/** One HTTP exchange with the server: what `OllamaClient` sends, for a test to stand in for — still on loopback. */
export type LoopbackExchange = (
  endpoint: SearchEndpoint,
  call: { method: 'GET' | 'POST'; path: '/api/tags' | '/api/embed'; body?: string },
  timeoutMs: number,
) => Promise<{ status: number; body: string }>;

/** The most an answer may hold: 32 vectors of 1024 numbers, written out, fit many times over. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** `node:http` to the literal address, no agent, no proxy, bounded in time and size. */
export const loopbackExchange: LoopbackExchange = (endpoint, call, timeoutMs) =>
  new Promise((resolve, reject) => {
    // Checked again here: whatever built the endpoint, a connection goes nowhere but these two addresses.
    const checked = searchEndpoint(endpoint.address);
    if (checked.host !== endpoint.host || checked.port !== endpoint.port) {
      reject(new CommsError('USAGE', 'the local model server address does not match its parts'));
      return;
    }
    const body = call.body === undefined ? undefined : Buffer.from(call.body, 'utf8');
    const outgoing = request(
      {
        host: checked.host,
        family: checked.host === '::1' ? 6 : 4,
        port: checked.port,
        path: call.path,
        method: call.method,
        agent: false,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': body.byteLength }),
        },
        timeout: timeoutMs,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_ANSWER_BYTES) {
            incoming.destroy(new Error('the local model server sent more than an answer can hold'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () =>
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('the local model server did not answer in time')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });

interface TagEntry {
  readonly name?: unknown;
  readonly model?: unknown;
  readonly digest?: unknown;
  readonly remote_model?: unknown;
  readonly remote_host?: unknown;
}

function entriesOf(body: string): TagEntry[] | null {
  try {
    const parsed = JSON.parse(body) as { models?: unknown };
    return Array.isArray(parsed.models)
      ? parsed.models.filter((entry): entry is TagEntry => typeof entry === 'object' && entry !== null)
      : null;
  } catch {
    return null;
  }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && value !== false;
}

/** A client of one Ollama on this machine, for one model of the reviewed list. */
export class OllamaClient {
  readonly endpoint: SearchEndpoint;
  readonly profile: SearchModelProfile;
  readonly #exchange: LoopbackExchange;
  readonly #timeoutMs: number;

  constructor(
    address: string,
    model: string,
    options: { exchange?: LoopbackExchange | undefined; timeoutMs?: number | undefined } = {},
  ) {
    this.endpoint = searchEndpoint(address);
    const profile = searchModelProfile(model);
    if (profile === undefined) {
      throw new CommsError('USAGE', `"${String(model).slice(0, 60)}" is not a model Search may use`, {
        hint: 'Search uses one of: qwen3-embedding:0.6b, embeddinggemma, bge-m3 — run on this machine by Ollama.',
      });
    }
    this.profile = profile;
    this.#exchange = options.exchange ?? loopbackExchange;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  /**
   * Whether the model can be used now: the server answers, lists it, and lists it as local. Never throws: what it
   * found is the state, and a state other than `running` means search is by words only.
   */
  async check(): Promise<SearchModelCheck> {
    const name = this.profile.name;
    if (isCloudModelName(name)) {
      return { state: 'remote-refused', detail: `${name} is run by Ollama elsewhere, so it is never used` };
    }
    let answer: { status: number; body: string };
    try {
      answer = await this.#exchange(this.endpoint, { method: 'GET', path: '/api/tags' }, 3_000);
    } catch {
      return { state: 'unreachable', detail: `nothing answered at ${this.endpoint.address}` };
    }
    const entries = answer.status === 200 ? entriesOf(answer.body) : null;
    if (entries === null) {
      return {
        state: 'unexpected',
        detail: `${this.endpoint.address} answered, but not as Ollama does (status ${answer.status})`,
      };
    }
    const wanted = new Set([name, ...this.profile.aliases]);
    const listed = entries.filter(
      (entry) =>
        (typeof entry.name === 'string' && wanted.has(entry.name)) ||
        (typeof entry.model === 'string' && wanted.has(entry.model)),
    );
    if (listed.length === 0) {
      return { state: 'missing', detail: `${this.endpoint.address} does not have ${name}: ollama pull ${name}` };
    }
    if (
      listed.some(
        (entry) =>
          present(entry.remote_model) ||
          present(entry.remote_host) ||
          (typeof entry.name === 'string' && isCloudModelName(entry.name)) ||
          (typeof entry.model === 'string' && isCloudModelName(entry.model)),
      )
    ) {
      return {
        state: 'remote-refused',
        detail: `${name} is listed as a model Ollama runs elsewhere, so no message is sent to it`,
      };
    }
    const digest = listed.find((entry) => typeof entry.digest === 'string' && entry.digest !== '')?.digest;
    if (typeof digest !== 'string' || !/^[A-Za-z0-9:]{1,200}$/.test(digest)) {
      return {
        state: 'unexpected',
        detail: `${name} is listed with no digest, so its vectors could not be kept apart`,
      };
    }
    return { state: 'running', digest, detail: `${name} is running on this machine` };
  }

  /**
   * Vectors for `inputs`, one each, in order, normalised to length 1. Throws — as UNAVAILABLE — on anything but that:
   * a count or a size that is not the profile's, a number that is not finite. Call `check` first: this sends the words.
   */
  async embed(inputs: readonly string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    const body = JSON.stringify({
      model: this.profile.name,
      input: inputs,
      truncate: true,
      keep_alive: '10m',
      ...(this.profile.asksDimensions ? { dimensions: this.profile.dimensions } : {}),
    });
    let answer: { status: number; body: string };
    try {
      answer = await this.#exchange(this.endpoint, { method: 'POST', path: '/api/embed', body }, this.#timeoutMs);
    } catch (error) {
      throw new CommsError('PROVIDER_UNAVAILABLE', 'the local model server could not make vectors', { cause: error });
    }
    if (answer.status !== 200) {
      throw new CommsError('PROVIDER_UNAVAILABLE', `the local model server answered ${answer.status} to /api/embed`);
    }
    let embeddings: unknown;
    try {
      embeddings = (JSON.parse(answer.body) as { embeddings?: unknown }).embeddings;
    } catch {
      embeddings = undefined;
    }
    if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
      throw new CommsError('PROVIDER_UNAVAILABLE', 'the local model server did not send one vector for each message');
    }
    return embeddings.map((raw) => normalised(raw, this.profile.dimensions));
  }
}

/** A vector as a list of `dimensions` finite numbers, cut to that size and scaled to length 1. */
export function normalised(raw: unknown, dimensions: number): Float32Array {
  if (!Array.isArray(raw) || raw.length < dimensions) {
    throw new CommsError('PROVIDER_UNAVAILABLE', `the local model server sent a vector that is not ${dimensions} long`);
  }
  const vector = new Float32Array(dimensions);
  let sum = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = raw[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CommsError('PROVIDER_UNAVAILABLE', 'the local model server sent a vector that is not numbers');
    }
    vector[index] = value;
    sum += value * value;
  }
  const length = Math.sqrt(sum);
  if (length === 0) throw new CommsError('PROVIDER_UNAVAILABLE', 'the local model server sent an empty vector');
  for (let index = 0; index < dimensions; index += 1) vector[index] = (vector[index] ?? 0) / length;
  return vector;
}
