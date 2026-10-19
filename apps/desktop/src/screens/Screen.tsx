import { PageShell } from '@cueplusplus/ui';
import type { ReactNode } from 'react';

/** A screen's frame: its title as the page's one heading, and its body. */
export function ScreenFrame({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <PageShell title={title} width="wide">
      <div className="flex flex-col gap-(--cue-space-4)">{children}</div>
    </PageShell>
  );
}
