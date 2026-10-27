/**
 * The designer's palette (workflows design §11.3): an app panel beside the canvas, outside React Flow, grouped as the
 * prototype draws it. Each step is dragged onto the canvas — `dragstart` puts its id on the drag's data, under the
 * app's own type — or pressed, which adds it beside the last column, for a keyboard or a trackpad that would rather not
 * drag. Either way it arrives with no arrows, to be wired and set.
 */
import { Panel } from '@cueplusplus/ui';
import { GripVertical } from 'lucide-react';
import { PALETTE_GROUPS, PALETTE_MIME } from '../../workflows/palette.ts';

export const PALETTE_COPY = {
  title: 'Steps',
  hint: 'Drag one onto the canvas, or press it to add it.',
  add: (label: string) => `Add ${label}`,
} as const;

export function Palette({ onAdd, disabled = false }: { onAdd: (id: string) => void; disabled?: boolean }) {
  return (
    <aside aria-label={PALETTE_COPY.title} className="w-48 shrink-0">
      <Panel className="flex flex-col gap-(--cue-space-3) p-(--cue-space-3)">
        <div className="flex flex-col gap-(--cue-space-1)">
          <h3 className="font-semibold text-fg">{PALETTE_COPY.title}</h3>
          <p className="text-(length:--cue-text-label) text-fg-muted">{PALETTE_COPY.hint}</p>
        </div>
        {PALETTE_GROUPS.map((group) => (
          <section key={group.name} aria-label={group.name} data-palette-group={group.name}>
            <h4 className="pb-(--cue-space-1) font-medium text-(length:--cue-text-label) text-fg-subtle">
              {group.name}
            </h4>
            <ul className="flex flex-col">
              {group.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    draggable={!disabled}
                    disabled={disabled}
                    data-palette={item.id}
                    aria-label={PALETTE_COPY.add(item.label)}
                    className="flex w-full cursor-grab items-center gap-(--cue-space-2) rounded-control px-(--cue-space-2) py-(--cue-space-1) text-left text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                    onDragStart={(event) => {
                      event.dataTransfer.setData(PALETTE_MIME, item.id);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => onAdd(item.id)}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-(--cue-space-2) shrink-0 rounded-full ${item.tone === 'output' ? 'bg-warn' : 'bg-fg-subtle'}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <GripVertical aria-hidden="true" className="size-(--cue-icon-sm) shrink-0 text-fg-subtle" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Panel>
    </aside>
  );
}
