import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError, ensurePrivateDir, type LooseningConsent, writeFileAtomic } from '@cloudpixel/comms-core';
import type { GmailContext } from '../context.ts';

/**
 * Which MCP clients may be trusted to put an approval form in front of a person.
 *
 * Under the `confirm` policy the approval has to come from a channel the model cannot answer. An MCP form elicitation
 * is such a channel **only if the client actually shows it to a human** — `clientInfo.name` is self-reported, and a
 * client that auto-accepts forms, or answers them from the model, would turn the strongest gate in this package into
 * a formality. So the list is empty by default and fail-closed, and a name reaches it only by evidence: the client
 * raises a probe form carrying a code, a person types that code back, and only then may the name be added — at a
 * terminal, by a person, with the same consent every other loosening needs.
 */

const PROBE_TTL_MS = 10 * 60 * 1000;
const PROBE_FILE = 'confirm-probes.json';

export interface ProbeRecord {
  probeId: string;
  client: string;
  at: string;
  /** Set when the human typed the code back; an unanswered probe is evidence of nothing. */
  completed: boolean;
}

interface ProbeFile {
  version: 1;
  probes: ProbeRecord[];
}

function probePath(context: GmailContext): string {
  return join(context.core.paths.stateDir, PROBE_FILE);
}

async function readProbes(context: GmailContext): Promise<ProbeFile> {
  try {
    const parsed = JSON.parse(await readFile(probePath(context), 'utf8')) as ProbeFile;
    return { version: 1, probes: Array.isArray(parsed.probes) ? parsed.probes : [] };
  } catch {
    return { version: 1, probes: [] };
  }
}

async function writeProbes(context: GmailContext, file: ProbeFile): Promise<void> {
  await ensurePrivateDir(context.core.paths.stateDir);
  // Only the last hour is kept: a probe is evidence about a moment, and an old one proves nothing about now.
  const cutoff = context.now().getTime() - 60 * 60 * 1000;
  const probes = file.probes.filter((probe) => Date.parse(probe.at) >= cutoff);
  await writeFileAtomic(probePath(context), `${JSON.stringify({ version: 1, probes }, null, 2)}\n`);
}

export interface StartedProbe {
  probeId: string;
  /** The code the person must type back into the form. Four characters, like every other challenge here. */
  code: string;
}

/** Records that a client raised a probe, and returns the code the human has to type back into it. */
export async function startProbe(context: GmailContext, client: string): Promise<StartedProbe> {
  const name = client.trim();
  if (!name) throw new CommsError('USAGE', 'the client did not say what it is called');
  const file = await readProbes(context);
  const probeId = `pr_${randomBytes(9).toString('base64url')}`;
  const code = randomBytes(3).toString('base64url').slice(0, 4).toUpperCase();
  file.probes.push({ probeId, client: name, at: context.now().toISOString(), completed: false });
  await writeProbes(context, file);
  return { probeId, code };
}

/** Marks a probe answered. Called only after the typed code matched, inside the tool that raised it. */
export async function completeProbe(context: GmailContext, probeId: string): Promise<void> {
  const file = await readProbes(context);
  const probe = file.probes.find((entry) => entry.probeId === probeId);
  if (!probe) throw new CommsError('NOT_FOUND', 'that probe is no longer on record');
  probe.completed = true;
  probe.at = context.now().toISOString();
  await writeProbes(context, file);
}

/** Has this client proved, in the last ten minutes, that its forms reach a person? */
export async function hasRecentProbe(context: GmailContext, client: string): Promise<boolean> {
  const file = await readProbes(context);
  const cutoff = context.now().getTime() - PROBE_TTL_MS;
  return file.probes.some(
    (probe) => probe.completed && probe.client === client.trim() && Date.parse(probe.at) >= cutoff,
  );
}

export async function listConfirmClients(context: GmailContext): Promise<string[]> {
  return (await context.config()).defaults.confirm.elicitationClients;
}

/**
 * Adds a client to the allowlist. Refused unless that client completed a probe in the last ten minutes, and refused
 * again by the config store unless the caller carries consent — which only a person at a terminal can obtain.
 */
export async function addConfirmClient(
  context: GmailContext,
  client: string,
  consent: LooseningConsent,
): Promise<string[]> {
  const name = client.trim();
  if (!name) throw new CommsError('USAGE', 'name the client to trust');
  if (!(await hasRecentProbe(context, name))) {
    throw new CommsError('APPROVAL_REQUIRED', `"${name}" has not shown that its approval forms reach a person`, {
      hint: `In that client, ask it to run the gmail_confirm_probe tool and type the code it shows. Then run this again within ten minutes.`,
    });
  }
  const config = await context.core.config.update(
    (current) => ({
      ...current,
      defaults: {
        ...current.defaults,
        confirm: {
          ...current.defaults.confirm,
          elicitationClients: [...new Set([...current.defaults.confirm.elicitationClients, name])],
        },
      },
    }),
    { consent },
  );
  await context.core.audit.append({
    inboxId: '',
    operation: 'confirm-clients.add',
    outcome: 'ok',
    surface: context.surface,
    reason: name,
  });
  return config.defaults.confirm.elicitationClients;
}

/** Removes a client. Trusting one fewer client is a tightening, so it needs nothing but the command. */
export async function removeConfirmClient(context: GmailContext, client: string): Promise<string[]> {
  const name = client.trim();
  const config = await context.core.config.update((current) => ({
    ...current,
    defaults: {
      ...current.defaults,
      confirm: {
        ...current.defaults.confirm,
        elicitationClients: current.defaults.confirm.elicitationClients.filter((entry) => entry !== name),
      },
    },
  }));
  await context.core.audit.append({
    inboxId: '',
    operation: 'confirm-clients.remove',
    outcome: 'ok',
    surface: context.surface,
    reason: name,
  });
  return config.defaults.confirm.elicitationClients;
}
