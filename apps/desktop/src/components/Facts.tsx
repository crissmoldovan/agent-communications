import { DescriptionList } from '@cueplusplus/ui';
import type { ReactNode } from 'react';

/**
 * Name/value pairs as the redesign sets them (D3): a `<dl>`, each name in the secondary size and ink, each value in
 * body text. A literal value — a path, an id, a version — wraps itself in `font-mono`; everything else is the sans face.
 */
export function Facts({ children }: { children: ReactNode }) {
  return (
    <DescriptionList.Root className="items-baseline gap-x-(--cue-space-6) gap-y-(--cue-space-3)">
      {children}
    </DescriptionList.Root>
  );
}

/** One pair of `Facts`: what it is, then what it says. */
export function Fact({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <>
      <DescriptionList.Term className="text-(length:--cue-text-ui) text-fg-muted">{name}</DescriptionList.Term>
      <DescriptionList.Detail className="text-(length:--cue-text-body)">{children}</DescriptionList.Detail>
    </>
  );
}
