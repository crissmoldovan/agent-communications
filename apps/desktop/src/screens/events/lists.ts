/**
 * The reads Events → Rules and Events → Deliveries share (owner feedback 0.32.0, §3.4, §3.5): `rules list`, then
 * `rule show` for each rule the allow-list can name, `deliveries list`, and the account lists that turn ids into
 * aliases. Each is read when the screen opens and again when the event service starts or stops running; the rules
 * again after Turn off or Remove, the deliveries after Try now or Stop trying. Also where each tab's page is open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type AccountNames, useAccountNames } from '../../account-aliases.ts';
import { useBridge } from '../../bridge-context.tsx';
import type { Loadable } from '../../data.tsx';
import { type DeliveryRow, readDeliveries } from '../../events-deliveries.ts';
import { type RuleRow, type RuleVersionView, readRuleShow, readRulesList } from '../../events-rules.ts';
import { useCall } from '../../hooks/use-call.ts';
import { useReloadOnServiceTurn } from '../../hooks/use-reload-on-return.ts';
import { type Call, type CliResult, errorMessage } from '../../ipc.ts';
import type { EditTarget } from './RuleEditor.tsx';

/** What a list says when its answer is not one the app can read. */
export const UNREADABLE_LIST = 'The list could not be read.';
/** What a rule's versions say when theirs is not. */
export const UNREADABLE_RULE = "This workflow's details could not be read.";

const RULES: Call = { kind: 'eventsRules' };
const DELIVERIES: Call = { kind: 'eventsDeliveries' };

/** How many `rule show` reads run at once: each starts the events CLI, so a long list is read a few at a time. */
const AT_ONCE = 4;

export interface EventsLists {
  rules: Loadable<RuleRow[]>;
  /** Each openable rule's versions, by id, as `rule show` read them; a rule not read yet is loading. */
  versions: ReadonlyMap<string, Loadable<RuleVersionView[]>>;
  deliveries: Loadable<DeliveryRow[]>;
  names: AccountNames;
  reloadRules(): Promise<void>;
  reloadDeliveries(): Promise<void>;
}

/** A read whose answer is read again by `read`: its error, or what `read` made of it, or that it could not be read. */
function shaped<T>(result: Loadable<unknown>, read: (value: unknown) => T | null, unreadable: string): Loadable<T> {
  if (result.state !== 'ready') return result;
  const value = read(result.value);
  return value === null ? { state: 'error', message: unreadable } : { state: 'ready', value };
}

function versionsOf(result: CliResult): Loadable<RuleVersionView[]> {
  if (result.status === 'failed') return { state: 'error', message: result.message };
  if (result.status !== 'ok') return { state: 'error', message: UNREADABLE_RULE };
  const versions = readRuleShow(result.data);
  return versions === null ? { state: 'error', message: UNREADABLE_RULE } : { state: 'ready', value: versions };
}

export function useEventsLists(): EventsLists {
  const bridge = useBridge();
  const rulesCall = useCall<unknown>(RULES);
  useReloadOnServiceTurn(rulesCall.reload);
  const deliveriesCall = useCall<unknown>(DELIVERIES);
  useReloadOnServiceTurn(deliveriesCall.reload);
  const names = useAccountNames();
  const rules = useMemo(() => shaped(rulesCall.result, readRulesList, UNREADABLE_LIST), [rulesCall.result]);
  const deliveries = useMemo(
    () => shaped(deliveriesCall.result, readDeliveries, UNREADABLE_LIST),
    [deliveriesCall.result],
  );

  // Each read of the list reads every rule's versions again; an answer to an earlier read is dropped.
  const [versions, setVersions] = useState<ReadonlyMap<string, Loadable<RuleVersionView[]>>>(new Map());
  const asked = useRef(0);
  useEffect(() => {
    if (rules.state !== 'ready') return;
    const ask = ++asked.current;
    const ids = rules.value.filter((rule) => rule.openable).map((rule) => rule.id);
    const queue = [...ids];
    const show = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        let read: Loadable<RuleVersionView[]>;
        try {
          read = versionsOf(await bridge.cli({ kind: 'eventsRuleShow', ruleId: id }));
        } catch (error) {
          read = { state: 'error', message: errorMessage(error) };
        }
        if (ask !== asked.current) return;
        const shown = id;
        setVersions((before) => new Map(before).set(shown, read));
      }
    };
    void Promise.all(Array.from({ length: Math.min(AT_ONCE, ids.length) }, show));
  }, [bridge, rules]);

  return {
    rules,
    versions,
    deliveries,
    names,
    reloadRules: rulesCall.reload,
    reloadDeliveries: deliveriesCall.reload,
  };
}

/** Which page of the two tabs is open, and the moves between them. */
export interface EventsNav {
  /** The rule whose page is open, or null for the list of rules. */
  rule: string | null;
  openRule(id: string | null): void;
  /** The rule being edited, or the new one being written (0.33.0); null when the editor is closed. */
  editing: EditTarget | null;
  edit(target: EditTarget | null): void;
  /** The delivery whose page is open, or null for the list of deliveries. */
  delivery: string | null;
  openDelivery(id: string | null): void;
  /** The rule the deliveries are narrowed to, or null for every rule's. */
  deliveriesOf: string | null;
  showDeliveriesOf(ruleId: string | null): void;
}

/** Where each tab stands; moving to another tab's page selects that tab. */
export function useEventsNav(selectTab: (tab: 'rules' | 'deliveries') => void): EventsNav {
  const [rule, setRule] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const edit = useCallback(
    (target: EditTarget | null) => {
      setEditing(target);
      if (target !== null) selectTab('rules');
    },
    [selectTab],
  );
  const [delivery, setDelivery] = useState<string | null>(null);
  const [deliveriesOf, setDeliveriesOf] = useState<string | null>(null);
  const openRule = useCallback(
    (id: string | null) => {
      setRule(id);
      if (id !== null) selectTab('rules');
    },
    [selectTab],
  );
  const openDelivery = useCallback(
    (id: string | null) => {
      setDelivery(id);
      if (id !== null) selectTab('deliveries');
    },
    [selectTab],
  );
  const showDeliveriesOf = useCallback(
    (ruleId: string | null) => {
      setDeliveriesOf(ruleId);
      setDelivery(null);
      if (ruleId !== null) selectTab('deliveries');
    },
    [selectTab],
  );
  return { rule, openRule, editing, edit, delivery, openDelivery, deliveriesOf, showDeliveriesOf };
}

/** A rule's versions, once read; null while they are not. */
export function readVersions(lists: EventsLists, ruleId: string): RuleVersionView[] | null {
  const read = lists.versions.get(ruleId);
  return read?.state === 'ready' ? read.value : null;
}
