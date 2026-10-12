import { syncBuiltinESMExports } from 'node:module';
import net, { type Server, type Socket } from 'node:net';

/**
 * Hands a test the exact pipe socket that `requestControl` creates without exposing a test hook in the production
 * control API. The imported builtin binding is synchronised for the duration of the callback only.
 */
export function interceptControlClientSocket(onSocket: (socket: Socket) => void): () => void {
  const original = net.createConnection;
  net.createConnection = ((...args: Parameters<typeof net.createConnection>) => {
    const socket = original(...args);
    onSocket(socket);
    return socket;
  }) as typeof net.createConnection;
  syncBuiltinESMExports();
  return () => {
    net.createConnection = original;
    syncBuiltinESMExports();
  };
}

/**
 * Adds a trailing connection listener to the server `startControlServer` creates. Its own listener has already
 * installed the permanent sink when this test seam receives the accepted socket.
 */
export function interceptAcceptedControlSocket(onSocket: (socket: Socket) => void): () => void {
  const original = net.createServer;
  net.createServer = ((...args: Parameters<typeof net.createServer>) => {
    const server = original(...args) as Server;
    server.on('connection', onSocket);
    return server;
  }) as typeof net.createServer;
  syncBuiltinESMExports();
  return () => {
    net.createServer = original;
    syncBuiltinESMExports();
  };
}
