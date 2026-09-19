import { ApprovalStore } from './approvals.ts';
import { AuditLog } from './audit.ts';
import { ConfigStore, secretsStoreOf } from './config.ts';
import { SendLedger } from './ledger.ts';
import { type PathEnvironment, type ResolvedPaths, resolvePaths } from './paths.ts';
import { PlanStore } from './plans.ts';
import { keychainNamespace, openSecretStore, type SecretStore, type SecretStoreKind } from './secrets.ts';
import { InboxStateStore } from './state.ts';
import { TaintStore } from './taint.ts';

/** Everything a provider package needs from the core, wired to one config directory. */
export interface Core {
  paths: ResolvedPaths;
  config: ConfigStore;
  states: InboxStateStore;
  approvals: ApprovalStore;
  ledger: SendLedger;
  plans: PlanStore;
  taint: TaintStore;
  audit: AuditLog;
  /** Opens the config directory's one secret backend (as recorded in config, or `kind` before the first write). */
  secrets(kind?: SecretStoreKind): Promise<SecretStore>;
}

export interface OpenCoreOptions extends PathEnvironment {
  now?: () => Date;
}

export function openCore(options: OpenCoreOptions = {}): Core {
  const paths = resolvePaths(options);
  const now = options.now ?? (() => new Date());
  const config = new ConfigStore(paths.configDir);
  let cached: { kind: SecretStoreKind; store: SecretStore } | null = null;
  return {
    paths,
    config,
    states: new InboxStateStore(paths.stateDir),
    approvals: new ApprovalStore(paths.stateDir, { now }),
    ledger: new SendLedger(paths.stateDir, now),
    plans: new PlanStore(paths.stateDir, now),
    taint: new TaintStore(paths.stateDir, now),
    audit: new AuditLog(paths.stateDir, now),
    async secrets(kind?: SecretStoreKind): Promise<SecretStore> {
      const chosen = kind ?? secretsStoreOf(await config.load());
      if (cached?.kind === chosen) return cached.store;
      const store = await openSecretStore(chosen, {
        secretsDir: paths.secretsDir,
        namespace: keychainNamespace(paths.configDir),
      });
      cached = { kind: chosen, store };
      return store;
    },
  };
}
