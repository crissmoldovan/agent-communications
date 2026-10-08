import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

const [{ test }, { preparePinnedConnection }] = await Promise.all([
  import('node:test'),
  import('../src/network/pinned-connection.ts'),
]);

test('NET-B2: the daemon network entrypoint proves its preload before dynamically importing transport code', async () => {
  const pinned = await preparePinnedConnection({
    url: 'http://127.0.0.1:8080/',
    approvedAddressSet: ['127.0.0.1'],
  });
  if (pinned.address !== '127.0.0.1') throw new Error('the sealed literal fixture was not pinned');
});
