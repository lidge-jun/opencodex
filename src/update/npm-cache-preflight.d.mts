import type { spawnSync } from "node:child_process";

export type NpmCachePreflightReason =
  | "cache_accessible"
  | "cache_entry_foreign_owner"
  | "cache_entry_inaccessible"
  | "cache_path_malformed"
  | "cache_root_dangling_link"
  | "cache_root_not_directory"
  | "inspection_incomplete"
  | "npm_config_failed"
  | "npm_unavailable"
  | "worker_failed"
  | "worker_output_malformed"
  | "worker_timeout";

export interface NpmCachePreflightResult {
  ok: boolean;
  reason: NpmCachePreflightReason;
}

export interface NpmCacheInspectionOptions {
  expectedUid?: number;
  /** Test seam: lstat used by the cache-root check. Defaults to lstatSync. */
  lstatFn?: (path: string) => { isSymbolicLink(): boolean; isDirectory(): boolean };
  maxDepth?: number;
  maxEntries?: number;
  nowMs?: () => number;
  /** Test seam: resolve a symlinked cache root. Defaults to realpathSync. */
  realpathFn?: (path: string) => string;
  /** Test seam: stat (following links) used by the cache-root check. Defaults to statSync. */
  statFn?: (path: string) => { isDirectory(): boolean };
  /** Test seam: resolve an entry's owner uid. Defaults to the lstat result. */
  uidOf?: (path: string, stat: { uid: number }) => number;
  timeoutMs?: number;
}

export interface NpmCachePreflightOptions {
  /** Inspect this resolved cache root instead of letting the worker resolve npm's cache. */
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  spawnSyncFn?: typeof spawnSync;
  timeoutMs?: number;
}

export type NpmCachePathResolution =
  | { ok: true; path: string }
  | { ok: false; reason: "npm_unavailable" | "npm_config_failed" | "cache_path_malformed" };

export interface NpmCachePathOptions {
  /** Working directory for `npm config get`; defaults to the home directory. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  invocationFn?: (
    args: string[],
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
  ) => { file: string; args: string[]; options?: Record<string, unknown> } | null;
  platform?: NodeJS.Platform;
  spawnSyncFn?: typeof spawnSync;
  timeoutMs?: number;
}

export function inspectNpmCacheRoot(
  cachePath: string,
  options?: Pick<NpmCacheInspectionOptions, "lstatFn" | "statFn">,
): NpmCachePreflightResult;

export function resolveNpmCachePath(options?: NpmCachePathOptions): NpmCachePathResolution;

export function inspectNpmCacheDirectory(
  cachePath: string,
  options?: NpmCacheInspectionOptions,
): NpmCachePreflightResult;

export function runNpmCachePreflight(options?: NpmCachePreflightOptions): NpmCachePreflightResult;
export function npmCachePreflightFailureMessage(reason: NpmCachePreflightReason): string;
