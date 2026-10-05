import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "./test-home-guard";
import { forgetEphemeralSecretPath, hardenSecretDir, hardenSecretPath, windowsSecretAclApplies } from "./windows-secret-acl";

import { verifyWindowsPrivateEntries, WINDOWS_OWNER_ACL_TIMEOUT_MS } from "./windows-owner-acl";

export const GUI_PAIR_INTENT_HEADER = "x-opencodex-gui-pair-intent";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INTENT_NAME = /^[0-9a-f]{64}$/;
// Records outlive their ~10s capability only when the publishing CLI died; a wide
// margin keeps an active command's fresh record from ever looking stale.
const STALE_INTENT_MS = 60_000;
const STALE_INTENT_SWEEP_LIMIT = 256;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function owned(stat: BigIntStats): boolean {
  return process.platform === "win32" || (stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o022n) === 0n);
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs;
}
function directory(path: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw new Error("Unsafe GUI pairing intent directory");
  return stat;
}
function location(capability: string, configDir: string): { dir: string; path: string } {
  if (!TOKEN.test(capability)) throw new Error("Invalid GUI pairing capability");
  const dir = join(configDir, "gui-pair-intents");
  return { dir, path: join(dir, digest(`opencodex-gui-pair-intent-v1\n${capability}`)) };
}
function releaseConsumeLock(path: string, identity: BigIntStats): boolean {
  try {
    if (!same(identity, lstatSync(path, { bigint: true }))) return false;
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function removeOwned(path: string, identity: BigIntStats): void {
  try {
    if (same(identity, lstatSync(path, { bigint: true }))) unlinkSync(path);
  } catch { /* expired or already consumed; never remove a replacement */ }
  forgetEphemeralSecretPath(path);
}

/** Best-effort stale cleanup; bound per-entry work before creating the next expiring intent. */
function sweepStaleIntents(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  const now = Date.now();
  // Count every entry, including foreign and fresh ones, rather than only successful deletes.
  // This caps metadata/deletion work, not readdirSync's array allocation or syscall duration.
  // Bun 1.4.0 also snapshots names behind opendirSync, so an iterator alone is not a memory cap.
  const limit = Math.min(names.length, STALE_INTENT_SWEEP_LIMIT);
  for (let index = 0; index < limit; index++) {
    const name = names[index]!;
    if (!INTENT_NAME.test(name)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat) || stat.nlink !== 1n) continue;
      if (now - Number(stat.mtimeMs) < STALE_INTENT_MS) continue;
      removeOwned(path, stat);
    } catch { /* leave unreadable entries alone */ }
  }
}

export interface GuiPairIntent {
  proof: string;
  dispose(): void;
}

/**
 * Prove write access to the private configuration home, separately from runtime-state reads.
 * Only a SHA-256 commitment goes to disk; the random verifier remains in the requesting CLI.
 * This is an owner-write boundary, NOT proof of human presence or protection from a fully
 * privileged same-user process. The existing HMAC binds PID, port, origin, nonce and expiry.
 */
export function createGuiPairIntent(capability: string, configDir = getConfigDir()): GuiPairIntent {
  assertNotRealHomeUnderTest(configDir);
  directory(configDir);
  const { dir, path } = location(capability, configDir);
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  directory(dir);
  if (!hardenSecretDir(dir, { required: true, deadlineMs: 2_000 }).ok) throw new Error("GUI pairing intent ACL refused");
  sweepStaleIntents(dir);
  const parent = directory(dir);
  const proof = randomBytes(32).toString("base64url");
  const fd = openSync(path, "wx", 0o600);
  let identity = fstatSync(fd, { bigint: true });
  try {
    writeFileSync(fd, `${digest(proof)}\n`, "utf8");
    if (!hardenSecretPath(path, { required: true, deadlineMs: 2_000 }).ok) throw new Error("GUI pairing intent ACL refused");
    identity = fstatSync(fd, { bigint: true });
    if (!same(identity, lstatSync(path, { bigint: true })) || !owned(identity)
      || identity.nlink !== 1n || parent.dev !== directory(dir).dev || parent.ino !== directory(dir).ino) {
      throw new Error("GUI pairing intent changed during publication");
    }
  } catch (error) {
    identity = fstatSync(fd, { bigint: true });
    closeSync(fd);
    removeOwned(path, identity);
    throw error;
  }
  closeSync(fd);
  // Disposal consumes the record: the same directory, identity and content checks as
  // redemption, so a corrupted or replaced commitment is retained on every platform.
  const dispose = (): void => { consumeGuiPairIntent(capability, proof, configDir); };
  return { proof, dispose };
}

/** Called only after the existing process-bound, expiring capability passed authorization. */
export function consumeGuiPairIntent(capability: string | null, proof: string | null, configDir = getConfigDir()): boolean {
  if (!capability || !proof || !TOKEN.test(capability) || !TOKEN.test(proof)) return false;
  let fd: number | undefined;
  let consumeLock: string | undefined;
  let consumeLockIdentity: BigIntStats | undefined;
  try {
    assertNotRealHomeUnderTest(configDir);
    directory(configDir);
    const { dir, path } = location(capability, configDir);
    const parent = directory(dir);
    consumeLock = `${path}.consuming`;
    mkdirSync(consumeLock, { mode: 0o700 });
    consumeLockIdentity = directory(consumeLock);
    const lockedParent = directory(dir);
    if (parent.dev !== lockedParent.dev || parent.ino !== lockedParent.ino) return false;
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !owned(before) || before.nlink !== 1n || before.size !== 65n) return false;
    // Do not block on a substituted FIFO. Windows retains descriptor/path identity checks.
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fd = openSync(path, flags);
    const opened = fstatSync(fd, { bigint: true });
    if (!same(before, opened) || !opened.isFile()) return false;
    const bytes = Buffer.alloc(66);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== 65 || !timingSafeEqual(bytes.subarray(0, size), Buffer.from(`${digest(proof)}\n`))) return false;
    const after = fstatSync(fd, { bigint: true });
    if (!same(opened, after) || !same(after, lstatSync(path, { bigint: true }))
      || parent.dev !== directory(dir).dev || parent.ino !== directory(dir).ino) return false;
    closeSync(fd); fd = undefined;
    // Verify only a matching commitment, with its descriptor closed and lock held.
    // Redemption must never harden an untrusted record into acceptable authority.
    if (windowsSecretAclApplies() && !verifyWindowsPrivateEntries([
      { path: dir, directory: true }, { path, directory: false },
    ], WINDOWS_OWNER_ACL_TIMEOUT_MS)) return false;
    const verifiedParent = directory(dir);
    if (parent.dev !== verifiedParent.dev || parent.ino !== verifiedParent.ino
      || !same(after, lstatSync(path, { bigint: true }))) return false;
    unlinkSync(path);
    forgetEphemeralSecretPath(path);
    return true;
  } catch { return false; }
  finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      if (consumeLock && consumeLockIdentity) {
        releaseConsumeLock(consumeLock, consumeLockIdentity);
      }
    }
  }
}
