import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_CODEX_MEMBER_BYTES, MAX_CODEX_UNPACKED_BYTES, type CodexArchiveFiles } from "./cli-update-artifacts";

interface FileProof { readonly size: number; readonly digest: string; readonly executable: boolean; readonly mode?: number }
export type CodexCliFileSet = Map<string, FileProof>;
export interface CodexCliPreimage {
  readonly presentRoots: readonly string[];
  readonly absentRoots: readonly string[];
  readonly files: CodexCliFileSet;
}
/** An absent planned root is evidence too. Reject link/invalid ancestor lanes
 * instead of treating an inaccessible or redirected tree as simply absent.
 */
function rootAbsent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let ancestor = dirname(path);
  for (;;) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(ancestor) !== ancestor) throw new Error("install_tree_unverified");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
}
export function observeCodexCliPreimage(roots: readonly string[]): CodexCliPreimage {
  const presentRoots: string[] = [], absentRoots: string[] = [];
  for (const root of new Set(roots)) (rootAbsent(root) ? absentRoots : presentRoots).push(root);
  const files = observeCodexCliFileSet(presentRoots);
  if (absentRoots.some(root => !rootAbsent(root))) throw new Error("install_tree_changed");
  return { presentRoots, absentRoots, files };
}
export function sameCodexCliPreimage(left: CodexCliPreimage, right: CodexCliPreimage): boolean {
  const sameRoots = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(root => b.includes(root));
  return sameRoots(left.presentRoots, right.presentRoots) && sameRoots(left.absentRoots, right.absentRoots)
    && sameCodexCliFiles(left.files, right.files);
}
/** Full bounded regular-file observation of the selected package roots only.
 * Ancestor/path links, nonregular files and changed identities refuse it.
 * Big members are hashed in 64 KiB chunks, never retained in memory.
 */
export function observeCodexCliFileSet(roots: readonly string[]): CodexCliFileSet {
  const files: CodexCliFileSet = new Map();
  let total = 0, entries = 0;
  const walk = (path: string) => {
    if (++entries > 8192 || realpathSync.native(path) !== path) throw new Error("install_tree_unverified");
    const lexical = lstatSync(path);
    if (lexical.isSymbolicLink()) throw new Error("install_tree_unverified");
    if (lexical.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
      const after = lstatSync(path);
      if (lexical.dev !== after.dev || lexical.ino !== after.ino || lexical.mtimeMs !== after.mtimeMs) throw new Error("install_tree_changed");
      return;
    }
    if (!lexical.isFile() || lexical.size > MAX_CODEX_MEMBER_BYTES) throw new Error("install_tree_unverified");
    total += lexical.size;
    if (total > MAX_CODEX_UNPACKED_BYTES || files.size >= 4096) throw new Error("install_tree_limit");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== lexical.size) throw new Error("install_tree_changed");
      const hash = createHash("sha256").update("codex-cli-observed-file-v1\0");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      for (;;) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset + 1), offset);
        if (!count) break;
        offset += count;
        if (offset > before.size) throw new Error("install_tree_changed");
        hash.update(chunk.subarray(0, count));
      }
      const after = fstatSync(fd), final = lstatSync(path);
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || final.isSymbolicLink() || final.dev !== before.dev || final.ino !== before.ino
        || final.mode !== before.mode) throw new Error("install_tree_changed");
      let executable = false;
      if (before.mode & 0o111) { try { accessSync(path, constants.X_OK); executable = true; } catch { /* current user cannot execute it */ } }
      files.set(path, { size: before.size, digest: hash.digest("hex"), executable, mode: before.mode & 0o7777 });
    } finally { closeSync(fd); }
  };
  const unique = [...new Set(roots)].filter(root => !roots.some(other => other !== root && root.startsWith(other + "/")));
  for (const root of unique) walk(root);
  return files;
}
export function codexCliExpectedFiles(roots: readonly [string, CodexArchiveFiles][]): CodexCliFileSet {
  return new Map(roots.flatMap(([root, files]) => [...files].map(([path, proof]) => [join(root, path),
    { size: proof.size, digest: proof.digest, executable: !!(proof.mode & 0o111) }] as const)));
}
export function sameCodexCliFiles(left: CodexCliFileSet, right: CodexCliFileSet): boolean {
  return left.size === right.size && [...left].every(([path, proof]) => {
    const other = right.get(path);
    return other?.size === proof.size && other.digest === proof.digest && other.executable === proof.executable
      && (proof.mode === undefined || proof.mode === other.mode);
  });
}
