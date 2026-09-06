import { getConfigDir } from "../config";
import { disconnectClient } from "../client/connect";
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import { assertClientLifecycleHeld, withClientLifecycle } from "../client/lifecycle-lock";
import { inspectRemoteDesktopCleanup, readDesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { removeOwnedConfigState, type ConfigRemovalResult } from "../lib/config-ownership";
import { sharedTeardownAuthorized, type UninstallObservation } from "./uninstall-plan";

export interface UninstallClientStateDeps {
  readConnection: typeof readClientConnectionState;
  inspectDesktop: typeof inspectRemoteDesktopCleanup;
  readReceipt: typeof readDesktopDisconnectReceipt;
  disconnect: (options?: Parameters<typeof disconnectClient>[0]) => Promise<unknown>;
  withLifecycle: typeof withClientLifecycle;
  remove: () => ConfigRemovalResult;
}

const defaults: UninstallClientStateDeps = {
  readConnection: readClientConnectionState,
  inspectDesktop: inspectRemoteDesktopCleanup,
  readReceipt: readDesktopDisconnectReceipt,
  disconnect: options => disconnectClient(options),
  withLifecycle: withClientLifecycle,
  remove: () => removeOwnedConfigState(getConfigDir()),
};

/** Restore connection-owned client artifacts before removing their ownership/recovery records. */
export async function removeOwnedConfigAfterDesktopCleanup(
  observed: UninstallObservation,
  deps: UninstallClientStateDeps = defaults,
): Promise<ConfigRemovalResult> {
  if (!sharedTeardownAuthorized(observed)) {
    throw new Error("Client cleanup refused: service or proxy teardown is not proven.");
  }
  const state = deps.readConnection();
  if (state.kind !== "connected" && state.kind !== "disconnected") {
    throw new Error("Client cleanup refused: connection state is invalid or mismatched.");
  }
  const desktop = deps.inspectDesktop();
  const receipt = deps.readReceipt();
  if (desktop.kind === "unsafe" || receipt.kind === "unsafe") {
    throw new Error("Client cleanup refused: Desktop recovery state is unsafe.");
  }
  const interrupted = receipt.kind === "valid" && receipt.value.phase !== "complete" ? receipt.value : undefined;
  if ((state.kind === "connected" && desktop.kind !== "absent" && !sameClientConnectionOwner(state.value, desktop.owner))
    || (interrupted && state.kind === "connected" && !sameClientConnectionOwner(state.value, interrupted.owner))
    || (interrupted && desktop.kind !== "absent" && !sameClientConnectionOwner(desktop.owner, interrupted.owner))) {
    throw new Error("Client cleanup refused: Desktop recovery ownership is mismatched.");
  }
  if (state.kind === "connected" || interrupted) {
    // Disconnect owns its N/L/C ordering. Do not hold L across this call, and
    // preserve the frozen catalog choice when resuming an interrupted operation.
    await deps.disconnect({
      expectedOwner: state.kind === "connected" ? {
        serverUrl: state.value.serverUrl, apiKeyId: state.value.apiKeyId, connectedAt: state.value.connectedAt,
      } : interrupted!.owner,
      ...(interrupted ? { keepCatalog: interrupted.keepCatalog } : {}),
    });
  } else if (desktop.kind !== "absent") {
    throw new Error("Client cleanup refused: finish Desktop recovery before uninstalling.");
  }

  // A connection can appear while asynchronous cleanup is finishing. The final
  // inspection and actual remover share L, but never hold C while deleting its DB.
  return deps.withLifecycle(async held => {
    assertClientLifecycleHeld(held);
    const latest = deps.readConnection();
    const latestDesktop = deps.inspectDesktop();
    const latestReceipt = deps.readReceipt();
    if (latest.kind !== "disconnected"
      || latestDesktop.kind !== "absent"
      || latestReceipt.kind === "unsafe"
      || (latestReceipt.kind === "valid" && latestReceipt.value.phase !== "complete")) {
      throw new Error("Client cleanup refused: connection or Desktop state changed before removal.");
    }
    return deps.remove();
  });
}
