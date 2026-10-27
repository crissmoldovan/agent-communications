/**
 * The three views of one workflow, in step (workflows design §11.3, W17, W20): the canvas, the text and the JSON, over
 * one document and one undo stack of whole documents.
 *
 * - **Canvas → document:** each change is a pure function of the old document; a drag changes the kept positions only.
 * - **Text → document:** each edit is parsed (`parseRuleText`). When it parses, the document is replaced, and the
 *   canvas beside the text is drawn again. When it does not, the canvas keeps the last good document, dimmed, with
 *   "The text has a mistake on line 12", and the other views wait until the text reads.
 * - **Document → text:** `printRuleText`, which reads no position, so the text is the same wherever the boxes are.
 * - **JSON:** the canonical document, read-only: what is approved.
 *
 * Try it (§7.7) walks the same document over an example message, with an outcome picked on each box (`TryIt`).
 */
import { Button, IconButton, SegmentedControl } from '@cueplusplus/ui';
import { FlaskConical, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { canonical, type JsonObject } from '../../rule-editor/model.ts';
import { parseRuleText, printRuleText, type RuleTextError } from '../../rule-text.ts';
import { designerChecks } from '../../workflows/checks.ts';
import { TRY_COPY } from '../../workflows/copy.ts';
import type { DocumentHistory } from '../../workflows/history.ts';
import { RuleJsonPane, RuleTextPane } from '../events/RuleText.tsx';
import { Designer, type DesignerContext } from './Designer.tsx';
import { TryIt } from './TryIt.tsx';

export type View = 'canvas' | 'text' | 'json' | 'try';

export const VIEWS_COPY = {
  viewAs: 'View as',
  views: { canvas: 'Canvas', text: 'Text', json: 'JSON' },
  undo: 'Undo',
  redo: 'Redo',
  mistake: (line: number) => `The text has a mistake on line ${line}`,
  fixFirst: 'Fix the text first: the other views show the workflow once it reads.',
} as const;

export function Views({ history, context }: { history: DocumentHistory; context: DesignerContext }) {
  const { document } = history;
  const [view, setView] = useState<View>('canvas');
  const [text, setText] = useState('');
  const [mistake, setMistake] = useState<RuleTextError | null>(null);
  // The document the text last read to: a change that came from elsewhere (the canvas, Undo) prints the text again.
  const read = useRef<string | null>(null);

  useEffect(() => {
    if (view !== 'text' || canonical(document) === read.current) return;
    read.current = canonical(document);
    setText(printRuleText(document));
    setMistake(null);
  }, [document, view]);

  const onText = (value: string) => {
    setText(value);
    const parsed = parseRuleText(value);
    if (!parsed.ok) {
      setMistake(parsed.errors[0] ?? { line: 1, column: 1, message: '' });
      return;
    }
    setMistake(null);
    read.current = canonical(parsed.doc);
    history.change(parsed.doc as JsonObject);
  };

  const toView = (next: View) => {
    if (next === view || (view === 'text' && mistake !== null)) return;
    if (next === 'text') read.current = null;
    setView(next);
  };

  // A part a control cannot say opens the text, where every part can be said.
  const withText: DesignerContext = useMemo(() => {
    const onEditAsText = () => {
      read.current = null;
      setView('text');
    };
    return { ...context, onEditAsText, visual: { ...context.visual, onEditAsText } };
  }, [context]);

  // A try is of the workflow as it would be saved: one the checks refuse is fixed first.
  const triable = useMemo(() => designerChecks(document).length === 0, [document]);

  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      <div className="flex flex-wrap items-center gap-(--cue-space-2)">
        <SegmentedControl
          indicator
          aria-label={VIEWS_COPY.viewAs}
          size="sm"
          value={view === 'try' ? 'canvas' : view}
          items={(['canvas', 'text', 'json'] as const).map((each) => ({
            value: each,
            label: VIEWS_COPY.views[each],
            disabled: view === 'text' && mistake !== null && each !== 'text',
          }))}
          onValueChange={(value) => toView(value as View)}
        />
        <Button
          size="sm"
          icon={FlaskConical}
          disabled={view === 'try' || mistake !== null || !triable}
          title={triable ? undefined : TRY_COPY.fixFirst}
          onClick={() => setView('try')}
        >
          {TRY_COPY.tryIt}
        </Button>
        <span className="ml-auto flex items-center gap-(--cue-space-1)">
          <IconButton
            icon={Undo2}
            aria-label={VIEWS_COPY.undo}
            variant="ghost"
            size="sm"
            disabled={!history.canUndo || mistake !== null}
            onClick={history.undo}
          />
          <IconButton
            icon={Redo2}
            aria-label={VIEWS_COPY.redo}
            variant="ghost"
            size="sm"
            disabled={!history.canRedo || mistake !== null}
            onClick={history.redo}
          />
        </span>
      </div>
      {view === 'try' ? (
        <TryIt document={document} context={withText} onBack={() => setView('canvas')} />
      ) : view === 'canvas' ? (
        <Designer document={document} onChange={history.change} context={withText} />
      ) : view === 'text' ? (
        <div className="flex flex-wrap items-start gap-(--cue-space-4)">
          <div className="flex min-w-0 flex-[999_1_28rem] flex-col gap-(--cue-space-2)">
            <RuleTextPane text={text} onText={onText} />
          </div>
          <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-(--cue-space-2)">
            {mistake === null ? null : (
              <div role="alert" className="flex flex-col gap-(--cue-space-1)">
                <p className="font-semibold text-danger">{VIEWS_COPY.mistake(mistake.line)}</p>
                <p className="text-(length:--cue-text-label) text-fg-muted">
                  <UntrustedText text={mistake.message} />
                </p>
                <p className="text-(length:--cue-text-label) text-fg-muted">{VIEWS_COPY.fixFirst}</p>
              </div>
            )}
            <Designer
              document={document}
              onChange={() => undefined}
              context={withText}
              readOnly
              dimmed={mistake !== null}
            />
          </div>
        </div>
      ) : (
        <RuleJsonPane document={document} />
      )}
    </div>
  );
}
