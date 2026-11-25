import { readJsonIfOk } from "../../fetch-json";

/** Kept in step with src/integrations/connection-view.ts (GET /api/connections). */
export type ConnectionClient = "codex" | "claude-code" | "claude-desktop";
export type ConnectionDesired = "proxy" | "native" | "remote-home" | "unset";
export type ConnectionObserved = "proxy" | "native" | "remote-home" | "foreign" | "missing" | "unknown";
export type ConnectionOwner = "opencodex" | "external" | "hub" | "none" | "unknown";
const CONNECTION_DRIFT_REASONS = [
  "external_owner", "account_mode", "hub_gated", "intercept_disabled", "file_edited", "pending_restart",
] as const;
export type ConnectionDriftReason = (typeof CONNECTION_DRIFT_REASONS)[number];

export interface ConnectionKeyChange {
  file: string;
  key: string;
  change: "add" | "update" | "remove";
}

export interface ConnectionView {
  client: ConnectionClient;
  home?: string;
  homeSource?: "default" | "extra";
  homeOrdinal?: number;
  configPath: string;
  desired: ConnectionDesired;
  observed: ConnectionObserved;
  owner: ConnectionOwner;
  ownerPath?: string;
  driftReasons: ConnectionDriftReason[];
  restorePreview?: { outcome: string; changes: ConnectionKeyChange[] };
}

export async function loadConnections(apiBase: string, signal?: AbortSignal): Promise<ConnectionView[]> {
  const response = await fetch(`${apiBase}/api/connections`, { signal });
  const body = await readJsonIfOk<{ connections?: unknown }>(response);
  if (!body || !Array.isArray(body.connections)) throw new Error("connections_unavailable");
  return body.connections as ConnectionView[];
}
