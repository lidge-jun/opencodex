import { getConfigDir } from "../config";
import { disconnectClient } from "../client/connect";
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import { assertClientLifecycleHeld, withClientLifecycle } from "../client/lifecycle-lock";
import { inspectRemoteDesktopCleanup, readDesktopDisconnectReceipt } from "../claude/desktop-remote-store";
import { removeOwnedConfigState, type ConfigRemovalResult } from "../lib/config-ownership";
import { windowsSecretAclReapPendingAtOrBelow } from "../lib/windows-secret-acl";
import { supportsDesktopPicker } from "../claude/desktop-picker-platform";
import { sharedTeardownAuthorized, type UninstallObservation } from "./uninstall-plan";
import { cleanupOwnedIntegrationsBeforeUninstall } from "./uninstall-integrations";

/** Outcome of retiring the Desktop picker profile and every picker root this install trusted. */
export interface PickerUninstallCleanup { ok: boolean; residual?: string[] }

export interface UninstallClientStateDeps {
  readConnection: typeof readClientConnectionState;
  inspectDesktop: typeof inspectRemoteDesktopCleanup;
  readReceipt: typeof readDesktopDisconnectReceipt;
  disconnect: (options?: Parameters<typeof disconnectClient>[0]) => Promise<unknown>;
  withLifecycle: typeof withClientLifecycle;
  cleanupIntegrations: typeof cleanupOwnedIntegrationsBeforeUninstall;
  remove: () => ConfigRemovalResult;
  /** True while a timed-out icacls child still owns a path at or below the config directory. */
  aclReapPending: (rootPath: string) => boolean;
  /** Release the picker profile, then untrust the current and any pending predecessor picker root. */
  removePickerArtifacts: () => Promise<PickerUninstallCleanup>;
}

/**
 * The picker root lives in the OS trust store (login keychain, CurrentUser Root on Windows), outside
 * the config directory. Deleting config first would erase ca.pem and the pending-untrust journal,
 * the only records naming which root to remove, and strand a trusted root after uninstall.
 */
async function removePickerArtifactsBeforeUninstall(): Promise<PickerUninstallCleanup> {
  if (!supportsDesktopPicker()) return { ok: true };
  const configDir = getConfigDir();
  const [{ removeDesktopPickerArtifacts }, { drainPendingPickerCaUntrust }] = await Promise.all([
    import("../claude/desktop-picker"),
    import("../claude/intercept/picker-ca-cleanup"),
  ]);
  const removed = await removeDesktopPickerArtifacts({ configDir });
  if (!removed.ok) return removed;
  return await drainPendingPickerCaUntrust(configDir) ? { ok: true } : { ok: false, residual: ["pending_trust"] };
}

const defaults: UninstallClientStateDeps = {
  readConnection: readClientConnectionState,
  inspectDesktop: inspectRemoteDesktopCleanup,
  readReceipt: readDesktopDisconnectReceipt,
  disconnect: options => disconnectClient(options),
  withLifecycle: withClientLifecycle,
  cleanupIntegrations: cleanupOwnedIntegrationsBeforeUninstall,
  remove: () => removeOwnedConfigState(getConfigDir()),
  aclReapPending: rootPath => windowsSecretAclReapPendingAtOrBelow(rootPath),
  removePickerArtifacts: removePickerArtifactsBeforeUninstall,
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

  // Picker cleanup takes L itself, so it runs before the final lock. A residual keeps every
  // record the retry needs: the config directory still names the root to untrust.
  const picker = await deps.removePickerArtifacts();
  if (!picker.ok) {
    throw new Error(`Client cleanup refused: Claude Desktop picker cleanup left ${picker.residual?.join(", ") || "state"} behind; `
      + "approve the certificate removal prompt or run 'ocx claude desktop picker off', then rerun 'ocx uninstall'.");
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
    // The async ACL belt releases its caller on a stalled `icacls.exe`, which is what keeps
    // startup and shutdown bounded. It is not evidence that the child released the directory,
    // and on Windows a live handle makes this removal fail partway instead of cleanly. Refuse
    // promptly and let the operator retry: waiting here would hand a stuck child the power to
    // hang `ocx uninstall`, which is the bound the belt exists to preserve.
    if (deps.aclReapPending(getConfigDir())) {
      throw new Error("Client cleanup refused: ACL hardening still owns a path under the config directory.");
    }
    // Integration records are the authority that permits removing only OpenCodex-owned fragments
    // from third-party files. Delete them only after every recorded contribution is retired.
    await deps.cleanupIntegrations();
    return deps.remove();
  });
}
