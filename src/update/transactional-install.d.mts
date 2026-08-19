export type InstallTreeVerification = { ok: boolean; failures: string[] };
export function verifyInstallTree(packageDir: string, expectedVersion?: string): InstallTreeVerification;
export function bootRestoreProbe(
  packageDir: string,
  deps?: { rename?: (from: string, to: string) => void },
): { action: "none" | "reaped" | "restored" | "failed"; count?: number; from?: string; error?: string };
export function transactionalNpmUpdate(args: {
  packageDir: string;
  pkgName: string;
  targetVersion?: string;
  tag: string;
  runNpm: (args: string[]) => { status: number | null };
  log?: (line: string) => void;
  deps?: { rename?: (from: string, to: string) => void };
}): {
  ok: boolean;
  phase: "stage" | "verify" | "swap-backup" | "swap-live" | "post-verify" | "double-fault" | "done";
  error?: string;
  rolledBack?: boolean;
  backup?: string;
};

