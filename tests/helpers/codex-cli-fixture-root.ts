import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

// Capture the native host before POSIX policy models override process.platform.
const nativeWindows = process.platform === "win32";

/** Canonical fixture ancestry for the updater's fail-closed mutation checks.
 * OS temp may use /var, an NTFS short name, or a junction. Resolve it before
 * creation and resolve the new directory too; deliberate aliases belong below it.
 */
export function createCodexCliTestRoot(prefix: string, temporaryRoot = tmpdir()): string {
  const parent = join(realpathSync.native(temporaryRoot), prefix);
  const created = mkdtempSync(nativeWindows ? win32.toNamespacedPath(parent) : parent);
  const canonical = realpathSync.native(created);
  if (nativeWindows && canonical.startsWith("\\\\?\\UNC\\")) return "\\\\" + canonical.slice(8);
  return nativeWindows && canonical.startsWith("\\\\?\\") ? canonical.slice(4) : canonical;
}
