import type { UpdateServiceHomeAuthority } from "./service-home-policy.mjs";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
export declare const UPDATE_HOME_PROBE_ARGS: string[];
export declare function supportsUpdateHomeProbe(launcher: string, read?: (path: string) => string): boolean;
export declare function updateHomeProbeEnvironment(env: Record<string, string | undefined>,
  homes: { codexHome: string; opencodexHome: string }): Record<string, string | undefined>;
export declare function probeUpdateLauncherHome(launcher: string, run: Parameters<typeof probeUpdateServiceHome>[0],
  node: string, env: Record<string, string | undefined>, read?: (path: string) => string): UpdateServiceHomeAuthority;
export declare function probeUpdateServiceHome(
  run: (bin: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout?: unknown; error?: unknown; signal?: unknown },
  bin: string, prefix: string[], options?: { requireLauncher?: boolean; env?: Record<string, string | undefined> },
): UpdateServiceHomeAuthority;

export declare function probeUpdatePackageOnlyLauncher(launcher: string, run: Parameters<typeof probeUpdateServiceHome>[0],
  node: string, env: Record<string, string | undefined>, read?: (path: string) => string): boolean;
