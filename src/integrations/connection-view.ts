/**
 * One client connection as the Connections view reports it (catch-up 010, G-001).
 *
 * Read-only projection: where a client is wanted to go (`desired`), where its files point now
 * (`observed`), who controls those files (`owner`) and why the two differ. Paths are display
 * paths (see src/lib/display-path.ts); no value, token or email is ever carried.
 */
export type ConnectionClient = "codex" | "claude-code" | "claude-desktop";
export type ConnectionDesired = "proxy" | "native" | "remote-home" | "unset";
export type ConnectionObserved = "proxy" | "native" | "remote-home" | "foreign" | "missing" | "unknown";
export type ConnectionOwner = "opencodex" | "external" | "hub" | "none" | "unknown";

/**
 * Why observed differs (or cannot follow) desired. Every member is produced by a projection:
 * - external_owner: another program, OpenCodex home or service owns the files (`ownerPath`).
 * - account_mode: Claude Desktop's pinned account mode contradicts what it runs.
 * - hub_gated: this machine is a hub and does not rewrite its own clients.
 * - intercept_disabled: Claude first-party is wanted while the intercept cannot run.
 * - file_edited: the file no longer matches the switch (edited, rewritten, or a restore remainder).
 * - pending_restart: the file is right but the listener it names is stopped or another port.
 */
export const CONNECTION_DRIFT_REASONS = [
  "external_owner", "account_mode", "hub_gated", "intercept_disabled", "file_edited", "pending_restart",
] as const;
export type ConnectionDriftReason = (typeof CONNECTION_DRIFT_REASONS)[number];

export interface ConnectionKeyChange {
  file: string;
  key: string;
  change: "add" | "update" | "remove";
}

export interface ConnectionRestorePreview {
  /** `restore` when the switch-off would run; otherwise the refusal or skip it would hit. */
  outcome: string;
  changes: ConnectionKeyChange[];
}

export interface ConnectionView {
  client: ConnectionClient;
  /** Claude Code only: the config dir this row describes. */
  home?: string;
  homeSource?: "default" | "extra";
  configPath: string;
  desired: ConnectionDesired;
  observed: ConnectionObserved;
  owner: ConnectionOwner;
  ownerPath?: string;
  driftReasons: ConnectionDriftReason[];
  restorePreview?: ConnectionRestorePreview;
}
