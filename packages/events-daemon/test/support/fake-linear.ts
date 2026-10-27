import http from 'node:http';
import net from 'node:net';
import type tls from 'node:tls';
import type { LinearClientOptions } from '../../src/runtime/linear-client.ts';

/*
 * A loopback fake of Linear's GraphQL API, for the Linear target's tests (0.33.0 design §3.4). It answers the few
 * operations the event service sends — the workspace, a team's labels and states, an issue lookup and `issueCreate` — on
 * 127.0.0.1, and records each request. The client reaches it through its own seams: the resolver gives a global
 * address (never contacted), the TCP connect goes to the fake's port instead, and TLS is the plain socket, so the client
 * still prepares exactly `https://api.linear.app/graphql` with its pinned, global-only checks. Never the real Linear,
 * and every key a test gives is fake.
 */

export interface FakeLinearRequest {
  readonly operation: string;
  readonly authorization: string | undefined;
  readonly host: string | undefined;
  readonly variables: Record<string, unknown>;
}

export interface FakeLinearIssue {
  readonly id: string;
  readonly identifier: string;
  readonly url: string;
  readonly input: Record<string, unknown>;
}

/** A scripted answer: an HTTP status and a JSON body, or a dropped connection after the request was handled. */
export type FakeLinearScript =
  | { readonly status: number; readonly body: unknown }
  | { readonly drop: true; readonly after?: 'handled' | 'unhandled' };

export interface FakeLinear {
  readonly requests: FakeLinearRequest[];
  readonly issues: FakeLinearIssue[];
  /** Hosts the client resolved, TCP peers it asked for, and the names it verified TLS as. */
  readonly lookups: string[];
  readonly peers: string[];
  readonly tlsNames: string[];
  /** The next answers to `operation`, in order, before the fake answers as Linear would. */
  script(operation: string, ...answers: FakeLinearScript[]): void;
  clientOptions(): LinearClientOptions;
  close(): Promise<void>;
}

export const FAKE_LINEAR_KEY = 'fake-linear-key';
export const FAKE_VIEWER_ID = '5f0c3e2a-1b2c-4d3e-8f4a-5b6c7d8e9f00';
export const FAKE_TEAM = { id: '0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11', key: 'CUE', name: 'Example Team' } as const;
export const FAKE_LABELS = [
  { id: '3e1f8a52-7c1d-4a8e-9f00-2b6c1d4e5f60', name: 'Billing' },
  { id: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', name: 'Urgent' },
] as const;

/** The fake team's workflow states, as Linear's `team.states` gives them (workflows design §4.2). */
export const FAKE_STATES = [
  { id: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'In Progress', type: 'started' },
  { id: '8e2d3c4b-5f6a-4b7c-9d8e-0f1a2b3c4d5e', name: 'Done', type: 'completed' },
  { id: '9f3e4d5c-6a7b-4c8d-8e9f-1a2b3c4d5e6f', name: 'Canceled', type: 'canceled' },
] as const;

function operationOf(query: unknown): string {
  return typeof query === 'string' ? (/^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/u.exec(query)?.[1] ?? '') : '';
}

export async function startFakeLinear(): Promise<FakeLinear> {
  const requests: FakeLinearRequest[] = [];
  const issues: FakeLinearIssue[] = [];
  const scripts = new Map<string, FakeLinearScript[]>();
  const lookups: string[] = [];
  const peers: string[] = [];
  const tlsNames: string[] = [];

  const answer = (operation: string, variables: Record<string, unknown>): { status: number; body: unknown } => {
    switch (operation) {
      case 'AgentCommsLinearWorkspace':
        return {
          status: 200,
          body: {
            data: {
              viewer: { organization: { name: 'Example Workspace' } },
              teams: { nodes: [FAKE_TEAM, { id: 'not-a-uuid', key: 'BAD', name: 'dropped' }] },
            },
          },
        };
      case 'AgentCommsLinearLabels':
        return {
          status: 200,
          body: {
            data: {
              team: variables.team === FAKE_TEAM.id ? { labels: { nodes: [FAKE_LABELS[0]] } } : null,
              issueLabels: { nodes: [FAKE_LABELS[1], FAKE_LABELS[0]] },
            },
          },
        };
      case 'AgentCommsLinearStates':
        return {
          status: 200,
          body: {
            data: {
              team: variables.team === FAKE_TEAM.id ? { states: { nodes: [...FAKE_STATES] } } : null,
            },
          },
        };
      case 'AgentCommsLinearIssueLookup': {
        const found = issues.filter((issue) => issue.id === variables.id);
        return {
          status: 200,
          body: {
            data: {
              viewer: { id: FAKE_VIEWER_ID },
              issues: { nodes: found.map(({ id, identifier, url }) => ({ id, identifier, url })) },
            },
          },
        };
      }
      case 'AgentCommsLinearIssueCreate': {
        const input = variables.input as Record<string, unknown>;
        if (issues.some((issue) => issue.id === input.id))
          return {
            status: 400,
            body: { errors: [{ message: 'Entity already exists', extensions: { code: 'INVALID_INPUT' } }] },
          };
        const identifier = `${FAKE_TEAM.key}-${issues.length + 1}`;
        const issue = {
          id: input.id as string,
          identifier,
          // Linear's address ends with the title's words; the event service keeps it without them.
          url: `https://linear.app/example/issue/${identifier}/${String(input.title)
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/gu, '-')}`,
          input,
        };
        issues.push(issue);
        return {
          status: 200,
          body: {
            data: { issueCreate: { success: true, issue: { id: issue.id, identifier, url: issue.url } } },
          },
        };
      }
      default:
        return {
          status: 400,
          body: { errors: [{ message: 'unknown', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
        };
    }
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let parsed: { query?: unknown; variables?: Record<string, unknown> } = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // An unreadable body is answered as Linear would, below.
      }
      const operation = operationOf(parsed.query);
      const variables = parsed.variables ?? {};
      requests.push({ operation, authorization: request.headers.authorization, host: request.headers.host, variables });
      if (
        request.method !== 'POST' ||
        request.url !== '/graphql' ||
        request.headers.authorization !== FAKE_LINEAR_KEY
      ) {
        response.writeHead(request.headers.authorization === FAKE_LINEAR_KEY ? 404 : 401, {
          'Content-Type': 'application/json',
        });
        response.end(
          JSON.stringify({
            errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }],
          }),
        );
        return;
      }
      const scripted = scripts.get(operation)?.shift();
      if (scripted !== undefined && 'drop' in scripted) {
        if (scripted.after === 'handled') answer(operation, variables);
        request.socket.destroy();
        return;
      }
      const { status, body } = scripted ?? answer(operation, variables);
      // Chunked, as a real server may answer; the client reads either.
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    requests,
    issues,
    lookups,
    peers,
    tlsNames,
    script(operation, ...answers) {
      scripts.set(operation, [...(scripts.get(operation) ?? []), ...answers]);
    },
    clientOptions() {
      return {
        resolver: {
          async lookup(hostname: string) {
            lookups.push(hostname);
            return ['8.8.8.8'];
          },
        },
        tcpConnect: (options) =>
          new Promise<net.Socket>((resolve, reject) => {
            peers.push(`${options.host}:${options.port}`);
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
          }),
        tlsConnect: async (options) => {
          tlsNames.push(`${options.servername ?? ''}/${options.certificateHost}`);
          return options.socket as unknown as tls.TLSSocket;
        },
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
