import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { verifyWindowsPrivateEntriesAsync } from "../../src/lib/windows-owner-acl";

/** The session creates a canonical private child anywhere below OS temp, not
 * directly below a drive root. Keep the lexical contract portable for tests.
 */
export function actualApplyRetentionRootWithinTemp(root: unknown, temporaryRoot: string): root is string {
  if (typeof root !== "string" || !/^[A-Za-z]:\\/.test(root) || !/^[A-Za-z]:\\/.test(temporaryRoot) || root.endsWith("\\")
    || win32.normalize(root) !== root || win32.normalize(temporaryRoot) !== temporaryRoot
    || !/^ocx-actual-apply-[A-Za-z0-9_-]+$/.test(win32.basename(root))) return false;
  const within = win32.relative(temporaryRoot, root);
  return !!within && within !== ".." && !within.startsWith("..\\") && !win32.isAbsolute(within);
}

const dosPath = (path: string) => path.startsWith("\\\\?\\") ? path.slice(4) : path;

/** Read-only admission: no alias, reparse leaf, outside-temp path or broad root
 * ACL is repaired into eligibility. The session must harden its own root first.
 */
export async function verifyActualApplyRetentionRoot(root: unknown): Promise<string> {
  const temporaryRoot = dosPath(realpathSync.native(tmpdir()));
  if (!actualApplyRetentionRootWithinTemp(root, temporaryRoot)
    || dosPath(realpathSync.native(root)) !== root) throw new Error("PRIVATE_TEMP_FIXTURE_REQUIRED");
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || !await verifyWindowsPrivateEntriesAsync([{ path: win32.toNamespacedPath(root), directory: true }], 5000)) {
    throw new Error("PRIVATE_TEMP_FIXTURE_REQUIRED");
  }
  return root;
}
