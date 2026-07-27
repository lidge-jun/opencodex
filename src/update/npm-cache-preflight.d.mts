export interface NpmCacheEntryStat {
  uid?: number;
  isDirectory(): boolean;
}

export interface NpmCachePreflightOptions {
  platform?: string;
  getuid?: () => number;
  npmBin?: string;
  shell?: boolean;
  spawn?: typeof import("node:child_process").spawnSync;
  scanSpawn?: typeof import("node:child_process").spawnSync;
  scanBin?: string;
  scanScript?: string;
  lstat?: (path: string) => NpmCacheEntryStat;
  readdir?: (path: string) => string[];
  realpath?: (path: string) => string;
  now?: () => number;
  maxEntries?: number;
  maxDurationMs?: number;
}

export type NpmCacheOwnershipIssue =
  | { kind: "foreign-owner"; path: string; actualUid: number }
  | { kind: "error"; path: string; reason: string };

export type NpmCacheOwnershipResult =
  | { ok: true; cachePath: string }
  | { ok: "skipped"; reason: string }
  | {
      ok: false;
      cachePath?: string;
      entryPath?: string;
      expectedUid: number;
      actualUid?: number;
      reason: string;
    };

export declare function findForeignOwnedNpmCacheEntry(
  cachePath: string,
  expectedUid: number,
  io?: Pick<
    NpmCachePreflightOptions,
    "lstat" | "readdir" | "realpath" | "now" | "maxEntries" | "maxDurationMs"
  >,
): NpmCacheOwnershipIssue | null;

export declare function checkNpmCacheOwnership(
  options?: NpmCachePreflightOptions,
): NpmCacheOwnershipResult;

export declare function formatNpmCacheOwnershipFailure(
  result: Extract<NpmCacheOwnershipResult, { ok: false }>,
): string;
