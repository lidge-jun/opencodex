import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  if (pendingPickerCaHasLivePublishedOwner(configDir, pending)) return false;

  const privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-untrust-"));
  try {
    const publicCopy = join(privateDir, "ca.pem");
    writeFileSync(publicCopy, pending.certPem, { mode: 0o600 });
    const result = await untrustPickerCa(publicCopy, pending.sha1, security, platform);
    if (!result.ok) return false;
    return acknowledgePendingPickerCaUntrust(configDir, pending, result);
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
}
