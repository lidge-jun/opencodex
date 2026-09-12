export type RemediationStatus = "monitoring" | "dispatched" | "fixed" | "ignored";

export interface FailureEvent {
  failureKind: string;
  provider?: string;
  model?: string;
  signature: string;
  timestamp?: number;
  requestId?: string;
  sessionId?: string;
}

export type FailureFingerprint = string;

export interface LedgerRecord {
  fingerprint: FailureFingerprint;
  firstSeen: number;
  lastSeen: number;
  count: number;
  status: RemediationStatus;
  details?: Record<string, unknown>;
}
