import { Panel, PanelHeader } from '@cueplusplus/ui';
import { type ReactNode, useId } from 'react';

/**
 * One part of a screen: a panel whose header names it, and a `section` that header labels, so each part is a region
 * a person (or a test) can find by its title. `actions` sit at the header's right, and act on the whole part.
 */
export function SectionPanel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Panel>
        <PanelHeader title={<span id={id}>{title}</span>} actions={actions} />
        <div className="flex flex-col gap-(--cue-space-3) p-(--cue-space-4)">{children}</div>
      </Panel>
    </section>
  );
}
