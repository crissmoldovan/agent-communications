/**
 * Approve… for a workflow with steps (workflows design §10.2, W6, W20, the approved prototype's WorkflowApprove): the
 * workflow's plain words, then one numbered line per step that does something, as `describeFlow` says it — the event
 * service's own words for the very document the activation binds — beside the graph laid out afresh, every kept
 * position ignored, so what is approved is drawn the same way for everyone. Then what changed since the version that
 * runs, and, past 20 lines, that a workflow this long is better split.
 *
 * `RuleReview` keeps the rest as it is: the typed name, the Terminal fallback, and the revoke on Back. Every part the
 * workflow's author wrote is author text (`Sentence`); nothing a sender wrote is in a preview.
 */
import { TriangleAlert } from 'lucide-react';
import type { AccountNames } from '../../account-aliases.ts';
import { aliasOf } from '../../account-aliases.ts';
import { judgeLine, watches, whatsKept, whichMessages } from '../../events-rules.ts';
import type { JsonObject } from '../../rule-editor/model.ts';
import { approvalLines, flowChanges, PREVIEW_LINES_MAX } from '../../workflows/approve.ts';
import { Sentence } from '../events/parts.tsx';
import { Designer, type DesignerContext } from './Designer.tsx';

export const APPROVE_COPY = {
  plainWords: 'In plain words',
  effects: 'What it does, step by step',
  drawn: 'The workflow, laid out afresh',
  changed: (version: number) => `What changed since version ${version}`,
  unchanged: (version: number) => `Nothing changed since version ${version}.`,
  tooLong: (count: number) =>
    `This workflow does ${count} things: more than anyone checks at a glance. Split it into smaller workflows, which can start one another.`,
} as const;

/** What a drawn-only canvas needs: the accounts' names, and nothing to edit with. */
function viewOnly(names: AccountNames): DesignerContext {
  const none = () => undefined;
  return {
    names,
    takenTargetIds: new Set(),
    webhooks: [],
    judges: [],
    readJudge: async () => null,
    linear: null,
    onEditAsText: none,
    visual: {
      names,
      judges: [],
      onChooseJudge: none,
      judgeReading: false,
      judgeProblem: null,
      linear: null,
      takenTargetIds: new Set(),
      onEditAsText: none,
      onIntegrations: null,
    },
  };
}

export function FlowApproval({
  rule,
  before,
  beforeVersion,
  names,
}: {
  /** The workflow the activation would switch on, as its own preview gives it. */
  rule: JsonObject;
  /** The version that runs now, if one does. */
  before: JsonObject | null;
  beforeVersion: number | null;
  names: AccountNames;
}) {
  const lines = approvalLines(rule);
  const changes = flowChanges(before, rule);
  const gate = [watches(rule, (id) => aliasOf(names, id)), whichMessages(rule), judgeLine(rule), whatsKept(rule)];
  return (
    <div className="flex flex-col gap-(--cue-space-3)">
      <section aria-label={APPROVE_COPY.plainWords} className="flex flex-col gap-(--cue-space-1)">
        <h3 className="font-medium text-fg">{APPROVE_COPY.plainWords}</h3>
        {gate.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the gate's parts come in a fixed order.
          <p key={index} className="text-fg">
            <Sentence parts={line.main} names={names} />
          </p>
        ))}
      </section>
      {lines.length > PREVIEW_LINES_MAX ? (
        <p
          role="alert"
          className="flex items-start gap-(--cue-space-2) rounded-control bg-warn-subtle p-(--cue-space-3) text-fg"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-(--cue-icon-sm) shrink-0 text-warn" />
          {APPROVE_COPY.tooLong(lines.length)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start gap-(--cue-space-3)">
        <section
          aria-label={APPROVE_COPY.effects}
          className="flex min-w-0 flex-[1_1_20rem] flex-col gap-(--cue-space-1)"
        >
          <h3 className="font-medium text-fg">{APPROVE_COPY.effects}</h3>
          <ol className="flex flex-col gap-(--cue-space-2)">
            {lines.map((line) => (
              <li
                key={line.number}
                data-line={line.number}
                data-steps={line.stepIds.join(' ')}
                className="flex gap-(--cue-space-2)"
              >
                <span className="w-6 shrink-0 text-right font-semibold text-fg-muted tabular-nums">{line.number}.</span>
                <span className="min-w-0 text-fg">
                  <Sentence parts={line.parts} names={names} />
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section aria-label={APPROVE_COPY.drawn} className="min-w-0 flex-[1_1_20rem]">
          <Designer document={rule} onChange={() => undefined} context={viewOnly(names)} readOnly fresh />
        </section>
      </div>
      {beforeVersion === null ? null : (
        <section aria-label={APPROVE_COPY.changed(beforeVersion)} className="flex flex-col gap-(--cue-space-1)">
          <h3 className="font-medium text-fg">{APPROVE_COPY.changed(beforeVersion)}</h3>
          {changes.length === 0 ? (
            <p className="text-fg-muted">{APPROVE_COPY.unchanged(beforeVersion)}</p>
          ) : (
            <ul className="flex flex-col gap-(--cue-space-1)">
              {changes.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the changes come in a fixed order for two documents.
                <li key={index} className="text-fg">
                  <Sentence parts={line} names={names} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
