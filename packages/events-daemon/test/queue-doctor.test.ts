import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020Runtime, { type Ajv2020 as Ajv2020Class, type Options } from 'ajv/dist/2020.js';
import { EventControlClient } from '../src/control/client.ts';
import doctorV1Schema from '../src/operations/contracts/doctor-v1.schema.json' with { type: 'json' };
import doctorV3Schema from '../src/operations/contracts/doctor-v3.schema.json' with { type: 'json' };
import layaStatusSchema from '../src/operations/contracts/laya-model-status-v1.schema.json' with { type: 'json' };
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

const ACCOUNT = 'ibx_QUEUEDOCTOR0000';

test('QUEUE-A: doctor counts the queue deliveries whose content was unreadable, and nothing else', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-queue-doctor-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
           VALUES ('event-doctor', ?, 'gmail.message.received', 1, ?, 'dedupe-doctor', 1, 1, 1)`,
        )
        .run(store.installationId, ACCOUNT);
      store.database
        .prepare(
          `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
           VALUES ('decision-doctor', 'event-doctor', ?, 'rule-doctor', 1, 'matched', 9999999999999, 'retained')`,
        )
        .run(ACCOUNT);
      for (const [id, key, kind, state] of [
        ['unreadable-1', 'queue:queue-doctor:1', 'queue', 'content-unreadable'],
        ['unreadable-2', 'queue:queue-doctor:2', 'queue', 'content-unreadable'],
        ['delivered', 'queue:queue-doctor:3', 'queue', 'delivered'],
        ['dry-run-unreadable', 'dryrun:log:1', 'dry-run', 'content-unreadable'],
      ] as const)
        store.database
          .prepare(
            `INSERT INTO deliveries
               (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
                encrypted_record, expires_at, state, switch_generation)
             VALUES (?, 'decision-doctor', ?, 'rule-doctor', 1, ?, 'queue-doctor', 1, ?, NULL, 9999999999999, ?, 0)`,
          )
          .run(id, ACCOUNT, key, kind, state);
    } finally {
      store.close();
    }
    let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
    try {
      owner = await startEventOwner({
        ...noRealHome(stateDir),
        stateDir,
        configDir: await emptyConfigDir(stateDir),
        tickMs: 60_000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('EPERM: the sandbox blocks the owner Unix listener');
        return;
      }
      throw error;
    }
    try {
      const report = (await new EventControlClient({ stateDir, clientName: 'queue-doctor' }).request(
        'doctor',
      )) as Record<string, unknown>;
      assert.equal(report.schemaVersion, 'doctor-v3');
      assert.deepEqual(report.queue, { unreadableDeliveries: 2 });
      const Ajv2020 = Ajv2020Runtime as unknown as new (options?: Options) => Ajv2020Class;
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      ajv.addSchema(doctorV1Schema);
      ajv.addSchema(layaStatusSchema);
      const validate = ajv.compile(doctorV3Schema);
      assert.equal(validate(report), true, JSON.stringify(validate.errors));
      assert.equal(validate({ ...report, queue: { unreadableDeliveries: -1 } }), false);
      assert.equal(validate({ ...report, queue: { unreadableDeliveries: 1, subject: 'x' } }), false);
    } finally {
      await owner.stop();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
