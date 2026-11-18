import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConfigDirHardeningSettled } from "../../config/paths";
import {
  acknowledgePendingPickerCaUntrust,
  bindPendingPickerCaLinuxStore,
  pendingPickerCaHasLivePublishedOwner,
  readPendingPickerCaUntrust,
} from "./picker-ca";
import { untrustPickerCa, type SecurityRunner } from "./picker-trust";

/** Drain exactly the recorded public predecessor; keep its journal on any uncertainty. */
export async function drainPendingPickerCaUntrust(
  configDir: string,
  security?: SecurityRunner,
  platform: NodeJS.Platform = process.platform,
  linuxHome?: string,
): Promise<boolean> {
  const pending = readPendingPickerCaUntrust(configDir, platform);
  if (!pending) return true;
  if (pending.linuxStore && platform !== "linux") return false;
  if (await withConfigDirHardeningSettled(configDir, () => pendingPickerCaHasLivePublishedOwner(configDir, pending, platform))) return false;

  const privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-untrust-"));
  try {
    const publicCopy = join(privateDir, "ca.pem");
    writeFileSync(publicCopy, pending.certPem, { mode: 0o600 });
    let pendingToAcknowledge = pending;
    const result = await untrustPickerCa(publicCopy, pending.sha1, security, platform, linuxHome,
      { store: pending.linuxStore, bindStore: store => {
        pendingToAcknowledge = bindPendingPickerCaLinuxStore(configDir, pending, store);
      } });
    if (result.reason === "original_store_unknown") {
      console.warn("Claude Desktop picker CA cleanup is still pending: the original NSS database is unknown. "
        + "Retry with the XDG_DATA_HOME used when the certificate was installed.");
    }
    if (!result.ok) return false;
    // OS untrust yielded: a new parent flight may have started since the owner inspection.
    return await withConfigDirHardeningSettled(configDir, () =>
      acknowledgePendingPickerCaUntrust(configDir, pendingToAcknowledge, result, platform));
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
}
