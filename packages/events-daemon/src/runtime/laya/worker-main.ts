import {
  assertNoProbeSocketsRemain,
  assertWorkerLoadBinding,
  LAYA_SANDBOX_PROFILE,
  type LayaWorkerBinding,
  runWorkerBoundaryProbe,
  sealWorkerNetworkAfterProbe,
} from './worker-boundary-probe.ts';
import { type WorkerFrame, WorkerFrameParser, writeWorkerFrame } from './worker-protocol.ts';
import {
  evaluateLayaRequest,
  type LayaRuntimeBinding,
  layaLoadPayload,
  layaWorkerRequest,
  loadVerifiedLayaRuntime,
} from './worker-runtime.ts';

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

/** Only the exact binding of the proven child, and these fields, may arrive on a request frame. */
const REQUEST_FIELDS: readonly string[] = [
  'type',
  'nonce',
  'pid',
  'profile',
  'entry',
  'pipeGeneration',
  'requestId',
  'templateId',
  'instructions',
  'state',
];

function requestFrame(binding: LayaWorkerBinding, frame: WorkerFrame) {
  const keys = Object.keys(frame).sort();
  const expected = [...REQUEST_FIELDS].sort();
  if (
    frame.type !== 'request' ||
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    frame.nonce !== binding.nonce ||
    frame.pid !== binding.pid ||
    frame.profile !== binding.profile ||
    frame.entry !== binding.entry ||
    frame.pipeGeneration !== binding.pipeGeneration ||
    typeof frame.requestId !== 'string' ||
    frame.requestId.length === 0
  )
    return null;
  const request = layaWorkerRequest(frame);
  return request === null ? null : { requestId: frame.requestId, request };
}

async function rejectAndExit(): Promise<never> {
  process.exitCode = 70;
  process.stdin.destroy();
  throw new Error('worker protocol');
}

const parser = new WorkerFrameParser();
let binding: LayaWorkerBinding | undefined;
/** The load frame is answered exactly once: `loaded`, or `load-refused` after which every frame ends the worker. */
let loadAnswered = false;
let runtime: LayaRuntimeBinding | undefined;
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
        // Every later frame carries exactly the five binding fields: the proof ports belong to the probe alone.
        binding = {
          nonce: probe.nonce,
          pid: probe.pid,
          profile: probe.profile,
          entry: probe.entry,
          pipeGeneration: probe.pipeGeneration,
        };
        await writeWorkerFrame(process.stdout, { type: 'probe-result', ...probe, ...result });
        continue;
      }
      if (!loadAnswered) {
        try {
          assertWorkerLoadBinding(binding, frame);
        } catch {
          await rejectAndExit();
        }
        loadAnswered = true;
        const payload = layaLoadPayload(frame.payload);
        try {
          // The runtime and model are imported only here: after this child proved its own boundary, and only from
          // the trees the daemon verified for this start.
          if (payload === null) throw new Error('load payload');
          runtime = await loadVerifiedLayaRuntime(payload);
        } catch {
          await writeWorkerFrame(process.stdout, { type: 'load-refused', ...binding, code: 'runtime-failed' });
          continue;
        }
        await writeWorkerFrame(process.stdout, { type: 'loaded', ...binding });
        continue;
      }
      const request = runtime === undefined ? null : requestFrame(binding, frame);
      if (runtime === undefined || request === null) return rejectAndExit();
      // One request at a time: the next frame waits on this chain until this answer is written.
      const outcome = await evaluateLayaRequest(runtime, request.request);
      await writeWorkerFrame(
        process.stdout,
        outcome.kind === 'answer'
          ? {
              type: 'answer',
              ...binding,
              requestId: request.requestId,
              value: outcome.value,
              inputTokens: outcome.inputTokens,
            }
          : { type: 'refused', ...binding, requestId: request.requestId, code: outcome.code },
      );
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
  // The daemon closed the pipe, or stopped: release the native session so the worker cannot outlive its parent.
  if (runtime !== undefined) {
    void runtime
      .close()
      .catch(() => undefined)
      .finally(() => process.exit());
  }
});
