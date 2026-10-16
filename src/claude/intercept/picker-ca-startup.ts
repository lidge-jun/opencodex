import { ensurePickerCa, type PickerCa } from "./picker-ca";
import { drainPendingPickerCaUntrust } from "./picker-ca-cleanup";
import type { PickerCaStore } from "./picker-ca-store";
import type { SecurityRunner } from "./picker-trust";
import { supportsDesktopPicker } from "../desktop-picker-platform";

/** Internal activation seam: finish legacy cleanup before a persistent issuer is usable. */
export async function preparePersistentPickerAuthority(options: {
  configDir: string; store?: PickerCaStore; security?: SecurityRunner; platform: NodeJS.Platform;
}): Promise<PickerCa> {
  if (!supportsDesktopPicker(options.platform)) throw new Error("picker_ca_unsupported_platform");
  const drain = () => drainPendingPickerCaUntrust(options.configDir, options.security, options.platform);
  if (!await drain()) throw new Error("picker_ca_pending_untrust");
  const ca = ensurePickerCa(options.configDir, { rotation: "startup", persistent: true, store: options.store });
  if (!await drain()) throw new Error("picker_ca_pending_untrust");
  return ca;
}
