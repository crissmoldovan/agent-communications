import { useState } from 'react';
import { Item, SafeResult, type ScreenProps } from './shared';

export function Approvals(props: ScreenProps) {
  const [id, setId] = useState('');
  const [digest, setDigest] = useState('');
  const [answer, setAnswer] = useState('');
  const result = props.results.approvalView;
  return (
    <main>
      <h2>Approvals</h2>
      <Item id="complete-preview" title="Complete authorisation preview">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setAnswer('');
            props.onApproval(id, digest, null);
          }}
        >
          <label>
            Approval id
            <input value={id} onChange={(event) => setId(event.target.value)} required />
          </label>
          <label>
            Digest
            <input value={digest} onChange={(event) => setDigest(event.target.value)} required />
          </label>
          <button type="submit">Read authoritative preview</button>
        </form>
        <SafeResult result={result} />
      </Item>
      <Item id="typed-challenge" title="Typed challenge">
        <p>{result?.approval?.challenge}</p>
        <label>
          Typed challenge
          <input value={answer} onChange={(event) => setAnswer(event.target.value)} autoComplete="off" />
        </label>
        <button
          type="button"
          disabled={
            !result?.approval ||
            result.approval.approvalId !== id ||
            result.approval.digest !== digest ||
            answer.length === 0
          }
          onClick={() => {
            props.onApproval(id, digest, answer);
            setAnswer('');
          }}
        >
          Approve
        </button>
      </Item>
    </main>
  );
}
