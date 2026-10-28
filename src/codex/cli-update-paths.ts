import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Shared by durable admission, the installation lease and apply staging. */
export function assertTrustedCodexCliAncestry(path: string): void {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("untrusted_posix_path");
  for (let current = resolve(path); ;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(current) !== current
      || (stat.uid !== uid && stat.uid !== 0)
      || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) {
      throw new Error("untrusted_posix_path");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

type DirectoryIdentity = { dev: number; ino: number; uid: number; mode: number };
export type CodexCliMutationPaths = ReadonlyMap<string, DirectoryIdentity>;
const MAX_PATH_ENTRIES = 16_384;

/** npm can replace more than the two approved packages: validate all existing
 * directories under the prefix, including bin, scopes and npm's rename parents.
 * Absent directories are safe to create only below this protected namespace.
 */
export function observeCodexCliMutationPaths(root: string): CodexCliMutationPaths {
  assertTrustedCodexCliAncestry(root);
  const directories = new Map<string, DirectoryIdentity>();
  let entries = 0;
  const walk = (path: string) => {
    if (++entries > MAX_PATH_ENTRIES) throw new Error("untrusted_posix_path");
    const stat = lstatSync(path);
    // npm's executable links are files; directory links are never traversed.
    if (stat.isSymbolicLink()) {
      if (statSync(path).isDirectory()) throw new Error("untrusted_posix_path");
      return;
    }
    if (!stat.isDirectory()) return;
    if (realpathSync.native(path) !== path || (stat.uid !== process.geteuid?.() && stat.uid !== 0)
      || (stat.mode & 0o022) !== 0) throw new Error("untrusted_posix_path");
    directories.set(path, { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
    for (const entry of readdirSync(path)) walk(join(path, entry));
    const after = lstatSync(path);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || after.uid !== stat.uid) {
      throw new Error("untrusted_posix_path");
    }
  };
  walk(root);
  return directories;
}

export function sameCodexCliMutationPaths(before: CodexCliMutationPaths, after: CodexCliMutationPaths): boolean {
  return before.size === after.size && [...before].every(([path, identity]) => {
    const next = after.get(path);
    return next && identity.dev === next.dev && identity.ino === next.ino
      && identity.uid === next.uid && identity.mode === next.mode;
  });
}

/** Canonicalize the chosen root before creation. Root-owned sticky ancestors
 * protect this same-owner, private child from other users' rename operations.
 * Unsafe TMPDIR is an explicit refusal, never an ambient fallback.
 */
export function createCodexCliApplyStaging(temporaryRoot: string): string {
  const root = realpathSync.native(temporaryRoot);
  assertTrustedCodexCliAncestry(root);
  const stage = mkdtempSync(join(root, "ocx-codex-cli-apply-"));
  chmodSync(stage, 0o700);
  assertTrustedCodexCliAncestry(stage);
  const stat = lstatSync(stage);
  if (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) throw new Error("untrusted_posix_path");
  return stage;
}
