import dns from 'node:dns';
import net from 'node:net';

/**
 * Seals this process to loopback: every TCP connection to a host that is not loopback by address (or `localhost`),
 * and every name lookup of one, throws before a byte leaves the machine. Loopback and Unix-domain sockets still work,
 * so a test can run the repository's fakes and a local control socket. Unlike the parity drive's seal, which refuses
 * all network, this is for an end-to-end test that needs its loopback fake — and must never reach the real provider
 * when a path ignores the fake (a built Gmail package never honours its loopback override).
 *
 * Node's own fetch, and TLS, connect through `net.Socket.prototype.connect`, so one guard covers them.
 */

const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1|localhost)$/i;

export class NetworkSealError extends Error {
  constructor(target) {
    super(`the loopback seal refused a connection to ${target}`);
    this.name = 'NetworkSealError';
  }
}

/** What a connection was asked for: a Unix path (allowed) or a host (checked). */
function hostOf(args) {
  const [first, second] = args;
  if (Array.isArray(first)) return hostOf(first);
  if (typeof first === 'object' && first !== null) {
    if (typeof first.path === 'string') return null;
    return typeof first.host === 'string' ? first.host : 'localhost';
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return null; // a Unix socket path
  return typeof second === 'string' ? second : 'localhost';
}

let sealed = false;
const attempts = [];

/** Installs the seal once for this process and returns the refused targets recorded so far. */
export function sealToLoopback() {
  if (!sealed) {
    sealed = true;
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function sealedConnect(...args) {
      const host = hostOf(args);
      if (host !== null && !LOOPBACK.test(host.replace(/^\[|\]$/g, ''))) {
        attempts.push(host);
        throw new NetworkSealError(host);
      }
      return connect.apply(this, args);
    };
    const lookup = dns.lookup;
    dns.lookup = function sealedLookup(hostname, ...rest) {
      if (!LOOPBACK.test(String(hostname))) {
        attempts.push(String(hostname));
        throw new NetworkSealError(String(hostname));
      }
      return lookup.call(this, hostname, ...rest);
    };
    const promisesLookup = dns.promises.lookup;
    dns.promises.lookup = async function sealedPromisesLookup(hostname, ...rest) {
      if (!LOOPBACK.test(String(hostname))) {
        attempts.push(String(hostname));
        throw new NetworkSealError(String(hostname));
      }
      return promisesLookup.call(this, hostname, ...rest);
    };
  }
  return attempts;
}
