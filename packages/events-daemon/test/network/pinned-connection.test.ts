import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addressSetDigest,
  openPinnedConnection,
  preparePinnedConnection,
  requestBytesForPinnedConnection,
} from '../../src/network/pinned-connection.ts';

test('NET-B2: validates the approved fingerprint before resolving and pins every vetted answer', async () => {
  let resolverCalls = 0;
  const resolver = {
    lookup: async () => {
      resolverCalls += 1;
      return ['8.8.8.8'];
    },
  };
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'https://receiver.example.test/hook',
        approvedAddressSet: ['8.8.8.8'],
        approvedAddressSetDigest: 'not-the-fingerprint',
        resolver,
      }),
    /fingerprint/i,
  );
  assert.equal(resolverCalls, 0);

  const approvedAddressSet = ['8.8.8.8'];
  const pinned = await preparePinnedConnection({
    url: 'https://receiver.example.test/hook?x=1',
    approvedAddressSet,
    approvedAddressSetDigest: addressSetDigest(approvedAddressSet),
    resolver,
  });
  assert.equal(pinned.hostname, 'receiver.example.test');
  assert.equal(pinned.address, '8.8.8.8');
  assert.equal(pinned.tls.servername, 'receiver.example.test');
  assert.equal(pinned.tls.rejectUnauthorized, true);
  assert.match(
    requestBytesForPinnedConnection(pinned, 'POST', Buffer.from('x')).toString(),
    /Host: receiver\.example\.test\r\n/,
  );

  let tcpOptions: unknown;
  let tlsOptions: unknown;
  await openPinnedConnection(pinned, {
    tcpConnect: async (options) => {
      tcpOptions = options;
      return {} as never;
    },
    tlsConnect: async (options) => {
      tlsOptions = options;
      return {} as never;
    },
  });
  assert.deepEqual(tcpOptions, { host: '8.8.8.8', port: 443 });
  assert.deepEqual(tlsOptions, {
    socket: {},
    rejectUnauthorized: true,
    servername: 'receiver.example.test',
    certificateHost: 'receiver.example.test',
  });

  const literalHttps = await preparePinnedConnection({
    url: 'https://127.0.0.1:8443/',
    approvedAddressSet: ['127.0.0.1'],
  });
  assert.deepEqual(literalHttps.tls, {
    rejectUnauthorized: true,
    certificateHost: '127.0.0.1',
  });
});

test('NET-B2: refuses all-answer drift, proxy-shaped URLs, redirects, and nonliteral HTTP', async () => {
  const resolver = { lookup: async () => ['8.8.8.8', '10.0.0.1'] };
  await assert.rejects(
    () => preparePinnedConnection({ url: 'https://receiver.example.test/', approvedAddressSet: ['8.8.8.8'], resolver }),
    /approved|address/i,
  );
  await assert.rejects(
    () => preparePinnedConnection({ url: 'http://localhost:8080/', approvedAddressSet: ['127.0.0.1'], resolver }),
    /literal/i,
  );
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'http://127.0.0.1:8080/',
        approvedAddressSet: ['127.0.0.1', '8.8.8.8'],
        resolver: { lookup: async () => ['127.0.0.1'] },
      }),
    /one exact/i,
  );
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'https://user@receiver.example.test/',
        approvedAddressSet: ['8.8.8.8'],
        resolver,
      }),
    /userinfo/i,
  );

  let resolverCalls = 0;
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'https://receiver.example.test/',
        approvedAddressSet: ['8.8.8.8', '10.0.0.1'],
        resolver: {
          lookup: async () => {
            resolverCalls += 1;
            return ['8.8.8.8'];
          },
        },
      }),
    /sorted/i,
  );
  assert.equal(resolverCalls, 0, 'policy shape is rejected before a DNS lookup');
});
