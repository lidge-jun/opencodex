export type UpdateServiceHomeAuthority = {
  readonly kind: "same" | "foreign" | "unknown" | "absent";
  readonly subject?: string;
};
export interface UpdateServiceHomePolicy {
  readonly initial: UpdateServiceHomeAuthority;
  readonly serviceAllowed: boolean;
  readonly packageOnly: boolean;
  checkPackage(home?: UpdateServiceHomeAuthority): boolean;
  check(home?: UpdateServiceHomeAuthority): boolean;
}
export declare const UPDATE_HOME_SCHEMA_VERSION: 1;
export declare const UPDATE_HOME_LAUNCHER_PROTOCOL: 1;
export declare const UPDATE_PACKAGE_ONLY_EXIT_CODE: 75;
export declare function isUpdateHomeProbe(args: string[]): boolean;
export declare function parseUpdateHomeProbe(value: unknown, options?: { requireLauncher?: boolean }): UpdateServiceHomeAuthority;
export declare function createUpdateServiceHomePolicy(inspect: () => UpdateServiceHomeAuthority,
  refuse: (message: string) => void, packageOnly?: boolean): UpdateServiceHomePolicy;
export declare function updateServiceHomeRefusal(authority: UpdateServiceHomeAuthority): string | null;
