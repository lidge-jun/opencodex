import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertTrustedCodexCliAncestry } from "./cli-update-paths";

export type CodexCliApplyLeaseResult = { readonly kind: "acquired"; release(): boolean }
  | { readonly kind: "busy" | "prefix_unsupported" | "unavailable" };
/** Installation-unit mutex. No stale/empty-owner recovery and no token delegation. */
export function acquireCodexCliApplyLease(prefix: string): CodexCliApplyLeaseResult {
  let fd: number | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  let ownerIdentity: { dev: number; ino: number } | undefined;
  const path = join(prefix, ".ocx-codex-cli-apply.lock");
  const owner = join(path, "owner.json");
  const record = JSON.stringify({ version: 1, pid: process.pid, token: randomUUID() });
  const release = () => {
    let current: number | undefined;
    let released = false;
    try {
      if (!lockIdentity || !ownerIdentity) return false;
      const directory = lstatSync(path);
      if (!directory.isDirectory() || directory.isSymbolicLink()
        || directory.dev !== lockIdentity.dev || directory.ino !== lockIdentity.ino) return false;
      current = openSync(owner, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const identity = fstatSync(current);
      if (!identity.isFile() || identity.size !== Buffer.byteLength(record)
        || identity.dev !== ownerIdentity.dev || identity.ino !== ownerIdentity.ino
        || readFileSync(current, "utf8") !== record) return false;
      const lexical = lstatSync(owner);
      if (lexical.isSymbolicLink() || lexical.dev !== identity.dev || lexical.ino !== identity.ino) return false;
      unlinkSync(owner);
      rmdirSync(path);
      lockIdentity = undefined;
      released = true;
    } catch { return false; }
    finally {
      if (current !== undefined) { try { closeSync(current); } catch { released = false; } }
    }
    return released;
  };
  try {
    try { assertTrustedCodexCliAncestry(prefix); }
    catch { return { kind: "prefix_unsupported" }; }
    const root = lstatSync(prefix);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync.native(prefix) !== prefix
      || (root.mode & 0o022) !== 0 || root.uid !== process.geteuid?.()) return { kind: "prefix_unsupported" };
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "busy" };
      throw error;
    }
    lockIdentity = lstatSync(path);
    fd = openSync(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    ownerIdentity = fstatSync(fd);
    writeFileSync(fd, record);
    const completed = fd;
    fd = undefined;
    closeSync(completed);
    return { kind: "acquired", release };
  } catch {
    if (fd !== undefined) {
      const owned = fd; fd = undefined;
      try { closeSync(owned); } catch { return { kind: "unavailable" }; }
    }
    // Only a positively identified owner is eligible for cleanup. Empty or
    // suspicious directories intentionally remain busy for operator inspection.
    if (ownerIdentity) release();
    return { kind: "unavailable" };
  }
}
