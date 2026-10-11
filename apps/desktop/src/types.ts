export type DesktopWindowKind = 'settings' | 'secrets';

export interface SafeSegment {
  path: string;
  text: string;
  trust: 'untrusted';
}
export interface SafeApproval {
  approvalId: string;
  digest: string;
  challenge: string;
  expiresAt: number;
}
export interface SafeAppResult {
  operation: string;
  segments: SafeSegment[];
  code: string | null;
  truncated: boolean;
  approval: SafeApproval | null;
}
/** Exact schema-closed request identity fields. Opaque records never become selections. */
export type ScopeValue = string | number | readonly string[];
export type Selection = Record<string, ScopeValue>;
export interface ControlResponse {
  result: SafeAppResult;
  association: Selection | null;
  generation: number;
}
export interface AppPreferences {
  openAtLogin: boolean;
  keepCollectingAfterQuit: boolean;
  revision?: number;
}
