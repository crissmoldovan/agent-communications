#!/usr/bin/env node
/** The writer inventory is a fail-closed manifest: every cipher/secret writer names its leased entrypoint. */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Keep this list here as well as in the task manifest.  The manifest is the
// mutation ledger; this independent expectation makes deleting an otherwise
// quiet composition entry fail rather than silently narrowing the inventory.
const REQUIRED_WRITER_INVENTORY = Object.freeze([
  'packages/events-daemon/src/runtime/activations.ts',
  'packages/events-daemon/src/runtime/scheduler.ts',
  'packages/events-daemon/src/runtime/source-owner-work.ts',
  'packages/events-daemon/src/runtime/projections.ts',
  'packages/events-daemon/src/runtime/evaluate.ts',
  'packages/events-daemon/src/runtime/decisions.ts',
  'packages/events-daemon/src/runtime/deliveries.ts',
  'packages/events-daemon/src/runtime/dispatcher.ts',
  'packages/events-daemon/src/runtime/webhook-dispatcher.ts',
  'packages/events-daemon/src/runtime/sse-dispatcher.ts',
  // The Linear target (0.33.0): its delivery boundary opens the rendered issue through the centrally leased cipher.
  'packages/events-daemon/src/runtime/linear-dispatcher.ts',
  // The action queue (0.30.0): its delivery boundary seals items; its read model opens them. Both go through the
  // centrally leased cipher.
  'packages/events-daemon/src/runtime/queue-dispatcher.ts',
  'packages/events-daemon/src/runtime/queue.ts',
  // `delivery show` (0.32.0): reads a decision's judge answer through the same centrally leased cipher.
  'packages/events-daemon/src/runtime/delivery-show.ts',
  // `messages list` / `message show` (0.32.0): open a queue item's kept summary through the same leased cipher.
  'packages/events-daemon/src/runtime/messages.ts',
  // `rule analyse` (0.33.0): reads a decision's judge metadata — its number and sending domain — through the same
  // centrally leased cipher, and writes nothing.
  'packages/events-daemon/src/runtime/rule-analyse.ts',
  // The agent-session target (0.33.0): its dispatcher opens a session delivery's record, seals the context it resolves
  // back into that record (so a busy session's next try sends the same words), and seals the queue item a match
  // becomes, through the same centrally leased cipher.
  'packages/events-daemon/src/runtime/session-dispatcher.ts',
  // Workflows (0.36): a run's sealed record — its mapped values — is sealed when the match commits and opened for the
  // step that reads it, both through the centrally leased cipher.
  'packages/events-daemon/src/runtime/workflow/runs.ts',
  'packages/events-daemon/src/runtime/workflow/context.ts',
  // A shadow version (0.36.0 §7.7): each effect it does not run is a dry-run record of the run's own values, sealed
  // through the same centrally leased cipher.
  'packages/events-daemon/src/runtime/workflow/shadow.ts',
  'packages/events-daemon/src/runtime/system-reset-outbox.ts',
  'packages/events-daemon/src/runtime/expiry.ts',
  'packages/events-daemon/src/runtime/revocations.ts',
  'packages/events-daemon/src/runtime/recovery.ts',
  'packages/events-daemon/src/runtime/reset.ts',
  'packages/events-daemon/src/runtime/owner.ts',
  'packages/events-daemon/src/runtime/b3-secret-control.ts',
  'packages/events-daemon/src/runtime/sse-server.ts',
  'packages/events-daemon/src/runtime/stream-replay.ts',
  // Workflow events (0.36.0, §9.1): the sink seals each raised event through the centrally leased cipher.
  'packages/events-daemon/src/runtime/events/sink.ts',
  // The event dispatcher opens a raised event, and seals each live subscriber's frame of it, through the same cipher.
  'packages/events-daemon/src/runtime/events/event-dispatcher.ts',
  // Chains (0.36.0, W34): a chained run's `/trigger` is opened from the raised event's record through the same
  // centrally leased cipher.
  'packages/events-daemon/src/runtime/events/chains.ts',
  'packages/events-daemon/src/sources/source-worker.ts',
  'packages/events-daemon/src/sources/gmail.ts',
  'packages/events-daemon/src/sources/materialise.ts',
  'packages/events-daemon/src/sources/resend.ts',
  'packages/events-daemon/src/sources/resend-status.ts',
  'packages/events-daemon/src/sources/slack.ts',
  'packages/events-daemon/src/sources/slack-replies.ts',
  'packages/events-daemon/src/sources/whatsapp.ts',
  'packages/events-daemon/src/store/event-secrets.ts',
  'packages/events-daemon/src/store/records.ts',
]);

async function filesBelow(root, directory = join(root, 'packages/events-daemon/src')) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? filesBelow(root, join(directory, entry.name))
          : entry.name.endsWith('.ts')
            ? // Inventory entries are repository paths with `/`; `relative` gives `\` on Windows.
              [relative(root, join(directory, entry.name)).split(sep).join('/')]
            : [],
      ),
    )
  ).flat();
}

async function manifestInventory(root) {
  const text = await readFile(join(root, 'packages/events-daemon/test/b3-guard-manifests/secrets.json'), 'utf8');
  const manifest = JSON.parse(text);
  if (!Array.isArray(manifest.writerInventory)) return [];
  return manifest.writerInventory;
}

export async function verifyB3WriterInventory({ root = ROOT, inventory = undefined, files = undefined } = {}) {
  const declared = inventory ?? (await manifestInventory(root));
  const listed = new Set(declared.map((entry) => (typeof entry === 'string' ? entry : entry.entry)));
  const problems = [];
  // The fixture caller passes an explicit inventory, so it can isolate the
  // discovery rule. The repository check also pins the complete B3 list.
  if (inventory === undefined) {
    const required = new Set(REQUIRED_WRITER_INVENTORY);
    for (const entry of REQUIRED_WRITER_INVENTORY) {
      if (!listed.has(entry)) problems.push(`${entry}: absent from the exact B3 writer inventory`);
    }
    for (const entry of listed) {
      if (!required.has(entry)) problems.push(`${entry}: is not a permitted B3 writer inventory entry`);
    }
    for (const entry of REQUIRED_WRITER_INVENTORY) {
      try {
        await readFile(join(root, entry), 'utf8');
      } catch {
        problems.push(`${entry}: named B3 writer entrypoint does not exist`);
      }
    }
  }
  const centralLease = await readFile(join(root, 'packages/events-daemon/src/store/records.ts'), 'utf8').catch(
    () => '',
  );
  const cipherLeaseIsMandatory =
    /async encrypt[\s\S]*withEventWriterLease/.test(centralLease) &&
    /async decrypt[\s\S]*withEventWriterLease/.test(centralLease);
  const scheduler = 'packages/events-daemon/src/runtime/scheduler.ts';
  for (const file of files ?? (await filesBelow(root))) {
    const text = await readFile(join(root, file), 'utf8');
    if (!/\b(?:cipher\.(?:encrypt|decrypt)|secret(?:Store|Backend)?\.(?:set|get|delete))\s*\(/.test(text)) continue;
    if (!listed.has(file))
      problems.push(`${file}: cipher/secret writer is absent from the explicit B3 lease inventory`);
    // Cipher access is deliberately leased at its one implementation boundary
    // so the lease cannot be dropped between a caller's decrypt/encrypt pair.
    // EventSecretStore is entered only by B3 service methods that acquire the
    // same lease (and recursively from EventRecordCipher while that lease is
    // held). This recognizes those two audited central boundaries instead of
    // accepting an unreviewable caller-local imitation.
    else if (
      !/withEventWriterLease\s*\(/.test(text) &&
      !(cipherLeaseIsMandatory && /cipher\.(?:encrypt|decrypt)\s*\(/.test(text))
    )
      problems.push(`${file}: listed cipher/secret writer does not acquire withEventWriterLease`);
  }
  // The interval callback enters through `tick()`, not the owner's public
  // control wrapper.  Central cipher leasing ends when encrypt/decrypt returns,
  // so this composition entry must keep the shared lease until the tick's own
  // commits and purges settle.
  if ((files ?? []).includes(scheduler) || (files === undefined && listed.has(scheduler))) {
    const text = await readFile(join(root, scheduler), 'utf8').catch(() => '');
    if (!/const work = withEventWriterLease\(this\.#writerQuiescer, \(\) => this\.#tick\(\)\)\.finally/.test(text))
      problems.push(`${scheduler}: timer-started writer does not acquire the shared lease before #tick`);
  }
  const evaluator = 'packages/events-daemon/src/runtime/evaluate.ts';
  if ((files ?? []).includes(evaluator) || (files === undefined && listed.has(evaluator))) {
    const text = await readFile(join(root, evaluator), 'utf8').catch(() => '');
    if (
      !/return this\.#writerQuiescer === undefined \? work\(\) : withEventWriterLease\(this\.#writerQuiescer, work\);/.test(
        text,
      )
    )
      problems.push(`${evaluator}: evaluator admission and evaluation writes do not hold the shared lease`);
  }
  if (inventory === undefined) {
    const owner = await readFile(join(root, 'packages/events-daemon/src/runtime/owner.ts'), 'utf8').catch(() => '');
    const control = await readFile(join(root, 'packages/events-daemon/src/runtime/b3-secret-control.ts'), 'utf8').catch(
      () => '',
    );
    const schedulerText = await readFile(join(root, scheduler), 'utf8').catch(() => '');
    const starts = [
      [
        // 0.36.0 (W33): the manual tick then waits, outside its lease, for the event deliveries it started apart.
        'manual owner tick',
        owner.includes(
          'tick: async () => {\n      await withEventWriterLease(writerQuiescer, () => scheduler.tick());',
        ),
      ],
      [
        // 0.36.0 (W33): a raised event's delivery runs apart from the tick that started it, under a lease of its own.
        'event delivery attempt apart from the tick',
        owner.includes('apart: (work) => withOwnEventWriterLease(writerQuiescer, work),'),
      ],
      [
        'startup expiry recovery',
        owner.includes('await withEventWriterLease(writerQuiescer, () => expiry.sweepAll());'),
      ],
      [
        'startup activation recovery',
        owner.includes('await withEventWriterLease(writerQuiescer, () => recoverActivations(activations));'),
      ],
      [
        'control activation completion',
        owner.includes('return withEventWriterLease(writerQuiescer, () =>\n        activations.approve({'),
      ],
      [
        'scheduled expiry/source/activation/dispatcher/SSE/webhook loop',
        schedulerText.includes('await this.#expiry.sweepAll();') &&
          schedulerText.includes('await this.#activations.resumeClaimedCompletions();') &&
          schedulerText.includes('await this.#pollReadyScope();') &&
          schedulerText.includes('await recoverDeliveryLeases(this.#dispatcher);') &&
          schedulerText.includes('await this.#dispatcher.dispatch(id);'),
      ],
      [
        'human secret control operations',
        control.includes('withEventWriterLease(this.#quiescer, async () =>') &&
          control.includes('return this.#quiescer.withExclusive(async () =>'),
      ],
    ];
    for (const [name, present] of starts) {
      if (!present) problems.push(`writer start inventory: ${name} is not held by the shared owner lease`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await verifyB3WriterInventory();
  if (problems.length) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
  }
}
