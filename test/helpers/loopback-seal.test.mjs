import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { test } from 'node:test';
import tls from 'node:tls';
import { assertLoopbackSeal, loopbackSealAttempts } from './loopback-seal-preload.mjs';

assertLoopbackSeal();

test('NET-B2: the preload refuses egress before import-time code acts while retaining literal local forms', async () => {
  assert.throws(() => dns.lookup('resolver.example.test', () => {}), /loopback seal/i);
  await assert.rejects(() => dns.promises.lookup('resolver.example.test'), /loopback seal/i);
  assert.throws(() => dns.resolve4('resolver.example.test', () => {}), /loopback seal/i);
  await assert.rejects(() => dns.promises.resolve4('resolver.example.test'), /loopback seal/i);
  assert.throws(() => new dns.Resolver().resolve4('resolver.example.test', () => {}), /loopback seal/i);
  assert.throws(() => net.connect(443, 'receiver.example.test'), /loopback seal/i);
  assert.throws(() => net.createConnection(443, 'receiver.example.test'), /loopback seal/i);
  assert.throws(() => tls.connect({ host: 'receiver.example.test', port: 443 }), /loopback seal/i);
  assert.throws(() => http.request('http://receiver.example.test/'), /loopback seal/i);
  assert.throws(() => https.request('https://receiver.example.test/'), /loopback seal/i);
  assert.ok(loopbackSealAttempts().some((attempt) => attempt.target === 'receiver.example.test'));
  if (process.platform === 'win32') return;
  const literal = net.connect({ host: '127.0.0.1', port: 9 });
  literal.on('error', () => {});
  literal.destroy();
  const unix = net.connect('/tmp/agentcomms-loopback-seal-missing.sock');
  unix.on('error', () => {});
  unix.destroy();
  assert.equal(literal.destroyed, true);
  assert.equal(unix.destroyed, true);
});

test('NET-B2: every callback and promise DNS resolver entry point is sealed', async () => {
  const hostname = 'example.com';
  const callbackResolveNames = Object.keys(dns).filter((name) => name === 'resolve' || name.startsWith('resolve'));
  const promiseResolveNames = Object.keys(dns.promises).filter(
    (name) => name === 'resolve' || name.startsWith('resolve'),
  );
  for (const name of callbackResolveNames) {
    assert.throws(() => dns[name](hostname, () => {}), /loopback seal/i, `dns.${name}`);
  }
  for (const name of promiseResolveNames) {
    await assert.rejects(() => dns.promises[name](hostname), /loopback seal/i, `dns.promises.${name}`);
  }
  assert.match(String(dns.lookupService), /sealedLookupService/, 'dns.lookupService is wrapped before it can resolve');
  assert.match(
    String(dns.promises.lookupService),
    /sealedPromiseLookupService/,
    'dns.promises.lookupService is wrapped before it can resolve',
  );
  assert.throws(() => dns.lookupService(hostname, 443, () => {}), /loopback seal/i);
  await assert.rejects(() => dns.promises.lookupService(hostname, 443), /loopback seal/i);

  const callbackResolver = new dns.Resolver();
  const promiseResolver = new dns.promises.Resolver();
  callbackResolver.setServers(['127.0.0.1:9']);
  promiseResolver.setServers(['127.0.0.1:9']);
  const resolverMethods = Object.getOwnPropertyNames(dns.Resolver.prototype).filter(
    (name) => name === 'reverse' || name === 'resolve' || name.startsWith('resolve'),
  );
  for (const name of resolverMethods) {
    assert.throws(() => callbackResolver[name](hostname, () => {}), /loopback seal/i, `dns.Resolver#${name}`);
  }
  const promiseResolverMethods = Object.getOwnPropertyNames(dns.promises.Resolver.prototype).filter(
    (name) => name === 'reverse' || name === 'resolve' || name.startsWith('resolve'),
  );
  for (const name of promiseResolverMethods) {
    await assert.rejects(() => promiseResolver[name](hostname), /loopback seal/i, `dns.promises.Resolver#${name}`);
  }
});
