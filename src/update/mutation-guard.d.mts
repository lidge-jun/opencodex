export type UpdateMutationKind = "runtime" | "service" | "tray" | "shim" | "package" | "publish" | "package-publish" | "own-child" | "own-tray";
export type UpdateMutationAuthorizer = (kind: UpdateMutationKind) => boolean;
export declare function createMutationAuthorizer(policy: {
  check(): boolean; checkPackage(): boolean; readonly serviceAllowed: boolean;
}): UpdateMutationAuthorizer;
export declare function materializeMutationData<T>(value: T): T;
export declare class UpdateMutationRefusedError extends Error { code: "EUPDATEAUTHORITY"; }
export declare function guardedRun<K extends UpdateMutationKind, A extends any[], R>(authorize: (kind: K) => boolean, kind: K,
  operation: (...args: A) => R, args: A): R;
export declare const guardedSpawn: (authorize: UpdateMutationAuthorizer, kind: UpdateMutationKind,
  ...args: Parameters<typeof import("node:child_process").spawn>) => import("node:child_process").ChildProcess;
export declare function guardedSpawnSync<K extends UpdateMutationKind>(authorize: (kind: K) => boolean, kind: K,
  file: string, args: readonly string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding,
  native?: typeof import("node:child_process").spawnSync): import("node:child_process").SpawnSyncReturns<string>;
export declare function guardedSpawnSync<K extends UpdateMutationKind>(authorize: (kind: K) => boolean, kind: K,
  file: string, args: readonly string[], options?: import("node:child_process").SpawnSyncOptions,
  native?: typeof import("node:child_process").spawnSync): import("node:child_process").SpawnSyncReturns<Buffer>;
export declare const guardedExecFile: (authorize: UpdateMutationAuthorizer, kind: UpdateMutationKind,
  file: string, args: readonly string[], options: import("node:child_process").ExecFileOptions,
  callback?: (...args: any[]) => void) => import("node:child_process").ChildProcess;
export declare const guardedExecFileSync: <K extends UpdateMutationKind>(authorize: (kind: K) => boolean, kind: K,
  ...args: Parameters<typeof import("node:child_process").execFileSync>) => string | Buffer;
export declare function guardedKill<K extends UpdateMutationKind>(authorize: (kind: K) => boolean, kind: K, pid: number, signal?: NodeJS.Signals | number): boolean;
export declare function guardedRenameSync(authorize: (kind: "package") => boolean, from: string, to: string, native?: typeof import("node:fs").renameSync): void;
export declare function ownedArtifactRm(target: string, options: import("node:fs").RmOptions, native?: typeof import("node:fs").rmSync): void;
export declare function ownedArtifactUnlink(target: string): void;
export declare function probeProcessAlive(pid: number): true;
export declare function relayOwnSignal(signal: NodeJS.Signals): true;
export declare function guardedExit(authorize: UpdateMutationAuthorizer, kind: "publish" | "package-publish", code: number): never;
export { spawn as probeSpawn, spawnSync as probeSpawnSync } from "node:child_process";
