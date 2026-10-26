import {
  AlertDialog,
  Button,
  Chip,
  Field,
  FieldLabel,
  Row as Line,
  Link,
  Panel,
  PasswordInput,
  SectionHeader,
} from '@cueplusplus/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY, needsLine } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { GATES, supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { useChange } from '../hooks/use-change.ts';
import { useReloadOnReturn } from '../hooks/use-reload-on-return.ts';
import { AI_PROVIDERS, type AiProvider, type Call, errorMessage } from '../ipc.ts';
import { takeDestination, useNavigate } from '../navigation.tsx';
import { keyOf, providerInUse, readListedJudges, readProviders } from '../providers.ts';
import { keyLabel, keyPlaceholder, PROVIDERS_COPY, removeKeyTitle } from './judges/copy.ts';
import { SetupProblem } from './judges/JudgeRow.tsx';
import { ScreenState } from './ScreenState.tsx';

/*
 * Settings → AI providers (0.32.0, owner decision 2026-10-26, the owner's prototype "Providers"): the person's keys for
 * the hosted judges, one row each for TypeSafe and OpenRouter. A key is typed into a password field that React never
 * holds: the field is read once, when the key is saved, handed to Rust's `provider_key_set` — which gives it to the
 * events CLI on stdin, never in argv — and emptied straight away. Nothing of a key is ever shown again: a row says only
 * whether it has one, and whether Jev uses it.
 */

/** Where Settings → AI providers is, for a link to land on it. */
export const AI_PROVIDERS_SECTION = 'ai-providers';

const EVENTS_VERSION: Call = { kind: 'version', product: 'events-daemon' };
const PROVIDER_LIST: Call = { kind: 'providerList' };
const JUDGES: Call = { kind: 'judgesList' };

/** The section, once the events service is one with provider keys; otherwise what it needs first, or nothing. */
export function AiProviders() {
  const { installation } = useAppData();
  const present = installation.state === 'ready' && installation.value.present.includes('events-daemon');
  const sectionRef = useRef<HTMLElement>(null);
  // A link from Events → Judges lands here: the section is scrolled to, and focus moves to it.
  useEffect(() => {
    if (takeDestination('settings', (destination) => destination.section === 'ai-providers') === null) return;
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
    sectionRef.current?.focus();
  }, []);
  if (!present) return null;
  return (
    <section
      ref={sectionRef}
      id={AI_PROVIDERS_SECTION}
      aria-label={PROVIDERS_COPY.title}
      tabIndex={-1}
      className="outline-none"
    >
      <SectionHeader label={PROVIDERS_COPY.title}>
        <p className="mb-(--cue-space-3) text-fg-muted">{PROVIDERS_COPY.body}</p>
        <Gated />
      </SectionHeader>
    </section>
  );
}

/** Nothing is read until the events service's own version says it keeps provider keys (DA12). */
function Gated() {
  const { result: version } = useCall<string>(EVENTS_VERSION);
  const supported = version.state === 'ready' && supports(version.value, 'judgeSetup');
  if (!supported)
    return (
      <Panel>
        <div className="px-(--cue-pad-row-x) py-(--cue-space-3)">
          <ScreenState value={version}>
            {(installed) => (
              <div className="flex flex-col gap-(--cue-space-1)">
                <p className="text-fg">{COPY.updateToUse}</p>
                <p className="text-fg-muted">{needsLine(GATES.judgeSetup, installed)}</p>
              </div>
            )}
          </ScreenState>
        </div>
      </Panel>
    );
  return <Providers />;
}

function Providers() {
  const keys = useCall<unknown>(PROVIDER_LIST);
  const judges = useCall<unknown>(JUDGES);
  useReloadOnReturn(keys.reload);
  const navigate = useNavigate();
  const read = keys.result.state === 'ready' ? readProviders(keys.result.value) : null;
  const listed = judges.result.state === 'ready' ? readListedJudges(judges.result.value) : null;
  const reload = async () => {
    await Promise.all([keys.reload(), judges.reload()]);
  };
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      <Panel>
        <ScreenState value={keys.result}>
          {() =>
            read === null ? (
              <p role="alert" className="px-(--cue-pad-row-x) py-(--cue-space-3) text-danger">
                {PROVIDERS_COPY.unreadable}
              </p>
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {AI_PROVIDERS.map((provider) => (
                  <ProviderRow
                    key={provider}
                    provider={provider}
                    hasKey={read[provider]}
                    used={listed === null ? null : providerInUse(listed, provider)}
                    reload={reload}
                  />
                ))}
                {/* Anthropic's key (0.33.0), for Analyse: a row once the event service keeps one. */}
                {listsAnthropic(keys.result) ? (
                  <ProviderRow
                    provider="anthropic"
                    hasKey={keys.result.state === 'ready' && keyOf(keys.result.value, 'anthropic')}
                    used={null}
                    reload={reload}
                  />
                ) : null}
              </div>
            )
          }
        </ScreenState>
      </Panel>
      <p className="text-fg-muted">
        {PROVIDERS_COPY.footer}
        {PROVIDERS_COPY.setUpIn}
        {navigate === null ? (
          PROVIDERS_COPY.eventsJudges
        ) : (
          <Link
            href="#judges"
            onClick={(event) => {
              event.preventDefault();
              navigate({ screen: 'events', tab: 'judges' });
            }}
          >
            {PROVIDERS_COPY.eventsJudges}
          </Link>
        )}
        .
      </p>
    </div>
  );
}

/** Whether `provider list` names Anthropic: an event service of 0.33.0 or later. */
function listsAnthropic(result: { state: string; value?: unknown }): boolean {
  if (result.state !== 'ready') return false;
  const providers = (result.value as { providers?: unknown } | null)?.providers;
  return Array.isArray(providers) && providers.some((entry) => (entry as { id?: unknown })?.id === 'anthropic');
}

/** One provider: its name and whether it has a key; Add key… when not, Replace… and Remove… when it has. */
function ProviderRow({
  provider,
  hasKey,
  used,
  reload,
}: {
  provider: AiProvider | 'anthropic';
  hasKey: boolean;
  used: boolean | null;
  reload: () => Promise<void>;
}) {
  const bridge = useBridge();
  const { run } = useChange();
  const { name, where, getKey, keys } = PROVIDERS_COPY.providers[provider];
  const titleId = useId();
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; hint: string | null } | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const empty = () => {
    if (field.current !== null) field.current.value = '';
  };

  const save = async () => {
    const value = field.current?.value.trim() ?? '';
    // Read once, then gone from the window: the field is emptied before the key is even sent.
    empty();
    if (value === '') return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.providerKeySet(provider, value);
      if (result.status === 'failed') setProblem({ message: result.message, hint: result.hint });
      else setForm(false);
    } catch (error) {
      setProblem({ message: errorMessage(error), hint: null });
    } finally {
      setBusy(false);
    }
    await reload();
  };

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await run({ kind: 'providerKeyRemove', provider });
    if (outcome.state === 'failed') setProblem({ message: outcome.message, hint: outcome.hint });
    await reload();
    setBusy(false);
  };

  return (
    <section aria-labelledby={titleId}>
      <Line className="items-start">
        <span
          aria-hidden="true"
          className="flex size-chip shrink-0 items-center justify-center rounded-control bg-sunken font-semibold text-fg-muted"
        >
          {name[0]}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-2)">
          <div className="flex flex-col gap-(--cue-space-1)">
            <span className="flex flex-wrap items-center gap-(--cue-space-2)">
              <span id={titleId} className="text-(length:--cue-text-body) font-medium text-fg">
                {name}
              </span>
              <Chip tone={hasKey ? 'ok' : 'neutral'} variant="tag">
                {hasKey ? PROVIDERS_COPY.keyAdded : PROVIDERS_COPY.noKey}
              </Chip>
            </span>
            <span className="text-fg-muted">{where}</span>
          </div>
          {provider === 'anthropic' ? (
            hasKey ? (
              <p className="text-fg-muted">{PROVIDERS_COPY.usedByAnalyse}</p>
            ) : null
          ) : hasKey ? (
            used === null ? null : (
              <p className="text-fg-muted">{used ? PROVIDERS_COPY.usedByJev : PROVIDERS_COPY.notUsed}</p>
            )
          ) : keys === null ? null : (
            <p className="text-fg-muted">
              {PROVIDERS_COPY.noAccount}
              <Link
                href={keys}
                external
                onClick={(event) => {
                  // The window never leaves the app: the page opens in the browser, through `open_link`.
                  event.preventDefault();
                  bridge
                    .openLink(keys)
                    .catch((error: unknown) => setProblem({ message: errorMessage(error), hint: null }));
                }}
              >
                {getKey}
              </Link>
              .
            </p>
          )}
          {form ? (
            <form
              className="flex flex-wrap items-end gap-(--cue-space-2)"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Field name={`${provider}-key`} className="min-w-64 flex-1">
                <FieldLabel>{keyLabel(name, hasKey)}</FieldLabel>
                <PasswordInput
                  ref={field}
                  showReveal={false}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={keyPlaceholder(name)}
                />
              </Field>
              <Button type="submit" variant="primary" loading={busy}>
                {PROVIDERS_COPY.saveKey}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  empty();
                  setForm(false);
                }}
              >
                {PROVIDERS_COPY.cancel}
              </Button>
            </form>
          ) : null}
          <SetupProblem problem={problem} />
        </div>
        {form ? null : (
          <div className="flex shrink-0 items-center gap-(--cue-space-2)">
            {hasKey ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => setForm(true)}>
                  {PROVIDERS_COPY.replace}
                </Button>
                <AlertDialog.Root>
                  <AlertDialog.Trigger
                    render={
                      <Button size="sm" variant="ghost" disabled={busy}>
                        {PROVIDERS_COPY.remove}
                      </Button>
                    }
                  />
                  <AlertDialog.Content>
                    <AlertDialog.Title>{removeKeyTitle(name)}</AlertDialog.Title>
                    <AlertDialog.Description>
                      {used === true ? PROVIDERS_COPY.removeBodyUsed(name) : PROVIDERS_COPY.removeBodyUnused}
                    </AlertDialog.Description>
                    <AlertDialog.Footer>
                      <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
                      <AlertDialog.Action tone="danger" onClick={() => void remove()}>
                        {PROVIDERS_COPY.remove.replace('…', '')}
                      </AlertDialog.Action>
                    </AlertDialog.Footer>
                  </AlertDialog.Content>
                </AlertDialog.Root>
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => setForm(true)}>
                {PROVIDERS_COPY.addKey}
              </Button>
            )}
          </div>
        )}
      </Line>
    </section>
  );
}
