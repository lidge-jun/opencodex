export type InstallTreeVerification = { ok: boolean; failures: string[] };
export function verifyInstallTree(packageDir: string, expectedVersion?: string): InstallTreeVerification;
export function verifyPnpmInstallTree(packageDir: string, expectedVersion?: string): InstallTreeVerification;
export function bootRestoreProbe(
  packageDir: string,
  deps?: { rename?: (from: string, to: string) => void },
): { action: "none" | "reaped" | "restored" | "failed"; count?: number; from?: string; error?: string };
export type UpdateFsDeps = {
  rename?: (from: string, to: string) => void;
  mkdir?: (path: string) => void;
  rm?: (path: string, options: { recursive: true; force: true }) => void;
  now?: () => number;
};
export const UPDATE_OWNER_MARKER: string;
export const STALE_STAGE_MIN_AGE_MS: number;
export function removeOwnedStage(stageRoot: string, deps?: UpdateFsDeps): { removed: boolean; code?: string };
export function sweepUpdateLeftovers(args: {
  packageDir: string;
  pkgName: string;
  log?: (line: string) => void;
  deps?: UpdateFsDeps;
}): {
  inUse: Array<{ path: string; code: string }>;
  recent: string[];
  notOwned: string[];
};
export function launcherUsableAfterNpmUpdate(tx: { ok: boolean; phase: string; rolledBack?: boolean } | null | undefined): boolean;
export function transactionalNpmUpdate(args: {
  packageDir: string;
  pkgName: string;
  targetVersion?: string;
  tag: string;
  runNpm: (args: string[]) => { status: number | null };
  log?: (line: string) => void;
  deps?: UpdateFsDeps;
}): {
  ok: boolean;
  phase: "stage" | "verify" | "swap-backup" | "swap-live" | "post-verify" | "double-fault" | "done";
  error?: string;
  rolledBack?: boolean;
  backup?: string;
};
