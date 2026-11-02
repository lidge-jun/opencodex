export interface OwnershipMutationLeaseOptions {
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => void;
  readonly processAlive?: (pid: number) => boolean;
  readonly beforeRelease?: (lockPath: string) => void;
  readonly joinToken?: string;
  /** Names the current executable at the recorded PID, identity unverified; uses `ps` on POSIX and omits the default image lookup on Windows. */
  readonly processImage?: (pid: number) => string | null;
  /** Isolated locks cannot re-enter or inherit ownership delegation. */
  readonly isolated?: boolean;
  readonly holderKind?: "sync" | "update";
  /** Explicit canonical lock path for isolated callers with no state-file authority. */
  readonly lockPath?: string;
}

/** The recorded lease owner, identity unverified, read for diagnostics; never used to reclaim it. */
export interface OwnershipMutationLeaseHolder {
  readonly path: string;
  /** The recorded PID; null when the directory holds no parseable owner. */
  readonly pid: number | null;
  readonly delegatePid: number | null;
  readonly holderAlive: boolean | null;
  /** Liveness of the current process at the recorded PID; identity is not verified. */
  readonly alive: boolean | null;
  readonly holderKind: "sync" | "update" | null;
  /** The current executable at the recorded PID when alive and readable; identity is not verified. */
  readonly image: string | null;
  /** Milliseconds since the owner was written, on the clock stale recovery uses. */
  readonly ageMs: number | null;
  readonly record: "complete" | "incomplete" | "empty" | "unreadable";
}

export interface OwnershipMutationLease { readonly token: string; addDelegate(pid: number): void; release(): void }

export declare const OWNERSHIP_MUTATION_LEASE_TOKEN_ENV: "OCX_OWNERSHIP_MUTATION_LEASE_TOKEN";
export declare function ownershipMutationLeasePath(statePaths: readonly string[]): string;

export declare function ownershipMutationLeaseChildEnvironment(
  environment: NodeJS.ProcessEnv,
  token: string,
): NodeJS.ProcessEnv;

export declare function unprivilegedOwnershipMutationEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export declare function acquireOwnershipMutationLease(
  statePaths: readonly string[],
  options?: OwnershipMutationLeaseOptions,
): OwnershipMutationLease;

export declare function withOwnershipMutationLease<T>(
  statePaths: readonly string[],
  run: () => T,
  options?: OwnershipMutationLeaseOptions,
): T;

export declare function inspectOwnershipMutationLease(
  statePaths: readonly string[],
  options?: Pick<OwnershipMutationLeaseOptions, "now" | "processAlive" | "processImage" | "lockPath">,
): OwnershipMutationLeaseHolder | null;

export declare function ownershipMutationLeaseStatusLine(
  statePaths: readonly string[],
  options?: Pick<OwnershipMutationLeaseOptions, "now" | "processAlive" | "processImage">,
): string | null;
