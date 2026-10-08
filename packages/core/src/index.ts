export * from './addresses.ts';
export * from './approval-binding.ts';
/*
 * What a person and an agent are told while an approval waits for the person (design 2026-10-05 §D7): the person's
 * located `approve` and the wait the agent learns from, made from the printing package's handoffs.
 */
export * from './approval-handoffs.ts';
export * from './approval-io.ts';
export * from './approval-legacy.ts';
/*
 * Daily approval retention (design 2026-10-05 §D9): `ApprovalStore.ensurePruned()` and what it reports. The batch's
 * own runner takes the store's internals, which are core's alone, and is not here.
 */
export {
  ensurePruned,
  MAINTENANCE_BUDGET_MS,
  MAINTENANCE_FUTURE_SKEW_MS,
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_LOCK_FILE,
  MAINTENANCE_RENEW_MS,
  MAINTENANCE_SLOTS,
  MAINTENANCE_STALE_MS,
  type MaintenanceError,
  type MaintenanceOptions,
  type MaintenanceStatus,
  type MaintenanceStep,
  PRUNE_STATE_FILE,
  type PruneCursor,
  type PruneState,
  parsePruneState,
  RETENTION_MS,
  type ReadPruneState,
  type RetainedApproval,
} from './approval-maintenance.ts';
export * from './approval-outcome.ts';
export * from './approval-stored.ts';
export * from './approval-validate.ts';
/*
 * Waiting for an approval (design 2026-10-05 §D3): the one operation behind every surface's wait — `agentcomms approval
 * wait`, `agent-gmail send wait`, `agent-slack approval wait`, `agent-resend send wait` and their tools.
 */
export { renderApprovalWait, type WaitCallContext, waitCallOptions } from './approval-wait-surface.ts';
export * from './approvals.ts';
export * from './audit.ts';
export * from './change-flow.ts';
export * from './changes.ts';
export * from './channel-manifest.ts';
export * from './channel-servers.ts';
export * from './chars.ts';
/*
 * The two kinds of command a person is told to run (CUE-403): one of this suite's own, which only the locator makes,
 * and another program's, made only by `externalCommand`. Their types are exported, and neither class nor brand is.
 */
export {
  type CliCommandBasis,
  type CliCommandCaller,
  type CliCommandLocated,
  type CliCommandNotLocated,
  type CliCommandRequest,
  type CliCommandResult,
  type CliDirection,
  type CliNotLocatedReason,
  locateCliCommand,
  type NodeRuntime,
  type PrintedCommand,
} from './cli-command.ts';
export * from './cli-runtime.ts';
export { type ExternalCommand, externalCommand } from './command-brands.ts';
export * from './compose-profile.ts';
export * from './config.ts';
export * from './core.ts';
export * from './digest.ts';
export * from './errors.ts';
export * from './fs.ts';
/*
 * The commands a package tells a person to run, located from where it is (CUE-403): `openCore({ caller })`, then
 * `core.handoffs`. See CONTRIBUTING.md, "Telling a person what to run". `CORE_CALLER` is core's own and is not here.
 */
export {
  type CliHandoffs,
  type CliHandoffsOptions,
  cliHandoffs,
  HANDOFF_FOLDERS,
  type Handoff,
  type HandoffSentenceOptions,
  type HandoffUse,
  handoffChoices,
  handoffSentence,
  handoffSentenceToFill,
  handoffText,
  handoffTextToFill,
  isCommand,
  type Remedy,
  type RemedyPart,
  remedy,
  requireHandoffs,
} from './handoffs.ts';
export * from './ids.ts';
export * from './internet-mark.ts';
export * from './jail.ts';
export * from './keys.ts';
export * from './known-folders.ts';
export * from './ledger.ts';
export * from './lock.ts';
export * from './mcp-clients.ts';
export * from './mcp-install.ts';
export * from './name-grammar.ts';
export * from './names.ts';
export * from './numbers.ts';
export * from './oauth-client-records.ts';
export {
  type ApprovalWait,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  MAX_WAITS,
  type WaitClock,
  type WaitEnd,
  type WaitOptions,
  type WaitProgress,
  waitForApproval,
} from './operations/approval-wait.ts';
export {
  type OrgAddRequest,
  type OrgChangeResult,
  type OrgOptions,
  orgAddChange,
} from './operations/organisations.ts';
/*
 * The registration and pruning changes, for the channels' own `mcp install` and `mcp prune`: the one change the core
 * server's `comms_server_install` and `comms_server_prune` make, so an approval for either is the other's too.
 */
export {
  type ServerInstallRequest,
  type ServerInstallResult,
  type ServerPruneRequest,
  serverInstallChange,
  serverPruneChange,
} from './operations/servers.ts';
export { type UpdateDeps, updateChange } from './operations/update.ts';
export {
  type UpdateAutoResult,
  type UpdateLaterResult,
  updateAutoChange,
  updateLaterChange,
} from './operations/update-settings.ts';
/*
 * Organisation profiles (design 2026-10-02): what a channel needs to read the record — whether a client row is an
 * organisation's, and the generations of its client. The core writes the record; nothing else does.
 */
export {
  activeGeneration,
  GENERATION_LIMIT,
  type GenerationState,
  generationState,
  learnProfileSlackAppId,
  managingOrganisation,
  type OrganisationProfile,
  organisationProfileSchema,
  organisationsOf,
  PROFILE_ORGANISATION_MAX,
  type ProfileFile,
  type ProfileSlackTarget,
  parseProfile,
  profileSourcePath,
  readProfileFile,
  recordOf,
  requireLiveOrganisationGeneration,
  resolveProfileSlackTarget,
  shownPath,
  shownText,
} from './organisations.ts';
export * from './other-servers.ts';
export * from './output.ts';
export * from './paths.ts';
export * from './plans.ts';
export * from './reconcile.ts';
export * from './render.ts';
export * from './sanitize.ts';
export * from './save-deny.ts';
export * from './save-destination.ts';
export * from './saved-files.ts';
export * from './secrets.ts';
export * from './send-epoch.ts';
export * from './send-pacing.ts';
export * from './sending-lease.ts';
export * from './state.ts';
export * from './system-programs.ts';
export * from './taint.ts';
export * from './tool-arguments.ts';
/*
 * The unsent report (design 2026-10-05 §D9): drafts grouped by each channel's declared rule, worded to the evidence the
 * scan read. A channel's own surfaces show it.
 */
export * from './unsent-report.ts';
export * from './untrusted.ts';
/*
 * The daily update check (design 2026-09-28). The reader and the gate carry no network code, and are all WhatsApp
 * imports; the checker and the update asks the registry, and every other package imports them for its servers' and
 * commands' gates.
 */
export * from './update-check.ts';
export * from './update-gate.ts';
export * from './update-state.ts';
export { VERSION } from './version.ts';
export * from './versions.ts';

export const PACKAGE_NAME = '@agentcomms/core';
