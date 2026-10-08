import { EventControlClient } from '../control/client.ts';
import type { DryRunSummary } from '../runtime/dispatcher.ts';
import type { ActivationIntentStatusSummary } from './status.ts';

export interface EventsDoctorReport {
  readonly owner: 'running';
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly switchGeneration: number;
  readonly protocolVersions: readonly number[];
  readonly installationId: string;
  readonly activationIntents: readonly ActivationIntentStatusSummary[];
  readonly dryrun: DryRunSummary;
}

export async function doctor(options: { readonly stateDir?: string | undefined } = {}): Promise<EventsDoctorReport> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('doctor')) as EventsDoctorReport;
}
