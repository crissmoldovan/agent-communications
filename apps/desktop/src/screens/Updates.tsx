import { Button, Chip, DescriptionList, SegmentedControl } from '@cueplusplus/ui';
import { useState } from 'react';
import type { UpdateStatus } from '../cli-types.ts';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { When } from '../components/When.tsx';
import { useAppData } from '../data.tsx';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import type { Call, TerminalOutcome, UpdateLevel } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/** The three levels, in the order the control shows them, each with what it means (core `update-settings.ts`). */
const LEVELS: readonly { value: UpdateLevel; label: string; means: string }[] = [
  { value: 'auto', label: 'Auto', means: 'Checks daily, and installs in the background once that is set up.' },
  {
    value: 'every-14-days',
    label: 'Every 14 days',
    means: 'Checks at most once every 14 days, and installs only with your yes.',
  },
  { value: 'never', label: 'Never', means: 'Never checks: updates only by hand.' },
];

const levelOf = (value: string) => LEVELS.find((level) => level.value === value);

/** Each of the background job's states, as a chip says it (core `update-job.ts`, `UpdateJobState`). */
const JOB_STATES: Readonly<Record<string, { label: string; tone: 'ok' | 'neutral' | 'warn' }>> = {
  installed: { label: 'set up', tone: 'ok' },
  'not-set-up': { label: 'not set up', tone: 'neutral' },
  missing: { label: 'missing', tone: 'warn' },
  stale: { label: 'out of date', tone: 'warn' },
  foreign: { label: "someone else's", tone: 'warn' },
  unsupported: { label: 'not offered', tone: 'neutral' },
  unreadable: { label: 'could not be read', tone: 'warn' },
};

/** The pauses the CLI takes (`update --pause 1|7|14`). */
const PAUSES: readonly { days: 1 | 7 | 14; label: string }[] = [
  { days: 1, label: 'Pause for 1 day' },
  { days: 7, label: 'Pause for 7 days' },
  { days: 14, label: 'Pause for 14 days' },
];

/**
 * What a rollback that ran says, in the CLI's own words (core `renderRollback`): each launcher switched back or not,
 * that nothing was changed when none could go back — which the CLI answers `ok`, with exit 69 — what was left as it is,
 * and what to do next.
 */
export function rollbackLine(data: unknown): string {
  const result = (typeof data === 'object' && data !== null ? data : {}) as {
    status?: unknown;
    steps?: unknown;
    left?: unknown;
    next?: unknown;
    holdFailed?: unknown;
  };
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const lines: string[] = [];
  for (const step of Array.isArray(result.steps) ? result.steps : []) {
    const each = (typeof step === 'object' && step !== null ? step : {}) as Record<string, unknown>;
    const launcher = text(each.launcher) ?? 'a launcher';
    lines.push(
      each.outcome === 'switched'
        ? `Switched the stable launcher ${launcher} back from ${text(each.from) ?? 'its runtime'} to ${text(each.to) ?? text(each.runtime) ?? 'the release before'}: no client configuration was changed.`
        : `Could not switch the stable launcher ${launcher} back: ${text(each.detail) ?? 'no reason given'}`,
    );
  }
  if (result.status === 'nothing') lines.push('Nothing was changed: no stable launcher here has a release before.');
  for (const left of Array.isArray(result.left) ? result.left : []) {
    const each = (typeof left === 'object' && left !== null ? left : {}) as Record<string, unknown>;
    lines.push(`Left as it is: ${text(each.launcher) ?? 'a launcher'}: ${text(each.reason) ?? 'no reason given'}.`);
  }
  if (text(result.next) !== null) lines.push(text(result.next) as string);
  if (text(result.holdFailed) !== null) {
    lines.push(
      `The background update run was not told to hold this release back (${text(result.holdFailed)}): its next run may install it again.`,
    );
  }
  return lines.length === 0 ? 'Done.' : lines.join('\n');
}

/**
 * One part's change (DA10): run once through `useChange`. Applied at once, the status is read again, and `describe`,
 * when given, says what it did; one that needs the person's approval is kept, for `ChangePreview`; a refusal is kept,
 * to say why.
 */
function usePartChange(describe?: (data: unknown) => string) {
  const { run } = useChange();
  const { refresh } = useAppData();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const start = async (call: Call) => {
    setBusy(true);
    setOutcome(null);
    setSaid(null);
    const result = await run(call);
    setOutcome(result.state === 'applied' ? null : result);
    if (result.state === 'applied' && describe !== undefined) setSaid(describe(result.data));
    setBusy(false);
    if (result.state === 'applied') await refresh('updateStatus');
  };
  // The preview's own approval was revoked either way, so the approvals waiting are read again.
  const done = (result: TerminalOutcome | 'cancelled') => {
    if (result === 'cancelled') setOutcome(null);
    void refresh('approvals');
  };
  return { busy, outcome, said, start, done };
}

/** What a change came to, when it did not simply apply: its preview, to approve in Terminal, or why it was refused. */
function ChangeResult({
  outcome,
  onDone,
}: {
  outcome: ChangeOutcome | null;
  onDone: (result: TerminalOutcome | 'cancelled') => void;
}) {
  if (outcome === null || outcome.state === 'applied') return null;
  if (outcome.state === 'needsTerminal') {
    return <ChangePreview key={outcome.approvalId} change={outcome} onDone={onDone} />;
  }
  return (
    <div role="alert" className="flex flex-col gap-(--cue-space-1)">
      <p className="text-danger">
        <UntrustedText text={outcome.message} />
      </p>
      {outcome.hint === null ? null : (
        <p className="text-fg-muted">
          <UntrustedText text={outcome.hint} />
        </p>
      )}
    </div>
  );
}

/** What this machine runs, and what the last check found. */
function Versions({ status }: { status: UpdateStatus }) {
  return (
    <SectionPanel title="Versions">
      <DescriptionList.Root>
        <DescriptionList.Term>Running</DescriptionList.Term>
        <DescriptionList.Detail>{status.running}</DescriptionList.Detail>
        <DescriptionList.Term>Latest</DescriptionList.Term>
        <DescriptionList.Detail>{status.latest ?? 'not known yet'}</DescriptionList.Detail>
        <DescriptionList.Term>Last checked</DescriptionList.Term>
        <DescriptionList.Detail>
          {status.lastChecked === null ? 'never' : <When at={status.lastChecked} />}
        </DescriptionList.Detail>
        {status.lastError === null ? null : (
          <>
            <DescriptionList.Term>Last check failed</DescriptionList.Term>
            <DescriptionList.Detail>
              <UntrustedText text={status.lastError} />
            </DescriptionList.Detail>
          </>
        )}
      </DescriptionList.Root>
    </SectionPanel>
  );
}

/** The level: picking one runs `updateLevel`. Updating more applies at once; updating less goes to Terminal. */
function Level({ status }: { status: UpdateStatus }) {
  const change = usePartChange();
  const set = levelOf(status.set);
  const inForce = levelOf(status.level)?.label ?? status.level;
  return (
    <SectionPanel title="Level">
      <SegmentedControl
        aria-label="Update level"
        items={LEVELS.map(({ value, label }) => ({ value, label }))}
        value={status.set}
        disabled={change.busy}
        onValueChange={(value) => {
          const picked = levelOf(value);
          if (picked !== undefined && picked.value !== status.set) {
            void change.start({ kind: 'updateLevel', level: picked.value });
          }
        }}
      />
      {set === undefined ? null : <p className="text-fg-muted">{set.means}</p>}
      {status.by === 'setting' ? null : (
        <p className="text-fg">
          <UntrustedText text={`${status.by} decides the level here: ${inForce}.`} />
        </p>
      )}
      {status.cap === null ? null : (
        <p className="text-fg">
          <UntrustedText
            text={`${status.cap.organisation}'s profile caps the level here at ${levelOf(status.cap.level)?.label ?? status.cap.level}.`}
          />
        </p>
      )}
      <ChangeResult outcome={change.outcome} onDone={change.done} />
    </SectionPanel>
  );
}

/** Update notices held for 1, 7 or 14 days, or let through again. Both apply at once: they ask nobody. */
function Pause({ status }: { status: UpdateStatus }) {
  const change = usePartChange();
  return (
    <SectionPanel title="Pause">
      {status.pausedUntil === null ? (
        <p className="text-fg">Update notices are on.</p>
      ) : (
        <p className="text-fg">
          Update notices are paused until <When at={status.pausedUntil} />.
        </p>
      )}
      {status.security === null ? null : (
        <p className="text-warn">
          <UntrustedText text={`A security fix is waiting: ${status.security}. A pause never holds it.`} />
        </p>
      )}
      <div className="flex flex-wrap gap-(--cue-space-2)">
        {PAUSES.map(({ days, label }) => (
          <Button key={days} disabled={change.busy} onClick={() => void change.start({ kind: 'updatePause', days })}>
            {label}
          </Button>
        ))}
        {status.pausedUntil === null ? null : (
          <Button disabled={change.busy} onClick={() => void change.start({ kind: 'updateResume' })}>
            Resume
          </Button>
        )}
      </div>
      <ChangeResult outcome={change.outcome} onDone={change.done} />
    </SectionPanel>
  );
}

/** The background job: where it stands, and setting it up (approved in Terminal) or removing it (at once). */
function BackgroundJob({ status }: { status: UpdateStatus }) {
  const change = usePartChange();
  const { job } = status;
  const shown = JOB_STATES[job.state] ?? { label: job.state, tone: 'warn' as const };
  const canSetUp = job.state === 'not-set-up' || job.state === 'missing' || job.state === 'stale';
  const canRemove = job.state === 'installed' || job.state === 'missing' || job.state === 'stale';
  return (
    <SectionPanel
      title="Background updates"
      actions={
        <Chip tone={shown.tone} variant="tag">
          {shown.label}
        </Chip>
      }
    >
      {job.state === 'unsupported' ? (
        <p className="text-fg-muted">Background updates aren't offered on this system.</p>
      ) : job.state === 'unreadable' ? (
        <p className="text-warn">
          <UntrustedText text={job.reason ?? 'The background job could not be read.'} />
        </p>
      ) : (
        <>
          <DescriptionList.Root>
            <DescriptionList.Term>Where</DescriptionList.Term>
            <DescriptionList.Detail className="font-mono">
              {job.where === null ? 'nowhere yet' : <UntrustedText text={job.where} />}
            </DescriptionList.Detail>
            <DescriptionList.Term>Set up</DescriptionList.Term>
            <DescriptionList.Detail>
              {job.installedAt === null ? 'not yet' : <When at={job.installedAt} />}
            </DescriptionList.Detail>
            <DescriptionList.Term>Last run</DescriptionList.Term>
            <DescriptionList.Detail>
              {job.lastRun === null ? 'not yet' : <When at={job.lastRun} />}
            </DescriptionList.Detail>
            {job.working === null ? null : (
              <>
                <DescriptionList.Term>Working</DescriptionList.Term>
                <DescriptionList.Detail>{job.working ? 'yes' : 'no'}</DescriptionList.Detail>
              </>
            )}
          </DescriptionList.Root>
          {job.state === 'foreign' ? (
            <p className="text-fg-muted">Something this installation did not write is in the job's place.</p>
          ) : null}
          {canSetUp && status.level !== 'auto' ? (
            <p className="text-fg-muted">Background updates install at the level Auto only.</p>
          ) : null}
          {canSetUp || canRemove ? (
            <div className="flex flex-wrap gap-(--cue-space-2)">
              {canSetUp ? (
                <Button
                  disabled={change.busy}
                  onClick={() => void change.start({ kind: 'updateBackgroundJob', on: true })}
                >
                  Set up background updates
                </Button>
              ) : null}
              {canRemove ? (
                <Button
                  variant="danger-outline"
                  disabled={change.busy}
                  onClick={() => void change.start({ kind: 'updateBackgroundJob', on: false })}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <ChangeResult outcome={change.outcome} onDone={change.done} />
    </SectionPanel>
  );
}

/**
 * Going back to the release before: a change the person approves, in Terminal. With nothing to go back to, the CLI
 * answers at once — `ok`, exit 69 — and what it said is shown.
 */
function Rollback() {
  const change = usePartChange(rollbackLine);
  return (
    <SectionPanel title="Rollback">
      <p className="text-fg-muted">Puts back the release this machine ran before its last update.</p>
      <div>
        <Button disabled={change.busy} onClick={() => void change.start({ kind: 'updateRollback' })}>
          Roll back to the release before
        </Button>
      </div>
      {change.said === null ? null : (
        <p role="status" className="text-fg">
          <UntrustedText text={change.said} />
        </p>
      )}
      <ChangeResult outcome={change.outcome} onDone={change.done} />
    </SectionPanel>
  );
}

/**
 * The update level, pauses, the background job and rollback (DA5.5), from `update --status` (0.24.0, DA13), which
 * the shared data polls. Pauses, resuming, a more frequent level and removing the job apply at once; a less frequent
 * level, setting the job up and rolling back show their preview, and are approved in Terminal (DA10).
 */
export function Updates() {
  const { updateStatus } = useAppData();
  return (
    <ScreenFrame title="Updates">
      <Gated feature="updateStatus">
        {updateStatus === 'unsupported' ? null : (
          <ScreenState value={updateStatus}>
            {(status) => (
              <>
                <Versions status={status} />
                <Level status={status} />
                <Pause status={status} />
                <BackgroundJob status={status} />
                <Rollback />
              </>
            )}
          </ScreenState>
        )}
      </Gated>
    </ScreenFrame>
  );
}
