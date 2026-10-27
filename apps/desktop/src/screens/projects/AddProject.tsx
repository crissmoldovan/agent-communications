/**
 * Add a project… (workflows design §8.1; the approved prototype's AddProject board, as 0.36 has it): the checkouts on
 * this Mac, found by `project scan` and grouped by the GitHub repository each one's origin names; the person picks one,
 * or types its `owner/name`; ticks the folders that are part of it; names it, writes its profile and its hints; and Add
 * makes it, with `project add -`. Nothing runs that is not on this Mac: a repository with no checkout here cannot be
 * worked on until Agent Comms can clone one, so it says so.
 *
 * Folders show with the home as `~`: this is the person's own view. The name, the profile and the hints are the
 * person's words; a folder's path and a repository's name are the person's disk's, shown as text.
 */
import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Panel,
  Radio,
  RadioGroup,
  Spinner,
  TagsInput,
  Textarea,
} from '@cueplusplus/ui';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useBridge } from '../../bridge-context.tsx';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { COPY } from '../../copy.ts';
import { isProjectId } from '../../grammar.ts';
import { errorMessage } from '../../ipc.ts';
import { shownFolder } from '../../lanes.ts';
import {
  type ProjectHintsV1,
  type ProjectScanResultV1,
  type ProjectV1,
  readScan,
  type ScanRepoV1,
} from '../../workflows/types.ts';
import { BackTo, Problem } from '../events/parts.tsx';
import { HINT_KEYS, PROFILE_MAX, PROJECTS_COPY, projectDocument } from './shared.tsx';

export const ADD_PROJECT_COPY = {
  title: 'Add a project',
  back: 'Projects',
  intro:
    'From the checkouts on this Mac: pick its repository, tick its folders, then say what it is. It stays on this Mac, and only you change it.',
  repository: 'Its repository',
  lookedIn: (roots: string) => `Looked in ${roots} for checkouts of a GitHub repository.`,
  scanning: 'Looking for checkouts on this Mac…',
  noRepos: 'No checkout of a GitHub repository was found here.',
  known: (project: string) => `Already the project ${project}`,
  folderCount: (count: number) => (count === 1 ? '1 folder' : `${count} folders`),
  typed: 'Or type its name on GitHub',
  typedHint: 'owner/name, as in github.com/owner/name',
  typedWrong: 'A GitHub repository is owner/name: letters, digits, ., _ and -.',
  notFound: (repo: string) =>
    `No checkout of ${repo} was found on this Mac. Clone it first, or look in the folder it is in.`,
  lookIn: 'Look in another folder',
  lookInHint: 'A whole folder, starting with /: the scan looks inside it, four folders deep.',
  lookInWrong: 'A folder written whole: it starts with / and has no . or .. step.',
  look: 'Look there',
  skipped: (count: number) =>
    count === 1
      ? '1 folder was passed over: a link, a hidden folder, or Agent Comms’ own.'
      : `${count} folders were passed over: links, hidden folders, or Agent Comms’ own.`,
  folders: 'Its folders on this Mac',
  foldersHint: 'A workflow’s session may work in a ticked folder once you approve a workflow that names this project.',
  noFolderTicked: 'Tick at least one folder.',
  name: 'Its name',
  nameHint: 'What it is called in Agent Comms and in each workflow’s approval.',
  id: 'Its id',
  idHint: 'Lowercase letters, digits and -, at most 64. It cannot change later.',
  idWrong: 'Lowercase letters, digits and -, at most 64.',
  idTaken: 'Another project has this id.',
  add: 'Add the project',
  cancel: 'Cancel',
  unreadable: 'The scan could not be read.',
} as const;

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/u;
const NAME = /^[a-z0-9._-]{1,100}$/u;

/**
 * A GitHub repository as a project keeps it, `github.com/<owner>/<name>`, from what the person types: `owner/name`,
 * `github.com/owner/name`, or its https address; null for anything else. The event service folds it again.
 */
export function foldTypedRepo(value: string): string | null {
  let rest = value.trim();
  const form = /^(?:https:\/\/)?github\.com\/(.+)$/iu.exec(rest);
  if (form !== null) rest = form[1] as string;
  else if (rest.includes(':')) return null;
  rest = rest.replace(/\/+$/u, '').replace(/\.git$/iu, '');
  const parts = rest.split('/');
  if (parts.length !== 2) return null;
  const owner = (parts[0] as string).toLowerCase();
  const name = (parts[1] as string).toLowerCase();
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null;
  return `github.com/${owner}/${name}`;
}

/** A folder written whole: absolute, with no `.` or `..` step and no trailing `/`, as Rust's scan roots take it. */
function wholeFolder(value: string): boolean {
  if (!value.startsWith('/') || value === '/' || value.endsWith('/')) return false;
  return value
    .slice(1)
    .split('/')
    .every((step) => step !== '' && step !== '.' && step !== '..');
}

/** An id from a name: lowercase, every run of other characters one `-`, at most 64. */
function idOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');
}

/** One numbered step of the page. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">
        <h3 id={id} className="flex items-center gap-(--cue-space-2) font-semibold text-fg">
          <span
            aria-hidden="true"
            className="flex size-(--cue-space-6) items-center justify-center rounded-full bg-accent-soft text-(length:--cue-text-label) text-accent"
          >
            {n}
          </span>
          {title}
        </h3>
        {children}
      </Panel>
    </section>
  );
}

type Scan = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: ProjectScanResultV1 };

export function AddProject({
  known,
  home,
  onClose,
  onAdded,
}: {
  known: readonly ProjectV1[];
  home: string | null;
  onClose: () => void;
  onAdded: (name: string) => Promise<void>;
}) {
  const bridge = useBridge();
  const [roots, setRoots] = useState<string[]>([]);
  const [scan, setScan] = useState<Scan>({ state: 'loading' });
  const [repo, setRepo] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [lookIn, setLookIn] = useState('');
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [name, setName] = useState('');
  const [id, setId] = useState<string | null>(null);
  const [profile, setProfile] = useState('');
  const [hints, setHints] = useState<ProjectHintsV1>({ senderDomains: [], slackConversations: [], people: [] });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The scan, from the event service's own roots, or from the folders the person named.
  const rootsKey = roots.join('\n');
  useEffect(() => {
    let current = true;
    setScan({ state: 'loading' });
    const asked = rootsKey === '' ? [] : rootsKey.split('\n');
    bridge
      .cli({ kind: 'eventsProjectScan', roots: asked })
      .then((result) => {
        if (!current) return;
        if (result.status !== 'ok') {
          setScan({
            state: 'error',
            message: result.status === 'failed' ? result.message : ADD_PROJECT_COPY.unreadable,
          });
          return;
        }
        try {
          setScan({ state: 'ready', value: readScan(result.data) });
        } catch {
          setScan({ state: 'error', message: ADD_PROJECT_COPY.unreadable });
        }
      })
      .catch((error: unknown) => {
        if (current) setScan({ state: 'error', message: errorMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [bridge, rootsKey]);

  const repos = scan.state === 'ready' ? scan.value.repos : [];
  const typedRepo = typed.trim() === '' ? null : foldTypedRepo(typed);
  const typedWrong = typed.trim() !== '' && typedRepo === null;
  const chosen: ScanRepoV1 | null = useMemo(() => {
    const wanted = typedRepo ?? repo;
    return wanted === null ? null : (repos.find((each) => each.repo === wanted) ?? null);
  }, [typedRepo, repo, repos]);
  const notFound = typedRepo !== null && scan.state === 'ready' && chosen === null;
  const ticked = chosen === null ? [] : chosen.folders.filter((folder) => !unticked.has(folder.folder));
  const defaultName = chosen === null ? '' : (chosen.repo.split('/').at(-1) ?? '');
  const shownName = name === '' ? defaultName : name;
  const shownId = id ?? idOf(shownName);
  const idWrong = shownId !== '' && !isProjectId(shownId);
  const idTaken = known.some((project) => project.projectId === shownId);
  const long = [...profile].length > PROFILE_MAX;
  const ready =
    chosen !== null &&
    chosen.known === null &&
    ticked.length > 0 &&
    shownName.trim() !== '' &&
    isProjectId(shownId) &&
    !idTaken &&
    !long;

  const pick = (next: string) => {
    setRepo(next);
    setTyped('');
    setUnticked(new Set());
    setName('');
    setId(null);
  };

  const add = async () => {
    if (!ready || chosen === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await bridge.cli({
        kind: 'eventsProjectAdd',
        document: projectDocument({
          projectId: shownId,
          name: shownName.trim(),
          repo: chosen.repo,
          profile,
          hints,
          folders: ticked.map((folder) => ({
            folder: folder.folder,
            kind: folder.kind,
            defaultBranch: folder.defaultBranch,
            worktreeRoot: null,
          })),
        }),
      });
      if (result.status !== 'ok') {
        setProblem(result.status === 'failed' ? result.message : ADD_PROJECT_COPY.unreadable);
        return;
      }
      await onAdded(shownName.trim());
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const lookInWrong = lookIn.trim() !== '' && !wholeFolder(lookIn.trim());
  return (
    <section aria-label={ADD_PROJECT_COPY.title} className="flex flex-col gap-(--cue-space-4)">
      <BackTo label={ADD_PROJECT_COPY.back} onBack={onClose} />
      <h2 className="font-semibold text-(length:--cue-text-title) text-fg">{ADD_PROJECT_COPY.title}</h2>
      <p className="text-fg-muted">{ADD_PROJECT_COPY.intro}</p>
      <Step n={1} title={ADD_PROJECT_COPY.repository}>
        {scan.state === 'loading' ? (
          <Spinner label={ADD_PROJECT_COPY.scanning} />
        ) : scan.state === 'error' ? (
          <Problem message={scan.message} />
        ) : (
          <>
            <p className="text-(length:--cue-text-label) text-fg-muted">
              <UntrustedText
                text={ADD_PROJECT_COPY.lookedIn(scan.value.roots.map((root) => shownFolder(root, home)).join(', '))}
              />
            </p>
            {scan.value.repos.length === 0 ? (
              <p className="text-fg-muted">{ADD_PROJECT_COPY.noRepos}</p>
            ) : (
              <RadioGroup
                aria-label={ADD_PROJECT_COPY.repository}
                value={chosen?.repo ?? ''}
                onValueChange={(value) => pick(String(value))}
              >
                {scan.value.repos.map((each) => (
                  <Radio
                    key={each.repo}
                    value={each.repo}
                    disabled={each.known !== null}
                    data-repo={each.repo}
                    label={
                      <span className="flex flex-wrap items-baseline gap-x-(--cue-space-3)">
                        <span className="font-medium text-fg">
                          <UntrustedText text={each.repo} />
                        </span>
                        <span className="text-(length:--cue-text-label) text-fg-muted">
                          {each.known === null ? (
                            ADD_PROJECT_COPY.folderCount(each.folders.length)
                          ) : (
                            <UntrustedText text={ADD_PROJECT_COPY.known(each.known)} />
                          )}
                        </span>
                      </span>
                    }
                  />
                ))}
              </RadioGroup>
            )}
            {scan.value.skipped.length === 0 ? null : (
              <p className="text-(length:--cue-text-label) text-fg-subtle">
                {ADD_PROJECT_COPY.skipped(scan.value.skipped.length)}
              </p>
            )}
          </>
        )}
        <Field name="typed-repo" invalid={typedWrong}>
          <FieldLabel>{ADD_PROJECT_COPY.typed}</FieldLabel>
          <Input
            value={typed}
            spellCheck={false}
            autoComplete="off"
            placeholder="owner/name"
            onValueChange={(value: string) => {
              setTyped(value);
              setUnticked(new Set());
              setName('');
              setId(null);
            }}
          />
          <FieldDescription>{ADD_PROJECT_COPY.typedHint}</FieldDescription>
          <FieldError issues={typedWrong ? [{ message: ADD_PROJECT_COPY.typedWrong }] : []} />
        </Field>
        {notFound && typedRepo !== null ? (
          <p role="status" data-slot="no-checkout" className="text-warn">
            <UntrustedText text={ADD_PROJECT_COPY.notFound(typedRepo)} />
          </p>
        ) : null}
        <Field name="look-in" invalid={lookInWrong}>
          <FieldLabel>{ADD_PROJECT_COPY.lookIn}</FieldLabel>
          <span className="flex gap-(--cue-space-2)">
            <Input
              value={lookIn}
              spellCheck={false}
              autoComplete="off"
              onValueChange={(value: string) => setLookIn(value)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={lookIn.trim() === '' || lookInWrong}
              onClick={() => setRoots([lookIn.trim()])}
            >
              {ADD_PROJECT_COPY.look}
            </Button>
          </span>
          <FieldDescription>{ADD_PROJECT_COPY.lookInHint}</FieldDescription>
          <FieldError issues={lookInWrong ? [{ message: ADD_PROJECT_COPY.lookInWrong }] : []} />
        </Field>
      </Step>
      {chosen === null || chosen.known !== null ? null : (
        <>
          <Step n={2} title={ADD_PROJECT_COPY.folders}>
            <p className="text-(length:--cue-text-label) text-fg-muted">{ADD_PROJECT_COPY.foldersHint}</p>
            <ul className="flex flex-col gap-(--cue-space-1)">
              {chosen.folders.map((folder) => (
                <li key={folder.folder} data-folder={folder.folder}>
                  <Checkbox
                    checked={!unticked.has(folder.folder)}
                    onCheckedChange={(checked: boolean) => {
                      const next = new Set(unticked);
                      if (checked) next.delete(folder.folder);
                      else next.add(folder.folder);
                      setUnticked(next);
                    }}
                    label={
                      <span className="flex flex-wrap gap-x-(--cue-space-2)">
                        <span className="break-all text-fg">
                          <UntrustedText text={shownFolder(folder.folder, home)} />
                        </span>
                        <span className="text-(length:--cue-text-label) text-fg-muted">
                          {[
                            PROJECTS_COPY.kinds[folder.kind],
                            folder.defaultBranch === null ? null : folder.defaultBranch,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
            {ticked.length === 0 ? <p className="text-warn">{ADD_PROJECT_COPY.noFolderTicked}</p> : null}
          </Step>
          <Step n={3} title={PROJECTS_COPY.profile}>
            <Field name="project-name">
              <FieldLabel>{ADD_PROJECT_COPY.name}</FieldLabel>
              <Input value={shownName} autoComplete="off" onValueChange={(value: string) => setName(value)} />
              <FieldDescription>{ADD_PROJECT_COPY.nameHint}</FieldDescription>
            </Field>
            <Field name="project-id" invalid={idWrong || idTaken}>
              <FieldLabel>{ADD_PROJECT_COPY.id}</FieldLabel>
              <Input
                value={shownId}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(value: string) => setId(value)}
              />
              <FieldDescription>{ADD_PROJECT_COPY.idHint}</FieldDescription>
              <FieldError
                issues={
                  idWrong
                    ? [{ message: ADD_PROJECT_COPY.idWrong }]
                    : idTaken
                      ? [{ message: ADD_PROJECT_COPY.idTaken }]
                      : []
                }
              />
            </Field>
            <Field name="project-profile" invalid={long}>
              <FieldLabel>{PROJECTS_COPY.profile}</FieldLabel>
              <Textarea rows={4} value={profile} onChange={(event) => setProfile(event.target.value)} />
              <FieldDescription>{PROJECTS_COPY.profileLimit}</FieldDescription>
              <FieldError issues={long ? [{ message: PROJECTS_COPY.profileTooLong }] : []} />
            </Field>
          </Step>
          <Step n={4} title={PROJECTS_COPY.hints}>
            <p className="text-(length:--cue-text-label) text-fg-muted">{PROJECTS_COPY.hintsAbout}</p>
            {HINT_KEYS.map((key) => (
              <Field key={key} name={`new-hints-${key}`}>
                <FieldLabel>{PROJECTS_COPY.hintWords[key]}</FieldLabel>
                <TagsInput
                  aria-label={PROJECTS_COPY.hintWords[key]}
                  placeholder={PROJECTS_COPY.hintExamples[key]}
                  value={hints[key]}
                  onValueChange={(value: string[]) => setHints({ ...hints, [key]: value })}
                />
              </Field>
            ))}
          </Step>
        </>
      )}
      {problem === null ? null : <Problem message={problem} />}
      <div className="flex gap-(--cue-space-2)">
        <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void add()}>
          {ADD_PROJECT_COPY.add}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {ADD_PROJECT_COPY.cancel}
        </Button>
      </div>
      {scan.state === 'loading' ? <span className="sr-only">{COPY.loading}</span> : null}
    </section>
  );
}
