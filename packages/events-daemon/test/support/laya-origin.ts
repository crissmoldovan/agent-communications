import { EventEmitter } from 'node:events';
import type net from 'node:net';
import type tls from 'node:tls';
import type { PinnedTcpOptions, PinnedTlsOptions } from '../../src/network/pinned-connection.ts';
import type { AddressResolver } from '../../src/network/resolver.ts';

export interface OriginReply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface OriginJournalEntry {
  readonly request: string;
  readonly tcp: PinnedTcpOptions;
}

export interface ScriptedLayaOrigin {
  readonly journal: OriginJournalEntry[];
  readonly tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly repliesUsed: () => number;
}

export interface StalledLayaOrigin {
  readonly journal: OriginJournalEntry[];
  readonly tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly destroyed: () => boolean;
  readonly forceDestroy: () => void;
}

export interface TlsHandshakeStallLayaOrigin {
  readonly journal: OriginJournalEntry[];
  readonly tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly destroyed: () => boolean;
  readonly tlsStarted: () => boolean;
  readonly tlsSignalObserved: () => boolean;
}

/**
 * A sealed, in-process raw origin: it records exactly the bytes the production
 * fetcher writes, then emits one scripted HTTP/1.1 reply.  It never resolves or
 * opens an external route.
 */
export function scriptedLayaOrigin(replies: readonly OriginReply[]): ScriptedLayaOrigin {
  const journal: OriginJournalEntry[] = [];
  let replyIndex = 0;
  let currentTcp: PinnedTcpOptions | undefined;

  const tcpConnect = async (options: PinnedTcpOptions): Promise<net.Socket> => {
    currentTcp = options;
    return {} as net.Socket;
  };

  const tlsConnect = async (_options: PinnedTlsOptions): Promise<tls.TLSSocket> => {
    const socket = new EventEmitter() as EventEmitter & {
      write(bytes: Uint8Array): boolean;
      destroy(): void;
      pause(): void;
      resume(): void;
    };
    socket.write = (bytes: Uint8Array) => {
      const reply = replies[replyIndex++];
      if (reply === undefined) throw new Error('the scripted Laya origin has no remaining reply');
      if (currentTcp === undefined) throw new Error('the scripted Laya origin was written before TCP pinning');
      journal.push({ request: Buffer.from(bytes).toString('latin1'), tcp: currentTcp });
      const headers = reply.headers ?? {};
      const body = Buffer.from(reply.body ?? Buffer.alloc(0));
      const statusText = reply.status === 200 ? 'OK' : reply.status === 206 ? 'Partial Content' : 'Redirect';
      const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      queueMicrotask(() => {
        socket.emit(
          'data',
          Buffer.concat([
            Buffer.from(`HTTP/1.1 ${reply.status} ${statusText}\r\n${headerLines.join('\r\n')}\r\n\r\n`, 'latin1'),
            body,
          ]),
        );
        socket.emit('end');
      });
      return true;
    };
    socket.destroy = () => undefined;
    socket.pause = () => undefined;
    socket.resume = () => undefined;
    return socket as unknown as tls.TLSSocket;
  };

  return {
    journal,
    tcpConnect,
    tlsConnect,
    repliesUsed: () => replyIndex,
  };
}

/** A sealed response whose body resumes in a second data event after the first sink callback completes. */
export function splitBodyLayaOrigin(reply: OriginReply, splitAt: number): ScriptedLayaOrigin {
  const journal: OriginJournalEntry[] = [];
  let currentTcp: PinnedTcpOptions | undefined;

  const tcpConnect = async (options: PinnedTcpOptions): Promise<net.Socket> => {
    currentTcp = options;
    return {} as net.Socket;
  };

  const tlsConnect = async (_options: PinnedTlsOptions): Promise<tls.TLSSocket> => {
    const socket = new EventEmitter() as EventEmitter & {
      write(bytes: Uint8Array): boolean;
      destroy(): void;
      pause(): void;
      resume(): void;
    };
    const headers = reply.headers ?? {};
    const body = Buffer.from(reply.body ?? Buffer.alloc(0));
    const statusText = reply.status === 200 ? 'OK' : reply.status === 206 ? 'Partial Content' : 'Redirect';
    const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
    let resumed = false;
    socket.write = (bytes: Uint8Array) => {
      if (currentTcp === undefined) throw new Error('the split Laya origin was written before TCP pinning');
      journal.push({ request: Buffer.from(bytes).toString('latin1'), tcp: currentTcp });
      queueMicrotask(() => {
        socket.emit(
          'data',
          Buffer.concat([
            Buffer.from(`HTTP/1.1 ${reply.status} ${statusText}\r\n${headerLines.join('\r\n')}\r\n\r\n`, 'latin1'),
            body.subarray(0, splitAt),
          ]),
        );
      });
      return true;
    };
    socket.destroy = () => socket.emit('close');
    socket.pause = () => undefined;
    socket.resume = () => {
      if (resumed) return;
      resumed = true;
      queueMicrotask(() => {
        socket.emit('data', body.subarray(splitAt));
        socket.emit('end');
      });
    };
    return socket as unknown as tls.TLSSocket;
  };

  return { journal, tcpConnect, tlsConnect, repliesUsed: () => journal.length };
}

/** A sealed peer which accepts the pinned connection and deliberately never completes a response. */
export function stalledLayaOrigin(options: { readonly heartbeatMs?: number | undefined } = {}): StalledLayaOrigin {
  const journal: OriginJournalEntry[] = [];
  let currentTcp: PinnedTcpOptions | undefined;
  let wasDestroyed = false;
  let interval: NodeJS.Timeout | undefined;
  let socket: (EventEmitter & { destroy(): void }) | undefined;

  const destroy = () => {
    if (wasDestroyed) return;
    wasDestroyed = true;
    if (interval !== undefined) clearInterval(interval);
    socket?.emit('close');
  };

  return {
    journal,
    tcpConnect: async (tcp) => {
      currentTcp = tcp;
      return {} as net.Socket;
    },
    tlsConnect: async (_options) => {
      const peer = new EventEmitter() as EventEmitter & {
        write(bytes: Uint8Array): boolean;
        destroy(): void;
        pause(): void;
        resume(): void;
      };
      socket = peer;
      peer.write = (bytes) => {
        if (currentTcp === undefined) throw new Error('the stalled Laya origin was written before TCP pinning');
        journal.push({ request: Buffer.from(bytes).toString('latin1'), tcp: currentTcp });
        if (options.heartbeatMs !== undefined) {
          queueMicrotask(() => peer.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n', 'latin1')));
          interval = setInterval(() => peer.emit('data', Buffer.from('x')), options.heartbeatMs);
        }
        return true;
      };
      peer.destroy = destroy;
      peer.pause = () => undefined;
      peer.resume = () => undefined;
      return peer as unknown as tls.TLSSocket;
    },
    destroyed: () => wasDestroyed,
    forceDestroy: destroy,
  };
}

/** A sealed peer which accepts TCP but never completes its TLS handshake. */
export function tlsHandshakeStallLayaOrigin(): TlsHandshakeStallLayaOrigin {
  const journal: OriginJournalEntry[] = [];
  let wasDestroyed = false;
  let startedTls = false;
  let sawTlsSignal = false;
  const tcp = new EventEmitter() as EventEmitter & { destroy(): void };
  tcp.destroy = () => {
    wasDestroyed = true;
    tcp.emit('close');
  };

  return {
    journal,
    tcpConnect: async () => tcp as unknown as net.Socket,
    tlsConnect: async (options) =>
      new Promise<tls.TLSSocket>((_resolve, reject) => {
        startedTls = true;
        const signal = (options as PinnedTlsOptions & { readonly signal?: AbortSignal }).signal;
        signal?.addEventListener(
          'abort',
          () => {
            sawTlsSignal = true;
            options.socket.destroy();
            reject(signal.reason instanceof Error ? signal.reason : new Error('TLS handshake aborted'));
          },
          { once: true },
        );
      }),
    destroyed: () => wasDestroyed,
    tlsStarted: () => startedTls,
    tlsSignalObserved: () => sawTlsSignal,
  };
}

export function resolverFor(...answers: readonly string[]): AddressResolver {
  return { lookup: async () => answers };
}
