import { withConfigMutationLockSync } from "../config";
import { assertNoClientDisconnectPending, pendingClientConnectMayOwnToken, readClientConnectionState } from "./state";
import type { OcxClientConnectionConfig } from "../types";

export type RestoreBoundaryOwnership = "restore" | "hub-owned" | "unproven";
export type RestoreOwnershipRefusal = Exclude<RestoreBoundaryOwnership, "restore">;

export class StopRestoreOwnershipError extends Error {
  constructor(readonly boundary: RestoreOwnershipRefusal) {
    super(`stop_restore_${boundary}`);
  }
}

/** Read only; the caller must exclude connection publication with L or C. */
export function inspectStopRestoreOwnership(read = readClientConnectionState): RestoreBoundaryOwnership {
  try {
    if (pendingClientConnectMayOwnToken()) return "unproven";
    assertNoClientDisconnectPending();
    const state = read();
    if (state.kind === "invalid" || state.kind === "mismatched") return "unproven";
    return state.kind === "connected" && state.value.transport !== "link" ? "hub-owned" : "restore";
  } catch { return "unproven"; }
}

function restoreConnectionSnapshot(connection: OcxClientConnectionConfig) {
  // Normal sync changes these observations, not restoration ownership. All other
  // fields, including priorCatalog and future connection fields, remain guarded.
  const { catalogFingerprint: _fingerprint, catalogSyncedAt: _syncedAt, ...snapshot } = connection;
  return snapshot;
}

/** C is reentrant inside N/C; this never acquires L or N. No lease crosses an await. */
export function stopRestoreWriteGuard(expectedConnection?: OcxClientConnectionConfig) {
  const expected = expectedConnection && restoreConnectionSnapshot(structuredClone(expectedConnection));
  let boundary: RestoreBoundaryOwnership = "restore";
  return {
    boundary: () => boundary,
    run<T>(write: () => T): T {
      let entered = false;
      try {
        return withConfigMutationLockSync(() => {
          entered = true;
          if (boundary === "restore") boundary = inspectStopRestoreOwnership();
          if (boundary === "restore" && expected) {
            try {
              if (expected.pendingOperation) throw new Error("client_rotation_pending");
              const current = readClientConnectionState();
              if (current.kind !== "connected" || !Bun.deepEquals(restoreConnectionSnapshot(current.value), expected, true)) {
                throw new Error("client_connection_changed");
              }
            } catch { boundary = "unproven"; }
          }
          if (boundary !== "restore") throw new StopRestoreOwnershipError(boundary);
          return write();
        });
      } catch (error) {
        if (!entered) boundary = "unproven";
        else if (error instanceof StopRestoreOwnershipError) boundary = error.boundary;
        throw error;
      }
    },
  };
}
