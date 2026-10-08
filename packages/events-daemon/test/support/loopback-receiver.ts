import net from 'node:net';

export interface LoopbackReceiver {
  readonly host: '127.0.0.1';
  readonly port: number;
  close(): Promise<void>;
}

/** Starts a fixture-only raw receiver on the single literal accepted by the test seal. */
export async function startLoopbackReceiver(onConnection: (socket: net.Socket) => void): Promise<LoopbackReceiver> {
  const server = net.createServer(onConnection);
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
    close: async () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
