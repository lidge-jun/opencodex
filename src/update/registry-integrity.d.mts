export interface RegistryCommandResult {
  status: number | null;
  stdout?: string | Uint8Array | null;
  stderr?: string | Uint8Array | null;
}

export type RegistryIntegrityResult =
  | { ok: true; integrity: string }
  | { ok: false; reason: string }
  | { ok: "skipped"; reason: string };

export declare function checkRegistryPackageIntegrity(
  packageName: string,
  version: string | null | undefined,
  run: (args: readonly string[], capture?: boolean) => RegistryCommandResult,
): RegistryIntegrityResult;
