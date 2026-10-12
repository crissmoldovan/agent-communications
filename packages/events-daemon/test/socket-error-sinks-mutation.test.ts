import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runB3Mutation } from './support/b3-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const ROOT = join(import.meta.dirname, '../../..');

interface SocketSinkMutation extends Record<string, unknown> {
  readonly case: string;
  readonly operation: string;
  readonly productionEntry: string;
  readonly test: string;
  readonly mutation: { readonly from: string; readonly to: string };
  readonly mutationTest: string;
  readonly loadedMarker: string;
}

const MUTATIONS: readonly SocketSinkMutation[] = [
  {
    case: 'permanent-error-sink-helper',
    operation: 'installErrorSink',
    productionEntry: 'packages/events-daemon/src/network/error-sink.ts',
    test: 'packages/events-daemon/test/network/error-sink.test.ts',
    mutation: { from: "resource.on('error', () => undefined);", to: 'void resource;' },
    mutationTest: 'NET-B2: a permanent error sink remains after an operation listener settles',
    loadedMarker: 'permanent-error-sink-helper',
  },
  {
    case: 'pinned-tcp-error-sink',
    operation: 'connectPinnedTcp',
    productionEntry: 'packages/events-daemon/src/network/pinned-connection.ts',
    test: 'packages/events-daemon/test/network/pinned-connection.test.ts',
    mutation: {
      from: "    socket.once('error', reject);\n    installErrorSink(socket);\n    socket.once('connect', () => {",
      to: "    socket.once('error', reject);\n    socket.once('connect', () => {",
    },
    mutationTest: 'NET-B2: connected pinned TCP keeps an error sink after its connect listener settles',
    loadedMarker: 'pinned-tcp-error-sink',
  },
  {
    case: 'pinned-tls-error-sink',
    operation: 'connectPinnedTls',
    productionEntry: 'packages/events-daemon/src/network/pinned-connection.ts',
    test: 'packages/events-daemon/test/network/pinned-connection.test.ts',
    mutation: {
      from: "    socket.once('error', reject);\n    installErrorSink(socket);\n    socket.once('secureConnect', () => {",
      to: "    socket.once('error', reject);\n    socket.once('secureConnect', () => {",
    },
    mutationTest: 'NET-B2: handshaken pinned TLS keeps an error sink after its handshake listener settles',
    loadedMarker: 'pinned-tls-error-sink',
  },
  {
    case: 'dispatcher-seam-tcp-error-sink',
    operation: 'WebhookDispatcher.dispatch',
    productionEntry: 'packages/events-daemon/src/runtime/webhook-dispatcher.ts',
    test: 'packages/events-daemon/test/webhook-dispatcher.test.ts',
    mutation: {
      from: "    installErrorSink(tcp);\n    this.#testFailpoint?.('after-tcp', claim);",
      to: "    this.#testFailpoint?.('after-tcp', claim);",
    },
    mutationTest:
      'B2-T6: seam-provided TCP and TLS sockets survive reset after their connect and handshake listeners settle',
    loadedMarker: 'dispatcher-seam-tcp-error-sink',
  },
  {
    case: 'dispatcher-seam-tls-error-sink',
    operation: 'WebhookDispatcher.dispatch',
    productionEntry: 'packages/events-daemon/src/runtime/webhook-dispatcher.ts',
    test: 'packages/events-daemon/test/webhook-dispatcher.test.ts',
    mutation: {
      from: '        installErrorSink(socket);\n      } catch (error) {',
      to: '      } catch (error) {',
    },
    mutationTest:
      'B2-T6: seam-provided TCP and TLS sockets survive reset after their connect and handshake listeners settle',
    loadedMarker: 'dispatcher-seam-tls-error-sink',
  },
  {
    case: 'control-client-error-sink',
    operation: 'requestControl',
    productionEntry: 'packages/events-daemon/src/control/client.ts',
    test: 'packages/events-daemon/test/control-client-error-sink.test.ts',
    mutation: {
      from: '    const socket = createConnection(endpoint);\n    installErrorSink(socket);',
      to: '    const socket = createConnection(endpoint);',
    },
    mutationTest:
      'CTRL-B1: a client socket destroyed with an error after its final exchange settles cannot escape socket.end()',
    loadedMarker: 'control-client-error-sink',
  },
  {
    case: 'control-server-accepted-socket-error-sink',
    operation: 'startControlServer',
    productionEntry: 'packages/events-daemon/src/control/server.ts',
    test: 'packages/events-daemon/test/control-server-error-sink.test.ts',
    mutation: {
      from: '  const server = createServer((socket) => {\n    installErrorSink(socket);',
      to: '  const server = createServer((socket) => {',
    },
    mutationTest: 'CTRL-B1: an accepted control socket destroyed before endpoint verification simply closes',
    loadedMarker: 'control-server-accepted-socket-error-sink',
  },
  {
    case: 'plain-loopback-fixture-peer-error-sink',
    operation: 'startLoopbackReceiver',
    productionEntry: 'packages/events-daemon/test/support/loopback-receiver.ts',
    test: 'packages/events-daemon/test/loopback-receiver-error-sink.test.ts',
    mutation: {
      from: '  const server = net.createServer((socket) => {\n    installErrorSink(socket);',
      to: '  const server = net.createServer((socket) => {',
    },
    mutationTest: 'B2-T6 fixture: an accepted plain loopback peer destroyed with an error simply closes',
    loadedMarker: 'plain-loopback-fixture-peer-error-sink',
  },
];

// No mutation removes the sink on an SSE connection or on a TLS fixture peer: `http.Server` and `tls.Server` attach
// their own error handler to every socket they accept (Node's socketOnError and onSocketTLSError), so removing the
// extra sink there has no observable effect. Those sinks stay as defence in depth.
test('B2-T6/B2-T9: every permanent socket-error sink mutation fails exactly its named lifecycle proof', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const blocked: string[] = [];
  const failures: string[] = [];
  const selected = process.env.SOCKET_ERROR_SINK_MUTATION_CASE;
  const entries = selected === undefined ? MUTATIONS : MUTATIONS.filter((entry) => entry.case === selected);
  assert.ok(entries.length > 0, `socket error-sink mutation case is recognised: ${selected ?? 'all'}`);
  for (const entry of entries) {
    try {
      const result = await runB3Mutation({ root: ROOT, entry });
      assert.match(result.output, new RegExp(`B3_MUTANT_LOADED:${entry.loadedMarker}`));
      assert.notEqual(result.status, 0, `${entry.case}: the named lifecycle test must fail without its sink`);
    } catch (error) {
      if (error instanceof Error && /\bEPERM\b/u.test(error.message)) {
        blocked.push(entry.case);
        continue;
      }
      failures.push(`${entry.case}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], 'every non-EPERM socket lifecycle mutation must fail its selected named proof');
  if (blocked.length > 0) t.skip(`EPERM-only socket lifecycle mutation cases in this sandbox: ${blocked.join(', ')}`);
});
