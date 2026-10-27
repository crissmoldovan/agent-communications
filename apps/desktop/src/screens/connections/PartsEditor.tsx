import { Checkbox, Radio, RadioGroup, Switch } from '@cueplusplus/ui';
import { useId } from 'react';
import {
  type AccountChoice,
  accountsOf,
  CORE_PART,
  hasReadOnly,
  PART_WORDS,
  type PartChoice,
  type PartSetting,
  type PartSettings,
} from '../../mcp-connections.ts';
import { PARTS_COPY } from './copy.ts';

/** The radio value for "every account": no account's name is this, since a name has a `/` in it. */
const EVERY = 'every';

/**
 * A connection's parts as switches (the boards' "Parts and accounts"): Agent Comms itself first, always included and
 * never a switch the person turns (lead's decision, 2026-10-27) — or, for a connection made at a terminal without it,
 * said as not in it — then every other part a connection can have (`channels --json`, D20). A part that is on and has
 * accounts here is kept to every one or to one (D12: one or all, never some); Gmail, the one part with a read-only
 * switch, can be kept to reading. Each change is the caller's to apply: added up while a connection is made, sent at once
 * on a connection's page.
 */
export function PartsEditor({
  choices,
  accounts,
  settings,
  disabled,
  onChange,
}: {
  choices: readonly PartChoice[];
  accounts: readonly AccountChoice[];
  settings: PartSettings;
  disabled: boolean;
  onChange: (server: string, setting: PartSetting) => void;
}) {
  return (
    <div className="flex flex-col gap-(--cue-space-2)" data-slot="parts-editor">
      <CorePart included={settings[CORE_PART]?.on !== false} />
      {choices
        .filter((choice) => choice.server !== CORE_PART)
        .map((choice) => (
          <OnePart
            key={choice.server}
            choice={choice}
            accounts={accountsOf(choice.server, accounts)}
            setting={settings[choice.server] ?? { on: false, account: null, readOnly: false }}
            disabled={disabled}
            onChange={(setting) => onChange(choice.server, setting)}
          />
        ))}
    </div>
  );
}

/** Agent Comms itself: a switch that is on and cannot be turned, or, when the connection has none, one that is off. */
function CorePart({ included }: { included: boolean }) {
  const id = useId();
  return (
    <div className="flex items-center gap-(--cue-space-3) rounded-control bg-surface-2 px-(--cue-space-3) py-(--cue-space-2)">
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={id} className="font-medium text-fg">
          {PARTS_COPY.coreName}
        </span>
        <span className="text-(length:--cue-text-ui) text-fg-subtle">
          {included ? PARTS_COPY.coreLine : PARTS_COPY.coreAbsent}
        </span>
      </span>
      <Switch aria-label={PARTS_COPY.coreLabel} checked={included} disabled />
    </div>
  );
}

function OnePart({
  choice,
  accounts,
  setting,
  disabled,
  onChange,
}: {
  choice: PartChoice;
  accounts: readonly string[];
  setting: PartSetting;
  disabled: boolean;
  onChange: (setting: PartSetting) => void;
}) {
  const id = useId();
  const words = PART_WORDS[choice.server];
  // An account it is kept to that is no longer here is still offered, so the radio says what is true.
  const offered =
    setting.account === null || accounts.includes(setting.account) ? accounts : [...accounts, setting.account];
  return (
    <div
      data-part={choice.server}
      className="flex flex-col gap-(--cue-space-2) rounded-control bg-surface-2 px-(--cue-space-3) py-(--cue-space-2)"
    >
      <div className="flex items-center gap-(--cue-space-3)">
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={id} className="font-medium text-fg">
            {choice.name}
          </span>
          {words === undefined ? null : (
            <span className="text-(length:--cue-text-ui) text-fg-subtle">{words.purpose}</span>
          )}
        </span>
        <Switch
          aria-labelledby={id}
          checked={setting.on}
          disabled={disabled}
          onCheckedChange={(on) =>
            onChange({ on, account: on ? setting.account : null, readOnly: on && setting.readOnly })
          }
        />
      </div>
      {!setting.on ? null : choice.kind === 'service' ? (
        <p className="text-(length:--cue-text-ui) text-fg-subtle">{PARTS_COPY.events}</p>
      ) : (
        <div className="flex flex-wrap gap-x-(--cue-space-6) gap-y-(--cue-space-2) border-border border-t pt-(--cue-space-2)">
          {offered.length === 0 ? (
            <p className="text-(length:--cue-text-ui) text-fg-subtle">{PARTS_COPY.noAccounts}</p>
          ) : (
            <div className="flex flex-col gap-(--cue-space-1)">
              <span className="text-(length:--cue-text-ui) text-fg-subtle">{PARTS_COPY.which}</span>
              <RadioGroup
                aria-label={`${choice.name}: ${PARTS_COPY.which}`}
                value={setting.account ?? EVERY}
                disabled={disabled}
                onValueChange={(value) => {
                  const account = value === EVERY ? null : String(value);
                  if (account === setting.account) return;
                  onChange({ ...setting, account });
                }}
              >
                <Radio value={EVERY} label={PARTS_COPY.every(accounts.length)} />
                {offered.map((account) => (
                  <Radio key={account} value={account} label={PARTS_COPY.only(account)} />
                ))}
              </RadioGroup>
            </div>
          )}
          {hasReadOnly(choice.server) ? (
            <div className="flex flex-col gap-(--cue-space-1)">
              <span className="text-(length:--cue-text-ui) text-fg-subtle">{PARTS_COPY.readOnly}</span>
              <Checkbox
                label={words?.readOnly ?? PARTS_COPY.readOnly}
                checked={setting.readOnly}
                disabled={disabled}
                onCheckedChange={(checked) => onChange({ ...setting, readOnly: checked === true })}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
