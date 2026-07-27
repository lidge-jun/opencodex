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
  lstat?: (path: string) => NpmCacheEntryStat;
  readdir?: (path: string) => string[];
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
  io?: Pick<NpmCachePreflightOptions, "lstat" | "readdir">,
): NpmCacheOwnershipIssue | null;

export declare function checkNpmCacheOwnership(
  options?: NpmCachePreflightOptions,
): NpmCacheOwnershipResult;

export declare function formatNpmCacheOwnershipFailure(
  result: Extract<NpmCacheOwnershipResult, { ok: false }>,
): string;
