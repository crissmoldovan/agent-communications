import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const MARKER = Symbol.for('agentcomms.events.loopback-seal.preloaded.v1');
const attempts = [];
const ownPreload = process.execArgv.some((argument) => argument.includes('loopback-seal-preload.mjs'));

function isLiteralLoopback(host) {
  const value = String(host)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return value === '127.0.0.1' || value === '::1';
}

function refused(what, target) {
  attempts.push({ what, target: String(target) });
  throw new Error(`loopback seal refused ${what} to ${target}`);
}

function socketDestination(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const second = Array.isArray(args[0]) ? args[0][1] : args[1];
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return { path: first.path };
    if (first.socket !== undefined) return { path: 'already-vetted socket' };
    return { host: first.host ?? first.hostname ?? 'localhost' };
  }
  if (typeof first === 'number' || /^\d+$/.test(String(first)))
    return { host: typeof second === 'string' ? second : 'localhost' };
  return { path: String(first) };
}

function assertSocket(args, what) {
  const destination = socketDestination(args);
  if (destination.path === undefined && !isLiteralLoopback(destination.host)) refused(what, destination.host);
}

function requestDestination(args) {
  const first = args[0];
  const second = args[1];
  if (first instanceof URL) return { host: first.hostname };
  if (typeof first === 'string' && /^https?:\/\//i.test(first)) return { host: new URL(first).hostname };
  const options =
    first !== null && typeof first === 'object' ? first : second !== null && typeof second === 'object' ? second : {};
  if (typeof options.socketPath === 'string') return { path: options.socketPath };
  return { host: options.hostname ?? options.host ?? 'localhost' };
}

function assertRequest(args, what) {
  const destination = requestDestination(args);
  if (destination.path === undefined && !isLiteralLoopback(destination.host)) refused(what, destination.host);
}

function patchLookup(target, promiseTarget = false) {
  const lookup = target.lookup;
  if (typeof lookup !== 'function') return;
  target.lookup = promiseTarget
    ? async function sealedPromiseLookup(hostname, ...rest) {
        if (!isLiteralLoopback(hostname)) refused('DNS lookup', hostname);
        return lookup.call(this, hostname, ...rest);
      }
    : function sealedLookup(hostname, ...rest) {
        if (!isLiteralLoopback(hostname)) refused('DNS lookup', hostname);
        return lookup.call(this, hostname, ...rest);
      };
}

function patchLookupService(target, promiseTarget = false) {
  const lookupService = target.lookupService;
  if (typeof lookupService !== 'function') return;
  target.lookupService = promiseTarget
    ? async function sealedPromiseLookupService(hostname, ...rest) {
        if (!isLiteralLoopback(hostname)) refused('DNS lookup service', hostname);
        return lookupService.call(this, hostname, ...rest);
      }
    : function sealedLookupService(hostname, ...rest) {
        if (!isLiteralLoopback(hostname)) refused('DNS lookup service', hostname);
        return lookupService.call(this, hostname, ...rest);
      };
}

function patchResolverMethods(target, promiseTarget = false) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (name !== 'reverse' && name !== 'resolve' && !name.startsWith('resolve')) continue;
    const original = target[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: promiseTarget
        ? async function sealedPromiseResolver(hostname, ...rest) {
            refused('DNS resolution', hostname);
            return original.call(this, hostname, ...rest);
          }
        : function sealedResolver(hostname, ...rest) {
            refused('DNS resolution', hostname);
            return original.call(this, hostname, ...rest);
          },
    });
  }
}

function patchRequest(module, label) {
  for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function sealedRequest(...args) {
      assertRequest(args, `${label}.${name}`);
      return original.apply(this, args);
    };
  }
}

function install() {
  if (globalThis[MARKER] === true) return;
  Object.defineProperty(globalThis, MARKER, { value: true });
  patchLookup(dns);
  patchLookup(dns.promises, true);
  patchLookupService(dns);
  patchLookupService(dns.promises, true);
  patchResolverMethods(dns);
  patchResolverMethods(dns.promises, true);
  patchResolverMethods(dns.Resolver.prototype);
  patchResolverMethods(dns.promises.Resolver.prototype, true);
  const socketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function sealedSocketConnect(...args) {
    assertSocket(args, 'socket connection');
    return socketConnect.apply(this, args);
  };
  for (const name of ['connect', 'createConnection']) {
    const original = net[name];
    net[name] = function sealedNetConnect(...args) {
      assertSocket(args, 'socket connection');
      return original.apply(this, args);
    };
  }
  const tlsConnect = tls.connect;
  tls.connect = function sealedTlsConnect(...args) {
    assertSocket(args, 'TLS connection');
    return tlsConnect.apply(this, args);
  };
  patchRequest(http, 'http');
  patchRequest(https, 'https');
  syncBuiltinESMExports();
}

if (ownPreload) install();

export function assertLoopbackSeal() {
  if (globalThis[MARKER] !== true) throw new Error('loopback seal preload is required before network-capable imports');
}

export function loopbackSealAttempts() {
  return attempts;
}
