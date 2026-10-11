import { phaseSeam } from './phase-seams';
import { DataItem, Item, OperationForm, Read, type ScreenProps } from './shared';

export function Judges(props: ScreenProps) {
  return (
    <main>
      <h2>Judges</h2>
      <Read operation="doctor" onOperation={props.onOperation}>
        Read judge boundary health
      </Read>
      <Read operation="judgesList" onOperation={props.onOperation}>
        Read judges
      </Read>
      <Read operation="judgeKindsList" onOperation={props.onOperation}>
        Read judge kinds
      </Read>
      <p>{phaseSeam(props.results.judgesList)}</p>
      <Item id="three-kinds" title="Judge kinds">
        <p>Every kind starts off. Only the daemon's enabled-kind record authorises calls.</p>
        <DataItem id="kind-results" title="Kinds from daemon" operation="judgeKindsList" props={props} />
        <DataItem id="kind-boundaries" title="Declared kind boundaries" props={props} paths={['/judgeBoundary']} />
      </Item>
      <Item id="approval-enable" title="Approval to enable">
        <OperationForm
          operation="enableJudgeKind"
          title="Prepare judge kind approval"
          onOperation={props.onOperation}
        />
        <DataItem id="kind-enable-result" title="Enable result" operation="enableJudgeKind" props={props} />
      </Item>
      <Item id="immediate-disable" title="Immediate disable">
        <OperationForm operation="disableJudgeKind" title="Disable judge kind" onOperation={props.onOperation} />
        <DataItem id="kind-disable-result" title="Disable result" operation="disableJudgeKind" props={props} />
      </Item>
      <DataItem id="inputs" title="Exact judge inputs" operation="judgesList" props={props} />
      <Item id="hosted-warning" title="Hosted disclosure warning">
        <p>
          Enabling a hosted judge permits future matching event inputs to leave this machine under its approved rule.
        </p>
      </Item>
      <Item id="keys" title="Human-only keys">
        <button type="button" onClick={props.onSecrets}>
          Enter or rotate key in Secrets
        </button>
      </Item>
      <DataItem id="endpoints" title="Local endpoints" operation="judgesList" props={props} />
      <DataItem id="laya-boundary" title="Laya limits and boundary" props={props} paths={['/judgeBoundary']} />
      <Item id="laya-progress" title="Laya progress and verified state">
        <Read operation="judgeModelStatus" onOperation={props.onOperation}>
          Read model status
        </Read>
        <p>{phaseSeam(props.results.judgeModelStatus)}</p>
        <DataItem id="model-state" title="Model state" operation="judgeModelStatus" props={props} />
      </Item>
      <Item id="laya-remove" title="Remove Laya files">
        <Read operation="removeJudgeModel" onOperation={props.onOperation}>
          Remove disabled model
        </Read>
        <DataItem id="model-remove-result" title="Remove model result" operation="removeJudgeModel" props={props} />
      </Item>
      <Item id="secret-handoff" title="Judge secret handoff">
        <button type="button" onClick={props.onSecrets}>
          Open Secrets
        </button>
      </Item>
      {['addJudge', 'updateJudge', 'removeJudge', 'judgeTest', 'updateBudget'].map((operation) => (
        <OperationForm key={operation} operation={operation} title={operation} onOperation={props.onOperation} />
      ))}
      <Read operation="budgetShow" onOperation={props.onOperation}>
        Read budget
      </Read>
      <DataItem id="budget" title="Current budget" operation="budgetShow" props={props} />
    </main>
  );
}
