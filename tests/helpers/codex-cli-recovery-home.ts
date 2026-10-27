import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Recovery publication uses the updater's canonical mutation-path contract. */
export function createCodexCliRecoveryTestHome(): string {
  // macOS TMPDIR commonly begins with /var, an alias of /private/var.
  return realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-recovery-home-")));
}
