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
