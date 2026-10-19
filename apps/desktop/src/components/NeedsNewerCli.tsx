import { Panel } from '@cueplusplus/ui';
import type { ReactNode } from 'react';
import { COPY, needsLine } from '../copy.ts';
import { useAppData } from '../data.tsx';
import { type Feature, GATES, supports } from '../gates.ts';

/** What a section says when the CLI is older than the feature it needs (DA12): the update line, then the versions. */
export function NeedsNewerCli({ feature, installed }: { feature: Feature; installed: string | null }) {
  return (
    <Panel className="flex flex-col gap-(--cue-space-2) p-(--cue-space-4)">
      <p className="text-fg">{COPY.updateToUse}</p>
      <p className="text-fg-muted">{needsLine(GATES[feature], installed)}</p>
    </Panel>
  );
}

/** Its children when the installed CLI has `feature`; otherwise `NeedsNewerCli`, and nothing inside runs. */
export function Gated({ feature, children }: { feature: Feature; children: ReactNode }) {
  const { installation } = useAppData();
  const installed = installation.state === 'ready' ? installation.value.version : null;
  return supports(installed, feature) ? children : <NeedsNewerCli feature={feature} installed={installed} />;
}
