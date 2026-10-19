import { Button, Chip, Row } from '@cueplusplus/ui';
import { useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import type { DoctorProduct, DoctorView } from '../cli-types.ts';
import { CopyButton } from '../components/CopyButton.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { type Loadable, useAppData } from '../data.tsx';
import { errorMessage } from '../ipc.ts';
import { ScreenFrame } from './Screen.tsx';

/** Each product's doctor, in the order the screen shows them, by the name a person knows it by. */
const DOCTORS: readonly { product: DoctorProduct; name: string }[] = [
  { product: 'core', name: 'agent-communications' },
  { product: 'gmail', name: 'Gmail' },
  { product: 'slack', name: 'Slack' },
  { product: 'resend', name: 'Resend' },
  { product: 'whatsapp', name: 'WhatsApp' },
  { product: 'events-daemon', name: 'Events service' },
];

type Status = DoctorView['checks'][number]['status'];

const TONES: Readonly<Record<Status, 'ok' | 'warn' | 'danger' | 'neutral'>> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'danger',
  skipped: 'neutral',
};

/**
 * The hosts whose links a fix may open, exactly: where doctor fixes, and the hints a failing check carries into one,
 * send a person — a Slack app's settings, an app's access to a Google account, Gmail's OAuth client (DA16).
 */
const LINK_HOSTS = ['api.slack.com', 'myaccount.google.com', 'console.cloud.google.com'] as const;

/**
 * Whether the app may open `url` (DA7, DA16), as Rust's `links::allowed_link` decides it again before anything opens:
 * `https`, no user, password or port of its own, on one of `LINK_HOSTS`, and never Google's `/url` redirect.
 */
export function allowedLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    return false;
  }
  const path = parsed.pathname.toLowerCase();
  if (path === '/url' || path.startsWith('/url/')) return false;
  return (LINK_HOSTS as readonly string[]).includes(parsed.hostname);
}

/** Every `https://` link in a fix's text, without the punctuation that ends the sentence around it. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s<>"'`()[\]{}]+/g)].map((match) => match[0].replace(/[.,;:!?]+$/, ''));
}

/** The links a fix may open, each as the URL parser writes it, so what opens is exactly what was checked. */
function openable(fix: string): string[] {
  return [
    ...new Set(
      linksIn(fix)
        .filter(allowedLink)
        .map((url) => new URL(url).href),
    ),
  ];
}

/** A fix: its text, as text, with Copy, and Open link for each link the app may open (DA14: running it is future work). */
function Fix({ text }: { text: string }) {
  const bridge = useBridge();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-(--cue-space-2)">
      <p className="font-mono text-fg">
        <UntrustedText text={text} />
      </p>
      <div className="flex flex-wrap gap-(--cue-space-2)">
        <CopyButton text={text} />
        {openable(text).map((url) => (
          <Button
            key={url}
            size="sm"
            title={url}
            onClick={() => {
              setProblem(null);
              bridge.openLink(url).catch((error: unknown) => setProblem(errorMessage(error)));
            }}
          >
            Open link
          </Button>
        ))}
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={problem} />
        </p>
      )}
    </div>
  );
}

/** One doctor's checks: each its title, a tone chip and its detail, and its fix. */
function Checks({ view }: { view: DoctorView }) {
  if (view.checks.length === 0) return <p className="text-fg-muted">This doctor ran no checks.</p>;
  return (
    <div>
      {view.checks.map((check, index) => (
        // A report's checks have no id in every product's shape; their order in the report is theirs.
        // biome-ignore lint/suspicious/noArrayIndexKey: each report replaces the one before it whole
        <Row key={index} className="items-start">
          <Chip tone={TONES[check.status]} variant="tag">
            {check.status}
          </Chip>
          <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
            <span className="text-fg">
              <UntrustedText text={check.title} />
            </span>
            {check.detail === '' ? null : (
              <span className="text-fg-muted">
                <UntrustedText text={check.detail} />
              </span>
            )}
            {check.fix === undefined ? null : <Fix text={check.fix} />}
          </div>
        </Row>
      ))}
    </div>
  );
}

/** What a doctor's result comes to, in one or two words, for its header. */
function Summary({ result }: { result: Loadable<DoctorView> | undefined }) {
  if (result === undefined || result.state === 'loading') return null;
  if (result.state === 'error') {
    return (
      <Chip tone="danger" variant="tag">
        did not run
      </Chip>
    );
  }
  const statuses = result.value.checks.map((check) => check.status);
  if (!result.value.healthy || statuses.includes('fail')) {
    return (
      <Chip tone="danger" variant="tag">
        problems
      </Chip>
    );
  }
  if (statuses.includes('warn')) {
    return (
      <Chip tone="warn" variant="tag">
        warnings
      </Chip>
    );
  }
  return (
    <Chip tone="ok" variant="tag">
      healthy
    </Chip>
  );
}

function ProductDoctor({
  product,
  name,
  result,
  onCheckGmail,
}: {
  product: DoctorProduct;
  name: string;
  result: Loadable<DoctorView> | undefined;
  onCheckGmail: () => void;
}) {
  const gmail = product === 'gmail';
  return (
    <SectionPanel
      title={name}
      actions={
        <div className="flex items-center gap-(--cue-space-2)">
          <Summary result={result} />
          {gmail ? (
            <Button size="sm" disabled={result?.state === 'loading'} onClick={onCheckGmail}>
              Check Gmail (asks Google)
            </Button>
          ) : null}
        </div>
      }
    >
      {result === undefined ? (
        <p className="text-fg-muted">
          {gmail ? "Not checked: Gmail's doctor calls Google, so it runs only when you ask." : 'Not checked yet.'}
        </p>
      ) : (
        <ScreenState value={result}>{(view) => <Checks view={view} />}</ScreenState>
      )}
    </SectionPanel>
  );
}

/**
 * Every check of every doctor here (DA5.7, DA14). The doctors run when the screen opens and on Refresh: each present
 * one but Gmail's, which calls Google and runs only on `Check Gmail`. Slack's and Resend's run offline (the allow-list
 * adds `--offline`). Core's never runs on a timer, because each run writes to the keychain. A fix is shown with Copy.
 */
export function Doctor() {
  const { installation, doctors, runDoctors } = useAppData();
  const present = installation.state === 'ready' ? installation.value.present : [];
  const shown = DOCTORS.filter(({ product }) => present.includes(product));
  const unasked = shown.map(({ product }) => product).filter((product) => product !== 'gmail');

  // On open, once: every doctor but Gmail's, except one already running (the start's, if the screen opened fast).
  // Once means once: a development build's strict mode runs effects twice, and core's doctor writes to the keychain.
  const latest = useRef({ unasked, doctors, runDoctors });
  const opened = useRef(false);
  useEffect(() => {
    latest.current = { unasked, doctors, runDoctors };
  });
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const { unasked: products, doctors: results, runDoctors: run } = latest.current;
    void run(products.filter((product) => results[product]?.state !== 'loading'));
  }, []);

  return (
    <ScreenFrame title="Doctor">
      <div className="flex gap-(--cue-space-2)">
        <Button
          disabled={unasked.some((product) => doctors[product]?.state === 'loading')}
          onClick={() => void runDoctors(unasked)}
        >
          Refresh
        </Button>
      </div>
      {shown.map(({ product, name }) => (
        <ProductDoctor
          key={product}
          product={product}
          name={name}
          result={doctors[product]}
          onCheckGmail={() => void runDoctors(['gmail'])}
        />
      ))}
    </ScreenFrame>
  );
}
