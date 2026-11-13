export interface PnpmRunResult {
  status: number | null;
  processTreeExited?: boolean;
  groupExited?: boolean;
  stdout?: string | Uint8Array | null;
  stderr?: string | Uint8Array | null;
}

export type RunPnpm = (args: readonly string[], capture?: boolean) => PnpmRunResult;
export type RunPnpmCandidate = (
  commandPath: string,
  args: readonly string[],
  capture?: boolean,
  owner?: PnpmGlobalOwner,
) => PnpmRunResult;

export interface PnpmGlobalOwner {
  commandPath: string;
  packagePath: string;
  /** Base passed to pnpm's --global-dir; pnpm creates the versioned group below it. */
  globalDir: string;
  /** Actual versioned global group reported by pnpm root/list. */
  globalRoot: string;
  globalBinDir: string;
  store?: string;
  /** Lexical versioned store path reported by pnpm and pinned on mutations. */
  storePath?: string;
  globalStore?: boolean;
  virtualStoreDirs?: string[];
  /** pnpm home the store query was anchored at; pinned for every later store re-check. */
  homeAnchor?: string;
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
      /** Present only for a global virtual-store owner. */
      store?: string;
      storePath?: string;
      virtualStoreDirs?: string[];
      homeAnchor?: string;
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
  /** Environment the pnpm commands receive; locates pnpm home for the store query. */
  env?: NodeJS.ProcessEnv;
  verifyShims?: (
    packageDir: string,
    globalBinDir: string,
    platform?: NodeJS.Platform,
  ) => PnpmVerificationResult;
}

export declare function readPnpmGlobalPackage(
  packageName: string,
  runPnpm: RunPnpm,
  verify?: (packageDir: string, expectedVersion?: string, store?: string, globalRoot?: string, lexicalStore?: string) => PnpmVerificationResult,
  constraints?: PnpmGlobalReadConstraints,
): PnpmGlobalPackage;

export declare function resolvePnpmGlobalOwner(options: {
  packageName: string;
  packagePath: string;
  commandPaths: readonly string[];
  runningShimPath?: string;
  runPnpm: RunPnpmCandidate;
  verify?: (packageDir: string, expectedVersion?: string, store?: string, globalRoot?: string, lexicalStore?: string) => PnpmVerificationResult;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Re-resolving a store-pinned owner: always run the store proof, whatever the tree's spelling. */
  requireStoreProof?: boolean;
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
      uncertain?: boolean;
      processTreeExited?: boolean;
      /** True only when a rollback transaction restored and verified the previous version. */
      rollbackPerformed?: boolean;
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
  verify?: (packageDir: string, expectedVersion?: string, store?: string, globalRoot?: string, lexicalStore?: string) => PnpmVerificationResult;
  verifyShims?: (
    packageDir: string,
    globalBinDir: string,
    platform?: NodeJS.Platform,
  ) => PnpmVerificationResult;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}): PnpmGlobalUpdateResult;
