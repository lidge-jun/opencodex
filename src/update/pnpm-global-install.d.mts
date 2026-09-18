export interface PnpmRunResult {
  status: number | null;
  stdout?: string | Uint8Array | null;
  stderr?: string | Uint8Array | null;
}

export type RunPnpm = (args: readonly string[], capture?: boolean) => PnpmRunResult;
export type RunPnpmCandidate = (
  commandPath: string,
  args: readonly string[],
  capture?: boolean,
) => PnpmRunResult;

export interface PnpmGlobalOwner {
  commandPath: string;
  packagePath: string;
  /** Base passed to pnpm's --global-dir; pnpm creates the versioned group below it. */
  globalDir: string;
  /** Actual versioned global group reported by pnpm root/list. */
  globalRoot: string;
  globalBinDir: string;
  version?: string;
}

export type PnpmGlobalOwnerResult =
  | { ok: true; owner: PnpmGlobalOwner }
  | { ok: false; reason: string };

export type PnpmVerificationResult = { ok: boolean; reason?: string };

export declare const PNPM_BUILD_APPROVAL: string;

export declare function pnpmGlobalCommandArgs(
  args: readonly string[],
  owner: PnpmGlobalOwner,
): string[];

export declare function pnpmOwnerEnvironment(
  owner: PnpmGlobalOwner,
  env?: Record<string, string | undefined>,
  platform?: NodeJS.Platform,
): Record<string, string | undefined>;

export interface PnpmOwnerInvocation {
  file: string;
  args: string[];
  options: { windowsVerbatimArguments?: boolean };
  env: Record<string, string | undefined>;
}

export declare function pnpmOwnerInvocation(
  owner: PnpmGlobalOwner,
  args: readonly string[],
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
): PnpmOwnerInvocation | null;

export declare function verifyPnpmGlobalShims(
  packageDir: string,
  globalBinDir: string,
  platform?: NodeJS.Platform,
  exists?: (path: string) => boolean,
): PnpmVerificationResult;

export type PnpmGlobalPackage =
  | {
      ok: true;
      version: string;
      path: string;
      globalDir?: string;
      globalRoot?: string;
      globalBinDir?: string;
    }
  | { ok: false; reason: string };

export interface PnpmGlobalReadConstraints {
  owner?: PnpmGlobalOwner;
  expectedPackagePath?: string;
  expectedGlobalDir?: string;
  expectedGlobalRoot?: string;
  globalBinDir?: string;
  /** Set false only for pre-update owner binding; post-update reads verify shims by default. */
  checkShims?: boolean;
  platform?: NodeJS.Platform;
  verifyShims?: (
    packageDir: string,
    globalBinDir: string,
    platform?: NodeJS.Platform,
  ) => PnpmVerificationResult;
}

export declare function readPnpmGlobalPackage(
  packageName: string,
  runPnpm: RunPnpm,
  verify?: (packageDir: string, expectedVersion?: string) => PnpmVerificationResult,
  constraints?: PnpmGlobalReadConstraints,
): PnpmGlobalPackage;

export declare function resolvePnpmGlobalOwner(options: {
  packageName: string;
  packagePath: string;
  commandPaths: readonly string[];
  runningShimPath?: string;
  runPnpm: RunPnpmCandidate;
  verify?: (packageDir: string, expectedVersion?: string) => PnpmVerificationResult;
  platform?: NodeJS.Platform;
}): PnpmGlobalOwnerResult;

export type PnpmGlobalUpdateResult =
  | {
      ok: true;
      phase: "done";
      version: string;
      path: string;
      globalDir: string;
      globalBinDir: string;
    }
  | {
      ok: false;
      phase: "preflight" | "install" | "rollback";
      rolledBack?: boolean;
      activePath?: string;
      globalDir?: string;
      globalBinDir?: string;
      error: string;
    };

export declare function runPnpmGlobalUpdate(options: {
  packageName: string;
  currentVersion?: string;
  targetVersion?: string;
  tag: string;
  owner: PnpmGlobalOwner;
  runningPackagePath?: string;
  runPnpm: RunPnpm;
  verify?: (packageDir: string, expectedVersion?: string) => PnpmVerificationResult;
  verifyShims?: (
    packageDir: string,
    globalBinDir: string,
    platform?: NodeJS.Platform,
  ) => PnpmVerificationResult;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}): PnpmGlobalUpdateResult;
