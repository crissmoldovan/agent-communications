import { ContractSeam, Item, Read, SafeResult, type ScreenProps } from './shared';

export function Settings(props: ScreenProps) {
  const preferences = props.preferences ?? { openAtLogin: false, keepCollectingAfterQuit: false };
  return (
    <main>
      <h2>Settings</h2>
      <Read operation="doctor" onOperation={props.onOperation}>
        Read daemon health
      </Read>
      <Item id="open-at-login" title="Open at login">
        <label>
          <input
            type="checkbox"
            checked={preferences.openAtLogin}
            onChange={(event) => props.onPreferences?.({ ...preferences, openAtLogin: event.target.checked })}
          />
          Open at login
        </label>
        <p>
          Desktop-only preference; OS registration is not available in this build. Login startup never starts the
          daemon.
        </p>
      </Item>
      <Item id="keep-collecting" title="Keep collecting after quit">
        <label>
          <input
            type="checkbox"
            checked={preferences.keepCollectingAfterQuit}
            onChange={(event) =>
              props.onPreferences?.({ ...preferences, keepCollectingAfterQuit: event.target.checked })
            }
          />
          Keep collecting after quit
        </label>
      </Item>
      <Item id="secret-backend" title="Event secret backend and migration">
        <ContractSeam code="APP_SECRET_CAPABILITY_UNAVAILABLE">
          Secret migration requires Task 6's separate capability. Current backend and migration state are not exposed by
          B3's non-secret read contract.
        </ContractSeam>
        <button type="button" onClick={props.onSecrets}>
          Open Secrets placeholder
        </button>
      </Item>
      <Item id="retention" title="Retention">
        <ContractSeam>
          B3 v1 has no global retention-settings read surface. Recovery counters and superseded work are not retention
          configuration.
        </ContractSeam>
      </Item>
      <Item id="data-disk-use" title="Data location and Laya disk use">
        <ContractSeam>
          The native preference view does not expose the selected data path, and B3 v1 has no Laya disk-usage field.
        </ContractSeam>
        <Read operation="judgeModelStatus" onOperation={props.onOperation}>
          Read model availability
        </Read>
        <SafeResult result={props.results.judgeModelStatus} />
      </Item>
      <Item id="unsigned-about" title="Unsigned version 1">
        <p>This version is an unsigned desktop prerelease.</p>
      </Item>
      {props.supervision}
    </main>
  );
}
