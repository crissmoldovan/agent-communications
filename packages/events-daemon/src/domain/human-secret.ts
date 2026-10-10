/** Opaque in-memory material accepted only after the terminal/app secret-input boundary. */
export class HumanSecret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /** The caller owns the hidden-input boundary; this constructor never reads argv, stdin, JSON or environment. */
  static fromTrustedInput(value: string): HumanSecret {
    if (typeof value !== 'string' || value.length === 0) throw new Error('human secret input must be non-empty');
    return new HumanSecret(value);
  }

  /** Internal byte-boundary accessor. Receipt/result serializers must never receive this value. */
  consume(): string {
    return this.#value;
  }
}
