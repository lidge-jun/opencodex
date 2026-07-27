export const DEFAULT_MAX_RECOVERY_TREE_ENTRIES: number;
export const DEFAULT_MAX_RECOVERY_TREE_SCAN_MS: number;
export const RECOVERY_TREE_SCAN_WORKER_ARG: string;

export interface RecoveryTreeScanOptions {
  maxEntries?: number;
  maxDurationMs?: number;
}

export function scanTrustedRecoveryTree(
  packageRoot: string,
  options?: RecoveryTreeScanOptions,
): boolean;
