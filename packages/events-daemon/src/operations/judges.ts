import { EventControlClient } from '../control/client.ts';
import { PERSON_SETUP_ORIGIN } from '../domain/judge-setup.ts';
import type { LayaModelStatus } from '../runtime/laya/contracts.ts';
import type { B3JudgeUnavailableV1 } from './b3-contract.ts';

type Options = { readonly stateDir?: string | undefined };

function request(operation: string, args: Record<string, unknown>, options: Options): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request(operation, args);
}

export function judgesList(options: Options = {}): Promise<unknown> {
  return request('judgesList', {}, options);
}
export function addJudge(document: unknown, options: Options = {}): Promise<unknown> {
  return request('addJudge', { document }, options);
}
export function updateJudge(document: unknown, options: Options = {}): Promise<unknown> {
  return request('updateJudge', { document }, options);
}
export function removeJudge(judgeId: string, options: Options = {}): Promise<unknown> {
  return request('removeJudge', { judgeId }, options);
}
export function judgeTest(judgeId: string, version: number, options: Options = {}): Promise<unknown> {
  return request('judgeTest', { judgeId, version }, options);
}
export function budgetShow(options: Options = {}): Promise<unknown> {
  return request('budgetShow', {}, options);
}
export function updateBudget(document: unknown, options: Options = {}): Promise<unknown> {
  return request('updateBudget', { document }, options);
}
export function judgeKindsList(options: Options = {}): Promise<unknown> {
  return request('judgeKindsList', {}, options);
}
export function enableJudgeKind(kind: string, options: Options = {}): Promise<unknown> {
  return request('enableJudgeKind', { kind }, options);
}
export function disableJudgeKind(kind: string, options: Options = {}): Promise<unknown> {
  return request('disableJudgeKind', { kind }, options);
}
export function judgeModelStatus(options: Options = {}): Promise<unknown> {
  return request('judgeModelStatus', {}, options) as Promise<LayaModelStatus | B3JudgeUnavailableV1>;
}
export function removeJudgeModel(options: Options = {}): Promise<LayaModelStatus | B3JudgeUnavailableV1> {
  return request('removeJudgeModel', {}, options) as Promise<LayaModelStatus | B3JudgeUnavailableV1>;
}

/**
 * `judge setup <kind>` (owner decision 2026-10-26): Jev, or a model server on this machine, set up and turned on in one
 * step — the judge, its key from the provider's stored key, the daemon-wide budget when there is none for its provider,
 * and the kind's enablement, which this command approves as the person's own act. The CLI refuses an agent and the MCP
 * server before it calls this; no MCP tool reaches it.
 */
export function judgeSetup(
  kind: string,
  input: {
    readonly provider?: string | undefined;
    readonly url?: string | undefined;
    readonly model?: string | undefined;
  } = {},
  options: Options = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir, clientName: PERSON_SETUP_ORIGIN }).request(
    'judge-setup',
    {
      kind,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.model === undefined ? {} : { model: input.model }),
    },
  );
}
