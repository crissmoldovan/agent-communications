import { DataItem, Item, OperationForm, Read, type ScreenProps } from './shared';

export function Rules(props: ScreenProps) {
  return (
    <main>
      <h2>Rules</h2>
      <Read operation="rules-list" onOperation={props.onOperation}>
        Read rule versions
      </Read>
      <DataItem id="tree" title="Deterministic tree" operation="rules-list" props={props} opaque />
      <DataItem id="optional-judge" title="Optional judge" operation="rule-show" props={props} opaque />
      <DataItem id="inputs-budgets" title="Exact inputs and budgets" operation="rule-show" props={props} opaque />
      <Item id="mapping-builder" title="Mapping builder">
        <p>
          Edit the mapping in a complete versioned rule document. B3 validates its field pointers and constants before
          storing a pending version.
        </p>
        <OperationForm operation="rule-create" title="Create rule document" onOperation={props.onOperation} />
        <OperationForm operation="rule-update" title="Update rule document" onOperation={props.onOperation} />
      </Item>
      <DataItem
        id="representation-schema"
        title="Representation and schema"
        operation="rule-show"
        props={props}
        opaque
      />
      <DataItem id="rate-cap" title="Delivery rate cap" operation="rule-show" props={props} opaque />
      <Item id="preview-dryrun" title="Preview and dry-run test">
        <OperationForm operation="ruleTest" title="Test catalogue example" onOperation={props.onOperation} />
        <OperationForm operation="ruleTestRetained" title="Test retained event id" onOperation={props.onOperation} />
        <DataItem id="test-result" title="Safe test result" operation="ruleTestRetained" props={props} />
        <DataItem id="example-result" title="Example result" operation="ruleTest" props={props} />
      </Item>
      {['rule-show', 'rule-enable', 'rule-disable', 'rule-remove'].map((operation) => (
        <OperationForm key={operation} operation={operation} title={operation} onOperation={props.onOperation} />
      ))}
    </main>
  );
}
