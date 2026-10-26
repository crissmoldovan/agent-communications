import type tls from 'node:tls';
import { connectPinnedTcp } from '../../src/network/pinned-connection.ts';
import { AnalyseTransport } from '../../src/runtime/analyse-transport.ts';
import { startLoopbackReceiver } from './loopback-receiver.ts';

/**
 * A loopback fake of OpenRouter's chat completions and Anthropic's Messages API (0.33.0 design §3.3), for Analyse's
 * tests: no real provider is called and every key is fake. The transport under test runs its whole path — the pinned
 * global-only resolution (a resolver that answers one public address), the request bytes, the bounded HTTP read —
 * and only the socket is redirected to this receiver on 127.0.0.1, with TLS left out.
 */

export interface FakeModelRequest {
  /** The exact bytes the transport wrote, as text. */
  readonly raw: string;
  readonly requestLine: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Record<string, unknown>;
}

export type FakeModelHandler = (request: FakeModelRequest, index: number) => string | Buffer;

export interface FakeModelProvider {
  readonly requests: FakeModelRequest[];
  /** The hostnames the transport resolved: the provider's fixed one, every time. */
  readonly resolved: string[];
  respond(handler: FakeModelHandler): void;
  transport(options?: { readonly deadlineMs?: number }): AnalyseTransport;
  close(): Promise<void>;
}

function parseRequest(bytes: Buffer): FakeModelRequest | null {
  const boundary = bytes.indexOf('\r\n\r\n');
  if (boundary === -1) return null;
  const lines = bytes.subarray(0, boundary).toString('latin1').split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  const length = Number(headers.get('content-length') ?? '0');
  const body = bytes.subarray(boundary + 4);
  if (body.byteLength < length) return null;
  return {
    raw: bytes.toString('utf8'),
    requestLine: lines[0] ?? '',
    headers,
    body: JSON.parse(body.subarray(0, length).toString('utf8')) as Record<string, unknown>,
  };
}

/** A whole HTTP response with a Content-Length. */
export function httpResponse(status: number, body: string, extraHeaders: readonly string[] = []): string {
  return [
    `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Refused'}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...extraHeaders,
    '',
    body,
  ].join('\r\n');
}

/** The same response, its body in chunks of at most `size` bytes. */
export function chunkedResponse(status: number, body: string, size = 7): string {
  const bytes = Buffer.from(body);
  const chunks: string[] = [];
  for (let at = 0; at < bytes.byteLength; at += size) {
    const piece = bytes.subarray(at, at + size);
    chunks.push(`${piece.byteLength.toString(16)}\r\n${piece.toString('latin1')}\r\n`);
  }
  return `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${chunks.join('')}0\r\n\r\n`;
}

/** An OpenRouter chat completion whose message is `content`. */
export function openRouterAnswer(content: string, finishReason = 'stop'): string {
  return JSON.stringify({
    id: 'gen-fake',
    object: 'chat.completion',
    created: 1,
    model: 'anthropic/claude-sonnet-5.5',
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/** An Anthropic message: a thinking block, which Analyse passes over, then `text`. */
export function anthropicAnswer(text: string, stopReason = 'end_turn'): string {
  return JSON.stringify({
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'fake-signature' },
      { type: 'text', text },
    ],
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

/** A model's answer as Analyse asks for it: `{ after, why }`. */
export function suggestion(after: string, why = 'It names who asks for what.'): string {
  return JSON.stringify({ after, why });
}

export async function startFakeModelProvider(): Promise<FakeModelProvider> {
  const requests: FakeModelRequest[] = [];
  const resolved: string[] = [];
  let handler: FakeModelHandler = () => httpResponse(500, '{}');
  const receiver = await startLoopbackReceiver((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const request = parseRequest(bytes);
      if (request === null) return;
      requests.push(request);
      socket.end(handler(request, requests.length - 1));
    });
  });
  return {
    requests,
    resolved,
    respond(next) {
      handler = next;
    },
    transport(options = {}) {
      return new AnalyseTransport({
        resolver: {
          async lookup(hostname: string) {
            resolved.push(hostname);
            return ['8.8.8.8'];
          },
        },
        // The pinned address is the provider's; only the socket is pointed at this loopback receiver.
        tcpConnect: (pinned) =>
          connectPinnedTcp({
            host: receiver.host,
            port: receiver.port,
            ...(pinned.signal === undefined ? {} : { signal: pinned.signal }),
          }),
        tlsConnect: async ({ socket }) => socket as unknown as tls.TLSSocket,
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      });
    },
    close: () => receiver.close(),
  };
}
