import { AlertDialog, Button, Chip, Row as Line } from '@cueplusplus/ui';
import type { ComponentType, ReactNode } from 'react';
import { useId } from 'react';
import { COPY } from '../../copy.ts';
import { UntrustedText } from '../UntrustedText.tsx';
import { JUDGE_ROWS_COPY, turnOffJudgeTitle } from './copy.ts';

/*
 * One judge's row in Events → Judges (0.32.0, the owner's prototype of 2026-10-26): its icon, its name and state, what
 * it is, then what more it has to say, and its actions at the end. A region named by the judge's name.
 */

export function JudgeRow({
  icon: Icon,
  name,
  badge,
  where,
  actions,
  children,
}: {
  icon: ComponentType<{ 'aria-hidden'?: boolean; className?: string }>;
  name: string;
  badge: ReactNode;
  where?: string | undefined;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Line className="items-start">
        <span
          aria-hidden="true"
          className="flex size-chip shrink-0 items-center justify-center rounded-control bg-sunken text-fg-muted"
        >
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2)">
          <div className="flex flex-col gap-(--cue-space-1)">
            <span className="flex flex-wrap items-center gap-(--cue-space-2)">
              <span id={id} className="text-(length:--cue-text-body) font-medium text-fg">
                {name}
              </span>
              {badge}
            </span>
            {where === undefined ? null : <span className="text-fg-muted">{where}</span>}
          </div>
          {children}
        </div>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-(--cue-space-2)">{actions}</div>}
      </Line>
    </section>
  );
}

/** A judge's state in a word: On, or Not set up, or Laya's Not available yet. */
export function JudgeBadge({ state }: { state: 'on' | 'off' | 'notAvailable' }) {
  if (state === 'on')
    return (
      <Chip tone="ok" variant="tag">
        {JUDGE_ROWS_COPY.on}
      </Chip>
    );
  return (
    <Chip tone={state === 'off' ? 'neutral' : 'info'} variant="tag">
      {state === 'off' ? JUDGE_ROWS_COPY.notSetUp : JUDGE_ROWS_COPY.laya.notAvailable}
    </Chip>
  );
}

/** A row's facts: a term and its value, side by side, the value as plain text. */
export function JudgeFacts({ facts }: { facts: readonly (readonly [string, string])[] }) {
  return (
    <dl className="flex flex-wrap gap-x-(--cue-space-6) gap-y-(--cue-space-1)">
      {facts.map(([term, value]) => (
        <div key={term} className="flex items-baseline gap-(--cue-space-2)">
          <dt className="text-fg-muted">{term}</dt>
          <dd className="text-fg">
            <UntrustedText text={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Turn off, which asks first: only its own Turn off runs `confirm`; Cancel, Escape or closing it runs nothing. */
export function TurnOffJudge({ name, disabled, confirm }: { name: string; disabled: boolean; confirm: () => void }) {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        render={
          <Button size="sm" variant="ghost" disabled={disabled}>
            {JUDGE_ROWS_COPY.turnOff}
          </Button>
        }
      />
      <AlertDialog.Content>
        <AlertDialog.Title>{turnOffJudgeTitle(name)}</AlertDialog.Title>
        <AlertDialog.Description>{JUDGE_ROWS_COPY.turnOffBody}</AlertDialog.Description>
        <AlertDialog.Footer>
          <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
          <AlertDialog.Action tone="danger" onClick={confirm}>
            {JUDGE_ROWS_COPY.turnOff}
          </AlertDialog.Action>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/** What went wrong with a row's or a dialog's last action, as the CLI or the app said it. */
export function SetupProblem({ problem }: { problem: { message: string; hint: string | null } | null }) {
  if (problem === null) return null;
  return (
    <div role="alert" className="flex flex-col gap-(--cue-space-1)">
      <p className="text-danger">
        <UntrustedText text={problem.message} />
      </p>
      {problem.hint === null ? null : (
        <p className="text-fg-muted">
          <UntrustedText text={problem.hint} />
        </p>
      )}
    </div>
  );
}
