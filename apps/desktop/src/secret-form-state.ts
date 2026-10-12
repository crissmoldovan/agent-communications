export type SecretResult =
  | { kind: 'Acknowledgement' }
  | { kind: 'RevealOnce'; material: string }
  | { kind: 'UrlFingerprint'; scheme: string; host: string; port: number; sha256: string }
  | { kind: 'MigrationStatus'; moved: number; leftovers: string[]; code?: string }
  | { kind: 'unavailable'; code: string };

export class SecretFormState {
  hidden = '';
  result: SecretResult | null = null;
  busy = false;
  message = '';
  #epoch = 0;
  #pendingInput: Record<string, unknown> | null = null;

  clear(_event = 'clear'): void {
    this.#epoch += 1;
    if (this.#pendingInput) delete this.#pendingInput.hidden;
    this.#pendingInput = null;
    this.hidden = '';
    this.result = null;
    this.busy = false;
    this.message = '';
  }

  snapshot() {
    return { hidden: this.hidden, result: this.result, busy: this.busy, message: this.message };
  }

  async submit(
    command: string,
    fields: Record<string, unknown>,
    invoke: (command: string, args: { input: Record<string, unknown> }) => Promise<SecretResult>,
  ): Promise<void> {
    const input = { ...fields, ...(this.hidden ? { hidden: this.hidden } : {}) };
    this.clear('submit');
    const epoch = this.#epoch;
    this.busy = true;
    this.#pendingInput = input;
    try {
      const pending = invoke(command, { input });
      // Tauri may asynchronously retry this same payload through postMessage after a fetch/CSP failure.
      // Only the in-flight bridge retains it; completion, failure or clear() removes the hidden field.
      const result = await pending;
      if (epoch === this.#epoch) {
        this.result = result;
        this.message =
          result.kind === 'unavailable'
            ? 'Use the terminal for secrets on this daemon. Start a new daemon from Settings to enable this window.'
            : 'Completed.';
      }
    } catch {
      if (epoch === this.#epoch)
        this.message = 'Secret operation failed. Check the selected owner and version, then try again.';
    } finally {
      delete input.hidden;
      if (this.#pendingInput === input) this.#pendingInput = null;
      if (epoch === this.#epoch) this.busy = false;
    }
  }
}
