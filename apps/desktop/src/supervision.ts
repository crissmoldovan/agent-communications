export type SupervisionView = {
  revision: number;
  keepCollectingAfterQuit: boolean;
  profileConfigured: boolean;
  state: 'idle' | 'starting' | 'cancelling' | 'running' | 'stopping';
  attached: boolean;
};

export type StartSelection = {
  executable: string;
  stateDir: string;
  configDir: string;
  expectedRevision: number;
  keepCollectingAfterQuit: boolean;
};

export type DesktopInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type SupervisionRequest = {
  requestEpoch: number;
  lifecycleEpoch: number;
};

/**
 * Binds every UI publication to both the request that produced it and the
 * current lifetime of the Settings webview. A hidden, closed, or purged
 * screen must never be repopulated by an earlier native command reply.
 */
export class WindowLifecycle {
  #requestEpoch = 0;
  #lifecycleEpoch = 0;

  request(): SupervisionRequest {
    this.#requestEpoch += 1;
    return { requestEpoch: this.#requestEpoch, lifecycleEpoch: this.#lifecycleEpoch };
  }

  hide(): void {
    this.#lifecycleEpoch += 1;
  }

  close(): void {
    this.#lifecycleEpoch += 1;
  }

  purge(): void {
    this.#lifecycleEpoch += 1;
  }

  publish(request: SupervisionRequest, apply: () => void): boolean {
    if (!this.isCurrent(request)) return false;
    apply();
    return true;
  }

  private isCurrent(request: SupervisionRequest): boolean {
    return request.requestEpoch === this.#requestEpoch && request.lifecycleEpoch === this.#lifecycleEpoch;
  }
}

export function supervisionCommands(invoke: DesktopInvoke) {
  return {
    status: () => invoke<SupervisionView>('desktop_supervision_status'),
    start: (selection: StartSelection) => invoke<SupervisionView>('desktop_start_daemon', { ...selection }),
    stop: () => invoke<SupervisionView>('desktop_quit_daemon'),
    openSecrets: () => invoke<void>('desktop_open_secrets'),
  };
}
