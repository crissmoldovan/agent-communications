import { SegmentedControl } from '@cueplusplus/ui';
import { useState } from 'react';
import { CopyButton } from '../../components/CopyButton.tsx';
import type { Snippets as SnippetSet } from '../../mcp-connections.ts';
import { SNIPPET_COPY } from './copy.ts';

type Format = keyof SnippetSet;

/**
 * A Manual connection's snippet, with its key in it (§11): in each format core writes — `mcpServers` JSON, Codex's
 * TOML, VS Code's `servers` — each as core wrote it, with Copy. Shown this once: the screen that holds it lets it go
 * when the person is done, and nothing else of the app keeps it (no log, no state of the app's, no test snapshot).
 */
export function Snippets({ snippets }: { snippets: SnippetSet }) {
  const [format, setFormat] = useState<Format>('json');
  return (
    <div className="flex flex-col gap-(--cue-space-2)" data-slot="snippets">
      <SegmentedControl
        indicator
        aria-label={SNIPPET_COPY.formatsLabel}
        className="self-start"
        items={(['json', 'toml', 'vscode'] as const).map((value) => ({ value, label: SNIPPET_COPY.formats[value] }))}
        value={format}
        onValueChange={(value) => setFormat(value as Format)}
      />
      <p className="text-(length:--cue-text-ui) text-fg-subtle">{SNIPPET_COPY.formatHints[format]}</p>
      <div className="flex flex-wrap items-start gap-(--cue-space-2)">
        <pre
          data-slot="snippet"
          className="min-w-0 flex-1 overflow-x-auto rounded-control bg-sunken px-(--cue-space-3) py-(--cue-space-2) font-mono text-(length:--cue-text-ui) text-fg"
        >
          {snippets[format]}
        </pre>
        <CopyButton text={snippets[format]} label={SNIPPET_COPY.copy} />
      </div>
      <p className="text-(length:--cue-text-ui) text-fg-subtle">{SNIPPET_COPY.once}</p>
    </div>
  );
}
