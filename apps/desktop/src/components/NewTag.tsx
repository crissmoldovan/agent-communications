import { Chip } from '@cueplusplus/ui';

/**
 * "New" beside a section that is new in this release (0.32.0, spec §3.8), said to a screen reader as part of its
 * name.
 */
export function NewTag() {
  return (
    <Chip tone="accent" variant="tinted" data-slot="new-tag">
      {/* A space first: the sidebar's row draws none between its name and its badge. */}
      <span className="sr-only"> </span>New
    </Chip>
  );
}
