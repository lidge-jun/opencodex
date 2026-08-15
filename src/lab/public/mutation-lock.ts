import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureLabDirs, labCommunityDir } from "../paths";
import { readPrivateRegularFile } from "./file-safety";
import { PublicEvidenceValidationError } from "./validate";

const PUBLIC_EVIDENCE_MUTATION_LOCK_NAME = ".mutation-lock";
const PUBLIC_EVIDENCE_MUTATION_LOCK_OWNER = "owner.json";
const PUBLIC_EVIDENCE_MUTATION_LOCK_RECLAIM = ".reclaim.json";
const PUBLIC_EVIDENCE_MUTATION_LOCK_INCOMPLETE_STALE_MS = 24 * 60 * 60 * 1000;
const PUBLIC_EVIDENCE_MUTATION_LOCK_ABSOLUTE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const DETACHED_MUTATION_LOCK_RE = /^\.mutation-lock-(?:stale|release)-\d+-[0-9a-f-]{36}$/;
const MUTATION_LOCK_META_FILE_OPTIONS = {
  maxBytes: 1024,
  errorCode: "community_cache_lock",
  errorMessage: "community cache mutation lock metadata is unsafe",
  sizeErrorCode: "community_cache_lock",
  sizeErrorMessage: "community cache mutation lock metadata exceeds its size bound",
  requireMode600: true,
} as const;

type MutationLockOwner = {
  pid: number;
  token: string;
  createdAt: number;
};

type MutationLockReclaim = {
  pid: number;
  token: string;
  createdAt: number;
};

type MutationLockDirectoryIdentity = {
  dev: number;
  ino: number;
};

function mutationLockPath(configDir?: string): string {
  return join(labCommunityDir(configDir), PUBLIC_EVIDENCE_MUTATION_LOCK_NAME);
}

function mutationLockOwnerPath(lockPath: string): string {
  return join(lockPath, PUBLIC_EVIDENCE_MUTATION_LOCK_OWNER);
}

function mutationLockReclaimPath(lockPath: string): string {
  return join(lockPath, PUBLIC_EVIDENCE_MUTATION_LOCK_RECLAIM);
}

function pidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function exceedsAbsoluteLockAge(createdAt: number, nowMs: number): boolean {
  return nowMs - createdAt > PUBLIC_EVIDENCE_MUTATION_LOCK_ABSOLUTE_STALE_MS;
}

function readLockMetadata<T extends MutationLockOwner | MutationLockReclaim>(
  path: string,
): T | null {
  try {
    const bytes = readPrivateRegularFile(path, MUTATION_LOCK_META_FILE_OPTIONS);
    const raw = JSON.parse(bytes.toString("utf8")) as Partial<T>;
    if (
      Number.isSafeInteger(raw.pid)
      && Number(raw.pid) > 0
      && typeof raw.token === "string"
      && /^[0-9a-f-]{36}$/.test(raw.token)
      && Number.isSafeInteger(raw.createdAt)
      && Number(raw.createdAt) > 0
    ) {
      return {
        pid: Number(raw.pid),
        token: raw.token,
        createdAt: Number(raw.createdAt),
      } as T;
    }
  } catch {
    // Incomplete metadata is handled conservatively by the age fallback where
    // applicable. Normal acquisition never trusts malformed metadata.
  }
  return null;
}

function readMutationLockOwner(lockPath: string): MutationLockOwner | null {
  return readLockMetadata<MutationLockOwner>(mutationLockOwnerPath(lockPath));
}

function readMutationLockReclaim(lockPath: string): MutationLockReclaim | null {
  return readLockMetadata<MutationLockReclaim>(mutationLockReclaimPath(lockPath));
}

function assertMutationLockDirectory(lockPath: string) {
  const stat = lstatSync(lockPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PublicEvidenceValidationError(
      "community_cache_lock",
      "community cache mutation lock is not a directory",
    );
  }
  return stat;
}

function sameDirectoryIdentity(
  left: MutationLockDirectoryIdentity,
  right: MutationLockDirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentDirectoryIdentity(lockPath: string): MutationLockDirectoryIdentity {
  const stat = assertMutationLockDirectory(lockPath);
  return { dev: stat.dev, ino: stat.ino };
}

function mutationLockIsReclaimable(lockPath: string, nowMs: number): boolean {
  const stat = assertMutationLockDirectory(lockPath);
  const owner = readMutationLockOwner(lockPath);
  if (owner) {
    // A live PID is strong evidence only while the recorded ownership generation is
    // reasonably recent. The absolute ceiling recovers from PID reuse after a crash.
    return pidDefinitelyDead(owner.pid) || exceedsAbsoluteLockAge(owner.createdAt, nowMs);
  }
  // The only ownerless state is the tiny mkdir-to-owner publication window. Use
  // a deliberately long fallback so a crashed acquisition can eventually heal
  // without treating an ordinary pause as proof that the owner disappeared.
  return nowMs - stat.mtimeMs > PUBLIC_EVIDENCE_MUTATION_LOCK_INCOMPLETE_STALE_MS;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function cleanupDetachedMutationLocks(lockPath: string): void {
  const dir = dirname(lockPath);
  for (const name of readdirSync(dir)) {
    if (!DETACHED_MUTATION_LOCK_RE.test(name)) continue;
    // Detached lock directories are no longer authoritative once a new canonical
    // lock has been acquired. Removing only their UUID-scoped names prevents them
    // from leaking storage or being mistaken for community cache objects.
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function publishMutationLockOwner(
  lockPath: string,
  owner: MutationLockOwner,
  expectedDirectory: MutationLockDirectoryIdentity,
): void {
  // Write through a unique temporary pathname first. If an ancient ownerless
  // lock is reclaimed while this process was suspended, the inode check prevents
  // this acquisition from publishing its owner metadata into a replacement lock.
  const tempPath = join(lockPath, `.owner-${owner.token}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (!sameDirectoryIdentity(currentDirectoryIdentity(lockPath), expectedDirectory)) {
      throw new PublicEvidenceValidationError(
        "community_cache_lock",
        "community cache mutation lock changed during owner publication",
      );
    }
    renameSync(tempPath, mutationLockOwnerPath(lockPath));
    if (!sameDirectoryIdentity(currentDirectoryIdentity(lockPath), expectedDirectory)) {
      throw new PublicEvidenceValidationError(
        "community_cache_lock",
        "community cache mutation lock changed after owner publication",
      );
    }
    const persisted = readMutationLockOwner(lockPath);
    if (!persisted || persisted.pid !== owner.pid || persisted.token !== owner.token) {
      throw new PublicEvidenceValidationError(
        "community_cache_lock",
        "community cache mutation lock owner publication was not durable",
      );
    }
  } finally {
    // The rename normally makes this ENOENT. If the lock pathname was replaced,
    // the UUID-scoped temporary name can be removed without touching successor state.
    unlinkIfPresent(tempPath);
  }
}

function reclaimClaimIsRecoverable(lockPath: string, nowMs: number): boolean {
  const claimPath = mutationLockReclaimPath(lockPath);
  const claim = readMutationLockReclaim(lockPath);
  if (claim) {
    return pidDefinitelyDead(claim.pid) || exceedsAbsoluteLockAge(claim.createdAt, nowMs);
  }
  try {
    const stat = lstatSync(claimPath);
    return nowMs - stat.mtimeMs > PUBLIC_EVIDENCE_MUTATION_LOCK_INCOMPLETE_STALE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function recoverStaleReclaimClaim(lockPath: string, nowMs: number): boolean {
  if (!reclaimClaimIsRecoverable(lockPath, nowMs)) return false;
  const claimPath = mutationLockReclaimPath(lockPath);
  const quarantinePath = join(lockPath, `.reclaim-stale-${randomUUID()}.json`);
  try {
    renameSync(claimPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  unlinkIfPresent(quarantinePath);
  return true;
}

function tryAcquireReclaimClaim(
  lockPath: string,
  nowMs: number,
): MutationLockReclaim | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const claim: MutationLockReclaim = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: nowMs,
    };
    try {
      writeFileSync(mutationLockReclaimPath(lockPath), JSON.stringify(claim), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return claim;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code !== "EEXIST") throw error;
      if (!recoverStaleReclaimClaim(lockPath, nowMs)) return null;
    }
  }
  return null;
}

function reclaimClaimStillOwned(lockPath: string, claim: MutationLockReclaim): boolean {
  const current = readMutationLockReclaim(lockPath);
  return current?.pid === claim.pid && current.token === claim.token;
}

function releaseReclaimClaim(lockPath: string, claim: MutationLockReclaim): void {
  if (!reclaimClaimStillOwned(lockPath, claim)) return;
  unlinkIfPresent(mutationLockReclaimPath(lockPath));
}

function tryReclaimMutationLock(lockPath: string, nowMs: number): boolean {
  // Capture the exact stale directory before the claim write changes its mtime.
  // After claiming, revalidate the inode and owner instead of reusing an age check
  // that our own .reclaim.json creation would make appear fresh.
  if (!mutationLockIsReclaimable(lockPath, nowMs)) return false;
  const staleDirectory = currentDirectoryIdentity(lockPath);
  const claim = tryAcquireReclaimClaim(lockPath, nowMs);
  if (!claim) return false;

  let moved = false;
  try {
    if (!reclaimClaimStillOwned(lockPath, claim)) return false;
    if (!sameDirectoryIdentity(currentDirectoryIdentity(lockPath), staleDirectory)) return false;
    const currentOwner = readMutationLockOwner(lockPath);
    if (
      currentOwner
      && !pidDefinitelyDead(currentOwner.pid)
      && !exceedsAbsoluteLockAge(currentOwner.createdAt, nowMs)
    ) return false;
    if (!reclaimClaimStillOwned(lockPath, claim)) return false;

    const quarantinePath = join(
      dirname(lockPath),
      `.mutation-lock-stale-${process.pid}-${randomUUID()}`,
    );
    try {
      // Rename the exact claimed directory away from the canonical pathname before
      // deleting it. A successor can create a new lock immediately afterwards, but
      // cleanup is confined to this unique quarantine path and cannot delete it.
      renameSync(lockPath, quarantinePath);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    rmSync(quarantinePath, { recursive: true, force: true });
    return true;
  } finally {
    if (!moved) releaseReclaimClaim(lockPath, claim);
  }
}

function discardUncommittedMutationLock(
  lockPath: string,
  expectedDirectory: MutationLockDirectoryIdentity,
): void {
  try {
    if (!sameDirectoryIdentity(currentDirectoryIdentity(lockPath), expectedDirectory)) return;
    const quarantinePath = join(
      dirname(lockPath),
      `.mutation-lock-release-${process.pid}-${randomUUID()}`,
    );
    renameSync(lockPath, quarantinePath);
    rmSync(quarantinePath, { recursive: true, force: true });
  } catch {
    // Preserve the owner-publication error. An unrecoverable cleanup witness stays
    // ownerless and can be reclaimed by the long incomplete-acquisition fallback.
  }
}

function releaseMutationLock(
  lockPath: string,
  owner: MutationLockOwner,
  expectedDirectory: MutationLockDirectoryIdentity,
): void {
  let currentDirectory: MutationLockDirectoryIdentity;
  try {
    currentDirectory = currentDirectoryIdentity(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sameDirectoryIdentity(currentDirectory, expectedDirectory)) return;
  const current = readMutationLockOwner(lockPath);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return;

  const quarantinePath = join(
    dirname(lockPath),
    `.mutation-lock-release-${process.pid}-${randomUUID()}`,
  );
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
}

/** Serialize public-evidence mutations across CLI/server processes with ownership-safe stale recovery. */
export function withPublicEvidenceMutationLock<T>(
  configDir: string | undefined,
  run: () => T,
): T {
  ensureLabDirs(configDir);
  const lockPath = mutationLockPath(configDir);
  let owner: MutationLockOwner | null = null;
  let ownedDirectory: MutationLockDirectoryIdentity | null = null;

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (tryReclaimMutationLock(lockPath, Date.now())) continue;
      } catch (reclaimError) {
        if ((reclaimError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw reclaimError;
      }
      throw new PublicEvidenceValidationError("community_cache_busy", "community cache is busy");
    }

    const directory = currentDirectoryIdentity(lockPath);
    const candidate: MutationLockOwner = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };
    try {
      publishMutationLockOwner(lockPath, candidate, directory);
    } catch (error) {
      discardUncommittedMutationLock(lockPath, directory);
      throw error;
    }
    owner = candidate;
    ownedDirectory = directory;
    break;
  }

  try {
    cleanupDetachedMutationLocks(lockPath);
    return run();
  } finally {
    if (owner && ownedDirectory) releaseMutationLock(lockPath, owner, ownedDirectory);
  }
}

/** Test-only seam for stale-owner policy. This module is not barrel-exported. */
export function publicEvidenceMutationLockIsReclaimableForTests(
  configDir: string | undefined,
  nowMs = Date.now(),
): boolean {
  return mutationLockIsReclaimable(mutationLockPath(configDir), nowMs);
}

/** Test-only seam for the exclusive stale-reclaimer claim. */
export function publicEvidenceTryReclaimMutationLockForTests(
  configDir: string | undefined,
  nowMs = Date.now(),
): boolean {
  return tryReclaimMutationLock(mutationLockPath(configDir), nowMs);
}
