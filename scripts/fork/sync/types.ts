export type SyncEventKind =
  | "already-current"
  | "pin-updated"
  | "pin-diverged"
  | "detect-failed";

export interface SyncEvent {
  kind: SyncEventKind;
  upstreamRepo: string;
  latestTag: string;
  latestTagSha: string;
  vendorMainSha: string;
  vendorDevSha: string;
  detectedAt: string;
  error?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  args: readonly string[],
) => Promise<CommandResult>;
