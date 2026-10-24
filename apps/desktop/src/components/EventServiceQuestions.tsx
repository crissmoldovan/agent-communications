import { AlertDialog, Button, Checkbox } from '@cueplusplus/ui';
import { useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { useAppData } from '../data.tsx';
import { errorMessage } from '../ipc.ts';
import { UntrustedText } from './UntrustedText.tsx';

/*
 * The two questions the event service asks of the whole app, whatever screen is open (plan P1, P3). Each is cue-ui's
 * AlertDialog, held open until it is answered: Escape and an outside press do not dismiss it, because Rust waits for
 * the answer. Each answer is sent once, however often its button is pressed.
 */

/** The words of both questions, as the plan's Global Constraints give them. */
export const QUESTION_COPY = {
  firstStartTitle: 'Start the event service?',
  firstStartBody: 'The event service has run on this Mac before. Starting it resumes whatever it was set to do.',
  start: 'Start',
  notNow: 'Not now',
  quitTitle: 'Keep the event service running?',
  quitBody: 'It keeps watching your accounts after Agent Comms quits.',
  keepRunning: 'Keep running',
  stopIt: 'Stop it',
  remember: 'Remember my answer',
} as const;

/** Sends one answer at a time: a press while one is on its way is ignored. */
function useAnswer(): {
  busy: boolean;
  problem: string | null;
  answer: (send: () => Promise<void>) => Promise<boolean>;
} {
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const answer = async (send: () => Promise<void>) => {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await send();
      return true;
    } catch (error) {
      setProblem(errorMessage(error));
      return false;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return { busy, problem, answer };
}

function Problem({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <p role="alert" className="text-danger">
      <UntrustedText text={text} />
    </p>
  );
}

/**
 * The first automatic start, on a Mac where the service has run before (P1): asked when the supervisor says so, and
 * once. Its answer is the supervisor's to keep; the state it answers with is shown at once.
 */
export function FirstStartQuestion() {
  const bridge = useBridge();
  const { eventService, showEventService } = useAppData();
  const [answered, setAnswered] = useState(false);
  const { busy, problem, answer } = useAnswer();
  const start = useRef<HTMLButtonElement>(null);
  const asked = eventService !== 'absent' && eventService.state === 'ready' && eventService.value.firstStartQuestion;

  const reply = (yes: boolean) =>
    void answer(async () => {
      const next = await bridge.answerFirstStart(yes);
      setAnswered(true);
      showEventService(next);
    });

  return (
    <AlertDialog.Root open={asked && !answered}>
      <AlertDialog.Content initialFocus={start}>
        <AlertDialog.Title>{QUESTION_COPY.firstStartTitle}</AlertDialog.Title>
        <AlertDialog.Description>{QUESTION_COPY.firstStartBody}</AlertDialog.Description>
        <Problem text={problem} />
        <AlertDialog.Footer>
          <Button variant="secondary" disabled={busy} onClick={() => reply(false)}>
            {QUESTION_COPY.notNow}
          </Button>
          <Button ref={start} variant="primary" disabled={busy} onClick={() => reply(true)}>
            {QUESTION_COPY.start}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

/**
 * Quit, while a service the app started runs and no answer is remembered (P3). Rust shows and focuses the window, then
 * sends `quit-requested`; a second Quit while it asks shows nothing more. Keep running is the default, and the app
 * quits on the answer.
 */
export function QuitQuestion() {
  const bridge = useBridge();
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const { busy, problem, answer } = useAnswer();
  const keep = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const stop = bridge.on('quit-requested', () => setOpen(true));
    return () => {
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [bridge]);

  const reply = async (keepRunning: boolean) => {
    if (await answer(() => bridge.answerQuit(keepRunning, remember))) setOpen(false);
  };

  return (
    <AlertDialog.Root open={open}>
      <AlertDialog.Content initialFocus={keep}>
        <AlertDialog.Title>{QUESTION_COPY.quitTitle}</AlertDialog.Title>
        <AlertDialog.Description>{QUESTION_COPY.quitBody}</AlertDialog.Description>
        <Checkbox
          label={QUESTION_COPY.remember}
          checked={remember}
          disabled={busy}
          onCheckedChange={(checked) => setRemember(checked)}
        />
        <Problem text={problem} />
        <AlertDialog.Footer>
          <Button variant="secondary" disabled={busy} onClick={() => void reply(false)}>
            {QUESTION_COPY.stopIt}
          </Button>
          <Button ref={keep} variant="primary" disabled={busy} onClick={() => void reply(true)}>
            {QUESTION_COPY.keepRunning}
          </Button>
        </AlertDialog.Footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
