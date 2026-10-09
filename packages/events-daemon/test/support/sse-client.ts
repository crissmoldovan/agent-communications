import { request } from 'node:http';

export interface SseHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A loopback-only raw client for the listener contract; callers provide the literal persisted port. */
export async function requestSse(input: {
  readonly port: number;
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
}): Promise<SseHttpResponse> {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        host: '127.0.0.1',
        port: input.port,
        method: input.method ?? 'GET',
        path: input.path ?? '/v1/streams/subscriber-listener',
        headers: input.headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    client.once('error', reject);
    client.end();
  });
}
