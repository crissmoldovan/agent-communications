import { ContractSeam, DataItem, Item, Read, SafeResult, type ScreenProps } from './shared';

export function Overview(props: ScreenProps) {
  return (
    <main>
      <h2>Overview</h2>
      <Read operation="doctor" onOperation={props.onOperation}>
        Refresh overview
      </Read>
      <Item id="global-switch" title="Global switch">
        <Read operation="disable-all" onOperation={props.onOperation}>
          Disable immediately
        </Read>
        <Read operation="enable-all" onOperation={props.onOperation}>
          Prepare enable approval
        </Read>
        <SafeResult result={props.results['enable-all']} />
      </Item>
      <DataItem
        id="daemon-protocol-health"
        title="Daemon and protocol health"
        props={props}
        paths={['/owner', '/switch']}
      />
      <DataItem id="source-lag" title="Source lag" props={props} paths={['/sources']} />
      <DataItem id="lineage-ids" title="Exact and derived authorisation ids" props={props} paths={['/lineages']} />
      <DataItem id="current-cutover" title="Current cut-over id" props={props} paths={['/lineages', '/points']} />
      <DataItem id="superseded-work" title="Superseded retained work" props={props} paths={['/superseded']} />
      <Item id="delivery-outcomes" title="Delivery outcomes">
        <ContractSeam>
          B3 v1 does not declare a typed recent-outcomes view; recovery counters are not delivery outcomes.
        </ContractSeam>
        <Read operation="deliveriesList" onOperation={props.onOperation}>
          Read opaque delivery records
        </Read>
        <SafeResult result={props.results.deliveriesList} />
      </Item>
      <DataItem id="holds" title="Held decisions" props={props} paths={['/recovery/held']} />
      <DataItem id="judge-kinds" title="Enabled judge kinds" props={props} paths={['/judgeBoundary']} />
      <DataItem id="whatsapp-live-lists" title="WhatsApp live lists" props={props} paths={['/whatsapp']} />
      <DataItem
        id="pending-approvals"
        title="Pending approvals"
        props={props}
        paths={['/awaitingReapproval', '/activationIntents']}
      />
      <Item id="activation-completion" title="Staged, replacement and enable-all completion">
        <p>The daemon reports completion deadlines and failure codes.</p>
        <DataItem id="activation-records" title="Activation records" props={props} paths={['/activationIntents']} />
        <ContractSeam>
          B3 doctor has no rule/version selector for a failed intent's new-approval action. This action is unavailable;
          no selector is reconstructed. Use the Rules flow with independently known exact identifiers.
        </ContractSeam>
      </Item>
    </main>
  );
}
