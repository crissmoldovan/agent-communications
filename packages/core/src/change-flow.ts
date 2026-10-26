import { approvalWaitOf, approveAndWaitSentence } from './approval-handoffs.ts';
import type { ApprovalObject } from './approval-outcome.ts';
import {
  approveChangeInApp,
  beginChangeApproval,
  type ChangeRequest,
  type ChangeSurface,
  claimChangeApproval,
  finishChangeApproval,
  type PreparedChange,
  prepareChange,
  recordChangeApprovalRefused,
  revokeChange,
} from './changes.ts';
import {
  agentMarker,
  canPrompt,
  defaultStreams,
  inlineCommand,
  insertWordsBeforeSentinel,
  paint,
  refuseUnlessPerson,
  type Streams,
} from './cli-runtime.ts';
import { type Config, classifyChange, type LooseningConsent } from './config.ts';
import type { Core } from './core.ts';
import { type DesktopOrigin, desktopAppOrigin, type TouchedFolder } from './desktop-origin.ts';
import { CommsError } from './errors.ts';
import { type CliHandoffs, type Handoff, handoffSentence, isCommand, requireHandoffs } from './handoffs.ts';
import { homeDirectory } from './paths.ts';

/**
 * One changing operation, run the same way from the CLI and from MCP.
 *
 * Every command and tool that changes an account — connecting one, widening it, loosening a policy, removing it —
 * goes through here, so the two surfaces cannot drift in how they ask. Three agents built those commands and tools in
 * parallel; one shape written once is the only way they stay the same shape.
 *
 * `plan` computes the change from the configuration as it stands *now*, and runs on both calls. That is what makes
 * the second call safe: the approval is claimed against the change as it would happen at that moment, and
 * `claimChange` refuses when that is no longer what the person approved.
 */
export interface GatedChange<T> {
  /** Computes the change from the configuration as it is now. */
  plan: (config: Config) => ChangeRequest | Promise<ChangeRequest>;
  /** Applies it. `consent` is what `ConfigStore.update` needs for a loosening; undefined when nothing loosens. */
  apply: (consent: LooseningConsent | undefined, request: ChangeRequest) => Promise<T>;
  /**
   * The refusal for an approval handed to this change when, as things stand, it needs none — in the change's own
   * words. Left out, it is the general one, which says to make the same call again without the approval because it
   * then applies at once. That is true of a tightening, and not of a change that needs none because nothing is left to
   * do: the update, once another call has brought everything to the latest release, applies nothing however it is
   * called, and "applies at once" sent an agent to apply an update that was no longer there (CUE-303).
   *
   * Only the words are the change's. It is refused whatever this returns, and the approval is not claimed.
   */
  refuseApproval?: ((approvalId: string) => CommsError | Promise<CommsError>) | undefined;
}

export type GatedOutcome<T> =
  | {
      status: 'applied';
      result: T;
      /**
       * Where the approval it was applied with stands — used, and when (design 2026-10-05 §D8) — or absent for a
       * change applied at once, which had none.
       */
      approval?: ApprovalObject | undefined;
    }
  | { status: 'approval-required'; prepared: PreparedChange };

/**
 * Applies a change at once when it needs nobody's agreement; otherwise prepares an approval the first time and claims
 * it on the second call, with its id.
 *
 * A change that loosens no setting and does nothing irreversible is applied directly: asking a person to agree to
 * something that needs no agreement teaches them to agree without reading. It refuses an approval id — in the change's
 * own words when it has them (`refuseApproval`) — as a report refuses one (`refuseApprovalWithoutChange`), rather than
 * applying and dropping it: the update check's stop lets a call claiming an approval through (design 2026-09-28 §2),
 * and one that is then never claimed would carry any approval the store holds — one an agent had just had prepared for
 * "not now", say — past the stop, to a tightening or a cancellation made where the call itself was stopped.
 */
export async function gatedChange<T>(
  core: Core,
  change: GatedChange<T>,
  options: {
    surface: ChangeSurface;
    /** The manifest channel of the surface making the change — `core` for core's own — recorded on its approval. */
    channel: string;
    approvalId?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    /** A person at this terminal is asked for the yes, so a preview prepared now says so (`PrepareChangeOptions`). */
    askedHere?: boolean | undefined;
  },
): Promise<GatedOutcome<T>> {
  const request = await change.plan(await core.config.load());
  const loosens = classifyChange(request.before, request.after).loosened.length > 0;
  const acts = (request.effects ?? []).length > 0;
  if (!loosens && !acts) {
    if (options.approvalId) {
      const refusal = await change.refuseApproval?.(options.approvalId);
      if (refusal !== undefined) throw refusal;
      throw new CommsError(
        'USAGE',
        'nothing was changed: as things stand this change needs no approval, so it takes none',
        {
          hint: 'Make the same call again without the approval: it applies at once and asks nobody. An approval is spent only on the change it was prepared for.',
          details: { approvalId: options.approvalId },
        },
      );
    }
    return { status: 'applied', result: await change.apply(undefined, request) };
  }
  if (!options.approvalId) {
    return {
      status: 'approval-required',
      prepared: await prepareChange(core, request, {
        surface: options.surface,
        channel: options.channel,
        platform: options.platform,
        askedHere: options.askedHere,
      }),
    };
  }
  const { consent, approval } = await claimChangeApproval(core, options.approvalId, request, {
    surface: options.surface,
    platform: options.platform,
  });
  return { status: 'applied', result: await change.apply(consent, request), approval };
}

/**
 * Refuses an approval id, as USAGE, on a call that takes one and would not claim it: a report, a dry run, a list of
 * steps, the end of a sign-in already started — what a tool or command that changes things does on the calls that
 * change nothing.
 *
 * The update check's stop lets a call claiming an approval through (design 2026-09-28 §2), because a claimed approval
 * is the person's earlier yes. A path that took the id and then only read dropped it, so any approval the store holds
 * got that path past the stop — "not now" among them, which an agent that was stopped can have prepared without the
 * person, since the update's own tool is never stopped. That undid the rule that "not now" is the person's decision.
 * So such a path refuses the id before it does anything, as `gatedChange` refuses one on a change that needs none, and
 * a report of the change policy refuses one (`refuseApprovalWithoutChange`). `message` and `hint` are the surface's
 * own words — its flag or its argument, and the call that does take the approval.
 */
export function refuseUnclaimedApproval(approvalId: unknown, refusal: { message: string; hint: string }): void {
  if (approvalId === undefined) return;
  throw new CommsError('USAGE', refusal.message, { hint: refusal.hint });
}

/**
 * The same, as an MCP tool returns it.
 *
 * `approvalRequired` with the preview and what to do next, or the result. The agent shows the preview in full and
 * asks; under `chat` it calls the tool again with `approvalId` once the person says yes, and under `confirm` it gives
 * them the command and calls again after they have run it.
 */
export function changeToolResult<T>(outcome: GatedOutcome<T>): Record<string, unknown> {
  // Applied with an approval: where it stands now — used — as every result that spends one says (§D8).
  if (outcome.status === 'applied') {
    return {
      applied: true,
      result: outcome.result as unknown,
      ...(outcome.approval === undefined ? {} : { approval: outcome.approval }),
    };
  }
  const { prepared } = outcome;
  return {
    applied: false,
    approvalRequired: true,
    approvalId: prepared.approvalId,
    policy: prepared.policy,
    summary: prepared.summary,
    preview: prepared.preview,
    expiresAt: prepared.expiresAt,
    next: prepared.next,
    // Where the approval stands (design 2026-10-05 §D8): pending, and whether the person's yes in the chat claims it.
    approval: prepared.approval,
  };
}

/**
 * A changing command at the CLI.
 *
 * With `--approval <id>` it claims that approval and applies. Without one, a person at a terminal approves there and
 * then: a plain `yes` under `chat`, the typed code under `confirm` — the person *is* the approver, so there is nobody to
 * send away. An agent, or anything without a terminal, gets the preview and the approval id and exits 10, exactly as a
 * post waiting for approval does; it runs the command again with `--approval <id>` once the person has agreed.
 */
export async function gatedChangeAtTerminal<T>(
  core: Core,
  change: GatedChange<T>,
  options: {
    /** The manifest channel of the command — `core` for core's own — recorded on the change's approval. */
    channel: string;
    approvalId?: string | undefined;
    env: NodeJS.ProcessEnv;
    output: { json?: boolean | undefined; color: boolean; platform?: NodeJS.Platform | undefined };
    /**
     * The words of this command after its program — `['policy', 'chat']` — to run again with `--approval <id>`: located
     * as the printing package's own CLI (`core.handoffs`), the approval inserted before any `--`.
     */
    rerun: readonly string[];
    /** Whose CLI `rerun` is: the printing package's own (left out), or core's — `update --later` from a channel's gate. */
    rerunOn?: 'own' | 'core' | undefined;
    /** A safe replacement when the command cannot be repeated, for example because showing its path changes it. */
    pendingHint?: ((prepared: PreparedChange) => string) | undefined;
    /**
     * The option that carries the approval on this command, when it is not `--approval`: `setup` registers a server
     * with `--mcp-approval`, because its `--approval` is already the OAuth client's, a different change.
     */
    approvalFlag?: string | undefined;
    /**
     * The person at this terminal has already said yes to this change, in this command, a moment ago — `agent-gmail
     * setup`'s "Connect this to an agent?". Under `chat` that answer is the approval: asking again for what they have
     * just asked for teaches people to agree without reading. Under `confirm` the code is still asked, because a
     * typed code is what that policy means. It counts only for a person; an agent still gets the approval id.
     */
    answered?: boolean | undefined;
    /**
     * The approval the desktop app prepared for this change and the person approved there (`--app-approval <id>`:
     * `mcp install` from 0.32.0; `label`, `behaviour allow|clear` and `update` from 0.34.0): approved through the app
     * channel and claimed by this change, as judge setup's are. Refused to an agent's shell and inside an MCP server's
     * process; never with `approvalId`.
     */
    appApproval?: string | undefined;
    /**
     * What the command reaches outside Agent Comms' own folders, for the test build's origin check: the apps' MCP configs
     * (`mcp install`, `update`) and npm's global packages (`update`).
     */
    appReach?: AppReach | undefined;
    /** Where an app approval came from (`desktopAppOrigin`, handed the folders it is for); injected by tests only. */
    appOrigin?: AppOriginCheck | undefined;
    streams?: Streams | undefined;
  },
): Promise<T> {
  if (options.appApproval !== undefined) return appliedFromApp(core, change, options, options.appApproval);
  const streams = options.streams ?? defaultStreams;
  // Decided before anything is prepared, so the preview a person here reads says their yes is given here.
  const person =
    agentMarker(options.env) === null && canPrompt(options.env, streams, { json: options.output.json === true });
  const first = await gatedChange(core, change, {
    surface: 'cli',
    channel: options.channel,
    approvalId: options.approvalId,
    platform: options.output.platform,
    askedHere: person,
  });
  if (first.status === 'applied') return first.result;

  const { prepared } = first;
  if (!person) {
    /*
     * The preview is what the agent has to show the person, so it is printed, not only tucked into the JSON
     * envelope's details: an agent reading plain output saw "needs approval" and nothing to show.
     */
    if (options.output.json !== true) streams.stdout.write(`${prepared.preview}\n\n`);
    const carrying = [options.approvalFlag ?? '--approval', prepared.approvalId];
    const handoffs = requireHandoffs(core, options.output.platform);
    throw new CommsError('APPROVAL_PENDING', `this change needs approval first: ${prepared.summary}`, {
      hint:
        options.pendingHint?.(prepared) ??
        approvalHint(
          prepared,
          handoffs[options.rerunOn ?? 'own'](insertWordsBeforeSentinel(options.rerun, ...carrying)),
          handoffs,
        ),
      details: {
        approvalId: prepared.approvalId,
        policy: prepared.policy,
        preview: prepared.preview,
        expiresAt: prepared.expiresAt,
        approval: prepared.approval,
      },
    });
  }

  if (prepared.policy === 'confirm') {
    const outcome = await approveChangeAtTerminal(core, prepared.approvalId, options.env, options.output, streams);
    if (outcome.state !== 'approved') throw cancelled();
  } else if (options.answered !== true) {
    streams.stdout.write(`${prepared.preview}\n\n`);
    const answer = await askLine(streams, `Type ${paint(options.output.color, 'bold', 'yes')} to apply this change: `);
    if (answer.trim().toLowerCase() !== 'yes') {
      await revokeChange(core, prepared.approvalId, 'cancelled at the terminal', {
        surface: 'cli',
        disposition: 'person',
      });
      throw cancelled();
    }
  }
  const second = await gatedChange(core, change, {
    surface: 'cli',
    channel: options.channel,
    approvalId: prepared.approvalId,
    platform: options.output.platform,
  });
  if (second.status !== 'applied') throw new CommsError('UNEXPECTED', 'the approved change asked for approval again');
  return second.result;
}

/**
 * What an agent is told to do with a change that is waiting for a person: show the preview, get the approval the
 * policy asks for, and run `rerun` — the same command, carrying the approval id.
 *
 * Shared with a command that reports a waiting change rather than failing on it — `agent-gmail setup`, which stops at
 * its registration step and says why in its report — so the two say it in the same words.
 */
export function approvalHint(
  prepared: Pick<PreparedChange, 'approvalId' | 'policy'>,
  rerun: Handoff,
  maker: CliHandoffs,
): string {
  // A command with no line is shown as its words, saying it has to be typed.
  const run = isCommand(rerun) ? inlineCommand(rerun) : null;
  // With either command missing, the sentence saying why stands in for it, never something else in its place.
  const rerunSaid = isCommand(rerun) ? '' : rerun.message;
  if (prepared.policy !== 'confirm') {
    return run === null
      ? `Show the person the preview. ${rerunSaid}`
      : `Show the person the preview. Once they say yes, run ${run}.`;
  }
  const approve = maker.own(['approve', prepared.approvalId]);
  if (!isCommand(approve)) {
    return `Show the person the preview. ${approve.message} ${run === null ? rerunSaid : `Then run ${run}.`}`;
  }
  // The person's `approve`, and the wait that learns when they have used it (design 2026-10-05 §D7).
  const handed = approveAndWaitSentence(maker, 'cli', prepared.approvalId, (command, wait) => {
    const learn = wait === undefined ? '' : `; learn when they have with ${wait}`;
    return run === null ? `They run ${command}${learn}.` : `They run ${command}${learn}, then run ${run}.`;
  });
  return `Show the person the preview. ${handed}${run === null ? ` ${rerunSaid}` : ''}`;
}

/**
 * Approves a configuration change at a terminal, the way a person approves a send: read the preview, type the code.
 *
 * Under the `confirm` change policy this is what "a person approved it" means, so it is the one command here an agent
 * may not run for the user, and it is refused by the same gate every other loosening goes through. A shell agent can
 * get past that gate — `script -q /dev/null` makes any command see a terminal — so it is a speed bump against the
 * ordinary case, as it is for every approval, not a boundary.
 *
 * It approves and changes nothing. What prepared the change makes it, by claiming the approval once; and a refusal to
 * even ask is recorded, so the audit trail shows an agent that tried.
 *
 * Exported so the whole command can be tested with streams that are a terminal: a subprocess test cannot have one.
 */
export async function approveChangeAtTerminal(
  core: Core,
  approvalId: string,
  env: NodeJS.ProcessEnv,
  output: { json?: boolean | undefined; color: boolean; platform?: NodeJS.Platform | undefined },
  streams: Streams = defaultStreams,
): Promise<{ approvalId: string; state: 'approved' | 'cancelled' }> {
  try {
    const handoffs = requireHandoffs(core, output.platform);
    refuseUnlessPerson(env, streams, {
      refusedToAgent: 'only a person can approve a change, not an agent',
      refusedWithoutTerminal: 'approving a change needs an interactive terminal',
      command: handoffs.own(['approve', approvalId]),
      // An agent is told what learns when the person has approved it (design 2026-10-05 §D7).
      wait: approvalWaitOf(handoffs, approvalId).command,
      color: output.color,
      json: output.json,
    });
  } catch (error) {
    await recordChangeApprovalRefused(core, approvalId, error, { surface: 'cli' });
    throw error;
  }
  const prompt = await beginChangeApproval(core, approvalId, { surface: 'cli' });
  streams.stdout.write(`${prompt.preview}\n\n`);
  const answer = await askLine(
    streams,
    `Type ${paint(output.color, 'bold', prompt.challenge)} to approve this change, or press Enter to cancel: `,
  );
  if (!answer.trim()) {
    await revokeChange(core, approvalId, 'cancelled at the terminal', { surface: 'cli', disposition: 'person' });
    return { approvalId, state: 'cancelled' };
  }
  await finishChangeApproval(core, approvalId, answer, { surface: 'cli' });
  return { approvalId, state: 'approved' };
}

function cancelled(): CommsError {
  return new CommsError('USAGE', 'cancelled: nothing was changed');
}

/** The environment variable an MCP server sets in its own process, which every program it starts inherits. */
const MCP_SERVER_MARKER = 'AGENTCOMMS_MCP_SERVER';

/**
 * A change the desktop app prepared, approved there by the person (0.32.0, design 2026-10-26-owner-feedback-0320
 * §3.3, §5 question 3), as judge setup's enablements are approved through the app channel (events design D2's note of
 * 2026-10-26): the app showed core's preview, the person pressed its confirm, and the app runs the same command with
 * the approval it was given. The change is planned first, from the configuration as it is now; the approval is checked
 * against it — a waiting change approval whose digest is this exact change's, which must need approval — and only then
 * is its code issued and answered (`approveChangeInApp`), so the record says `approvedVia: 'app'` and the audit line
 * `approvedBy: desktop-app`. This change then claims it, once, and applies; an approval answered and not applied is
 * revoked. A plan that refuses or throws, or an approval for anything else, approves nothing (the release's security
 * review, 2026-10-26).
 *
 * Who may: the person, in the Agent Comms app — on macOS a process the app itself started, as `desktopAppOrigin` checks
 * (a speed bump against agents, not a boundary against code running as the person). On Windows and Linux nothing
 * attests the app, so nothing is approved here: the person approves the change at their terminal (the second look at
 * 0.33.0; the app offers Approve in Terminal), and the refusal is audited as `desktop-app (unattested)`, so
 * `approvedVia: 'app'` means the attested app. Always refused to an agent's shell (its marker) and inside an MCP
 * server's process, before the approval is touched, and the refusal audited. What: only the change the approval was
 * prepared for, and only on a command that passes this option — `mcp install` (0.32.0), and the person-only changes
 * the app makes from 0.34.0: `label word|name|rule add|rule remove|icon|style`, `behaviour allow|clear` and `update`
 * (design 2026-10-26-desktop-0340 §3, B1–B3). No MCP tool does. Where nothing attests the app, the refusal names the
 * command itself, without the option, to run at the person's terminal.
 */
async function appliedFromApp<T>(
  core: Core,
  change: GatedChange<T>,
  options: {
    channel: string;
    approvalId?: string | undefined;
    env: NodeJS.ProcessEnv;
    output: { platform?: NodeJS.Platform | undefined };
    rerun: readonly string[];
    rerunOn?: 'own' | 'core' | undefined;
    appReach?: AppReach | undefined;
    appOrigin?: AppOriginCheck | undefined;
  },
  approvalId: string,
): Promise<T> {
  const platform = options.output.platform;
  if (options.approvalId !== undefined) {
    throw new CommsError('USAGE', 'an approval given in the app is not carried with --approval as well', {
      hint: 'Pass one of them: --app-approval is the app approving its own change.',
    });
  }
  let origin: DesktopOrigin = { ok: false, reason: 'not-checked' };
  let refusedAs: 'desktop-app (unattested)' | undefined;
  try {
    const marker = agentMarker(options.env);
    if (marker !== null) {
      throw new CommsError('APPROVAL_REQUIRED', 'only a person can approve a change in the app, not an agent', {
        hint: 'Ask the person to approve it in the Agent Comms app, or at their own terminal.',
        details: { marker },
      });
    }
    const server = options.env[MCP_SERVER_MARKER];
    if (server !== undefined && server !== '') {
      throw new CommsError(
        'APPROVAL_REQUIRED',
        "only a person can approve a change in the app, and an MCP server's process is not the app",
        { details: { reason: 'MCP_SERVER_PROCESS', marker: MCP_SERVER_MARKER } },
      );
    }
    // On macOS the process that started this one must be Agent Comms itself, its running code verified by its pid;
    // Windows and Linux attest nothing, so there the change is approved at the person's terminal instead.
    // Every folder the command will touch goes with it: the test build speaks only when its profile holds them all.
    const check = { configDir: core.paths.configDir, folders: touchedFolders(core, options.env, options.appReach) };
    origin = await (options.appOrigin ?? desktopAppOrigin)(check);
    if (!origin.ok && origin.reason === 'unattested-platform') {
      refusedAs = 'desktop-app (unattested)';
      throw new CommsError(
        'APPROVAL_REQUIRED',
        'nothing on this platform attests that the Agent Comms app started this, so approve the change at your terminal',
        { hint: atYourTerminal(core, options), details: { reason: 'ORIGIN_UNATTESTED' } },
      );
    }
    if (!origin.ok) {
      throw new CommsError(
        'APPROVAL_REQUIRED',
        'only the Agent Comms app can approve a change in the app, and this was not started by it',
        {
          hint: 'Approve it in the Agent Comms app, or at your own terminal.',
          details: { reason: origin.reason, ...(origin.outside === undefined ? {} : { outside: origin.outside }) },
        },
      );
    }
  } catch (error) {
    await recordChangeApprovalRefused(core, approvalId, error, { surface: 'app', approvedBy: refusedAs });
    throw error;
  }
  // Only an attested origin reaches here.
  if (!origin.ok) throw new CommsError('APPROVAL_REQUIRED', 'only the Agent Comms app can approve a change in the app');
  // Planned first, from the configuration as it is now: a plan that refuses or throws approves nothing.
  const request = await change.plan(await core.config.load());
  // Checked against the approval before it is answered: only this exact change, which must need approval.
  await approveChangeInApp(core, approvalId, request, {
    surface: 'app',
    platform,
    approvedBy: origin.build === 'test' ? 'desktop-app (test build)' : 'desktop-app',
  });
  try {
    const { consent } = await claimChangeApproval(core, approvalId, request, { surface: 'app', platform });
    return await change.apply(consent, request);
  } catch (error) {
    // Approved and then not applied: never left approved for anything else to claim.
    await revokeChange(core, approvalId, 'approved in the desktop app and not applied', {
      surface: 'app',
      disposition: 'person',
    }).catch(() => undefined);
    throw error;
  }
}

/** What a command run from the app reaches outside Agent Comms' own folders (`gatedChangeAtTerminal`'s `appReach`). */
export interface AppReach {
  /** The apps' MCP configs, which are under the home folder (and `CLAUDE_CONFIG_DIR`, `CODEX_HOME` when set). */
  readonly clients?: boolean | undefined;
  /** npm's global packages, in its global folder (`npm_config_prefix`). */
  readonly npmGlobal?: boolean | undefined;
}

/** The app-origin check, handed the config folder and every other folder the command touches (`desktopAppOrigin`). */
export type AppOriginCheck = (check: {
  configDir: string;
  folders: readonly TouchedFolder[];
}) => Promise<DesktopOrigin>;

/**
 * Every folder a change made from the app touches besides its config folder (the security review of 0.34.0, finding
 * 1): its state, data and secrets folders, and what `reach` adds — the home folder and the apps' own config folders for
 * a command that registers servers, and npm's global folder, which only `npm_config_prefix` names here, for one that
 * updates global packages.
 */
function touchedFolders(core: Core, env: NodeJS.ProcessEnv, reach: AppReach | undefined): TouchedFolder[] {
  const { stateDir, dataDir, secretsDir } = core.paths;
  const folders: TouchedFolder[] = [
    { what: 'state folder', path: stateDir },
    { what: 'data folder', path: dataDir },
    { what: 'secrets folder', path: secretsDir },
  ];
  if (reach?.clients === true) {
    folders.push({ what: 'home folder, where the apps keep their MCP configs', path: homeDirectory(env) });
    if (env.CLAUDE_CONFIG_DIR) folders.push({ what: "Claude Code's config folder", path: env.CLAUDE_CONFIG_DIR });
    if (env.CODEX_HOME) folders.push({ what: "Codex's config folder", path: env.CODEX_HOME });
  }
  if (reach?.npmGlobal === true) {
    folders.push({ what: "npm's global folder", path: env.npm_config_prefix || env.NPM_CONFIG_PREFIX || undefined });
  }
  return folders;
}

/**
 * What a person does where nothing attests the app: press Approve in Terminal, or run the command the app ran — its own
 * words, located, without `--app-approval` — at their own terminal, where they approve it there and then.
 */
function atYourTerminal(
  core: Core,
  options: {
    rerun: readonly string[];
    rerunOn?: 'own' | 'core' | undefined;
    output: { platform?: NodeJS.Platform | undefined };
  },
): string {
  const instead =
    'In the app, press Approve in Terminal; or run the same command at your own terminal, without --app-approval.';
  try {
    const handoffs = requireHandoffs(core, options.output.platform);
    return handoffSentence(
      handoffs[options.rerunOn ?? 'own'](options.rerun),
      (command) => `In the app, press Approve in Terminal; or run ${command} at your own terminal.`,
      { instead },
    );
  } catch {
    // A core opened with no caller names no command: the words alone, never a guess at one.
    return instead;
  }
}

async function askLine(streams: Streams, question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stderr as NodeJS.WritableStream,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
