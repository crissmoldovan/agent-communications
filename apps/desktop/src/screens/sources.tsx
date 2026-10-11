import { ContractSeam, DataItem, Item, OperationForm, Read, type ScreenProps } from './shared';

export function Sources(props: ScreenProps) {
  return (
    <main>
      <h2>Sources</h2>
      <Read operation="sources-list" onOperation={props.onOperation}>
        Read sources
      </Read>
      <Read operation="doctor" onOperation={props.onOperation}>
        Read source health
      </Read>
      <DataItem id="accounts" title="Accounts" operation="sources-list" props={props} opaque />
      <Item id="event-types" title="Event types">
        <Read operation="catalogue-list" onOperation={props.onOperation}>
          Read event catalogue
        </Read>
        <DataItem id="catalogue" title="Catalogue" operation="catalogue-list" props={props} />
        <OperationForm operation="catalogue-show" title="Show event type and version" onOperation={props.onOperation} />
      </Item>
      <Item id="interval-budget" title="Interval and budget">
        <ContractSeam>
          B3 source-show exposes source and opaque account records, not typed interval or budget settings.
        </ContractSeam>
      </Item>
      <Item id="expected-latency" title="Expected latency">
        <ContractSeam>B3 doctor provides observed lag, not an expected-latency estimate.</ContractSeam>
      </Item>
      <Item id="shared-cursor" title="Shared acquisition cursor">
        <ContractSeam>B3 doctor exposes activation points, not the shared acquisition cursor position.</ContractSeam>
      </Item>
      <DataItem
        id="activation-cutover"
        title="Per-rule activation and current cut-over"
        props={props}
        paths={['/points', '/lineages']}
      />
      <Item id="slack-drains" title="Slack reply drains">
        <ContractSeam>
          B3 v1 has no typed open Slack reply-drain surface. Recovery lease/dead-letter counters are not Slack drains.
        </ContractSeam>
      </Item>
      <DataItem
        id="materialisation-health"
        title="Gmail and Resend materialisation health"
        props={props}
        paths={['/sources']}
      />
      <Item id="observation-time" title="Observation-time labels">
        <p>Labels describe what was observed during acquisition; they do not reconstruct earlier provider state.</p>
      </Item>
      <OperationForm operation="source-show" title="Show stable source id" onOperation={props.onOperation} />
    </main>
  );
}
