import { Button, Chip, InfoTip, Panel, SectionHeader, SegmentedControl } from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import type { UpdateStatus } from '../cli-types.ts';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { Fact, Facts } from '../components/Facts.tsx';
import { Gated } from '../components/NeedsNewerCli.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { When } from '../components/When.tsx';
import { useAppData } from '../data.tsx';
import { type ChangeOutcome, useChange } from '../hooks/use-change.ts';
import type { Call, TerminalOutcome, UpdateLevel } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/** The three levels, in the order the control shows them, each with what it means (core `update-settings.ts`). */
const LEVELS: readonly { value: UpdateLevel; label: string; means: string }[] = [
  { value: 'auto', label: 'Auto', means: 'Checks daily; installs in the background once that is set up.' },
  {
    value: 'every-14-days',
    label: 'Every 14 days',
    means: 'Checks every 14 days at most; installs only with your yes.',
  },
  { value: 'never', label: 'Never', means: 'Never checks: updates only by hand.' },
];

/** What rolling back does: said on hover or focus beside its heading, since its button says the rest. */
export const ROLLBACK_HINT = 'Puts back the release this machine ran before its last update.';

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

/**
 * One part of the screen (D3): a quiet heading over a soft panel, as a region its heading names. `hint` is the
 * sentence that only explains it, on hover or focus beside the heading; `action` sits at the heading's far end.
 */
function Part({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <SectionHeader
        label={
          hint === undefined ? (
            title
          ) : (
            <span className="flex items-center gap-(--cue-space-2)">
              {title}
              <InfoTip label={`About ${title.toLowerCase()}`} text={hint} />
            </span>
          )
        }
        action={action}
      >
        <Panel className="flex flex-col gap-(--cue-space-4) p-(--cue-space-5)">{children}</Panel>
      </SectionHeader>
    </section>
  );
}

/** A version, a literal value: in the mono face. */
function Version({ children }: { children: string }) {
  return <span className="font-mono">{children}</span>;
}

/** What this machine runs, and what the last check found. */
function Versions({ status }: { status: UpdateStatus }) {
  return (
    <Part title="Versions">
      <Facts>
        <Fact name="Running">
          <Version>{status.running}</Version>
        </Fact>
        <Fact name="Latest">
          {status.latest === null ? (
            <span className="text-fg-muted">not known yet</span>
          ) : (
            <Version>{status.latest}</Version>
          )}
        </Fact>
        <Fact name="Last checked">
          {status.lastChecked === null ? (
            <span className="text-fg-muted">never</span>
          ) : (
            <When at={status.lastChecked} />
          )}
        </Fact>
        {status.lastError === null ? null : (
          <Fact name="Last check failed">
            <span className="text-warn">
              <UntrustedText text={status.lastError} />
            </span>
          </Fact>
        )}
      </Facts>
    </Part>
  );
}

/** The level: picking one runs `updateLevel`. Updating more applies at once; updating less goes to Terminal. */
function Level({ status }: { status: UpdateStatus }) {
  const change = usePartChange();
  const set = levelOf(status.set);
  const inForce = levelOf(status.level)?.label ?? status.level;
  return (
    <Part title="Level">
      <div className="flex flex-col gap-(--cue-space-2)">
        <SegmentedControl
          aria-label="Update level"
          className="self-start"
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
        {set === undefined ? null : <p className="text-(length:--cue-text-ui) text-fg-muted">{set.means}</p>}
      </div>
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
    </Part>
  );
}

/**
 * Update notices held for 1, 7 or 14 days, or let through again. Both apply at once: they ask nobody. Each pause says
 * its length on its button, after the "Pause for" they share; its name says the whole of it.
 */
function Pause({ status }: { status: UpdateStatus }) {
  const change = usePartChange();
  return (
    <Part title="Pause">
      <div className="flex flex-wrap items-center gap-x-(--cue-space-5) gap-y-(--cue-space-3)">
        {status.pausedUntil === null ? (
          <p className="text-fg">Update notices are on.</p>
        ) : (
          <p className="text-fg">
            Update notices are paused until <When at={status.pausedUntil} />.
          </p>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-(--cue-space-2)">
          <span aria-hidden="true" className="text-(length:--cue-text-ui) text-fg-muted">
            Pause for
          </span>
          {PAUSES.map(({ days, label }) => (
            <Button
              key={days}
              size="sm"
              aria-label={label}
              disabled={change.busy}
              onClick={() => void change.start({ kind: 'updatePause', days })}
            >
              {days === 1 ? '1 day' : `${days} days`}
            </Button>
          ))}
          {status.pausedUntil === null ? null : (
            <Button
              size="sm"
              variant="primary"
              disabled={change.busy}
              onClick={() => void change.start({ kind: 'updateResume' })}
            >
              Resume
            </Button>
          )}
        </div>
      </div>
      {status.security === null ? null : (
        <p className="rounded-control bg-(--cue-warn-soft) px-(--cue-space-4) py-(--cue-space-3) text-warn">
          <UntrustedText text={`A security fix is waiting: ${status.security}. A pause never holds it.`} />
        </p>
      )}
      <ChangeResult outcome={change.outcome} onDone={change.done} />
    </Part>
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
    <Part
      title="Background updates"
      action={
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
          <Facts>
            <Fact name="Where">
              {job.where === null ? (
                <span className="text-fg-muted">nowhere yet</span>
              ) : (
                <span className="font-mono">
                  <UntrustedText text={job.where} />
                </span>
              )}
            </Fact>
            <Fact name="Set up">
              {job.installedAt === null ? (
                <span className="text-fg-muted">not yet</span>
              ) : (
                <When at={job.installedAt} />
              )}
            </Fact>
            <Fact name="Last run">
              {job.lastRun === null ? <span className="text-fg-muted">not yet</span> : <When at={job.lastRun} />}
            </Fact>
            {job.working === null ? null : <Fact name="Working">{job.working ? 'yes' : 'no'}</Fact>}
          </Facts>
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
                  size="sm"
                  variant="primary"
                  disabled={change.busy}
                  onClick={() => void change.start({ kind: 'updateBackgroundJob', on: true })}
                >
                  Set up background updates
                </Button>
              ) : null}
              {canRemove ? (
                <Button
                  size="sm"
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
    </Part>
  );
}

/**
 * Going back to the release before: a change the person approves, in Terminal. With nothing to go back to, the CLI
 * answers at once — `ok`, exit 69 — and what it said is shown.
 */
function Rollback() {
  const change = usePartChange(rollbackLine);
  return (
    <Part title="Rollback" hint={ROLLBACK_HINT}>
      <div>
        <Button size="sm" disabled={change.busy} onClick={() => void change.start({ kind: 'updateRollback' })}>
          Roll back to the release before
        </Button>
      </div>
      {change.said === null ? null : (
        <p role="status" className="text-fg">
          <UntrustedText text={change.said} />
        </p>
      )}
      <ChangeResult outcome={change.outcome} onDone={change.done} />
    </Part>
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
              <div className="flex flex-col gap-(--cue-space-6)">
                <Versions status={status} />
                <Level status={status} />
                <Pause status={status} />
                <BackgroundJob status={status} />
                <Rollback />
              </div>
            )}
          </ScreenState>
        )}
      </Gated>
    </ScreenFrame>
  );
}
