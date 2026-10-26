import {
  Button,
  Dialog,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  SegmentedControl,
} from '@cueplusplus/ui';
import { useEffect, useState } from 'react';
import { isLocalModel, isLoopbackUrl } from '../../grammar.ts';
import { useChange } from '../../hooks/use-change.ts';
import { DoInTerminal, refusedAsUnattested, setupsAtTerminal } from '../DoInTerminal.tsx';
import { LOCAL_SETUP_COPY } from './copy.ts';
import { SetupProblem } from './JudgeRow.tsx';

type ServerKind = keyof typeof LOCAL_SETUP_COPY.kinds;

/**
 * Set up a local model server (0.32.0, the owner's prototype of 2026-10-26): what the person runs, its address on this
 * Mac and its model. The address is checked as the event service checks it — plain HTTP to 127.0.0.1 or [::1], with a
 * port — and Rust and the service check it again. Turn on runs `judge setup local-endpoint --url <url> [--model <name>]`.
 */
export function LocalModelDialog({
  open,
  onOpenChange,
  on,
  currentModel,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether a local model server is on already: the dialog then changes it. */
  on: boolean;
  currentModel: string | null;
  onDone: () => Promise<void>;
}) {
  const { run } = useChange();
  const [kind, setKind] = useState<ServerKind>('ollama');
  const [address, setAddress] = useState<string>(LOCAL_SETUP_COPY.addresses.ollama);
  const [model, setModel] = useState<string>(LOCAL_SETUP_COPY.defaultModel);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  // Where the app cannot attest the person, the server is set up in a terminal (Do it in Terminal).
  const [refused, setRefused] = useState(false);
  const atTerminal = setupsAtTerminal() || refused;

  useEffect(() => {
    if (!open) return;
    setKind('ollama');
    setAddress(LOCAL_SETUP_COPY.addresses.ollama);
    setModel(currentModel ?? LOCAL_SETUP_COPY.defaultModel);
    setProblem(null);
    setRefused(false);
  }, [open, currentModel]);

  const url = address.trim();
  const name = model.trim();
  const urlOk = isLoopbackUrl(url);
  const modelOk = isLocalModel(name);

  const turnOn = async () => {
    if (!urlOk || !modelOk) return;
    setBusy(true);
    setProblem(null);
    const outcome = await run({ kind: 'judgeSetup', judgeKind: 'local-endpoint', url, model: name });
    setBusy(false);
    if (outcome.state === 'failed') {
      setProblem({ message: outcome.message, hint: outcome.hint });
      if (refusedAsUnattested(outcome.code)) setRefused(true);
      return;
    }
    if (outcome.state === 'needsTerminal') {
      setProblem({ message: 'The local model server was not turned on.', hint: null });
      return;
    }
    onOpenChange(false);
    await onDone();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content width="md" showCloseButton={false}>
        <Dialog.Title>{on ? LOCAL_SETUP_COPY.changeTitle : LOCAL_SETUP_COPY.title}</Dialog.Title>
        <Dialog.Description>{LOCAL_SETUP_COPY.body}</Dialog.Description>
        <div className="flex flex-col gap-(--cue-space-4)">
          <div className="flex flex-col gap-(--cue-space-2)">
            <span className="font-medium text-fg">{LOCAL_SETUP_COPY.whatYouRun}</span>
            <SegmentedControl
              indicator
              aria-label={LOCAL_SETUP_COPY.whatYouRun}
              value={kind}
              onValueChange={(value) => {
                const next = value as ServerKind;
                setKind(next);
                setAddress(LOCAL_SETUP_COPY.addresses[next]);
              }}
              items={(Object.keys(LOCAL_SETUP_COPY.kinds) as ServerKind[]).map((value) => ({
                value,
                label: LOCAL_SETUP_COPY.kinds[value],
              }))}
            />
          </div>
          <Field name="address" invalid={url !== '' && !urlOk}>
            <FieldLabel>{LOCAL_SETUP_COPY.address}</FieldLabel>
            <Input
              value={address}
              spellCheck={false}
              autoComplete="off"
              onValueChange={(value: string) => setAddress(value)}
            />
            <FieldDescription>{LOCAL_SETUP_COPY.addressHint}</FieldDescription>
            <FieldError issues={url !== '' && !urlOk ? [{ message: LOCAL_SETUP_COPY.addressWrong }] : []} />
          </Field>
          <Field name="model" invalid={name !== '' && !modelOk}>
            <FieldLabel>{LOCAL_SETUP_COPY.model}</FieldLabel>
            <Input
              value={model}
              spellCheck={false}
              autoComplete="off"
              onValueChange={(value: string) => setModel(value)}
            />
            <FieldDescription>{LOCAL_SETUP_COPY.modelHint}</FieldDescription>
            <FieldError issues={name !== '' && !modelOk ? [{ message: LOCAL_SETUP_COPY.modelWrong }] : []} />
          </Field>
          <SetupProblem problem={problem} />
          {atTerminal && urlOk && modelOk ? (
            <DoInTerminal
              key={`${url} ${name}`}
              command={{
                kind: 'atTerminal',
                call: { kind: 'judgeSetup', judgeKind: 'local-endpoint', url, model: name },
              }}
              onDone={() => {
                onOpenChange(false);
                void onDone();
              }}
            />
          ) : null}
        </div>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost">{LOCAL_SETUP_COPY.cancel}</Button>} />
          {atTerminal ? null : (
            <Button variant="primary" loading={busy} disabled={!urlOk || !modelOk} onClick={() => void turnOn()}>
              {on ? LOCAL_SETUP_COPY.save : LOCAL_SETUP_COPY.turnOn}
            </Button>
          )}
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
