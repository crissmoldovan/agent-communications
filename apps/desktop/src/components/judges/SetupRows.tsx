import { Button, Link } from '@cueplusplus/ui';
import { Clock, Monitor, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useCall } from '../../hooks/use-call.ts';
import { useChange } from '../../hooks/use-change.ts';
import type { AiProvider, Call } from '../../ipc.ts';
import { useNavigate } from '../../navigation.tsx';
import { jevModelName, type ListedJudge, latestJudge, readProviders } from '../../providers.ts';
import { JUDGE_ROWS_COPY, keysAlready, PROVIDERS_COPY } from './copy.ts';
import { JudgeBadge, JudgeFacts, JudgeRow, SetupProblem, TurnOffJudge } from './JudgeRow.tsx';
import { LocalModelDialog } from './LocalModelDialog.tsx';
import { SetUpJevDialog } from './SetUpJevDialog.tsx';

/*
 * Events → Judges for an events service with judge setup (0.32.0, the owner's prototype of 2026-10-26): Jev and a local
 * model server are set up and turned on in the app, and turned off at once; Laya says it is not available yet. The
 * Judges section wires these in; their words are `copy.ts`'s, and their layout is theirs alone.
 */

/** A kind's state as the Judges section read it from `judge kinds list`. */
export type SetupKindState = 'off' | 'on' | 'unreadable';

const PROVIDER_LIST: Call = { kind: 'providerList' };

function isProvider(value: string): value is AiProvider {
  return value === 'typesafe' || value === 'openrouter';
}

/** Jev's row: Set up… when it is off, saying which keys there are; when on, who serves it, and Change… and Turn off. */
export function JevRow({
  state,
  judges,
  reload,
}: {
  state: SetupKindState;
  judges: readonly ListedJudge[] | null;
  reload: () => Promise<void>;
}) {
  const { run } = useChange();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const keys = useCall<unknown>(state === 'off' ? PROVIDER_LIST : null).result;
  const judge = latestJudge(judges, 'typesafe');
  const provider = judge !== null && isProvider(judge.provider) ? judge.provider : null;
  const on = state === 'on';
  const already = keys.state === 'ready' ? keysAlready(readProviders(keys.value)) : null;

  const turnOff = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await run({ kind: 'judgeKindDisable', judgeKind: 'typesafe' });
    if (outcome.state === 'failed') setProblem({ message: outcome.message, hint: outcome.hint });
    if (outcome.state === 'needsTerminal')
      setProblem({ message: `${JUDGE_ROWS_COPY.jev.name} was not turned off.`, hint: null });
    await reload();
    setBusy(false);
  };

  return (
    <JudgeRow
      icon={Sparkles}
      name={JUDGE_ROWS_COPY.jev.name}
      badge={state === 'unreadable' ? null : <JudgeBadge state={on ? 'on' : 'off'} />}
      where={JUDGE_ROWS_COPY.jev.where}
      actions={
        state === 'unreadable' ? undefined : on ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => setOpen(true)}>
              {JUDGE_ROWS_COPY.change}
            </Button>
            <TurnOffJudge name={JUDGE_ROWS_COPY.jev.name} disabled={busy} confirm={() => void turnOff()} />
          </>
        ) : (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setOpen(true)}>
            {JUDGE_ROWS_COPY.setUp}
          </Button>
        )
      }
    >
      {state === 'unreadable' ? <p className="text-danger">{JUDGE_ROWS_COPY.unreadable}</p> : null}
      {state === 'off' ? (
        <p className="text-fg-muted">
          {already === null ? JUDGE_ROWS_COPY.jev.needsKey : `${JUDGE_ROWS_COPY.jev.needsKey} ${already}`}
        </p>
      ) : null}
      {on && judge !== null ? (
        <JudgeFacts
          facts={[
            [JUDGE_ROWS_COPY.jev.through, provider === null ? judge.provider : PROVIDERS_COPY.providers[provider].name],
            [JUDGE_ROWS_COPY.jev.model, jevModelName(judge.model)],
          ]}
        />
      ) : null}
      <SetupProblem problem={problem} />
      <SetUpJevDialog open={open} onOpenChange={setOpen} current={on ? provider : null} onDone={reload} />
    </JudgeRow>
  );
}

/** The local model server's row: Set up… when it is off; when on, its model, and Change… and Turn off. */
export function LocalModelRow({
  state,
  judges,
  reload,
}: {
  state: SetupKindState;
  judges: readonly ListedJudge[] | null;
  reload: () => Promise<void>;
}) {
  const { run } = useChange();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const judge = latestJudge(judges, 'local-endpoint');
  const on = state === 'on';

  const turnOff = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await run({ kind: 'judgeKindDisable', judgeKind: 'local-endpoint' });
    if (outcome.state === 'failed') setProblem({ message: outcome.message, hint: outcome.hint });
    if (outcome.state === 'needsTerminal')
      setProblem({ message: `${JUDGE_ROWS_COPY.local.name} was not turned off.`, hint: null });
    await reload();
    setBusy(false);
  };

  return (
    <JudgeRow
      icon={Monitor}
      name={JUDGE_ROWS_COPY.local.name}
      badge={state === 'unreadable' ? null : <JudgeBadge state={on ? 'on' : 'off'} />}
      where={JUDGE_ROWS_COPY.local.where}
      actions={
        state === 'unreadable' ? undefined : on ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => setOpen(true)}>
              {JUDGE_ROWS_COPY.change}
            </Button>
            <TurnOffJudge name={JUDGE_ROWS_COPY.local.name} disabled={busy} confirm={() => void turnOff()} />
          </>
        ) : (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setOpen(true)}>
            {JUDGE_ROWS_COPY.setUp}
          </Button>
        )
      }
    >
      {state === 'unreadable' ? <p className="text-danger">{JUDGE_ROWS_COPY.unreadable}</p> : null}
      {on && judge !== null ? <JudgeFacts facts={[[JUDGE_ROWS_COPY.local.model, judge.model]]} /> : null}
      <SetupProblem problem={problem} />
      <LocalModelDialog
        open={open}
        onOpenChange={setOpen}
        on={on}
        currentModel={judge?.model ?? null}
        onDone={reload}
      />
    </JudgeRow>
  );
}

/**
 * Laya's row while no release offers it yet: Not available yet, what it will be, and that there is nothing to set up.
 * No button, and no details: there is nothing of it here to show.
 */
export function LayaNotAvailableRow({ name }: { name: string }) {
  return (
    <JudgeRow icon={Clock} name={name} badge={<JudgeBadge state="notAvailable" />}>
      <p className="text-fg-muted">{JUDGE_ROWS_COPY.laya.body}</p>
    </JudgeRow>
  );
}

/** The Judges section's opening line. */
export function JudgesIntro() {
  return <p className="px-(--cue-pad-row-x) py-(--cue-space-3) text-fg-muted">{JUDGE_ROWS_COPY.intro}</p>;
}

/** The Judges section's closing line: where keys are kept, and that turning a judge off applies at once. */
export function JudgesFooter() {
  const navigate = useNavigate();
  return (
    <p className="text-fg-muted">
      {JUDGE_ROWS_COPY.keysAreKept}
      {navigate === null ? (
        JUDGE_ROWS_COPY.aiProviders
      ) : (
        <Link
          href="#ai-providers"
          onClick={(event) => {
            event.preventDefault();
            navigate({ screen: 'settings', section: 'ai-providers' });
          }}
        >
          {JUDGE_ROWS_COPY.aiProviders}
        </Link>
      )}
      {JUDGE_ROWS_COPY.offAtOnce}
    </p>
  );
}
