import { createServer, type Server, type Socket } from 'node:net';
import { isCommsError } from '@agentcomms/core';
import { installErrorSink } from '../network/error-sink.ts';
import {
  type AuthenticatedControlRequest,
  CONTROL_PROTOCOL_VERSIONS,
  type ControlError,
  ControlFrameReader,
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
  readonly handle: (request: AuthenticatedControlRequest) => Promise<unknown>;
  /**
   * Re-proves, for every accepted connection, that only this user can reach the endpoint (B1-G): the owner passes the
   * private socket-directory check. A rejection closes the connection before any frame is read.
   */
  readonly verifyEndpoint: () => Promise<void>;
  readonly supportedVersions?: readonly number[];
  /** Internal connection lifecycle notification; does not change session authentication semantics. */
  readonly onSessionClosed?: ((session: string) => void) | undefined;
  /**
   * Invoked only after a successful operation reply has flushed to the local socket. The owner uses this for Stop so
   * it cannot tear down the socket before the requester receives its acknowledgement.
   */
  readonly onResponseFlushed?: ((request: AuthenticatedControlRequest) => Promise<void> | void) | undefined;
}

export interface RunningControlServer {
  close(): Promise<void>;
}

export async function startControlServer(options: ControlServerOptions): Promise<RunningControlServer> {
  const sessions = new ControlSessions();
  const sockets = new Set<Socket>();
  const versions = options.supportedVersions ?? CONTROL_PROTOCOL_VERSIONS;
  const server = createServer((socket) => {
    installErrorSink(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    void serve(socket, { ...options, sessions, versions });
  });
  installErrorSink(server);
  await listen(server, options.endpoint);
  let closing: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      // Stop's teardown and the owner's own shutdown may both close; the second call waits for the first.
      closing ??= (async () => {
        sessions.close();
        for (const socket of sockets) socket.destroy();
        await close(server);
      })();
      return closing;
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
    writeBestEffort(socket, controlFailure('AUTH_REQUIRED', 'local control endpoint is not private to this user'));
    socket.end();
    return;
  }

  const frames = new ControlFrameReader();
  let session: ReturnType<ControlSessions['create']> | null = null;
  socket.once('close', () => {
    if (session) options.onSessionClosed?.(session.id);
  });
  let ended = false;
  let pending = Promise.resolve();
  socket.resume();
  socket.on('data', (chunk: Buffer) => {
    if (ended) return;
    let messages: unknown[];
    try {
      messages = frames.push(chunk);
    } catch (error) {
      writeBestEffort(
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
        writeBestEffort(socket, controlFailure('MALFORMED_FRAME', 'local control request is malformed'));
        ended = true;
        socket.end();
      }
    });
  });

  async function handleMessage(message: unknown): Promise<void> {
    if (ended) return;
    if (!session) {
      if (!isControlHello(message)) {
        writeBestEffort(socket, controlFailure('AUTH_REQUIRED', 'local control hello is required'));
        ended = true;
        socket.end();
        return;
      }
      if (!matchesControlToken(options.token, message.hello.token)) {
        writeBestEffort(socket, controlFailure('AUTH_REQUIRED', 'local control token is not accepted'));
        ended = true;
        socket.end();
        return;
      }
      const negotiated = negotiateVersion(message.hello.supportedVersions, options.versions);
      if (!negotiated.ok) {
        writeBestEffort(socket, controlFailure('PROTOCOL_UNSUPPORTED', 'no local control protocol version overlaps'));
        ended = true;
        socket.end();
        return;
      }
      session = options.sessions.create(negotiated.version, message.hello.client.name);
      writeBestEffort(socket, { ok: true, version: session.version, session: session.id });
      return;
    }
    if (!isControlRequest(message)) {
      writeBestEffort(socket, controlFailure('MALFORMED_FRAME', 'local control request is malformed'));
      ended = true;
      socket.end();
      return;
    }
    const active = options.sessions.get(message.session, message.version);
    if (!active) {
      writeBestEffort(socket, {
        ...controlFailure('AUTH_REQUIRED', 'local control session is required'),
        requestId: message.requestId,
      });
      return;
    }
    if (active.requestIds.has(message.requestId)) {
      writeBestEffort(socket, {
        ...controlFailure('DUPLICATE_REQUEST_ID', 'local control request id was already used'),
        requestId: message.requestId,
      });
      return;
    }
    active.requestIds.add(message.requestId);
    const request: AuthenticatedControlRequest = {
      ...message,
      origin: active.clientName,
    };
    try {
      await write(socket, {
        ok: true,
        requestId: message.requestId,
        data: await options.handle(request),
      });
      try {
        await options.onResponseFlushed?.(request);
      } catch {
        socket.destroy();
      }
    } catch (error) {
      writeBestEffort(socket, { ok: false, requestId: message.requestId, error: operationError(error) });
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

function write(socket: Socket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      socket.write(encodeControlFrame(value), (error) =>
        error === null || error === undefined ? resolve() : reject(error),
      );
    } catch (error) {
      reject(error);
    }
  });
}

function writeBestEffort(socket: Socket, value: unknown): void {
  void write(socket, value).catch(() => undefined);
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
