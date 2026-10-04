export interface OwnershipMutationLeaseOptions {
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => void;
  readonly processAlive?: (pid: number) => boolean;
  readonly beforeRelease?: (lockPath: string) => void;
  readonly joinToken?: string;
  /** Names a live holder's executable for diagnostics; the default asks `tasklist` or `ps`. */
  readonly processImage?: (pid: number) => string | null;
}

/** Who holds the lease directory, as read for diagnostics; never used to reclaim it. */
export interface OwnershipMutationLeaseHolder {
  readonly path: string;
  /** Null when the directory holds no parseable owner. */
  readonly pid: number | null;
  readonly alive: boolean | null;
  /** The holder's executable name when it is alive and the lookup answered. */
  readonly image: string | null;
  /** Milliseconds since the owner was written, on the clock stale recovery uses. */
  readonly ageMs: number | null;
  readonly record: "complete" | "incomplete" | "empty" | "unreadable";
}

export interface OwnershipMutationLease { readonly token: string; release(): void }

export declare const OWNERSHIP_MUTATION_LEASE_TOKEN_ENV: "OCX_OWNERSHIP_MUTATION_LEASE_TOKEN";

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
  options?: Pick<OwnershipMutationLeaseOptions, "now" | "processAlive" | "processImage">,
): OwnershipMutationLeaseHolder | null;

export declare function ownershipMutationLeaseStatusLine(
  statePaths: readonly string[],
  options?: Pick<OwnershipMutationLeaseOptions, "now" | "processAlive" | "processImage">,
): string | null;
