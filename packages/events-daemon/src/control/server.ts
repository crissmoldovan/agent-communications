import { createServer, type Server, type Socket } from 'node:net';
import { isCommsError } from '@agentcomms/core';
import {
  CONTROL_PROTOCOL_VERSIONS,
  type ControlError,
  ControlFrameReader,
  type ControlRequest,
  controlFailure,
  encodeControlFrame,
  isControlHello,
  isControlRequest,
  negotiateVersion,
} from './protocol.ts';
import { ControlSessions, matchesControlToken } from './session.ts';

export interface ControlServerOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly handle: (request: ControlRequest) => Promise<unknown>;
  /**
   * Re-proves, for every accepted connection, that only this user can reach the endpoint (B1-G): the owner passes the
   * private socket-directory check. A rejection closes the connection before any frame is read.
   */
  readonly verifyEndpoint: () => Promise<void>;
  readonly supportedVersions?: readonly number[];
}

export interface RunningControlServer {
  close(): Promise<void>;
}

export async function startControlServer(options: ControlServerOptions): Promise<RunningControlServer> {
  const sessions = new ControlSessions();
  const sockets = new Set<Socket>();
  const versions = options.supportedVersions ?? CONTROL_PROTOCOL_VERSIONS;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void serve(socket, { ...options, sessions, versions });
  });
  await listen(server, options.endpoint);
  return {
    async close(): Promise<void> {
      sessions.close();
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}

async function serve(
  socket: Socket,
  options: ControlServerOptions & {
    readonly sessions: ControlSessions;
    readonly versions: readonly number[];
  },
): Promise<void> {
  // Frames arriving while the endpoint is re-verified wait in the socket's buffer: no listener reads them yet.
  socket.pause();
  try {
    await options.verifyEndpoint();
  } catch {
    write(socket, controlFailure('AUTH_REQUIRED', 'local control endpoint is not private to this user'));
    socket.end();
    return;
  }

  const frames = new ControlFrameReader();
  let session: ReturnType<ControlSessions['create']> | null = null;
  let ended = false;
  let pending = Promise.resolve();
  socket.resume();
  socket.on('data', (chunk: Buffer) => {
    if (ended) return;
    let messages: unknown[];
    try {
      messages = frames.push(chunk);
    } catch (error) {
      write(
        socket,
        controlFailure('FRAME_TOO_LARGE', error instanceof Error ? error.message : 'invalid local control frame'),
      );
      ended = true;
      socket.end();
      return;
    }
    for (const message of messages) pending = pending.then(() => handleMessage(message));
    void pending.catch(() => {
      if (!ended) {
        write(socket, controlFailure('MALFORMED_FRAME', 'local control request is malformed'));
        ended = true;
        socket.end();
      }
    });
  });

  async function handleMessage(message: unknown): Promise<void> {
    if (ended) return;
    if (!session) {
      if (!isControlHello(message)) {
        write(socket, controlFailure('AUTH_REQUIRED', 'local control hello is required'));
        ended = true;
        socket.end();
        return;
      }
      if (!matchesControlToken(options.token, message.hello.token)) {
        write(socket, controlFailure('AUTH_REQUIRED', 'local control token is not accepted'));
        ended = true;
        socket.end();
        return;
      }
      const negotiated = negotiateVersion(message.hello.supportedVersions, options.versions);
      if (!negotiated.ok) {
        write(socket, controlFailure('PROTOCOL_UNSUPPORTED', 'no local control protocol version overlaps'));
        ended = true;
        socket.end();
        return;
      }
      session = options.sessions.create(negotiated.version);
      write(socket, { ok: true, version: session.version, session: session.id });
      return;
    }
    if (!isControlRequest(message)) {
      write(socket, controlFailure('MALFORMED_FRAME', 'local control request is malformed'));
      ended = true;
      socket.end();
      return;
    }
    const active = options.sessions.get(message.session, message.version);
    if (!active) {
      write(socket, {
        ...controlFailure('AUTH_REQUIRED', 'local control session is required'),
        requestId: message.requestId,
      });
      return;
    }
    if (active.requestIds.has(message.requestId)) {
      write(socket, {
        ...controlFailure('DUPLICATE_REQUEST_ID', 'local control request id was already used'),
        requestId: message.requestId,
      });
      return;
    }
    active.requestIds.add(message.requestId);
    try {
      write(socket, { ok: true, requestId: message.requestId, data: await options.handle(message) });
    } catch (error) {
      write(socket, { ok: false, requestId: message.requestId, error: operationError(error) });
    }
  }
}

/**
 * D12's failure envelope for an operation: the operation's own stable code, message, hint, retryability and details.
 * Anything that is not a CommsError is reported without its text, which could carry internals.
 */
function operationError(error: unknown): ControlError {
  if (isCommsError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: 'UNEXPECTED', message: 'the local event operation failed', retryable: false };
}

function write(socket: Socket, value: unknown): void {
  socket.write(encodeControlFrame(value));
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
