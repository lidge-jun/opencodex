import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withConfigDirHardeningSettled } from "../../config/paths";
import {
  acknowledgePendingPickerCaUntrust,
  pendingPickerCaHasLivePublishedOwner,
  readPendingPickerCaUntrust,
} from "./picker-ca";
import { untrustPickerCa, type SecurityRunner } from "./picker-trust";

/** Drain exactly the recorded public predecessor; keep its journal on any uncertainty. */
export async function drainPendingPickerCaUntrust(
  configDir: string,
  security?: SecurityRunner,
  platform?: NodeJS.Platform,
): Promise<boolean> {
  const pending = readPendingPickerCaUntrust(configDir);
  if (!pending) return true;
  if (await withConfigDirHardeningSettled(configDir, () => pendingPickerCaHasLivePublishedOwner(configDir, pending))) return false;

  const privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-untrust-"));
  try {
    const publicCopy = join(privateDir, "ca.pem");
    writeFileSync(publicCopy, pending.certPem, { mode: 0o600 });
    const result = await untrustPickerCa(publicCopy, pending.sha1, security, platform);
    if (!result.ok) return false;
    // OS untrust yielded: a new parent flight may have started since the owner inspection.
    return await withConfigDirHardeningSettled(configDir, () => acknowledgePendingPickerCaUntrust(configDir, pending, result));
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
}
