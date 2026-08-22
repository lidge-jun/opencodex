export type SyncEventKind =
  | "already-current"
  | "pin-updated"
  | "pin-diverged"
  | "detect-failed"
  | "main-behind"
  | "history-diverged";

export interface SyncEvent {
  kind: SyncEventKind;
  upstreamRepo: string;
  latestTag: string;
  latestTagSha: string;
  vendorMainSha: string;
  vendorDevSha: string;
  vendorContainedInMain?: boolean;
  mergeBaseCount?: number;
  recommendedLane?: "noop" | "daily-merge" | "emergency-rebuild";
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

export type ProcessRunner = (
  args: readonly string[],
  stdin: string,
) => Promise<CommandResult>;

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ForkSyncNotifier {
  id: string;
  notify(event: SyncEvent): Promise<void>;
}

export interface ForkSyncCoordinator {
  id: string;
  start(event: SyncEvent): Promise<void>;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name?: string } | string>;
}

export interface GitHubIssuesClient {
  listOpen(options: { label: string }): Promise<GitHubIssue[]>;
  create(options: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<void>;
  update(options: {
    issueNumber: number;
    title: string;
    body: string;
    labels: string[];
  }): Promise<void>;
}
