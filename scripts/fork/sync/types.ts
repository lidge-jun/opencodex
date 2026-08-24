export type SyncEventKind =
  | "already-current"
  | "pin-updated"
  | "pin-diverged"
  | "detect-failed"
  | "main-behind"
  | "history-diverged";

export type PathClass =
  | "fork-owned"
  | "upstream-owned"
  | "shared-hotspot"
  | "recipe";

export interface PrepareResult {
  status: "merged" | "hotspot-handoff" | "history-diverged" | "skipped";
  branch?: string;
  resolutions: Array<{
    path: string;
    classification: PathClass;
    action: string;
  }>;
  unresolved: string[];
  pullRequestNumber?: number;
}

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
  prepareStatus?: PrepareResult["status"];
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

export interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string;
  state: string;
  draft?: boolean;
  head: { ref: string };
  base: { ref: string };
}

export interface DraftPullRequestClient {
  upsert(input: {
    event: SyncEvent;
    result: PrepareResult;
  }): Promise<number>;
}
