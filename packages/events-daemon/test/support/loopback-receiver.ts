import net from 'node:net';
import tls from 'node:tls';
import { installErrorSink } from '../../src/network/error-sink.ts';

export interface LoopbackReceiver {
  readonly host: '127.0.0.1';
  readonly port: number;
  close(): Promise<void>;
}

export interface LoopbackReceiverOptions<SocketType extends net.Socket = net.Socket> {
  /** Test seam run after this fixture has installed its permanent listener on an accepted socket. */
  readonly afterAccept?: ((socket: SocketType) => void) | undefined;
}

function closeServer(server: net.Server, sockets: ReadonlySet<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/** Starts a fixture-only raw receiver on the single literal accepted by the test seal. */
export async function startLoopbackReceiver(
  onConnection: (socket: net.Socket) => void,
  options: LoopbackReceiverOptions = {},
): Promise<LoopbackReceiver> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    installErrorSink(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    onConnection(socket);
    options.afterAccept?.(socket);
  });
  installErrorSink(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('fixture receiver did not bind literal IPv4 loopback');
  }
  return {
    host: '127.0.0.1',
    port: address.port,
    close: async () => closeServer(server, sockets),
  };
}

/** Starts a fixture-only TLS receiver on the single literal accepted by the test seal. */
export async function startLoopbackTlsReceiver(
  credentials: { readonly key: string; readonly cert: string },
  onConnection: (socket: tls.TLSSocket) => void,
  options: LoopbackReceiverOptions<tls.TLSSocket> = {},
): Promise<LoopbackReceiver> {
  const sockets = new Set<tls.TLSSocket>();
  const server = tls.createServer(credentials, (socket) => {
    installErrorSink(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    onConnection(socket);
    options.afterAccept?.(socket);
  });
  installErrorSink(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('fixture TLS receiver did not bind literal IPv4 loopback');
  }
  return {
    host: '127.0.0.1',
    port: address.port,
    close: async () => closeServer(server, sockets),
  };
}
