/**
 * One undo stack of whole documents (workflows design §11.3): the canvas, the text and the JSON are three views of the
 * one workflow document, and every change any of them makes — a step dropped, an arrow drawn, a setting, a text that
 * parses — is a new document on one stack. Undo and Redo move along it, whichever view made the change; a position is
 * not a change of the document, so moving a box is not on it.
 */
import { useCallback, useReducer } from 'react';
import { canonical, type JsonObject } from '../rule-editor/model.ts';

export interface History {
  readonly past: readonly JsonObject[];
  readonly present: JsonObject;
  readonly future: readonly JsonObject[];
}

export type HistoryAction =
  | { readonly kind: 'change'; readonly document: JsonObject }
  | { readonly kind: 'apply'; readonly change: (document: JsonObject) => JsonObject }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  /** The document as it was stored: a new start, with nothing to undo past it. */
  | { readonly kind: 'reset'; readonly document: JsonObject };

/** At most this many documents behind the present: an editing session, not a version history. */
const DEPTH = 200;

/** The stack after `action`: a change that leaves the document as it is adds nothing, and clears nothing ahead. */
export function historyReducer(history: History, action: HistoryAction): History {
  switch (action.kind) {
    case 'change':
    case 'apply': {
      const document = action.kind === 'change' ? action.document : action.change(history.present);
      if (canonical(document) === canonical(history.present)) return history;
      return { past: [...history.past, history.present].slice(-DEPTH), present: document, future: [] };
    }
    case 'undo': {
      const previous = history.past.at(-1);
      if (previous === undefined) return history;
      return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
    }
    case 'redo': {
      const next = history.future[0];
      if (next === undefined) return history;
      return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
    }
    case 'reset':
      return { past: [], present: action.document, future: [] };
  }
}

export interface DocumentHistory {
  readonly document: JsonObject;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  change(document: JsonObject): void;
  /** A change made from the document as it is when it lands, for a change that waits on a read. */
  apply(change: (document: JsonObject) => JsonObject): void;
  undo(): void;
  redo(): void;
  /** Starts again from `document`, as it was stored. */
  reset(document: JsonObject): void;
}

/** The editor's document and its one undo stack. */
export function useDocumentHistory(initial: () => JsonObject): DocumentHistory {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: initial(),
    future: [],
  }));
  const change = useCallback((document: JsonObject) => dispatch({ kind: 'change', document }), []);
  const apply = useCallback(
    (how: (document: JsonObject) => JsonObject) => dispatch({ kind: 'apply', change: how }),
    [],
  );
  const undo = useCallback(() => dispatch({ kind: 'undo' }), []);
  const redo = useCallback(() => dispatch({ kind: 'redo' }), []);
  const reset = useCallback((document: JsonObject) => dispatch({ kind: 'reset', document }), []);
  return {
    document: history.present,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    change,
    apply,
    undo,
    redo,
    reset,
  };
}
