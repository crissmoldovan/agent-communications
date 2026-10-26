import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';
import { ANALYSE_GLOBAL_ONLY_ENDPOINTS, preparePinnedConnection } from '../../src/network/pinned-connection.ts';

assertLoopbackSeal();

/*
 * 0.33.0 design §3.3: Analyse's model runs on OpenRouter's chat completions or Anthropic's Messages API. Global-only
 * resolution admits those two URLs only to a caller that names Analyse's purpose, and that purpose admits nothing else.
 * Every other host, subdomain, port, path or scheme is refused before DNS, and every answer must be globally reachable.
 */

const JUDGE_ENDPOINTS = ['https://api.typesafe.ai/v1/systemone', 'https://openrouter.ai/api/v1/systemone'];

function resolverAnswering(addresses: readonly string[]) {
  const asked: string[] = [];
  return {
    asked,
    resolver: {
      async lookup(hostname: string) {
        asked.push(hostname);
        return [...addresses];
      },
    },
  };
}

test('ANALYSE-NET: Analyse reaches exactly OpenRouter’s chat completions and Anthropic’s Messages API, by name', async () => {
  assert.deepEqual(ANALYSE_GLOBAL_ONLY_ENDPOINTS, [
    'https://openrouter.ai/api/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
  ]);
  for (const [url, host] of [
    ['https://openrouter.ai/api/v1/chat/completions', 'openrouter.ai'],
    ['https://api.anthropic.com/v1/messages', 'api.anthropic.com'],
  ] as const) {
    const { asked, resolver } = resolverAnswering(['8.8.8.8']);
    const connection = await preparePinnedConnection({
      url,
      addressMode: 'global-only',
      hostedPurpose: 'analyse',
      resolver,
    });
    assert.deepEqual(asked, [host]);
    assert.equal(connection.address, '8.8.8.8');
    assert.equal(connection.port, 443);
    assert.equal(connection.useTls, true);
    assert.equal(connection.hostHeader, host);
    assert.equal(connection.tls.servername, host, 'SNI is the hostname');
    assert.equal(connection.tls.certificateHost, host, 'the certificate must be the hostname’s');
  }
});

test('ANALYSE-NET: anything else is refused before DNS, a judge’s endpoints included, and a judge cannot reach Analyse’s', async () => {
  const { asked, resolver } = resolverAnswering(['8.8.8.8']);
  for (const url of [
    ...JUDGE_ENDPOINTS,
    'https://openrouter.ai/api/v1/chat/completions?stream=true',
    'https://openrouter.ai:8443/api/v1/chat/completions',
    'https://evil.openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai.example/api/v1/chat/completions',
    'http://openrouter.ai/api/v1/chat/completions',
    'https://api.anthropic.com/v1/messages/batches',
    'https://api.anthropic.com/v1/complete',
    'https://anthropic.com/v1/messages',
    'https://api.anthropic.com.example/v1/messages',
    'https://user@api.anthropic.com/v1/messages',
  ])
    await assert.rejects(
      () => preparePinnedConnection({ url, addressMode: 'global-only', hostedPurpose: 'analyse', resolver }),
      /global-only|userinfo/u,
      url,
    );
  for (const url of ANALYSE_GLOBAL_ONLY_ENDPOINTS)
    await assert.rejects(
      () => preparePinnedConnection({ url, addressMode: 'global-only', resolver }),
      /reserved for the fixed TypeSafe endpoint/u,
      `a judge's global-only call cannot reach ${url}`,
    );
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: ANALYSE_GLOBAL_ONLY_ENDPOINTS[1],
        approvedAddressSet: ['8.8.8.8'],
        hostedPurpose: 'analyse',
        resolver,
      }),
    /hosted purpose is for global-only/u,
    'a purpose never widens an approved-address-set call',
  );
  assert.deepEqual(asked, [], 'every refusal came before DNS');
});

test('ANALYSE-NET: a private, loopback or metadata answer for a model host is refused', async () => {
  for (const answer of ['127.0.0.1', '10.0.0.7', '169.254.169.254', '::1', 'fd00:ec2::254']) {
    const { resolver } = resolverAnswering(['8.8.8.8', answer]);
    await assert.rejects(
      () =>
        preparePinnedConnection({
          url: ANALYSE_GLOBAL_ONLY_ENDPOINTS[0],
          addressMode: 'global-only',
          hostedPurpose: 'analyse',
          resolver,
        }),
      /refused|not globally|non-global/u,
      answer,
    );
  }
});
