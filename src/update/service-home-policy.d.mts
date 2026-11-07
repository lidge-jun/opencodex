export type UpdateServiceHomeAuthority = {
  readonly kind: "same" | "foreign" | "unknown" | "absent" | "invalid";
  readonly subject?: string;
};
export interface UpdateServiceHomePolicy {
  authorizeMutation: import("./mutation-guard.mjs").UpdateMutationAuthorizer;
  readonly initial: UpdateServiceHomeAuthority;
  readonly serviceAllowed: boolean;
  readonly packageOnly: boolean;
  checkPackage(home?: UpdateServiceHomeAuthority): boolean;
  check(home?: UpdateServiceHomeAuthority): boolean;
}
export declare const UPDATE_HOME_SCHEMA_VERSION: 1;
export declare const UPDATE_HOME_LAUNCHER_PROTOCOL: 1;
export declare const UPDATE_PACKAGE_ONLY_EXIT_CODE: 75;
export declare const UPDATE_PACKAGE_ONLY_PROTOCOL_VERSION: 2;
export declare const UPDATE_WORKER_HOME_FLAG: "--update-worker-home";
export declare function updateWorkerHomeArgv(home: UpdateServiceHomeAuthority | undefined): string | null;
export declare function parseUpdateWorkerHome(argv: readonly string[]): UpdateServiceHomeAuthority | undefined;
export declare function isUpdateHomeProbe(args: string[]): boolean;
export declare function parseUpdateHomeProbe(value: unknown, options?: { requireLauncher?: boolean }): UpdateServiceHomeAuthority;
export declare function createUpdateServiceHomePolicy(inspect: () => UpdateServiceHomeAuthority,
  refuse: (message: string) => void, packageOnly?: boolean,
  delegatedBaseline?: UpdateServiceHomeAuthority): UpdateServiceHomePolicy;
export declare function updateServiceHomeRefusal(authority: UpdateServiceHomeAuthority): string | null;
