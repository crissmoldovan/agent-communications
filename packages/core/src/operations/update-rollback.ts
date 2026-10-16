import { basename } from 'node:path';
import type { GatedChange } from '../change-flow.ts';
import { SERVERS, type ServerId, serverFacts, serverLabel } from '../channel-servers.ts';
import type { Core } from '../core.ts';
import { CommsError, toCommsError } from '../errors.ts';
import {
  launcherCanStart,
  launcherName,
  launcherPaths,
  launcherRuntimeVersion,
  readPointer,
  rollbackPointer,
} from '../launcher.ts';

/**
 * Back to the release before (design 2026-10-16, U6): every stable launcher on this machine switched back to the
 * runtime it started before its last switch — `agentcomms update --rollback`, or `comms_update` with `rollback`.
 *
 * A change the person approves, like the update it undoes: one effect a launcher, so the approval is bound to exactly
 * which launchers go back and to which release, and a launcher switched since the preview is another change, refused.
 * It switches pointers and nothing else: no client configuration is edited, no runtime is installed or removed, and a
 * server already running keeps the code it started with until its client starts it again. The runtime it leaves
 * becomes the launcher's previous one, so a second rollback goes forward again.
 */

/** One launcher that has a release before to go back to. */
interface RollbackPlan {
  channel: ServerId;
  package: string;
  name: string;
  launcher: string;
  /** The runtime it starts now, and the one it goes back to. */
  current: string;
  previous: string;
}

export interface RollbackStep {
  kind: 'pointer';
  channel: ServerId;
  package: string;
  launcher: string;
  /** The release it started, and the one it starts now; null for a runtime whose folder names none. */
  from: string | null;
  to: string | null;
  /** The runtime it starts now. */
  runtime: string;
  outcome: 'switched' | 'failed';
  detail?: string | undefined;
}

export interface UpdateRollbackResult {
  /** `rolled-back`: every launcher went back. `failed`: one did not, as its step says. `nothing`: none could. */
  status: 'rolled-back' | 'failed' | 'nothing';
  steps: RollbackStep[];
  /** Launchers with no release before to go back to, each with why. */
  left: { channel: ServerId; launcher: string; reason: string }[];
  ok: boolean;
  /** What the person does next: restart the clients. Null when nothing went back. */
  next: string | null;
}

/** The release a runtime folder is, or its folder's name when it is not one. */
function releaseOf(runtime: string, name: string): string {
  return launcherRuntimeVersion(runtime, name) ?? basename(runtime);
}

/** Every launcher that can go back, and every one that cannot, with why: read from the pointers alone. */
async function planRollback(core: Core): Promise<{ plans: RollbackPlan[]; left: UpdateRollbackResult['left'] }> {
  const { dataDir } = core.paths;
  const plans: RollbackPlan[] = [];
  const left: UpdateRollbackResult['left'] = [];
  for (const channel of SERVERS) {
    const { packageName } = serverFacts(channel);
    const name = launcherName(packageName);
    const { launcher } = launcherPaths(dataDir, name);
    let pointer: Awaited<ReturnType<typeof readPointer>>;
    try {
      pointer = await readPointer(dataDir, name);
    } catch (error) {
      left.push({ channel, launcher, reason: toCommsError(error).message });
      continue;
    }
    // No launcher here: nothing of it to go back to, and nothing to say.
    if (pointer === undefined) continue;
    if (pointer.previous === undefined) {
      left.push({ channel, launcher, reason: 'it has started one release only, so there is none before it' });
      continue;
    }
    if (!(await launcherCanStart(pointer.previous, name))) {
      left.push({
        channel,
        launcher,
        reason: `the release before, in ${pointer.previous}, is no longer there to start`,
      });
      continue;
    }
    plans.push({ channel, package: packageName, name, launcher, current: pointer.current, previous: pointer.previous });
  }
  return { plans, left };
}

export function updateRollbackChange(core: Core): GatedChange<UpdateRollbackResult> {
  let planned: { plans: RollbackPlan[]; left: UpdateRollbackResult['left'] } | null = null;
  return {
    plan: async (config) => {
      planned = await planRollback(core);
      const { plans } = planned;
      return {
        before: config,
        after: config,
        effects: plans.map(
          (plan) =>
            `switches the ${serverLabel(plan.channel)} stable launcher ${plan.launcher} back from ${releaseOf(plan.current, plan.name)} to ${releaseOf(plan.previous, plan.name)}; no client configuration is changed`,
        ),
        summary:
          plans.length > 0
            ? `Roll agent-communications back to the release before: ${plans.length} ${plans.length === 1 ? 'launcher' : 'launchers'}`
            : 'Look for a release before to roll back to',
      };
    },
    apply: async () => {
      if (planned === null) throw new CommsError('UNEXPECTED', 'the rollback was applied before it was planned');
      const steps: RollbackStep[] = [];
      for (const plan of planned.plans) {
        const base = {
          kind: 'pointer' as const,
          channel: plan.channel,
          package: plan.package,
          launcher: plan.launcher,
          from: launcherRuntimeVersion(plan.current, plan.name),
          to: launcherRuntimeVersion(plan.previous, plan.name),
        };
        try {
          // Only from the runtime the preview named: a launcher switched since is not what was approved.
          const { to } = await rollbackPointer(core.paths.dataDir, plan.name, { expect: plan.current });
          steps.push({ ...base, runtime: to, outcome: 'switched' });
        } catch (error) {
          steps.push({ ...base, runtime: plan.current, outcome: 'failed', detail: toCommsError(error).message });
        }
      }
      const ok = steps.every((step) => step.outcome === 'switched');
      const switched = steps.some((step) => step.outcome === 'switched');
      return {
        status: steps.length === 0 ? 'nothing' : ok ? 'rolled-back' : 'failed',
        steps,
        left: planned.left,
        ok,
        next: switched
          ? 'Restart each MCP client that starts these servers — in Claude Code, /mcp and then Reconnect — to run the release before: a server already running keeps its code until then. Rolling back again goes forward again.'
          : null,
      };
    },
    refuseApproval: (approvalId) =>
      new CommsError('USAGE', 'nothing was changed: no stable launcher here has a release before to go back to', {
        hint: 'So the rollback needs no approval, and takes none. The same call without it says which launchers there are and why none can go back.',
        details: { approvalId },
      }),
  };
}
