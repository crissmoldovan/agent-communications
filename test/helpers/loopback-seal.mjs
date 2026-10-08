import { assertLoopbackSeal, loopbackSealAttempts } from './loopback-seal-preload.mjs';

/** Returns the preload's refusal attempts; the preload installs the process-wide seal. */
export function sealToLoopback() {
  assertLoopbackSeal();
  return loopbackSealAttempts().map((attempt) => attempt.target);
}
