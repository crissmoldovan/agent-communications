/**
 * Projects (workflows design §8, §11.2; the approved prototype's Projects board): the GitHub repositories the person
 * works on, their folders on this Mac — checkouts and their worktrees — the agent windows that worked in them today,
 * the profile a judge reads to choose a project, and the hints that choose one without a judge. A workflow's Which
 * project? step chooses among them.
 *
 * Projects are the person's alone (§8.1): only they add, change or remove one, here or at their terminal, and no agent
 * reads the list. A project's folders become what a workflow may work in only when a workflow's approval binds them; its
 * profile and hints change at once, and so does Remove. Projects need the event service, from 0.36.0.
 *
 * This is the person's own view, so folders show, with the home as `~`. A name, a profile and the hints are the
 * person's words, shown as text and nothing else.
 */
import {
  AlertDialog,
  Button,
  Chip,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Panel,
  Spinner,
  TagsInput,
  Textarea,
} from '@cueplusplus/ui';
import { FolderGit2, Plus } from 'lucide-react';
import { type ReactNode, useCallback, useId, useMemo, useState } from 'react';
import { readSessions, type SessionView } from '../activity.ts';
import { useBridge } from '../bridge-context.tsx';
import { NeedsNewerCli } from '../components/NeedsNewerCli.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { supports } from '../gates.ts';
import { useCall } from '../hooks/use-call.ts';
import { useReloadOnServiceTurn } from '../hooks/use-reload-on-return.ts';
import { errorMessage } from '../ipc.ts';
import { shownFolder } from '../lanes.ts';
import { type ProjectHintsV1, type ProjectV1, readProjects } from '../workflows/types.ts';
import { Day, Problem, Short } from './events/parts.tsx';
import { AddProject } from './projects/AddProject.tsx';
import { HINT_KEYS, PROFILE_MAX, PROJECTS_COPY, projectDocument } from './projects/shared.tsx';
import { ScreenFrame } from './Screen.tsx';

/** The agent windows whose folder is one of the project's, or inside one. */
function windowsIn(project: ProjectV1, sessions: readonly SessionView[], home: string | null): SessionView[] {
  const folders = project.folders.map((each) => shownFolder(each.folder, home));
  return sessions.filter(
    (session) =>
      session.folder !== null &&
      folders.some((folder) => session.folder === folder || (session.folder as string).startsWith(`${folder}/`)),
  );
}

/** A titled part of a project's card. */
function Part({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-(--cue-space-2)">
      <div className="flex items-center gap-(--cue-space-2)">
        <h3 id={id} className="font-medium text-(length:--cue-text-label) text-fg-muted">
          {title}
        </h3>
        {action === undefined ? null : <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** Changes a project at once: the whole document again, with `change` made. */
function useUpdate(project: ProjectV1, onChanged: () => Promise<void>) {
  const bridge = useBridge();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const update = useCallback(
    async (change: Partial<Pick<ProjectV1, 'profile' | 'hints'>>): Promise<boolean> => {
      setBusy(true);
      setProblem(null);
      setSaid(null);
      try {
        const result = await bridge.cli({
          kind: 'eventsProjectUpdate',
          document: projectDocument({ ...project, ...change }),
        });
        if (result.status !== 'ok') {
          setProblem(result.status === 'failed' ? result.message : PROJECTS_COPY.unreadable);
          return false;
        }
        setSaid(PROJECTS_COPY.saved);
        await onChanged();
        return true;
      } catch (error) {
        setProblem(errorMessage(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [bridge, project, onChanged],
  );
  return { update, busy, problem, said };
}

function Profile({ project, onChanged }: { project: ProjectV1; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const { update, busy, problem, said } = useUpdate(project, onChanged);
  const long = editing !== null && [...editing].length > PROFILE_MAX;
  return (
    <Part
      title={PROJECTS_COPY.profile}
      action={
        editing === null ? (
          <Button size="sm" variant="ghost" onClick={() => setEditing(project.profile)}>
            {PROJECTS_COPY.edit}
          </Button>
        ) : undefined
      }
    >
      {editing === null ? (
        <>
          {project.profile === '' ? (
            <p className="text-fg-muted">{PROJECTS_COPY.profileEmpty}</p>
          ) : (
            <p className="text-fg" data-slot="project-profile">
              <UntrustedText text={project.profile} />
            </p>
          )}
          {project.profileAt === null || project.profileBy !== 'person' ? null : (
            <p className="text-(length:--cue-text-label) text-fg-muted">
              {PROJECTS_COPY.profileBy(<Day at={project.profileAt} />)}
            </p>
          )}
        </>
      ) : (
        <Field name="profile" invalid={long}>
          <FieldLabel className="sr-only">{PROJECTS_COPY.profile}</FieldLabel>
          <Textarea
            aria-label={PROJECTS_COPY.profile}
            rows={4}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
          />
          <FieldDescription>{PROJECTS_COPY.profileLimit}</FieldDescription>
          <FieldError issues={long ? [{ message: PROJECTS_COPY.profileTooLong }] : []} />
          <div className="flex gap-(--cue-space-2)">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={long}
              onClick={() =>
                void update({ profile: editing }).then((done) => {
                  if (done) setEditing(null);
                })
              }
            >
              {PROJECTS_COPY.save}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
              {PROJECTS_COPY.cancel}
            </Button>
          </div>
        </Field>
      )}
      {problem === null ? null : <Problem message={problem} />}
      {said === null ? null : (
        <p role="status" className="text-(length:--cue-text-label) text-ok">
          {said}
        </p>
      )}
    </Part>
  );
}

function Hints({ project, onChanged }: { project: ProjectV1; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<ProjectHintsV1 | null>(null);
  const { update, busy, problem, said } = useUpdate(project, onChanged);
  return (
    <Part
      title={PROJECTS_COPY.hints}
      action={
        editing === null ? (
          <Button size="sm" variant="ghost" onClick={() => setEditing(project.hints)}>
            {PROJECTS_COPY.edit}
          </Button>
        ) : undefined
      }
    >
      <p className="text-(length:--cue-text-label) text-fg-muted">{PROJECTS_COPY.hintsAbout}</p>
      {editing === null ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-(--cue-space-3) gap-y-(--cue-space-1)">
          {HINT_KEYS.map((key) => (
            <div key={key} className="contents" data-hints={key}>
              <dt className="text-fg-muted">{PROJECTS_COPY.hintWords[key]}</dt>
              <dd className="flex flex-wrap gap-(--cue-space-1)">
                {project.hints[key].length === 0 ? (
                  <span className="text-fg-subtle">{PROJECTS_COPY.noHints}</span>
                ) : (
                  project.hints[key].map((hint) => (
                    <Chip key={hint} tone="neutral" variant="tag">
                      <UntrustedText text={hint} />
                    </Chip>
                  ))
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="flex flex-col gap-(--cue-space-2)">
          {HINT_KEYS.map((key) => (
            <Field key={key} name={`hints-${key}`}>
              <FieldLabel>{PROJECTS_COPY.hintWords[key]}</FieldLabel>
              <TagsInput
                aria-label={PROJECTS_COPY.hintWords[key]}
                placeholder={PROJECTS_COPY.hintExamples[key]}
                value={editing[key]}
                onValueChange={(value: string[]) => setEditing({ ...editing, [key]: value })}
              />
            </Field>
          ))}
          <div className="flex gap-(--cue-space-2)">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={() =>
                void update({ hints: editing }).then((done) => {
                  if (done) setEditing(null);
                })
              }
            >
              {PROJECTS_COPY.save}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
              {PROJECTS_COPY.cancel}
            </Button>
          </div>
        </div>
      )}
      {problem === null ? null : <Problem message={problem} />}
      {said === null ? null : (
        <p role="status" className="text-(length:--cue-text-label) text-ok">
          {said}
        </p>
      )}
    </Part>
  );
}

function Remove({ project, onChanged }: { project: ProjectV1; onChanged: () => Promise<void> }) {
  const bridge = useBridge();
  const [problem, setProblem] = useState<string | null>(null);
  const remove = async () => {
    setProblem(null);
    try {
      const result = await bridge.cli({ kind: 'eventsProjectRemove', projectId: project.projectId });
      if (result.status === 'ok') await onChanged();
      else setProblem(result.status === 'failed' ? result.message : PROJECTS_COPY.unreadable);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  };
  return (
    <>
      <AlertDialog.Root>
        <AlertDialog.Trigger
          render={
            <Button size="sm" variant="danger-outline">
              {PROJECTS_COPY.remove}
            </Button>
          }
        />
        <AlertDialog.Content>
          <AlertDialog.Title>{PROJECTS_COPY.removeTitle(project.name)}</AlertDialog.Title>
          <AlertDialog.Description>{PROJECTS_COPY.removeBody}</AlertDialog.Description>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{COPY.cancel}</AlertDialog.Cancel>
            <AlertDialog.Action tone="danger" onClick={() => void remove()}>
              {PROJECTS_COPY.removeAction}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      {problem === null ? null : <Problem message={problem} />}
    </>
  );
}

/** The relay sessions working in the project now, busy or idle, as `projects list` gives them (0.36). */
function RelaySessions({ project, home }: { project: ProjectV1; home: string | null }) {
  if (project.sessions === undefined) return null;
  return (
    <>
      {project.sessions === null ? (
        <p className="text-fg-muted">{PROJECTS_COPY.relayUnreadable(project.sessionsReason ?? 'RELAY_FAILED')}</p>
      ) : project.sessions.length === 0 ? null : (
        <ul aria-label={PROJECTS_COPY.relaySessions} className="flex flex-col gap-(--cue-space-1)">
          {project.sessions.map((session) => (
            <li
              key={session.session}
              data-session={session.session}
              data-state={session.state}
              className="flex flex-wrap items-baseline gap-x-(--cue-space-2)"
            >
              <span className="break-all text-fg">
                <UntrustedText text={shownFolder(session.folder, home)} />
              </span>
              <span className="text-fg-muted">{session.provider}</span>
              <Chip tone={session.state === 'busy' ? 'warn' : 'neutral'} variant="tag">
                {PROJECTS_COPY.sessionStates[session.state]}
              </Chip>
              {session.lastActiveAt === null ? null : (
                <span className="text-(length:--cue-text-label) text-fg-muted">
                  {PROJECTS_COPY.lastActive} <Short at={session.lastActiveAt} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-(length:--cue-text-label) text-fg-subtle">{PROJECTS_COPY.relayWhere}</p>
    </>
  );
}

function Sessions({
  project,
  sessions,
  home,
}: {
  project: ProjectV1;
  sessions: { state: 'off' } | { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: SessionView[] };
  home: string | null;
}) {
  if (sessions.state === 'off' && project.sessions === undefined) return null;
  const windows = sessions.state === 'ready' ? windowsIn(project, sessions.value, home) : [];
  const relayWorking = (project.sessions?.length ?? 0) > 0;
  return (
    <Part title={PROJECTS_COPY.sessions}>
      <RelaySessions project={project} home={home} />
      {sessions.state === 'off' ? null : sessions.state === 'loading' ? (
        <Spinner size="sm" label={COPY.loading} />
      ) : sessions.state === 'error' ? (
        <p className="text-fg-muted">{PROJECTS_COPY.sessionsUnreadable}</p>
      ) : windows.length === 0 ? (
        relayWorking ? null : (
          <p className="text-fg-muted">{PROJECTS_COPY.noSessions}</p>
        )
      ) : (
        <ul className="flex flex-col gap-(--cue-space-1)">
          {windows.map((window) => (
            <li
              key={window.key}
              data-window={window.key}
              className="flex flex-wrap items-baseline gap-x-(--cue-space-2)"
            >
              <span className="break-all text-fg">
                <UntrustedText text={window.folder ?? ''} />
              </span>
              {window.client === null ? null : (
                <span className="text-fg-muted">
                  <UntrustedText text={window.client.name} />
                </span>
              )}
              <span className="text-(length:--cue-text-label) text-fg-muted">
                {PROJECTS_COPY.lastActive} <Short at={Date.parse(window.lastSeen)} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {sessions.state === 'off' ? null : (
        <p className="text-(length:--cue-text-label) text-fg-subtle">{PROJECTS_COPY.sessionsWhere}</p>
      )}
    </Part>
  );
}

function ProjectCard({
  project,
  sessions,
  home,
  onChanged,
}: {
  project: ProjectV1;
  sessions: Parameters<typeof Sessions>[0]['sessions'];
  home: string | null;
  onChanged: () => Promise<void>;
}) {
  return (
    <li>
      <section aria-label={`Project ${project.name}`} data-project={project.projectId}>
        <Panel className="flex flex-col gap-(--cue-space-4) p-(--cue-space-4)">
          <div className="flex flex-wrap items-center gap-(--cue-space-3)">
            <span
              aria-hidden="true"
              className="flex size-(--cue-control-md) shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent"
            >
              <FolderGit2 className="size-(--cue-icon-sm)" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold text-(length:--cue-text-emphasis) text-fg">
                <UntrustedText text={project.name} />
              </span>
              <span className="text-(length:--cue-text-label) text-fg-muted">
                <UntrustedText text={project.repo} />
              </span>
            </span>
            <Remove project={project} onChanged={onChanged} />
          </div>
          <Part title={PROJECTS_COPY.onThisMac}>
            <ul className="flex flex-col gap-(--cue-space-1)">
              {project.folders.map((folder) => (
                <li key={folder.folder} data-folder={folder.folder} className="flex flex-wrap gap-x-(--cue-space-2)">
                  <span className="break-all text-fg">
                    <UntrustedText text={shownFolder(folder.folder, home)} />
                  </span>
                  <span className="text-(length:--cue-text-label) text-fg-muted">
                    {[
                      PROJECTS_COPY.kinds[folder.kind],
                      folder.defaultBranch === null ? null : PROJECTS_COPY.defaultBranch(folder.defaultBranch),
                      folder.worktreeRoot === null
                        ? null
                        : PROJECTS_COPY.worktreesIn(shownFolder(folder.worktreeRoot, home)),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </Part>
          <Sessions project={project} sessions={sessions} home={home} />
          <Profile project={project} onChanged={onChanged} />
          <Hints project={project} onChanged={onChanged} />
        </Panel>
      </section>
    </li>
  );
}

/** The agent windows of the last 24 hours, where core has the activity log (0.29.0); `off` before it. */
function useWindows(on: boolean) {
  const call = useCall<unknown>(on ? { kind: 'activitySessions', since: '24h' } : null);
  return useMemo((): Parameters<typeof Sessions>[0]['sessions'] => {
    if (!on) return { state: 'off' };
    if (call.result.state === 'loading') return { state: 'loading' };
    if (call.result.state === 'error') return { state: 'error' };
    const read = readSessions(call.result.value);
    return read === null ? { state: 'error' } : { state: 'ready', value: read.sessions };
  }, [on, call.result]);
}

function ProjectsList({ home, core }: { home: string | null; core: string | null }) {
  const call = useCall<unknown>({ kind: 'eventsProjectsList' });
  useReloadOnServiceTurn(call.reload);
  const sessions = useWindows(supports(core, 'activity'));
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const projects = useMemo(():
    | { state: 'loading' }
    | { state: 'error'; message: string }
    | { state: 'ready'; value: ProjectV1[] } => {
    if (call.result.state === 'loading') return { state: 'loading' };
    if (call.result.state === 'error') return { state: 'error', message: call.result.message };
    try {
      return { state: 'ready', value: readProjects(call.result.value).projects };
    } catch {
      return { state: 'error', message: PROJECTS_COPY.unreadable };
    }
  }, [call.result]);
  if (adding)
    return (
      <AddProject
        known={projects.state === 'ready' ? projects.value : []}
        home={home}
        onClose={() => setAdding(false)}
        onAdded={async (name) => {
          setAdding(false);
          setSaid(PROJECTS_COPY.added(name));
          await call.reload();
        }}
      />
    );
  return (
    <>
      <div className="flex flex-wrap items-start gap-(--cue-space-3)">
        <p className="min-w-60 flex-1 text-fg-muted">{PROJECTS_COPY.about}</p>
        <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
          {PROJECTS_COPY.add}
        </Button>
      </div>
      {said === null ? null : (
        <p role="status" className="text-ok">
          <UntrustedText text={said} />
        </p>
      )}
      {projects.state === 'loading' ? (
        <Spinner label={COPY.loading} />
      ) : projects.state === 'error' ? (
        <Panel className="p-(--cue-space-4)">
          <Problem message={projects.message} />
        </Panel>
      ) : projects.value.length === 0 ? (
        <Panel>
          <EmptyState title={PROJECTS_COPY.empty} />
        </Panel>
      ) : (
        <ul className="flex flex-col gap-(--cue-space-3)">
          {projects.value.map((project) => (
            <ProjectCard
              key={project.projectId}
              project={project}
              sessions={sessions}
              home={home}
              onChanged={call.reload}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** Projects in the sidebar: the event service's, from 0.36.0. */
export function Projects() {
  const { installation, eventsVersion } = useAppData();
  const ready = installation.state === 'ready' ? installation.value : null;
  const present = ready?.present.includes('events-daemon') === true;
  const home = ready?.home ?? null;
  let body: ReactNode;
  if (!present || eventsVersion === 'absent')
    body = (
      <Panel>
        <EmptyState title={PROJECTS_COPY.needsService} />
      </Panel>
    );
  else if (eventsVersion.state === 'loading') body = <Spinner label={COPY.loading} />;
  else if (eventsVersion.state === 'error') body = <Problem message={eventsVersion.message} />;
  else if (!supports(eventsVersion.value, 'workflows'))
    body = <NeedsNewerCli feature="workflows" installed={eventsVersion.value} />;
  else body = <ProjectsList home={home} core={ready?.version ?? null} />;
  return <ScreenFrame title={PROJECTS_COPY.title}>{body}</ScreenFrame>;
}
