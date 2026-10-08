import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { CommsError, ERROR_REGISTRY, type ErrorCode, resolvePaths } from '@agentcomms/core';
import { type EventPaths, eventPaths } from '../runtime/paths.ts';
import {
  assertControlSupported,
  controlEndpoint,
  verifyControlSocket,
  verifyPrivateSocketDirectory,
} from './endpoint.ts';
import { type EventInstanceRecord, readInstance, tokenFingerprint } from './instance.ts';
import {
  CONTROL_PROTOCOL_VERSIONS,
  ControlFrameReader,
  type ControlReply,
  type ControlRequest,
  encodeControlFrame,
} from './protocol.ts';

export class EventControlClient {
  readonly #paths: EventPaths;
  readonly #clientName: string;

  constructor(options: { readonly stateDir?: string | undefined; readonly clientName?: string | undefined } = {}) {
    this.#paths = eventPaths(options.stateDir ?? resolvePaths().stateDir);
    this.#clientName = options.clientName ?? 'events-cli';
  }

  async request(operation: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // No token leaves this process for an endpoint another user could have created (B1-G).
    assertControlSupported();
    const record = await readInstance(this.#paths);
    if (!record) throw notRunning();
    await verifyOwnEndpoint(this.#paths, record);
    const token = await readToken(this.#paths, record);
    try {
      return await requestControl(record, token, this.#clientName, operation, args);
    } catch (error) {
      if (isMissingOwner(error)) throw notRunning();
      throw error;
    }
  }
}

/** Proves the instance names this state directory's own private socket, before any token is sent to it. */
export async function verifyOwnEndpoint(paths: EventPaths, record: EventInstanceRecord): Promise<void> {
  if (record.endpoint !== controlEndpoint(paths)) throw notRunning();
  await verifyPrivateSocketDirectory(paths);
  await verifyControlSocket(record.endpoint);
}

export async function probeControl(paths: EventPaths, record: EventInstanceRecord, token: string): Promise<boolean> {
  try {
    await verifyOwnEndpoint(paths, record);
    await requestControl(record, token, 'events-owner-probe', 'status', {});
    return true;
  } catch {
    return false;
  }
}

export async function requestControl(
  record: EventInstanceRecord,
  token: string,
  clientName: string,
  operation: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const socket = await connect(record.endpoint);
  try {
    const hello = (await exchange(socket, {
      hello: { supportedVersions: CONTROL_PROTOCOL_VERSIONS, token, client: { name: clientName } },
    })) as ControlReply;
    if (!hello.ok || hello.version === undefined || hello.session === undefined) throw controlError(hello);
    const request: ControlRequest = {
      version: hello.version,
      requestId: randomBytes(16).toString('base64url'),
      session: hello.session,
      operation,
      args,
    };
    const reply = (await exchange(socket, request)) as ControlReply;
    if (!reply.ok) throw controlError(reply);
    return reply.data;
  } finally {
    socket.end();
  }
}

async function readToken(paths: EventPaths, record: EventInstanceRecord): Promise<string> {
  let token: string;
  try {
    token = (await readFile(paths.controlToken, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notRunning();
    throw error;
  }
  if (!/^[0-9a-f]{64}$/.test(token) || tokenFingerprint(token) !== record.tokenFingerprint) throw notRunning();
  return token;
}

function connect(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function exchange(socket: Socket, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new ControlFrameReader();
    const onData = (chunk: Buffer) => {
      try {
        const frames = reader.push(chunk);
        const frame = frames[0];
        if (frame === undefined) return;
        cleanup();
        resolve(frame);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.write(encodeControlFrame(value));
  });
}

function controlError(reply: ControlReply): Error {
  if (!reply.ok) {
    const options = {
      ...(reply.error.hint === undefined ? {} : { hint: reply.error.hint }),
      ...(reply.error.details === undefined ? {} : { details: reply.error.details }),
    };
    const code = reply.error.code;
    if (code === 'PROTOCOL_UNSUPPORTED') return new CommsError('CONFIG', reply.error.message, options);
    // An operation's own stable code comes back as itself; a protocol fault is bad data from the owner.
    if (Object.hasOwn(ERROR_REGISTRY, code)) return new CommsError(code as ErrorCode, reply.error.message, options);
    return new CommsError('BAD_DATA', reply.error.message, options);
  }
  return new CommsError('BAD_DATA', 'local control hello was malformed');
}

function notRunning(): CommsError {
  return new CommsError('NOT_FOUND', 'the local event service is not running', {
    hint: 'Start the local event service in a terminal before requesting its runtime controls.',
  });
}

function isMissingOwner(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ECONNRESET';
}
