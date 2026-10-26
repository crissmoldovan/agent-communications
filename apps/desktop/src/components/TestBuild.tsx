import { builtTime, profileFolder, splitCommit, TEST_BUILD_COPY } from '../app-build.ts';
import type { AppBuild, Folders } from '../ipc.ts';

/** A moment the build was made, short, with the exact instant kept in `dateTime`; one it cannot read, as its text. */
function Built({ at }: { at: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <>{at}</>;
  return <time dateTime={date.toISOString()}>{builtTime(at)}</time>;
}

/**
 * The band across the top of a test build's window (spec §3.7): TEST BUILD, the branch and commit it was built from,
 * when, and that it uses the test profile. It is the window's top, so it drags the window as the header does; on
 * macOS it leaves the traffic lights their room.
 */
export function TestBuildBand({ build, mac }: { build: AppBuild; mac: boolean }) {
  const { commit, branch } = splitCommit(build.commit);
  const details = [branch, commit].filter((part): part is string => part !== null);
  return (
    <div
      role="note"
      aria-label={TEST_BUILD_COPY.band}
      data-tauri-drag-region=""
      className={`flex shrink-0 select-none flex-wrap items-center gap-x-(--cue-space-2) bg-warn px-(--cue-space-4) py-(--cue-space-2) font-medium text-(length:--cue-text-ui) text-warn-fg [-webkit-app-region:drag] [app-region:drag] ${mac ? 'min-h-7 ps-20' : ''}`}
    >
      <strong className="font-semibold tracking-wide">{TEST_BUILD_COPY.heading}</strong>
      {details.map((part) => (
        <span key={part}>{` · ${part}`}</span>
      ))}
      {build.builtAt === null ? null : (
        <span>
          {' · built '}
          <Built at={build.builtAt} />
        </span>
      )}
      <span>{` · ${TEST_BUILD_COPY.profileLine}`}</span>
    </div>
  );
}

/** The test profile's folder, at the sidebar's foot (spec §3.7), from the folders the app's calls pin. */
export function TestProfile({ folders, home }: { folders: Folders; home: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-(--cue-space-1) px-(--cue-space-3) pt-(--cue-space-2)">
      <span className="text-(length:--cue-text-ui) text-fg-subtle">{TEST_BUILD_COPY.profile}</span>
      <span className="break-all font-mono text-(length:--cue-text-ui) text-fg">{profileFolder(folders, home)}</span>
    </div>
  );
}
