/** Stop only the file routes this Link created; connection and recovery records remain. */
import { loadConfig } from "../config";
import { getConfigDir, withConfigDirHardeningSettled } from "../config/paths";
import { cleanupConnectedFileRouteIntent } from "../integrations/route-intent-disconnect";
import { readRouteIntentReceiptStrict } from "../integrations/route-intent-state";
import { readServiceApiTokenState } from "../lib/service-secrets";
import type { OcxClientConnectionConfig } from "../types";
import { clearHomeRouteIntentRecord } from "./link-home";
import { withClientLifecycleSync, type ClientLifecycleLockDeps } from "./lifecycle-lock";
import { stopRestoreWriteGuard } from "./restore-ownership";

export async function restoreLinkFileRouting(
  connection: OcxClientConnectionConfig,
  options: { beforeWrite?: () => void; lifecycleLockDeps?: ClientLifecycleLockDeps } = {},
): Promise<boolean> {
  if (connection.transport !== "link" || !connection.link) return false;
  const expected = structuredClone(connection);
  const ownership = stopRestoreWriteGuard(expected);
  const port = loadConfig().port;
  const guard = () => ownership.run(() => {
    options.beforeWrite?.();
    if (loadConfig().port !== port) throw new Error("client_route_port_changed");
    const token = readServiceApiTokenState();
    if (token.kind !== "present" || token.fingerprint !== expected.tokenFingerprint) throw new Error("client_token_changed");
  });
  return withConfigDirHardeningSettled(getConfigDir(), async () => {
    withClientLifecycleSync(() => {
      guard();
      const receipt = readRouteIntentReceiptStrict();
      if (receipt?.linkId !== undefined) {
        if (receipt.linkId !== expected.link!.linkId) throw new Error("client_route_owner_changed");
        // A partial stop must not leave the Home's previous successful apply proof current.
        clearHomeRouteIntentRecord();
      }
    }, options.lifecycleLockDeps);
    const restored = await cleanupConnectedFileRouteIntent(expected, guard, options.lifecycleLockDeps);
    guard();
    return restored;
  });
}
