import { spawn, spawnSync, execFile, execFileSync } from "node:child_process";
import { renameSync, rmSync, unlinkSync } from "node:fs";

/**
 * One synchronous authority gate shared by Node, Bun and worker lanes. A home refusal
 * (including a throwing inspector) is permanent for this attempt. Service absence is
 * a skipped service action, not a refusal of authorized foreground runtime cleanup.
 * Package-only publication grants no runtime authority. Cleanup kinds are deliberately
 * narrow: callers must retain the exact live ChildProcess or their own pre-stop tray.
 * @param {{ check(): boolean, checkPackage(): boolean, readonly serviceAllowed: boolean }} policy
 */
export function createMutationAuthorizer(policy) {
  let refused = false;
  /** @param {"runtime" | "service" | "tray" | "shim" | "package" | "publish" | "package-publish" | "own-child" | "own-tray"} kind */
  return function authorizeMutation(kind) {
    // These complete an already authorized operation; they never discover a new target,
    // install/refresh a tray, or start/restart a runtime or a service.
    if (kind === "own-child" || kind === "own-tray") return true;
    if (refused) return false;
    try {
      const allowed = (kind === "package" || kind === "package-publish" ? policy.checkPackage() : policy.check()) === true;
      refused = !allowed;
      return allowed && (kind !== "service" || policy.serviceAllowed === true);
    } catch {
      refused = true;
      return false;
    }
  };
}

/** Copy data before the final gate. Never carry a caller's prototype, getter,
 * iterator, coercion hook or Proxy into the primitive. Functions are not data.
 * Cycles are rejected; caller prototypes are discarded rather than passed to native coercion. */
export function materializeMutationData(value, ancestors = new Set()) {
  if (value === null || ["undefined", "string", "number", "boolean", "bigint"].includes(typeof value)) return value;
  if (typeof value !== "object") throw new TypeError("Update mutation arguments must be plain data");
  if (ancestors.has(value)) throw new TypeError("Cyclic update mutation data");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = value.length, copy = [];
      for (let i = 0; i < length; i++) copy.push(materializeMutationData(value[i], ancestors));
      return copy;
    }
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) copy[key] = materializeMutationData(value[key], ancestors);
    }
    return copy;
  } finally { ancestors.delete(value); }
}

export class UpdateMutationRefusedError extends Error {
  constructor() { super("Automatic update mutation refused; check 'ocx service status'."); this.code = "EUPDATEAUTHORITY"; }
}

/** The operation slot is a trusted, thunk-free primitive adapter. It must consume
 * only its arguments, never close over unmaterialized caller data or do preparation.
 * No callback slots are supported here: helpers with synchronous callbacks must
 * guard their actual primitive after those callbacks, not wrap the orchestration. */
export function guardedRun(authorizeMutation, kind, operation, args) {
  const data = materializeMutationData(args);
  if (authorizeMutation(kind) !== true) throw new UpdateMutationRefusedError();
  return operation(...data);
}

export function guardedSpawn(authorize, kind, file, args, options) {
  return guardedRun(authorize, kind, spawn, [file, args, options]);
}
export function guardedSpawnSync(authorize, kind, file, args, options, native = spawnSync) {
  return guardedRun(authorize, kind, native, [file, args, options]);
}
// execFile's final callback is an explicitly documented native callback slot: it
// runs on later completion/error events, never synchronously in native dispatch.
export function guardedExecFile(authorize, kind, file, args, options, callback) {
  const data = materializeMutationData([file, args, options]);
  if (callback !== undefined && typeof callback !== "function") throw new TypeError("Invalid execFile callback");
  if (authorize(kind) !== true) throw new UpdateMutationRefusedError();
  return execFile(...data, callback);
}
export function guardedExecFileSync(authorize, kind, file, args, options) {
  return guardedRun(authorize, kind, execFileSync, [file, args, options]);
}
export function guardedKill(authorize, kind, pid, signal) {
  return guardedRun(authorize, kind, process.kill.bind(process), [pid, signal]);
}
export function guardedRenameSync(authorize, from, to, native = renameSync) {
  return guardedRun(authorize, "package", native, [from, to]);
}
/** Only private transaction artifacts or boot recovery's verified dead package.
 * These bounded completions do not acquire runtime/service/home authority. */
export function ownedArtifactRm(target, options, native = rmSync) {
  const data = materializeMutationData([target, options]);
  return native(...data);
}
export function ownedArtifactUnlink(target) { return unlinkSync(materializeMutationData(target)); }
export function probeProcessAlive(pid) { return process.kill(materializeMutationData(pid), 0); }
export function relayOwnSignal(signal) { return process.kill(process.pid, materializeMutationData(signal)); }
export function guardedExit(authorize, kind, code) { return guardedRun(authorize, kind, process.exit.bind(process), [code]); }

// Explicit probe/ordinary-launch adapters. These do not convey update authority;
// callers are pinned by the inventory, and cannot use them for control commands.
export { spawn as probeSpawn, spawnSync as probeSpawnSync };
