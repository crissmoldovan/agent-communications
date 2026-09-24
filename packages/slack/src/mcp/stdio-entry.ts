/**
 * Starting the stdio server. On stdio, **stdout is the protocol**: one stray `console.log` from anywhere — our
 * code, a dependency, a deprecation notice — corrupts the stream and the client drops the connection with an
 * unhelpful parse error. So the console is redirected to stderr before the server is built.
 */
import { createSlackMcpServer, type SlackMcpOptions } from './server.ts';

export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

export async function startSlackStdioServer(options: SlackMcpOptions = {}): Promise<void> {
  redirectConsoleToStderr();
  const server = await createSlackMcpServer(options);
  await server.connectStdio();
}
