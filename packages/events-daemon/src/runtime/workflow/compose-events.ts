import type { JsonValue } from '@agentcomms/events';
import type { EventDatabase } from '../../store/database.ts';
import { chainRequestsInTransaction } from '../events/chains.ts';
import { createWorkflowEventSink, type WorkflowEventSinkDeps } from '../events/sink.ts';
import type { ProjectionCipher } from '../projections.ts';
import type { RunView, WorkflowComposition } from './contracts.ts';
import { type RunRecord, runRecordLocation } from './runs.ts';
import { raiseExecutor } from './steps/raise.ts';

/**
 * Track D's part of the workflow engine (plan I4): the Raise step's executor and the event sink every transition goes
 * through. The owner hands it to `composeWorkflows` with the other tracks' parts.
 */
export function composeWorkflowEvents(deps: WorkflowEventSinkDeps): WorkflowComposition {
  return { executors: [raiseExecutor], sink: createWorkflowEventSink(deps) };
}

/**
 * The owner's composition (workflows design §9.1, W27, W34): a Raise step's declared fields are opened from the run's
 * sealed record, through the owner's leased cipher, only when such a step settles; and each raised event asks for the
 * chained workflows it starts, in the engine's transaction.
 */
export function composeOwnerWorkflowEvents(deps: {
  readonly store: EventDatabase;
  readonly cipher: ProjectionCipher;
}): WorkflowComposition {
  return composeWorkflowEvents({
    cipher: deps.cipher,
    installationId: deps.store.installationId,
    fields: async (run: RunView): Promise<Readonly<Record<string, JsonValue>>> => {
      const row = deps.store.database.prepare('SELECT encrypted_record FROM workflow_runs WHERE id = ?').get(run.id) as
        | { encrypted_record: Uint8Array | null }
        | undefined;
      if (row === undefined || row.encrypted_record === null) return {};
      const record = JSON.parse(
        (await deps.cipher.decrypt(runRecordLocation(run.id), row.encrypted_record)).toString('utf8'),
      ) as RunRecord;
      const fields = record.fields;
      return typeof fields === 'object' && fields !== null && !Array.isArray(fields)
        ? (fields as Readonly<Record<string, JsonValue>>)
        : {};
    },
    onRaisedInTransaction: (database, event, now) => chainRequestsInTransaction(database, event, event.run, now),
  });
}
