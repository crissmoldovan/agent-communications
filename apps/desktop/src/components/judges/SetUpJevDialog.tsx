import { Button, Chip, Dialog, Link, Radio, RadioGroup, Spinner } from '@cueplusplus/ui';
import { useEffect, useState } from 'react';
import { useCall } from '../../hooks/use-call.ts';
import { useChange } from '../../hooks/use-change.ts';
import type { AiProvider, Call } from '../../ipc.ts';
import { useNavigate } from '../../navigation.tsx';
import { jevModelName, readProviders } from '../../providers.ts';
import { JEV_SETUP_COPY } from './copy.ts';
import { SetupProblem } from './JudgeRow.tsx';

const PROVIDER_LIST: Call = { kind: 'providerList' };

/** The order the dialog offers them in: OpenRouter, then TypeSafe directly. */
const OFFERED: readonly AiProvider[] = ['openrouter', 'typesafe'];

/** The model each provider's Jev is: the provider fixes it (the event service's own route). */
const MODELS: Readonly<Record<AiProvider, string>> = { openrouter: 'typesafe/jev-1.14', typesafe: 'jev-1.13.0' };

/**
 * Set up Jev (0.32.0, the owner's prototype of 2026-10-26): how Jev is reached, through OpenRouter or TypeSafe directly,
 * each with whether its key is added. An option without a key is greyed and cannot be picked, with a link to Settings →
 * AI providers, where keys are kept; with neither, the dialog says to add one first. Turn on runs the events service's
 * `judge setup typesafe --provider <provider>`, which uses the stored key: no key passes through here.
 */
export function SetUpJevDialog({
  open,
  onOpenChange,
  current,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider Jev uses now, when it is on: the dialog then changes it. */
  current: AiProvider | null;
  onDone: () => Promise<void>;
}) {
  const { run } = useChange();
  const navigate = useNavigate();
  const { result } = useCall<unknown>(open ? PROVIDER_LIST : null);
  const keys = result.state === 'ready' ? readProviders(result.value) : null;
  const usable = OFFERED.filter((provider) => keys?.[provider] === true);
  const [picked, setPicked] = useState<AiProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const chosen = picked !== null && usable.includes(picked) ? picked : (usable.find((p) => p === current) ?? usable[0]);

  // Each opening starts again from what is stored: the keys are read again as it opens.
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setProblem(null);
  }, [open]);

  const turnOn = async () => {
    if (chosen === undefined) return;
    setBusy(true);
    setProblem(null);
    const outcome = await run({ kind: 'judgeSetup', judgeKind: 'typesafe', provider: chosen });
    setBusy(false);
    if (outcome.state === 'failed') {
      setProblem({ message: outcome.message, hint: outcome.hint });
      return;
    }
    if (outcome.state === 'needsTerminal') {
      setProblem({ message: 'Jev was not turned on.', hint: null });
      return;
    }
    onOpenChange(false);
    await onDone();
  };

  const openProviders = () => {
    onOpenChange(false);
    navigate?.({ screen: 'settings', section: 'ai-providers' });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content width="md" showCloseButton={false}>
        <Dialog.Title>{current === null ? JEV_SETUP_COPY.title : JEV_SETUP_COPY.changeTitle}</Dialog.Title>
        <Dialog.Description>{JEV_SETUP_COPY.body}</Dialog.Description>
        <div className="flex flex-col gap-(--cue-space-4)">
          {result.state === 'loading' ? <Spinner label={JEV_SETUP_COPY.connectThrough} /> : null}
          {result.state === 'error' || (result.state === 'ready' && keys === null) ? (
            <p role="alert" className="text-danger">
              {JEV_SETUP_COPY.unreadableKeys}
            </p>
          ) : null}
          {keys !== null && usable.length === 0 ? (
            <div role="status" className="flex flex-col items-start gap-(--cue-space-2)">
              <p className="text-fg">{JEV_SETUP_COPY.noKeys}</p>
              {navigate === null ? null : (
                <Button size="sm" onClick={openProviders}>
                  {JEV_SETUP_COPY.openProviders}
                </Button>
              )}
            </div>
          ) : null}
          {keys === null ? null : (
            <fieldset className="flex flex-col gap-(--cue-space-2)">
              <legend className="mb-(--cue-space-2) font-medium text-fg">{JEV_SETUP_COPY.connectThrough}</legend>
              <RadioGroup
                aria-label={JEV_SETUP_COPY.connectThrough}
                value={chosen ?? ''}
                onValueChange={(value) => setPicked(value as AiProvider)}
              >
                {OFFERED.map((provider) => {
                  const option = JEV_SETUP_COPY.options[provider];
                  const has = keys[provider];
                  return (
                    <div
                      key={provider}
                      data-provider={provider}
                      className={`flex items-start justify-between gap-(--cue-space-3) ${has ? '' : 'opacity-60'}`}
                    >
                      <div className="flex flex-col gap-(--cue-space-1)">
                        <Radio
                          value={provider}
                          disabled={!has}
                          label={
                            <span className="flex flex-col gap-(--cue-space-1)">
                              <span className="font-medium text-fg">{option.label}</span>
                              <span className="text-fg-muted">{has ? option.hasKey : option.noKey}</span>
                            </span>
                          }
                        />
                        {has || navigate === null ? null : (
                          <span className="ps-(--cue-space-6) text-fg-muted">
                            <Link
                              href="#ai-providers"
                              onClick={(event) => {
                                event.preventDefault();
                                openProviders();
                              }}
                            >
                              {JEV_SETUP_COPY.addOne}
                            </Link>
                            .
                          </span>
                        )}
                      </div>
                      <Chip tone={has ? 'ok' : 'neutral'} variant="tag">
                        {has ? JEV_SETUP_COPY.keyAdded : JEV_SETUP_COPY.noKey}
                      </Chip>
                    </div>
                  );
                })}
              </RadioGroup>
            </fieldset>
          )}
          {chosen === undefined ? null : (
            <>
              <div className="flex items-baseline gap-(--cue-space-2)">
                <span className="text-fg-muted">{JEV_SETUP_COPY.model}</span>
                <span className="text-fg">{jevModelName(MODELS[chosen])}</span>
              </div>
              <div className="flex flex-col gap-(--cue-space-1) rounded-control bg-sunken p-(--cue-space-3)">
                <span className="font-medium text-fg">{JEV_SETUP_COPY.whatJevSees}</span>
                <span className="text-fg-muted">{JEV_SETUP_COPY.options[chosen].sees}</span>
                <span className="text-fg-muted">{JEV_SETUP_COPY.budget}</span>
              </div>
            </>
          )}
          <SetupProblem problem={problem} />
        </div>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost">{JEV_SETUP_COPY.cancel}</Button>} />
          <Button variant="primary" loading={busy} disabled={chosen === undefined} onClick={() => void turnOn()}>
            {current === null ? JEV_SETUP_COPY.turnOn : JEV_SETUP_COPY.save}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
