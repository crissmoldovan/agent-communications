import { type ReactNode, useState } from 'react';
import type { AppPreferences, SafeAppResult, Selection } from '../types';

export interface ScreenProps {
  results: Record<string, SafeAppResult>;
  onOperation(operation: string, args: Record<string, unknown>, expectedScope?: Selection): void | Promise<void>;
  onApproval(approvalId: string, digest: string, typedResponse: string | null): void;
  onSecrets(): void;
  preferences?: AppPreferences;
  onPreferences?(preferences: AppPreferences): void;
  supervision?: ReactNode;
}

export function SafeResult({ result, paths }: { result?: SafeAppResult; paths?: string[] }) {
  if (!result) return <p>Read the daemon to see its current state.</p>;
  const segments = paths
    ? result.segments.filter((segment) => paths.some((path) => segment.path.startsWith(path)))
    : result.segments;
  return (
    <div className="safe-result">
      {result.code && <p role="status">{result.code}</p>}
      <p>Untrusted data — text only</p>
      {segments.map((segment) => (
        <div key={segment.path}>
          <small>{segment.path}</small>
          <pre>{segment.text}</pre>
        </div>
      ))}
      {segments.length === 0 && <p>No matching records in this response.</p>}
      {result.truncated && <p>Display limit reached. Narrow the selection to see more.</p>}
    </div>
  );
}

export function Item({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-item={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function ContractSeam({
  code = 'DESKTOP_B3_FIELD_UNAVAILABLE',
  children,
}: {
  code?: 'DESKTOP_B3_FIELD_UNAVAILABLE' | 'DESKTOP_B3_OPAQUE_RECORD' | 'APP_SECRET_CAPABILITY_UNAVAILABLE';
  children: ReactNode;
}) {
  return (
    <p role="status" data-contract-seam={code}>
      {code}: {children}
    </p>
  );
}

/** Every mutation/prepare response remains visible, including approval ids and typed phase unavailability. */
export function OperationResults({ results }: { results: Record<string, SafeAppResult> }) {
  return (
    <section aria-label="Operation results">
      {Object.entries(results).map(([operation, result]) => (
        <section key={operation}>
          <h3>{operation}</h3>
          <SafeResult result={result} />
        </section>
      ))}
    </section>
  );
}

export function Read({
  operation,
  children,
  onOperation,
}: {
  operation: string;
  children: ReactNode;
  onOperation: ScreenProps['onOperation'];
}) {
  return (
    <button type="button" data-operation={operation} onClick={() => onOperation(operation, {})}>
      {children}
    </button>
  );
}

/** Operation is fixed by each screen. B3's schema validates the exact structured arguments in Rust. */
export function OperationForm({
  operation,
  title,
  onOperation,
  initial = '{}',
}: {
  operation: string;
  title: string;
  onOperation: ScreenProps['onOperation'];
  initial?: string;
}) {
  const [document, setDocument] = useState(initial);
  const [expectedScope, setExpectedScope] = useState('{}');
  const [error, setError] = useState('');
  return (
    <OperationFormView
      operation={operation}
      title={title}
      onOperation={onOperation}
      document={document}
      expectedScope={expectedScope}
      error={error}
      onDocument={setDocument}
      onScope={setExpectedScope}
      onError={setError}
    />
  );
}

export function OperationFormView({
  operation,
  title,
  onOperation,
  document,
  expectedScope,
  error,
  onDocument,
  onScope,
  onError,
}: {
  operation: string;
  title: string;
  onOperation: ScreenProps['onOperation'];
  document: string;
  expectedScope: string;
  error: string;
  onDocument(value: string): void;
  onScope(value: string): void;
  onError(value: string): void;
}) {
  return (
    <form
      data-operation={operation}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const args: unknown = JSON.parse(document);
          if (typeof args !== 'object' || args === null || Array.isArray(args))
            throw new Error('Arguments must be a JSON object.');
          const scope: unknown = JSON.parse(expectedScope);
          if (
            !scope ||
            typeof scope !== 'object' ||
            Array.isArray(scope) ||
            Object.values(scope).some((value) => typeof value !== 'string' && typeof value !== 'number')
          )
            throw new Error('Invalid scope');
          onError('');
          return onOperation(operation, args as Record<string, unknown>, scope as Selection);
        } catch {
          onError('Enter structured JSON objects using stable ids and exact versions.');
        }
      }}
    >
      <label>
        {title}
        <textarea value={document} onChange={(event) => onDocument(event.target.value)} spellCheck={false} />
      </label>
      <label>
        Expected response scope (optional; schema-declared ids, versions, accountId or source only)
        <textarea value={expectedScope} onChange={(event) => onScope(event.target.value)} spellCheck={false} />
      </label>
      <p>Use stable ids and exact versions from the daemon. Secret entry belongs in the Secrets window.</p>
      <button type="submit">{title}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function DataItem({
  id,
  title,
  props,
  operation = 'doctor',
  paths,
  opaque = false,
}: {
  id: string;
  title: string;
  props: ScreenProps;
  operation?: string;
  paths?: string[];
  opaque?: boolean;
}) {
  return (
    <Item id={id} title={title}>
      {opaque && (
        <ContractSeam code="DESKTOP_B3_OPAQUE_RECORD">
          B3 v1 returns opaque records here, not a typed {title.toLowerCase()} view. Records below are text only and
          cannot be used as authority for a selection.
        </ContractSeam>
      )}
      <SafeResult result={props.results[operation]} paths={paths} />
    </Item>
  );
}
