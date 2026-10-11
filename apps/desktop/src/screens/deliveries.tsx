import { DataItem, Item, OperationForm, Read, type ScreenProps } from './shared';

export function Deliveries(props: ScreenProps) {
  return (
    <main>
      <h2>Deliveries</h2>
      <Item id="filters" title="Delivery filters">
        <OperationForm operation="deliveriesList" title="Read filtered deliveries" onOperation={props.onOperation} />
      </Item>
      <DataItem id="state" title="Delivery state" operation="deliveriesList" props={props} opaque />
      <Item id="retryability" title="Retryable deliveries">
        <p>Only a retryable delivery can be retried; the daemon checks its current state.</p>
        <OperationForm operation="retryDelivery" title="Retry delivery id" onOperation={props.onOperation} />
      </Item>
      <Item id="drop" title="Drop delivery">
        <OperationForm operation="dropDelivery" title="Drop delivery id" onOperation={props.onOperation} />
      </Item>
      <Item id="safe-dryrun" title="Safe dry-run results">
        <Read operation="dryrun-list" onOperation={props.onOperation}>
          Read dry-run rows
        </Read>
        <DataItem id="dryrun-list" title="Dry-run rows" operation="dryrun-list" props={props} />
        <OperationForm operation="dryrun-show" title="Show dry-run delivery id" onOperation={props.onOperation} />
        <DataItem id="dryrun-result" title="Dry-run result" operation="dryrun-show" props={props} />
      </Item>
      <Item id="reset-barrier" title="Reset barriers and target resume">
        <DataItem id="barriers" title="Degraded barriers" props={props} paths={['/recovery/resetBarriers']} />
        <OperationForm operation="targetResume" title="Resume target version" onOperation={props.onOperation} />
      </Item>
      <Item id="holds" title="Held decisions">
        <Read operation="heldList" onOperation={props.onOperation}>
          Read holds
        </Read>
        <DataItem id="held-result" title="Current holds" operation="heldList" props={props} />
        <OperationForm operation="decideHeld" title="Resolve held decision" onOperation={props.onOperation} />
        <DataItem id="held-decision-result" title="Held decision result" operation="decideHeld" props={props} />
      </Item>
    </main>
  );
}
