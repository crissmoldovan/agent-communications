import { CommsError } from '@agentcomms/core';
import { isLinearId } from '../domain/linear-target.ts';
import type { EventSecretStore } from '../store/event-secrets.ts';
import { providerSecretOwner } from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';
import type { LinearClient, LinearOutcome } from './linear-client.ts';

/*
 * Settings → Integrations → Linear (0.33.0 design §3.4): `integration show linear` says whether a Linear key is kept,
 * and with one asks Linear which workspace and teams it can see — and, for one team, the labels an issue there can
 * carry. It is the person's read, in the app or at a terminal: the CLI refuses it inside an MCP server's process, the
 * owner refuses an agent window's call, and no MCP tool reaches it. The key is read from its slot here and goes only to
 * Linear's GraphQL endpoint; nothing Linear says is kept.
 */

export interface LinearTeamV1 {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface LinearLabelV1 {
  readonly id: string;
  readonly name: string;
}

export interface IntegrationShowResultV1 {
  readonly integration: 'linear';
  readonly connected: boolean;
  /** The workspace's name, as Linear gives it; null without a key. */
  readonly workspace: string | null;
  readonly teams: readonly LinearTeamV1[];
  /** The labels an issue in the team asked for can carry — the team's and the workspace's — when one was asked for. */
  readonly labels?: readonly LinearLabelV1[];
}

const WORKSPACE_QUERY =
  'query AgentCommsLinearWorkspace { viewer { organization { name } } teams(first: 100) { nodes { id key name } } }';
const LABELS_QUERY =
  'query AgentCommsLinearLabels($team: String!) { team(id: $team) { labels(first: 250) { nodes { id name } } } issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name } } }';

/** Text Linear gave, as a person reads it: one line, no control characters, at most 200 characters. */
function shown(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters it removes.
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu, ' ').trim();
  return text.length === 0 ? null : text.slice(0, 200);
}

function nodes(value: unknown): readonly Record<string, unknown>[] {
  const list = (value as { nodes?: unknown } | null)?.nodes;
  return Array.isArray(list) ? list.filter((entry) => typeof entry === 'object' && entry !== null) : [];
}

function failed(outcome: Exclude<LinearOutcome, { kind: 'data' }>): never {
  if (outcome.kind === 'refused' && (outcome.code === 'AUTHENTICATION_ERROR' || [401, 403].includes(outcome.status)))
    throw new CommsError('AUTH_REQUIRED', 'Linear refused the key: add a new one in Settings → Integrations', {
      details: { reason: 'LINEAR_KEY_REFUSED', code: outcome.code },
    });
  if (outcome.kind === 'refused')
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Linear refused the request', {
      details: { reason: 'LINEAR_REFUSED', code: outcome.code },
    });
  throw new CommsError('TRANSIENT', 'Linear could not be reached; try again shortly', {
    details: { reason: outcome.kind === 'rate-limited' ? 'LINEAR_RATE_LIMITED' : 'LINEAR_UNAVAILABLE' },
  });
}

export class LinearIntegration {
  readonly #secrets: Pick<EventSecretStore, 'readLiveGenerations'>;
  readonly #cipher: EventRecordCipher;
  readonly #client: Pick<LinearClient, 'request'>;

  constructor(input: {
    readonly secrets: Pick<EventSecretStore, 'readLiveGenerations'>;
    readonly cipher: EventRecordCipher;
    readonly client: Pick<LinearClient, 'request'>;
  }) {
    this.#secrets = input.secrets;
    this.#cipher = input.cipher;
    this.#client = input.client;
  }

  /** The person's current Linear key, or null when none is kept. */
  async key(): Promise<string | null> {
    const generations = await this.#secrets.readLiveGenerations({
      owner: providerSecretOwner('linear'),
      purpose: 'provider-key',
      cipher: this.#cipher,
    });
    return generations.find((generation) => generation.lifecycle === 'current')?.material ?? null;
  }

  async show(args: Readonly<Record<string, unknown>>): Promise<IntegrationShowResultV1> {
    if (args.integration !== 'linear') throw new CommsError('USAGE', 'the integration is linear');
    const team = args.team;
    if (team !== undefined && (typeof team !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(team)))
      throw new CommsError('USAGE', 'a team is named by its key, such as CUE, or its id');
    const key = await this.key();
    if (key === null) return { integration: 'linear', connected: false, workspace: null, teams: [] };
    const workspace = await this.#client.request({ key, query: WORKSPACE_QUERY, variables: {} });
    if (workspace.kind !== 'data') failed(workspace);
    const teams = nodes(workspace.data.teams).flatMap((entry) => {
      const name = shown(entry.name);
      return isLinearId(entry.id) && typeof entry.key === 'string' && /^[A-Za-z0-9_]{1,32}$/u.test(entry.key)
        ? [{ id: entry.id, key: entry.key, name: name ?? entry.key }]
        : [];
    });
    const organization = (workspace.data.viewer as { organization?: { name?: unknown } } | null)?.organization;
    const result = {
      integration: 'linear' as const,
      connected: true,
      workspace: shown(organization?.name) ?? 'Linear',
      teams,
    };
    if (team === undefined) return result;
    const chosen = teams.find((entry) => entry.id === team || entry.key.toLowerCase() === team.toLowerCase());
    if (chosen === undefined)
      throw new CommsError('NOT_FOUND', 'the Linear key sees no such team', { details: { reason: 'LINEAR_TEAM' } });
    const labels = await this.#client.request({ key, query: LABELS_QUERY, variables: { team: chosen.id } });
    if (labels.kind !== 'data') failed(labels);
    const found = new Map<string, LinearLabelV1>();
    for (const entry of [
      ...nodes((labels.data.team as { labels?: unknown } | null)?.labels),
      ...nodes(labels.data.issueLabels),
    ]) {
      const name = shown(entry.name);
      if (isLinearId(entry.id) && name !== null && !found.has(entry.id))
        found.set(entry.id, { id: entry.id, name: name.slice(0, 80) });
    }
    return {
      ...result,
      labels: [...found.values()].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : left.id < right.id ? -1 : 1,
      ),
    };
  }
}
