import type { DatabaseSync } from 'node:sqlite';
import type { EventSecretStore } from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { B3SecretControl } from './b3-secret-control.ts';
import { assertObjectSecretReady } from './object-secret-readiness.ts';
import type { EventPaths } from './paths.ts';
import type { WriterQuiescer } from './writer-quiescer.ts';

/**
 * The only B3 runtime-entry seam exported to the later retained/operator
 * tasks.  It keeps secret completion, exact readiness and owner-wide rekeying
 * in the serial prerequisite rather than letting a parallel task add a writer.
 */
export interface B3ControlPorts {
  readonly quiescer: WriterQuiescer;
  readonly secrets: B3SecretControl;
  assertObjectSecretReady(input: {
    readonly owner: { readonly kind: 'target' | 'subscriber' | 'judge'; readonly id: string; readonly version: number };
  }): Promise<{ readonly ready: true }>;
}

export function createB3ControlPorts(input: {
  readonly database: DatabaseSync;
  readonly paths: EventPaths;
  readonly eventSecrets: EventSecretStore;
  readonly cipher: EventRecordCipher;
  readonly quiescer: WriterQuiescer;
}): B3ControlPorts {
  const secrets = new B3SecretControl({
    database: input.database,
    paths: input.paths,
    secrets: input.eventSecrets,
    cipher: input.cipher,
    quiescer: input.quiescer,
  });
  return {
    quiescer: input.quiescer,
    secrets,
    assertObjectSecretReady: ({ owner }) =>
      assertObjectSecretReady({
        database: input.database,
        secrets: input.eventSecrets,
        cipher: input.cipher,
        owner,
      }),
  };
}
