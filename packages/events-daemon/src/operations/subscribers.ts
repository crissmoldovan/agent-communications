import { CommsError } from '@agentcomms/core';
import { EventControlClient } from '../control/client.ts';
import type { PersonSetupOrigin } from '../domain/judge-setup.ts';
import type { SubscriptionApprovalResultV1 } from '../runtime/judge-setup.ts';

type Options = { readonly stateDir?: string | undefined };

export async function subscribersList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('subscribersList');
}

export async function addSubscriber(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('addSubscriber', { document });
}

export async function updateSubscriber(document: unknown, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('updateSubscriber', { document });
}

export async function removeSubscriber(subscriberId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('removeSubscriber', { subscriberId });
}

/**
 * Prepares one inert subscriber version's events for the person's approval (0.36.0, W29), as `workflow enable` prepares
 * a workflow's: the prepared activation, with its approval id and its binding's digest. Nothing is approved here.
 */
export async function enableSubscriber(subscriberId: string, version: number, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('subscriber-enable', { subscriberId, version });
}

const APPROVAL_ID = /^ap_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

/**
 * A subscriber version's events, approved by the person in the Agent Comms app after its preview (0.36.0, W29): the
 * owner's `subscriber-approve` wire, from the origin the CLI found, for exactly the digest the person saw. At a terminal
 * the person approves with `approve`, which asks for the challenge.
 */
export async function approveSubscriberFromApp(
  approvalId: string,
  digest: string,
  options: Options & { readonly origin: PersonSetupOrigin },
): Promise<SubscriptionApprovalResultV1> {
  if (!APPROVAL_ID.test(approvalId)) throw new CommsError('USAGE', 'that is not an approval id');
  if (!DIGEST.test(digest)) throw new CommsError('USAGE', 'the digest is the 64 hex digits its preview showed');
  return (await new EventControlClient({ stateDir: options.stateDir, clientName: options.origin }).request(
    'subscriber-approve',
    { approvalId, digest },
  )) as SubscriptionApprovalResultV1;
}
