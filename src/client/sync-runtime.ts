/** Cross-process admission for Link sync while its local runtime shuts down. */
import { lstatSync } from "node:fs";
import { ConfigMutationLockError, withConfigMutationLockSync } from "../config";
import { getRuntimePortPath, isValidRuntimePortState, writeRuntimePort, type RuntimePortState } from "../config/process-state";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";

export class ClientSyncRuntimeError extends Error {
  constructor(readonly code: "client_runtime_stopping" | "client_runtime_changed" | "client_runtime_unverified") {
    super(`${code}: retry sync after the Child has started; ocx start/stop can reconcile a stale runtime record`);
  }
}

function readSyncRuntime(): RuntimePortState | null {
  const path = getRuntimePortPath();
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ClientSyncRuntimeError("client_runtime_unverified");
  }
  try {
    const value: unknown = JSON.parse(readBoundedRegularFileSync(path, 16 * 1024).toString("utf8"));
    if (!isValidRuntimePortState(value)) throw new Error("invalid runtime record");
    return value;
  } catch { throw new ClientSyncRuntimeError("client_runtime_unverified"); }
}

/** Capture and recheck under C. Proven no-runtime sync keeps its existing offline behavior. */
export function clientSyncRuntimeGuard(): () => void {
  const expected = readSyncRuntime();
  if (expected?.clientStopping) throw new ClientSyncRuntimeError("client_runtime_stopping");
  return () => {
    const current = readSyncRuntime();
    if (current?.clientStopping) throw new ClientSyncRuntimeError("client_runtime_stopping");
    if (!Bun.deepEquals(current, expected, true)) throw new ClientSyncRuntimeError("client_runtime_changed");
  };
}

/** The same C transaction excludes every sync commit; never mark a replacement runtime. */
export function markClientRuntimeStopping(expected: Required<Pick<RuntimePortState, "pid" | "port" | "attestationSecret">>): void {
  withConfigMutationLockSync(() => {
    const current = readSyncRuntime();
    if (!current || current.pid !== expected.pid || current.port !== expected.port
      || current.attestationSecret !== expected.attestationSecret) {
      throw new ClientSyncRuntimeError("client_runtime_changed");
    }
    if (!current.clientStopping) writeRuntimePort({ ...current, clientStopping: true });
  });
}

/** Yield only for proved SQLite contention; storage/identity failures remain immediate refusals. */
export async function markClientRuntimeStoppingWithRetry(
  expected: Required<Pick<RuntimePortState, "pid" | "port" | "attestationSecret">>,
  deps: { mark?: () => void; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { (deps.mark ?? (() => markClientRuntimeStopping(expected)))(); return true; }
    catch (error) {
      const cause = error instanceof ConfigMutationLockError ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if ((code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") || attempt === 19) return false;
      await (deps.sleep ?? Bun.sleep)(50);
    }
  }
  return false;
}
