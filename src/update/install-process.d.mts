import type { StdioOptions } from "node:child_process";

export const INSTALLER_TREE_CLEANUP_FAILED_EXIT_CODE: number;

export interface ProcessTreeCommandOptions {
  timeoutMs?: number;
  stdio?: StdioOptions;
  windowsHide?: boolean;
  shell?: boolean | string;
  env?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  forceWaitMs?: number;
}

export interface ProcessTreeCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  interruptedSignal: NodeJS.Signals | null;
  timedOut: boolean;
  treeExited: boolean;
}

export interface ProcessGroupInspection {
  hasRunningMember: boolean;
  hasRunningLeader: boolean;
}

export type ProcessGroupForceDecision = "exited" | "signal" | "refuse";

export function processGroupForceDecision(
  inspection: ProcessGroupInspection | null,
  originalLeaderConfirmed: boolean,
): ProcessGroupForceDecision;

export function terminateInstallerProcessTree(
  pid: number | undefined,
  options?: Pick<ProcessTreeCommandOptions, "terminationGraceMs" | "forceWaitMs"> & {
    isOriginalLeader?: () => boolean;
  },
): Promise<boolean>;

export function runProcessTreeCommand(
  bin: string,
  args: string[],
  options?: ProcessTreeCommandOptions,
): Promise<ProcessTreeCommandResult>;
