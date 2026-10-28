import { lstatSync, readdirSync } from "node:fs";
import { win32 } from "node:path";
import { inspectWindowsInstallationFiles } from "./windows-installation-files";
import { verifyWindowsEntriesAclAsync, type WindowsAclEntry } from "../lib/windows-owner-acl";
import { MAX_CODEX_MEMBER_BYTES, MAX_CODEX_UNPACKED_BYTES } from "./cli-update-artifacts";
import { windowsArchivePathValidator } from "./cli-update-windows-paths";
import type { WindowsCodexExpectedFile } from "./cli-update-windows-layout";

export interface WindowsInstallSnapshot {
  readonly files: readonly (WindowsCodexExpectedFile & { readonly identity: string })[];
  readonly directories: readonly string[];
  readonly absent: readonly string[];
}
const roots = ["codex", "codex.cmd", "codex.ps1", "node_modules/@openai/codex",
  "node_modules/@openai/codex-win32-x64", "node_modules/.package-lock.json"];
const key = (path: string) => path.replaceAll("\\", "/");
export const windowsCodexOwnedPath = (relative: string): boolean => roots.slice(0, -1).some(root =>
  relative === root || relative.startsWith(root + "/"));

/** Bound the existing shared prefix, never follow links outside it. Only our separately
 * pinned mutex is excluded. Unrelated packages and shims are preservation obligations,
 * not installer targets. Oversized or unsupported namespaces refuse before npm starts.
 */
function inventory(prefix: string) {
  const paths: string[] = [], directories: string[] = [], acl: WindowsAclEntry[] = [];
  const validate = windowsArchivePathValidator();
  let entries = 0, total = 0;
  const walk = (relative: string) => {
    if (++entries > 4096) throw new Error("installation_readback_limit");
    const path = win32.join(prefix, relative), st = lstatSync(path);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (!st.isDirectory() && st.nlink !== 1)) {
      throw new Error("installation_path_unverified");
    }
    validate(relative, st.isDirectory());
    // Descriptor readers need extended-length targets; inventory/native identity
    // paths retain their canonical DOS spelling.
    acl.push({ path: win32.toNamespacedPath(path), directory: st.isDirectory(), policy: "write-private" });
    if (st.isDirectory()) {
      directories.push(`${relative}:${st.dev}:${st.ino}`);
      for (const name of readdirSync(path).sort()) walk(`${relative}/${name}`);
    } else {
      total += st.size;
      if (st.size > MAX_CODEX_MEMBER_BYTES || total > MAX_CODEX_UNPACKED_BYTES) throw new Error("installation_readback_limit");
      paths.push(relative);
    }
  };
  for (const relative of readdirSync(prefix).sort()) if (relative !== ".ocx-codex-cli-apply.lock") walk(relative);
  const absent = roots.filter(root => !paths.includes(root) && !directories.some(dir => dir.startsWith(root + ":")));
  return { paths, directories, acl, absent };
}
export function windowsInstallNamespaceSupported(prefix: string): boolean {
  try { inventory(prefix); return true; } catch { return false; }
}

/** Full bounded observation of both old/new package lanes, three shims and npm hidden lock.
 * Includes absence and empty directories. A positive match cannot be made by reading only
 * expected filenames. No POSIX executable-bit guesses substitute for Windows identity/ACL.
 */
export async function observeWindowsInstall(prefix: string): Promise<WindowsInstallSnapshot> {
  const { paths, directories, absent, acl } = inventory(prefix);
  // Existing ancestors are guarded by the authority; each observed child must also
  // refuse writes from principals outside that same trust boundary.
  for (let i = 0; i < acl.length; i += 32) {
    if (!await verifyWindowsEntriesAclAsync(acl.slice(i, i + 32), 5000)) throw new Error("installation_acl_unverified");
  }
  const files: (WindowsCodexExpectedFile & { identity: string })[] = [];
  for (let i = 0; i < paths.length; i += 12) {
    const batch = paths.slice(i, i + 12);
    const observed = await inspectWindowsInstallationFiles(batch.map(relative => ({
      path: win32.join(prefix, relative), maxBytes: lstatSync(win32.join(prefix, relative)).size, hashOnly: true, installationDigest: true,
    })));
    if (observed.kind !== "observed") throw new Error("installation_file_unverified");
    for (const file of observed.files) files.push({ relativePath: key(win32.relative(prefix, file.path)),
      size: file.identity.size, digest: file.digest, identity: JSON.stringify(file.identity) });
  }
  // Detect namespace changes while the bounded observations yielded.
  const again = inventory(prefix);
  if (JSON.stringify([...again.directories, ...again.paths].sort()) !== JSON.stringify([...directories, ...paths].sort())
    || JSON.stringify(absent) !== JSON.stringify(again.absent)) throw new Error("installation_changed");
  return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), directories: directories.sort(), absent: absent.sort() };
}
export const sameWindowsInstall = (left: WindowsInstallSnapshot, right: WindowsInstallSnapshot): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
/** npm metadata and every bounded unrelated entry must retain bytes and identity. */
export function sameWindowsPreservedEntries(left: WindowsInstallSnapshot, right: WindowsInstallSnapshot): boolean {
  const preserved = (snapshot: WindowsInstallSnapshot) => ({
    files: snapshot.files.filter(file => !windowsCodexOwnedPath(file.relativePath)),
    directories: snapshot.directories.filter(dir => !windowsCodexOwnedPath(dir.split(":")[0]!)),
  });
  return JSON.stringify(preserved(left)) === JSON.stringify(preserved(right));
}
