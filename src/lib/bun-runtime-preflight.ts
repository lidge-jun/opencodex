import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import type { DurableBunRuntime } from "./bun-runtime";

export type RuntimePreflightReason = "spawn" | "timeout" | "create" | "remove" | "protocol";
export const RUNTIME_PREFLIGHT_TIMEOUT_MS = 5_000;
export const RUNTIME_PREFLIGHT_GUIDANCE = "The selected Bun runtime could not create and remove a directory in the OpenCodex config directory. "
  + "Windows application policy may deny writes from this executable location. "
  + "Set OPENCODEX_BUN_PATH to a trusted Bun executable allowed by your policy before launching ocx, "
  + "or reinstall opencodex with npm install -g opencodex, then retry. No alternate runtime was selected.";

export class RuntimePreflightError extends Error {
  readonly code = "OCX_RUNTIME_PREFLIGHT_FAILED";
  constructor(readonly reason: RuntimePreflightReason) {
    super(`${RUNTIME_PREFLIGHT_GUIDANCE} (preflight: ${reason})`);
    this.name = "RuntimePreflightError";
  }
}

type DirectoryIdentity = { dev: number; ino: number; isDirectory(): boolean; isSymbolicLink(): boolean };
export interface RuntimePreflightFs {
  lstatSync: (path: string) => DirectoryIdentity;
  mkdirSync: (path: string, mode: number) => unknown;
  rmdirSync: (path: string) => void;
  readdirSync: (path: string) => readonly string[];
}
export interface RuntimePreflightOptions {
  platform?: NodeJS.Platform;
  rootWasAbsent?: boolean;
  spawnSync?: typeof spawnSync;
  fs?: RuntimePreflightFs;
  nonce?: () => string;
}
/** Caller seams keep one selection through admission, rendering and state publication. */
export interface RuntimePreflightDeps {
  selectRuntime?: () => DurableBunRuntime;
  assertRuntimeWritable?: typeof assertSelectedRuntimeWritable;
  configDir?: () => string;
  platform?: NodeJS.Platform;
}

const probeFs: RuntimePreflightFs = { lstatSync, mkdirSync, rmdirSync, readdirSync };

function sameDirectory(fs: RuntimePreflightFs, path: string, owned: DirectoryIdentity): boolean {
  const current = fs.lstatSync(path);
  return current.isDirectory() && !current.isSymbolicLink()
    && current.dev === owned.dev && current.ino === owned.ino;
}

function removeOwnedEmptyDirectory(fs: RuntimePreflightFs, path: string, owned: DirectoryIdentity): void {
  try {
    if (sameDirectory(fs, path, owned) && fs.readdirSync(path).length === 0
      && sameDirectory(fs, path, owned)) fs.rmdirSync(path);
  } catch { /* Never delete contents or a replacement; cleanup does not mask refusal. */ }
}

function prepareRoot(fs: RuntimePreflightFs, root: string, rootWasAbsent?: boolean): void {
  try {
    if (rootWasAbsent === undefined) {
      try { fs.lstatSync(root); rootWasAbsent = false; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        rootWasAbsent = true;
      }
    }
    if (rootWasAbsent) {
      try {
        fs.mkdirSync(root, 0o700); // Exclusive, non-recursive: a missing parent refuses.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Use a concurrently created root, subject to the directory check below.
      }
    }
    const current = fs.lstatSync(root);
    if (!current.isDirectory() || current.isSymbolicLink()) throw new RuntimePreflightError("create");
  } catch {
    throw new RuntimePreflightError("create");
  }
}

function probeInProcess(fs: RuntimePreflightFs, path: string): void {
  let owned: DirectoryIdentity | undefined;
  try {
    try { fs.mkdirSync(path, 0o700); owned = fs.lstatSync(path); }
    catch { throw new RuntimePreflightError("create"); }
    try { fs.rmdirSync(path); }
    catch { throw new RuntimePreflightError("remove"); }
  } finally {
    if (owned) removeOwnedEmptyDirectory(fs, path, owned);
  }
}

function probeChild(runtime: DurableBunRuntime, path: string, nonce: string, spawn: typeof spawnSync): void {
  // The child emits only this invocation's nonce and a fixed result, never paths/errors.
  const script = `const fs = require("node:fs"); const path = ${JSON.stringify(path)};
let result = "create", owned;
try { fs.mkdirSync(path, 0o700); owned = fs.lstatSync(path); result = "remove";
  fs.rmdirSync(path); result = "ok";
} catch { /* result already names the failed step; details never leave the child */ } finally {
  if (owned) { try { const now = fs.lstatSync(path);
    if (now.isDirectory() && !now.isSymbolicLink() && now.dev === owned.dev && now.ino === owned.ino
      && fs.readdirSync(path).length === 0) fs.rmdirSync(path);
  } catch { /* leave any probe entry that cannot be proven ours */ } }
}
process.stdout.write(${JSON.stringify(nonce)} + ":" + result);
process.exitCode = result === "ok" ? 0 : 1;`;
  let child: ReturnType<typeof spawnSync>;
  try {
    child = spawn(runtime.path, ["-e", script], {
      shell: false, windowsHide: true, timeout: RUNTIME_PREFLIGHT_TIMEOUT_MS,
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024,
    });
  } catch { throw new RuntimePreflightError("spawn"); }
  if (child.error) {
    throw new RuntimePreflightError((child.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "spawn");
  }
  const ack = String(child.stdout ?? "");
  if (ack === `${nonce}:create` && child.status === 1) throw new RuntimePreflightError("create");
  if (ack === `${nonce}:remove` && child.status === 1) throw new RuntimePreflightError("remove");
  if (ack !== `${nonce}:ok` || child.status !== 0) throw new RuntimePreflightError("protocol");
}

/** Windows admission of ONLY the already selected runtime. No discovery or memoization. */
export function assertSelectedRuntimeWritable(
  runtime: DurableBunRuntime,
  configDir: string,
  deps: RuntimePreflightOptions = {},
): void {
  if ((deps.platform ?? process.platform) !== "win32") return;
  if (runtime.source === "standalone" && runtime.path !== process.execPath) throw new RuntimePreflightError("protocol");
  const fs = deps.fs ?? probeFs;
  // The config root is durable: never delete it by pathname, even on refusal.
  prepareRoot(fs, configDir, deps.rootWasAbsent);
  const nonce = (deps.nonce ?? randomUUID)();
  const path = join(configDir, `.ocx-runtime-probe-${nonce}`);
  if (runtime.source === "standalone") probeInProcess(fs, path);
  else probeChild(runtime, path, nonce, deps.spawnSync ?? spawnSync);
}
