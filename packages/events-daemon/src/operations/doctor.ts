import { EventControlClient } from '../control/client.ts';

export interface EventsDoctorReport {
  readonly owner: 'running';
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly switchGeneration: number;
  readonly protocolVersions: readonly number[];
  readonly installationId: string;
}

export async function doctor(options: { readonly stateDir?: string | undefined } = {}): Promise<EventsDoctorReport> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('doctor')) as EventsDoctorReport;
}
