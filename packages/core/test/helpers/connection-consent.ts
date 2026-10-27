import type { LooseningConsent } from '../../src/config.ts';
import { type ConnectionRecord, connectionLabel, connectionPath } from '../../src/connections.ts';

/**
 * The consent a test writes a connection with straight into `config.json`: its path as one being added names it, and
 * as one already there does — the store asks for the first when it is new, the second when it serves again.
 */
export function connectionConsent(record: Pick<ConnectionRecord, 'id' | 'name' | 'app' | 'where'>): LooseningConsent {
  return {
    kind: 'loosening-consent',
    paths: [connectionPath(connectionLabel(record, null)), connectionPath(connectionLabel(record, record.id))],
  };
}
