export interface OwnershipMutationLeaseOptions {
  readonly waitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => void;
  readonly processAlive?: (pid: number) => boolean;
  readonly beforeRelease?: (lockPath: string) => void;
  readonly joinToken?: string;
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
