import { DataItem, Item, OperationForm, Read, type ScreenProps } from './shared';

export function Targets(props: ScreenProps) {
  return (
    <main>
      <h2>Targets and subscribers</h2>
      <Read operation="targets-list" onOperation={props.onOperation}>
        Read targets
      </Read>
      <Read operation="subscribersList" onOperation={props.onOperation}>
        Read subscribers
      </Read>
      <DataItem id="retention" title="Dry-run retention" operation="targets-list" props={props} opaque />
      <DataItem id="webhook-policy" title="Webhook network policy" operation="targets-list" props={props} opaque />
      <DataItem id="sse-origins" title="SSE retention and origins" operation="subscribersList" props={props} opaque />
      <DataItem id="versions" title="Approved and pending versions" operation="targets-list" props={props} opaque />
      <Item id="tests" title="Target tests">
        <p>Ordinary tests require an active version. Pending activation tests belong to the approval screen.</p>
        <OperationForm operation="targetTest" title="Test active target version" onOperation={props.onOperation} />
        <DataItem id="target-test-result" title="Target test result" operation="targetTest" props={props} />
      </Item>
      <Item id="secret-handoff" title="Secret completion and rotation">
        <button type="button" onClick={props.onSecrets}>
          Open Secrets
        </button>
      </Item>
      <Item id="new-url-version" title="New secret URL version">
        <p>A changed secret URL creates a new target version and needs a new rule activation.</p>
        <button type="button" onClick={props.onSecrets}>
          Set URL in Secrets
        </button>
      </Item>
      {['target-add', 'target-update', 'target-remove', 'addSubscriber', 'updateSubscriber', 'removeSubscriber'].map(
        (operation) => (
          <OperationForm key={operation} operation={operation} title={operation} onOperation={props.onOperation} />
        ),
      )}
    </main>
  );
}
