import { Button, CodeBlock, PageShell } from '@cueplusplus/ui';
import { COPY } from '../copy.ts';
import { INSTALL_COMMAND } from '../install.ts';

/**
 * What the app shows when `<data>/launch/core` is not there (DA4): the documented install command, and nothing that
 * runs it. Settings stays reachable, because a person who keeps the folders elsewhere sets them there.
 */
export function NotInstalled({ onSettings }: { onSettings?: () => void }) {
  return (
    <PageShell title={COPY.appName} width="narrow">
      <div className="flex flex-col gap-(--cue-space-4)">
        <p className="text-fg">{COPY.notInstalled}</p>
        <p className="text-fg-muted">{COPY.runThis}</p>
        <CodeBlock code={INSTALL_COMMAND} label="Terminal" language="sh" />
        <p className="text-fg-muted">{COPY.foldersElsewhere}</p>
        {onSettings === undefined ? null : (
          <div>
            <Button variant="secondary" onClick={onSettings}>
              {COPY.openSettings}
            </Button>
          </div>
        )}
      </div>
    </PageShell>
  );
}
