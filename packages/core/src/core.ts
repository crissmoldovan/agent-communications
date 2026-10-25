import { ActivityLog } from './activity.ts';
import { readActivitySettings } from './activity-settings.ts';
import { ApprovalStore } from './approvals.ts';
import { AuditLog } from './audit.ts';
import type { CliCommandCaller } from './cli-command.ts';
import { ConfigStore, secretsStoreOf } from './config.ts';
import { type CliHandoffs, cliHandoffs } from './handoffs.ts';
import { SendLedger } from './ledger.ts';
import { type PathEnvironment, type PathOverrides, type ResolvedPaths, resolvePathIdentity } from './paths.ts';
import { PlanStore } from './plans.ts';
import { keychainNamespace, openSecretStore, type SecretStore, type SecretStoreKind } from './secrets.ts';
import { AckLedger } from './standing-ledger.ts';
import { InboxStateStore } from './state.ts';
import { TaintStore } from './taint.ts';
import { securityAnswered } from './update-state.ts';

/** Everything a provider package needs from the core, wired to one config directory. */
export interface Core {
  paths: ResolvedPaths;
  /** The subset of `paths` explicitly pinned by global CLI options. */
  pathOverrides: Readonly<PathOverrides>;
  config: ConfigStore;
  states: InboxStateStore;
  approvals: ApprovalStore;
  ledger: SendLedger;
  /**
   * The acknowledgement ledger (design 2026-10-19-standing-approvals, S6, S9): every use of a standing approval,
   * counted per account, under its own lock, before the use's child is minted — and never refunded.
   */
  acks: AckLedger;
  plans: PlanStore;
  taint: TaintStore;
  audit: AuditLog;
  /**
   * The activity log (design 2026-10-25-activity): one line per call an agent session makes to account data, private,
   * by day, under the settings in `config.json`'s `activity`. Never throws into a caller (`ActivityLog.append`).
   */
  activity: ActivityLog;
  /** Opens the config directory's one secret backend (as recorded in config, or `kind` before the first write). */
  secrets(kind?: SecretStoreKind): Promise<SecretStore>;
  /**
   * The commands this process tells a person to run — its own CLI's, core's, another product's — located from the
   * caller it was opened with (`OpenCoreOptions.caller`), for these folders. Undefined when none was given: then there
   * is no command to print at all, and anything that asks for one meets the programming error `requireHandoffs` throws —
   * never a bare name. Every package opens core with its caller.
   */
  handoffs?: CliHandoffs | undefined;
}

export interface OpenCoreOptions extends PathEnvironment {
  now?: () => Date;
  /**
   * The package opening core, so the commands it prints run its own installation: `{ url: import.meta.url, packageName }`
   * of a module of that package (see CONTRIBUTING.md, "Telling a person what to run").
   */
  caller?: CliCommandCaller | undefined;
}

export function openCore(options: OpenCoreOptions = {}): Core {
  const { paths, pathOverrides } = resolvePathIdentity(options);
  const now = options.now ?? (() => new Date());
  const handoffs =
    options.caller === undefined
      ? undefined
      : cliHandoffs({ caller: options.caller, paths, platform: options.platform, env: options.env });
  const config = new ConfigStore(paths.configDir, { handoffs });
  const audit = new AuditLog(paths.stateDir, now);
  let cached: { kind: SecretStoreKind; store: SecretStore } | null = null;
  return {
    paths,
    pathOverrides,
    config,
    states: new InboxStateStore(paths.stateDir),
    // The store's one window on the configuration — bound to this `ConfigStore`, whose `load` reads private state and
    // so must never be passed loose.
    // Its daily retention records each deletion in this same audit log (design 2026-10-05 §D9).
    approvals: new ApprovalStore(paths.stateDir, {
      now,
      handoffs,
      loadConfig: () => config.load(),
      audit,
      // A send or post answered: the security line its preview carried counts as asked (design 2026-10-16, U7).
      answered: (approvalId) => securityAnswered(paths.stateDir, approvalId),
    }),
    ledger: new SendLedger(paths.stateDir, now),
    acks: new AckLedger(paths.stateDir, now),
    plans: new PlanStore(paths.stateDir, now),
    taint: new TaintStore(paths.stateDir, now),
    audit,
    // Its settings read afresh for every line — the store answers from its cache while the file is unchanged — so
    // turning recording off applies at once in every process sharing this configuration.
    activity: new ActivityLog(paths.stateDir, {
      now,
      settings: async () => readActivitySettings(await config.load()),
    }),
    handoffs,
    async secrets(kind?: SecretStoreKind): Promise<SecretStore> {
      const chosen = kind ?? secretsStoreOf(await config.load());
      if (cached?.kind === chosen) return cached.store;
      const store = await openSecretStore(chosen, {
        secretsDir: paths.secretsDir,
        namespace: keychainNamespace(paths.configDir),
        handoffs,
      });
      cached = { kind: chosen, store };
      return store;
    },
  };
}
