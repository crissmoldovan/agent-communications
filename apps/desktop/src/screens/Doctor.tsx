import { Button, Chip, InfoTip, Panel, Row, SectionHeader } from '@cueplusplus/ui';
import { Check, CircleX, type LucideIcon, Minus, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import type { DoctorProduct, DoctorView } from '../cli-types.ts';
import { CopyButton } from '../components/CopyButton.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
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

/** Why Gmail's doctor waits to be asked: the hint beside "Not checked". */
export const GMAIL_NOT_CHECKED = "Gmail's doctor calls Google, so it runs only when you ask.";

/**
 * Each status's mark: a shape of its own as well as a colour, so a warning and a failure differ for a reader who cannot
 * tell amber from red, with the status's word for a screen reader.
 */
const MARKS: Readonly<Record<Status, { icon: LucideIcon; ink: string }>> = {
  ok: { icon: Check, ink: 'text-ok' },
  warn: { icon: TriangleAlert, ink: 'text-warn' },
  fail: { icon: CircleX, ink: 'text-danger' },
  skipped: { icon: Minus, ink: 'text-fg-subtle' },
};

/** A check's status, drawn as its mark; its word is spoken unless the row already shows it. */
function Mark({ status, spoken = true }: { status: Status; spoken?: boolean }) {
  const { icon: Icon, ink } = MARKS[status];
  return (
    <span data-status={status} className="relative inline-flex shrink-0 items-center">
      <Icon aria-hidden="true" strokeWidth={2.2} className={`size-icon-md ${ink}`} />
      {spoken ? <span className="sr-only">{status}</span> : null}
    </span>
  );
}

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
      <div className="flex flex-wrap items-center gap-(--cue-space-3)">
        <p className="min-w-0 flex-1 break-words rounded-control bg-sunken px-(--cue-space-3) py-(--cue-space-2) font-mono text-(length:--cue-text-ui) text-fg">
          <UntrustedText text={text} />
        </p>
        <div className="flex shrink-0 flex-wrap gap-(--cue-space-2)">
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
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={problem} />
        </p>
      )}
    </div>
  );
}

/** Something to look at: a failing or warning check, a doctor that did not run, or one that says it is not healthy. */
interface Issue {
  key: string;
  product: DoctorProduct;
  name: string;
  status: 'fail' | 'warn';
  title: string;
  detail: string;
  fix?: string;
  /** What went wrong running the doctor, said the moment it shows. */
  alert?: boolean;
}

/** What there is to look at across the doctors shown: every failure first, then every warning, each in the doctors' order. */
function issuesOf(
  shown: readonly { product: DoctorProduct; name: string }[],
  doctors: Partial<Record<DoctorProduct, Loadable<DoctorView>>>,
): Issue[] {
  const failing: Issue[] = [];
  const warnings: Issue[] = [];
  for (const { product, name } of shown) {
    const result = doctors[product];
    if (result?.state === 'error') {
      failing.push({
        key: `${product}:run`,
        product,
        name,
        status: 'fail',
        title: 'Did not run',
        detail: result.message,
        alert: true,
      });
    }
    if (result?.state !== 'ready') continue;
    const { checks, healthy } = result.value;
    checks.forEach((check, index) => {
      if (check.status !== 'fail' && check.status !== 'warn') return;
      const issue: Issue = {
        key: `${product}:${index}`,
        product,
        name,
        status: check.status,
        title: check.title,
        detail: check.detail,
      };
      if (check.fix !== undefined) issue.fix = check.fix;
      (check.status === 'fail' ? failing : warnings).push(issue);
    });
    if (!healthy && !checks.some((check) => check.status === 'fail' || check.status === 'warn')) {
      failing.push({ key: `${product}:healthy`, product, name, status: 'fail', title: 'Not healthy', detail: '' });
    }
  }
  return [...failing, ...warnings];
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The page's one line under its title: how the checks came out, or that they are running. */
function summaryOf(
  shown: readonly { product: DoctorProduct }[],
  doctors: Partial<Record<DoctorProduct, Loadable<DoctorView>>>,
  issues: number,
): string | null {
  const results = shown.flatMap(({ product }) => {
    const result = doctors[product];
    return result === undefined ? [] : [result];
  });
  if (results.some((result) => result.state === 'loading')) return 'Checking…';
  if (results.length === 0) return null;
  const checks = results.flatMap((result) => (result.state === 'ready' ? result.value.checks : []));
  const passing = checks.filter((check) => check.status === 'ok').length;
  const skipped = checks.filter((check) => check.status === 'skipped').length;
  return [
    plural(passing, 'check passes', 'checks pass'),
    ...(issues > 0 ? [`${issues} to look at`] : []),
    ...(skipped > 0 ? [`${skipped} skipped`] : []),
  ].join(' · ');
}

/** One thing to look at, tinted by its tone: whose it is, what it says, and its fix to copy. */
function IssueItem({ issue }: { issue: Issue }) {
  const ground = issue.status === 'warn' ? 'bg-(--cue-warn-soft)' : 'bg-(--cue-danger-soft)';
  return (
    <li
      data-product={issue.product}
      className={`flex items-start gap-(--cue-space-4) rounded-surface px-(--cue-space-5) py-(--cue-space-4) ${ground}`}
    >
      <span className="flex h-lh items-center">
        <Mark status={issue.status} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <p className="min-w-0 break-words text-fg">
          <span className="text-fg-muted">{issue.name}</span>
          <span aria-hidden="true" className="text-fg-subtle">
            {' · '}
          </span>
          <span className="font-medium">
            <UntrustedText text={issue.title} />
          </span>
        </p>
        {issue.detail === '' ? null : (
          <p role={issue.alert ? 'alert' : undefined} className="min-w-0 break-words text-fg-muted">
            <UntrustedText text={issue.detail} />
          </p>
        )}
        {issue.fix === undefined ? null : (
          <div className="pt-(--cue-space-1)">
            <Fix text={issue.fix} />
          </div>
        )}
      </div>
    </li>
  );
}

/** A check that passed or was skipped, kept quiet: its mark, its title, and its detail at the far end. */
function QuietCheck({ check }: { check: DoctorView['checks'][number] }) {
  const skipped = check.status === 'skipped';
  return (
    <Row className="items-center">
      <Mark status={check.status} spoken={!skipped} />
      <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
        <span className={skipped ? 'text-fg-muted' : 'text-fg'}>
          <UntrustedText text={check.title} />
        </span>
        {check.fix === undefined ? null : <Fix text={check.fix} />}
      </div>
      {check.detail === '' ? null : (
        <span className="min-w-0 break-words text-right text-(length:--cue-text-ui) text-fg-muted">
          <UntrustedText text={check.detail} />
        </span>
      )}
      {skipped ? <Chip variant="tag">{check.status}</Chip> : null}
    </Row>
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

/**
 * A doctor's own list, under its name: what it says while it runs or before it is asked, and the checks that passed or
 * were skipped. What it found to look at is at the top of the screen, so its list holds only the quiet rest.
 */
function QuietChecks({ product, result }: { product: DoctorProduct; result: Loadable<DoctorView> | undefined }) {
  if (result === undefined) {
    return (
      <Panel>
        <Row>
          {product === 'gmail' ? (
            <span className="inline-flex items-center gap-(--cue-space-2) text-fg-muted">
              Not checked
              <InfoTip text={GMAIL_NOT_CHECKED} label="Why Gmail is not checked" />
            </span>
          ) : (
            <span className="text-fg-muted">Not checked yet.</span>
          )}
        </Row>
      </Panel>
    );
  }
  if (result.state === 'loading') {
    return (
      <Panel>
        <Row>
          <ScreenState value={result}>{() => null}</ScreenState>
        </Row>
      </Panel>
    );
  }
  if (result.state === 'error') return null;
  const { checks } = result.value;
  if (checks.length === 0) {
    return (
      <Panel>
        <Row>
          <span className="text-fg-muted">This doctor ran no checks.</span>
        </Row>
      </Panel>
    );
  }
  const quiet = checks.filter((check) => check.status === 'ok' || check.status === 'skipped');
  if (quiet.length === 0) return null;
  return (
    <Panel>
      {quiet.map((check, index) => (
        // A report's checks have no id in every product's shape; their order in the report is theirs.
        // biome-ignore lint/suspicious/noArrayIndexKey: each report replaces the one before it whole
        <QuietCheck key={index} check={check} />
      ))}
    </Panel>
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
  const id = useId();
  const gmail = product === 'gmail';
  return (
    <section aria-labelledby={id}>
      <SectionHeader
        label={<span id={id}>{name}</span>}
        action={
          <>
            <Summary result={result} />
            {gmail ? (
              <Button size="sm" disabled={result?.state === 'loading'} onClick={onCheckGmail}>
                Check Gmail (asks Google)
              </Button>
            ) : null}
          </>
        }
      >
        <QuietChecks product={product} result={result} />
      </SectionHeader>
    </section>
  );
}

/**
 * Every check of every doctor here (DA5.7, DA14). The doctors run when the screen opens and on Refresh: each present
 * one but Gmail's, which calls Google and runs only on `Check Gmail`. Slack's and Resend's run offline (the allow-list
 * adds `--offline`). Core's never runs on a timer, because each run writes to the keychain. A fix is shown with Copy.
 * What needs a look — a failure, a warning, a doctor that did not run — comes first, across every doctor; each
 * doctor's list under it holds only what passed or was skipped.
 */
export function Doctor() {
  const { installation, doctors, runDoctors } = useAppData();
  const present = installation.state === 'ready' ? installation.value.present : [];
  const shown = DOCTORS.filter(({ product }) => present.includes(product));
  const unasked = shown.map(({ product }) => product).filter((product) => product !== 'gmail');
  const issues = issuesOf(shown, doctors);
  const summary = summaryOf(shown, doctors, issues.length);

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
      <div className="flex flex-col gap-(--cue-space-6)">
        <div className="flex flex-col gap-(--cue-space-4)">
          <div className="flex items-center gap-(--cue-space-4)">
            <p data-slot="doctor-summary" className="min-w-0 flex-1 text-fg-muted">
              {summary}
            </p>
            <Button
              size="sm"
              disabled={unasked.some((product) => doctors[product]?.state === 'loading')}
              onClick={() => void runDoctors(unasked)}
            >
              Refresh
            </Button>
          </div>
          {issues.length === 0 ? null : (
            <section aria-label="To look at">
              <ul className="flex flex-col gap-(--cue-space-3)">
                {issues.map((issue) => (
                  <IssueItem key={issue.key} issue={issue} />
                ))}
              </ul>
            </section>
          )}
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
      </div>
    </ScreenFrame>
  );
}
