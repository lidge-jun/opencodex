import type { spawnSync } from "node:child_process";

export type NpmCachePreflightReason =
  | "cache_accessible"
  | "cache_entry_foreign_owner"
  | "cache_entry_inaccessible"
  | "cache_path_malformed"
  | "inspection_incomplete"
  | "npm_config_failed"
  | "npm_unavailable"
  | "windows_skip"
  | "worker_failed"
  | "worker_output_malformed"
  | "worker_timeout";

export interface NpmCachePreflightResult {
  ok: boolean;
  reason: NpmCachePreflightReason;
}

export interface NpmCacheInspectionOptions {
  expectedUid?: number;
  maxDepth?: number;
  maxEntries?: number;
  nowMs?: () => number;
  /** Test seam: resolve a symlinked cache root. Defaults to realpathSync. */
  realpathFn?: (path: string) => string;
  /** Test seam: resolve an entry's owner uid. Defaults to the lstat result. */
  uidOf?: (path: string, stat: { uid: number }) => number;
  timeoutMs?: number;
}

export interface NpmCachePreflightOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  spawnSyncFn?: typeof spawnSync;
  timeoutMs?: number;
}

export function inspectNpmCacheDirectory(
  cachePath: string,
  options?: NpmCacheInspectionOptions,
): NpmCachePreflightResult;

export function runNpmCachePreflight(options?: NpmCachePreflightOptions): NpmCachePreflightResult;
export function npmCachePreflightFailureMessage(reason: NpmCachePreflightReason): string;
