import {
  assertNoProbeSocketsRemain,
  assertWorkerLoadBinding,
  LAYA_SANDBOX_PROFILE,
  type LayaWorkerBinding,
  runWorkerBoundaryProbe,
  sealWorkerNetworkAfterProbe,
} from './worker-boundary-probe.ts';
import { type WorkerFrame, WorkerFrameParser, writeWorkerFrame } from './worker-protocol.ts';

function bindingFromProbe(
  frame: WorkerFrame,
): (LayaWorkerBinding & { readonly tcpPort: number; readonly udpPort: number; readonly udsPath: string }) | null {
  if (
    typeof frame.nonce !== 'string' ||
    typeof frame.pid !== 'number' ||
    !Number.isSafeInteger(frame.pid) ||
    typeof frame.profile !== 'string' ||
    typeof frame.entry !== 'string' ||
    typeof frame.pipeGeneration !== 'string' ||
    typeof frame.tcpPort !== 'number' ||
    !Number.isSafeInteger(frame.tcpPort) ||
    typeof frame.udpPort !== 'number' ||
    !Number.isSafeInteger(frame.udpPort) ||
    typeof frame.udsPath !== 'string'
  ) {
    return null;
  }
  return {
    nonce: frame.nonce,
    pid: frame.pid,
    profile: frame.profile as LayaWorkerBinding['profile'],
    entry: frame.entry,
    pipeGeneration: frame.pipeGeneration,
    tcpPort: frame.tcpPort,
    udpPort: frame.udpPort,
    udsPath: frame.udsPath,
  };
}

/** The probe must name this very process: its PID, the entry Node is running and the reviewed profile. */
function namesThisWorker(probe: LayaWorkerBinding): boolean {
  return probe.pid === process.pid && probe.entry === process.argv[1] && probe.profile === LAYA_SANDBOX_PROFILE;
}

async function rejectAndExit(): Promise<never> {
  process.exitCode = 70;
  process.stdin.destroy();
  throw new Error('worker protocol');
}

const parser = new WorkerFrameParser();
let binding: LayaWorkerBinding | undefined;
let work = Promise.resolve();

process.stdin.on('data', (chunk: Buffer) => {
  work = work.then(async () => {
    for (const frame of parser.push(chunk)) {
      if (binding === undefined) {
        const probe = frame.type === 'probe' ? bindingFromProbe(frame) : null;
        if (probe === null || !namesThisWorker(probe)) return rejectAndExit();
        const result = await runWorkerBoundaryProbe(probe, async (attempt, outcome) => {
          await writeWorkerFrame(process.stdout, { type: 'probe-attempt', ...probe, attempt, outcome });
        });
        // Seal before reporting, so the daemon can never send load to a worker whose network is still open, and
        // report nothing while a probe socket, listener or lookup is still alive.
        sealWorkerNetworkAfterProbe();
        await assertNoProbeSocketsRemain();
        binding = probe;
        await writeWorkerFrame(process.stdout, { type: 'probe-result', ...binding, ...result });
        continue;
      }
      try {
        assertWorkerLoadBinding(binding, frame);
      } catch {
        await rejectAndExit();
      }
      // Task 8 is the only code allowed to add the native runtime import/load path.  This worker is intentionally
      // content-free now, but its reply proves that the nonce-bound original pipes remained live after the probe.
      await writeWorkerFrame(process.stdout, {
        type: 'load-refused',
        ...binding,
        code: 'E2_EXTERNAL_REFERENCE_BLOCKED',
      });
    }
  });
  void work.catch(() => {
    process.exitCode = 70;
    process.stdin.destroy();
  });
});

process.stdin.on('end', () => {
  try {
    parser.finish();
  } catch {
    process.exitCode = 70;
  }
});
