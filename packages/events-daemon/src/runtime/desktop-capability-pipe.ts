import { closeSync, fstatSync, readSync } from 'node:fs';

/** Only `run` reads this descriptor, once, before opening the owner. No argv, env material or file path is read. */
export function readDesktopCapabilityPipe(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const descriptor = env.AGENTCOMMS_DESKTOP_CAPABILITY_FD;
  if (descriptor === undefined) return undefined;
  if (descriptor !== '3') throw new Error('invalid desktop capability descriptor');
  const bytes = Buffer.alloc(33);
  try {
    if (!fstatSync(3).isFIFO()) throw new Error('desktop capability requires an inherited pipe');
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(3, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length !== 32) throw new Error('invalid desktop capability size');
    return Buffer.from(bytes.subarray(0, 32));
  } finally {
    bytes.fill(0);
    closeSync(3);
  }
}
