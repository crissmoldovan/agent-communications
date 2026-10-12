import { createHash } from 'node:crypto';
import { run } from '../../../../packages/events-daemon/src/operations/run.ts';
import { openEventDatabase } from '../../../../packages/events-daemon/src/store/database.ts';
import { selectEventSecretStore } from '../../../../packages/events-daemon/src/store/event-secrets.ts';
import { assertLoopbackSeal } from '../../../../test/helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();
const argument = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const stateDir = argument('--state-dir');
const configDir = argument('--config-dir');
try {
  const opened = await openEventDatabase({ stateDir });
  await selectEventSecretStore(opened.database, 'file');
  for (const [kind, id, document] of [
    ['target', 'target-native', { targetId: 'target-native', version: 1, kind: 'dry-run', retentionMs: 60_000 }],
    [
      'subscriber',
      'subscriber-native',
      {
        subscriberId: 'subscriber-native',
        version: 1,
        kind: 'sse',
        authority: { host: '127.0.0.1', port: 43101 },
        origins: ['http://127.0.0.1'],
        retentionMs: 60_000,
      },
    ],
    [
      'judge',
      'judge-native',
      { judgeId: 'judge-native', version: 1, kind: 'typesafe', provider: 'typesafe', model: 'jev' },
    ],
  ]) {
    const text = JSON.stringify(document);
    opened.database
      .prepare(
        `INSERT OR IGNORE INTO ${kind}_versions (id, ${kind}_id, version, document, digest) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`${id}@1`, id, 1, text, createHash('sha256').update(text).digest('hex'));
  }
  opened.close();
  await run({ stateDir, configDir });
} catch (error) {
  const code = typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'UNKNOWN';
  process.stderr.write(`secret-owner-error-code:${code}\n`);
  process.exitCode = 1;
}
