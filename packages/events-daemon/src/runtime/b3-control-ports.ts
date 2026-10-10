import type { DatabaseSync } from 'node:sqlite';
import type { SourceOptions } from '../domain/source-options.ts';
import type { EventSecretStore } from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { B3SecretControl } from './b3-secret-control.ts';
import { assertObjectSecretReady } from './object-secret-readiness.ts';
import type { EventPaths } from './paths.ts';
import type { WriterQuiescer } from './writer-quiescer.ts';

/**
 * The owner-composed retry/drop boundary: its implementation is the dispatcher's shared disclosure/write fence,
 * including D9 visibility for WhatsApp. Task 4 deliberately receives the boundary as one port rather than copying
 * a selectable subset of its judges here.
 */
export interface B3DeliveryWriteFenceRequest {
  readonly operation: 'retry' | 'drop';
  readonly deliveryId: string;
  readonly accountId: string;
  readonly source: SourceOptions['channel'];
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly subscriberId: string | null;
  readonly subscriberVersion: number | null;
  readonly whatsappMessageId: string | null;
  readonly switchGeneration: number;
}

/**
 * The only B3 runtime-entry seam exported to the later retained/operator
 * tasks.  It keeps secret completion, exact readiness and owner-wide rekeying
 * in the serial prerequisite rather than letting a parallel task add a writer.
 */
export interface B3ControlPorts {
  readonly quiescer: WriterQuiescer;
  readonly secrets: B3SecretControl;
  /**
   * Task 5's owner composition supplies D2/D7/D9's one dispatcher fence; absence is refused by operator control. It
   * opens the one IMMEDIATE transaction, re-checks every live authority inside it, then runs `work` synchronously in
   * that same transaction; `work` opens no transaction of its own.
   */
  readonly withDeliveryWriteFence?: <T>(request: B3DeliveryWriteFenceRequest, work: () => T) => Promise<T>;
  /** Task 5's listener owner supplies the registry close; absence is refused before subscriber revocation writes. */
  readonly closeSubscriberStreams?: (input: {
    readonly subscriberId: string;
    readonly subscriberVersion: number;
  }) => void;
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
