export interface LoopbackSealAttempt {
  readonly what: string;
  readonly target: string;
}

export function assertLoopbackSeal(): void;
export function loopbackSealAttempts(): LoopbackSealAttempt[];
