import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  forgetEphemeralSecretPath,
  hardenSecretPath,
  hardenSecretPathAsync,
  reattributeHardenedSecretPath,
  windowsSecretAclReapPendingForPath,
} from "../lib/windows-secret-acl";
import {
  renameAtomicFile,
  renameAtomicFileAsync,
} from "../lib/windows-atomic-replace";
import { getConfigDir } from "./paths";

let atomicSequence = 0;

/**
 * Whether this writer's Windows ACL branch applies.
 *
 * Deliberately a local override rather than the ACL module's
 * `windowsSecretAclApplies()`. That one is flipped by many unrelated suites
 * through `setPlatformForTests("win32")`, and honouring it here would make every
 * such suite start running icacls against config writes on a POSIX runner. The
 * gate a cost fix needs is one only the cost tests can open.
 */
let windowsHardeningOverride: boolean | null = null;

function windowsHardeningApplies(): boolean {
  return windowsHardeningOverride ?? process.platform === "win32";
}

/** Test seam: drive the Windows hardening branch on a POSIX runner. Null restores. */
export function setWindowsHardeningForTests(enabled: boolean | null): void {
  windowsHardeningOverride = enabled;
}

/** Shared process-wide suffix source for config-owned atomic sibling files. */
export function nextAtomicTempSequence(): number {
  return ++atomicSequence;
}
/** Internal error classifier shared by config backup and atomic-write paths. */
export function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export type { AtomicRenameIO } from "../lib/windows-atomic-replace";
export { renameAtomicFile } from "../lib/windows-atomic-replace";

export interface AtomicWriteIO {
  write: (path: string, content: string) => void;
  harden: (path: string) => void;
  rename: (source: string, destination: string) => void;
  truncate: (path: string) => void;
  unlink: (path: string) => void;
}

export interface AtomicWriteHooks {
  afterTempWrite?: (tempPath: string, targetPath: string) => void;
  beforeRename?: (tempPath: string, targetPath: string) => void;
  validateBeforeRename?: (targetPath: string) => void;
}

export class AtomicWriteResidualTempError extends Error {
  constructor(readonly tempPath: string, readonly hardened = true, options?: ErrorOptions) {
    super(`Atomic config write left a ${hardened ? "hardened " : ""}zero-byte temporary file`, options);
    this.name = "AtomicWriteResidualTempError";
  }
}

export class AtomicWriteSecretResidualError extends Error {
  constructor(readonly tempPath: string, options?: ErrorOptions) {
    super("Atomic config write could not scrub or remove a secret-bearing temporary file", options);
    this.name = "AtomicWriteSecretResidualError";
  }
}

/**
 * Resolve a write target through any symlink before the temp+rename dance so
 * dotfiles-managed links survive an atomic replacement.
 */
export function resolveWriteTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (cause) {
    let entry;
    try {
      entry = lstatSync(path);
    } catch (error) {
      if (isMissingPathError(error)) return path;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing to replace unresolvable symlinked write target: ${path}`, { cause });
    }
    return path;
  }
}

function assertResolvedTargetAllowed(path: string, target: string): void {
  if (target === path) {
    let realParent: string;
    try {
      realParent = realpathSync(dirname(target));
    } catch {
      return;
    }
    if (realParent !== dirname(target)) assertNotRealHomeUnderTest(realParent);
    return;
  }
  assertNotRealHomeUnderTest(dirname(target));
}

function assertPrivateTempDescriptor(path: string, descriptor: number): void {
  const opened = fstatSync(descriptor);
  const linked = lstatSync(path);
  if (!opened.isFile() || !linked.isFile()
    || opened.dev !== linked.dev || opened.ino !== linked.ino) {
    throw new Error("atomic temporary file identity changed before write");
  }
  if (process.platform !== "win32" && (opened.mode & 0o777) !== 0o600) {
    throw new Error("atomic temporary file permissions are not owner-only");
  }
}

/**
 * Carry the harden applied to the empty temp across the content write.
 *
 * The temp is hardened before it holds a byte, and then `atomicWriteFile` hardens
 * it again before the rename. The second call used to be a full icacls sequence
 * rather than a memo hit, because the ACL memo's freshness component is
 * `ctimeNs` and libuv reports that from the NTFS ChangeTime, which a data write
 * moves. So every secret write on Windows applied the same three-step ACL twice:
 * `/grant:r`, `/inheritance:r`, `/remove:g`, plus up to three `/findsid` probes,
 * all of it to arrive at the ACL the file already had.
 *
 * It runs after the descriptor closes, not before, because Windows may not have
 * published the new ChangeTime to a path query while the handle is still open;
 * refreshing to a time the next reader will not see would leave the memo missing
 * and change nothing. What licenses the shortcut is the identity assertion the
 * caller makes immediately before the close, which proves this path resolves to
 * the object the ACL was applied to, plus the object comparison inside
 * `reattributeHardenedSecretPath`, which refuses to move the memo to a different
 * object. Nothing is skipped on the strength of the pathname alone, and a
 * refusal costs only the second full harden this is trying to avoid.
 */
function carryHardenAcrossContentWrite(path: string): void {
  if (!windowsHardeningApplies()) return;
  reattributeHardenedSecretPath(path);
}

function writePrivateTempFile(
  path: string,
  content: string,
  timeoutMemoKey: string,
  onCreated: () => void,
): void {
  const descriptor = openSync(path, "wx", 0o600);
  onCreated();
  try {
    if (windowsHardeningApplies()) {
      hardenSecretPath(path, { required: true, timeoutMemoKey });
    }
    // Keyed on the REAL platform, not the override: on a POSIX host the mode is
    // the boundary and `assertPrivateTempDescriptor` demands 0o600, which an
    // ambient umask can otherwise take away from the open above.
    if (process.platform !== "win32") {
      fchmodSync(descriptor, 0o600);
    }
    assertPrivateTempDescriptor(path, descriptor);
    writeFileSync(descriptor, content, { encoding: "utf-8" });
    // Second assertion, after the content write: the object this path resolves
    // to is still the object the ACL was applied to and the one we just wrote.
    assertPrivateTempDescriptor(path, descriptor);
  } finally {
    closeSync(descriptor);
  }
  carryHardenAcrossContentWrite(path);
}

async function writePrivateTempFileAsync(
  path: string,
  content: string,
  timeoutMemoKey: string,
  onCreated: () => void,
): Promise<void> {
  const descriptor = openSync(path, "wx", 0o600);
  onCreated();
  try {
    if (windowsHardeningApplies()) {
      await hardenSecretPathAsync(path, { required: true, timeoutMemoKey });
    }
    if (process.platform !== "win32") {
      fchmodSync(descriptor, 0o600);
    }
    assertPrivateTempDescriptor(path, descriptor);
    writeFileSync(descriptor, content, { encoding: "utf-8" });
    assertPrivateTempDescriptor(path, descriptor);
  } finally {
    closeSync(descriptor);
  }
  carryHardenAcrossContentWrite(path);
}

function atomicWriteFileToTarget(
  path: string,
  content: string,
  target: string,
  io?: AtomicWriteIO,
  hooks: AtomicWriteHooks = {},
): void {
  recordOwnedConfigPath(getConfigDir(), path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let hardened = false;
  let ownsTemp = false;
  const effective: AtomicWriteIO = io ?? {
    write: (tempPath, value) => writePrivateTempFile(tempPath, value, path, () => { ownsTemp = true; }),
    harden: tempPath => {
      // No chmod on the Windows branch: there it sets the read-only ATTRIBUTE,
      // which is not the secret boundary and is not what protects this file, and
      // its ChangeTime bump is what used to invalidate the harden memo one line
      // later. On POSIX the mode IS the boundary, so it stays.
      if (windowsHardeningApplies()) {
        hardenSecretPath(tempPath, { required: true, timeoutMemoKey: path });
        return;
      }
      try { chmodSync(tempPath, 0o600); } catch { /* platform may ignore chmod */ }
    },
    rename: renameAtomicFile,
    truncate: tempPath => truncateSync(tempPath, 0),
    unlink: unlinkSync,
  };
  try {
    if (io) ownsTemp = true;
    effective.write(tmp, content);
    hooks.afterTempWrite?.(tmp, target);
    effective.harden(tmp);
    hardened = true;
    hooks.beforeRename?.(tmp, target);
    hooks.validateBeforeRename?.(target);
    effective.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
  } catch (cause) {
    if (!ownsTemp) throw cause;
    let scrubbed = false;
    try {
      effective.truncate(tmp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { effective.write(tmp, ""); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      effective.unlink(tmp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) removed = true;
      else {
        try { effective.unlink(tmp); removed = true; }
        catch (retryError) { if (isMissingPathError(retryError)) removed = true; }
      }
    }
    if (!removed && !scrubbed) throw new AtomicWriteSecretResidualError(tmp, { cause });
    if (!removed && !hardened) {
      try { effective.harden(tmp); hardened = true; } catch { /* reported below */ }
    }
    if (removed) forgetEphemeralSecretPath(tmp);
    if (!removed) throw new AtomicWriteResidualTempError(tmp, hardened, { cause });
    throw cause;
  }
}

export function atomicWriteFile(
  path: string,
  content: string,
  io?: AtomicWriteIO,
  hooks: AtomicWriteHooks = {},
): void {
  atomicWriteFileToTarget(path, content, resolveWriteTarget(path), io, hooks);
}

/**
 * Atomically replace the named directory entry without resolving a symlink at
 * that entry. This is for files in directories writable by another process:
 * a raced symlink is replaced, never followed to a more privileged target.
 */
export function atomicWriteFileNoFollow(
  path: string,
  content: string,
  io?: AtomicWriteIO,
  hooks: AtomicWriteHooks = {},
): void {
  // Only the final entry is no-follow: the parent still resolves, because an
  // OS alias above the configured root (a home junction, /tmp) is legitimate
  // and Windows cannot exclusive-create a temp through a junction.
  atomicWriteFileToTarget(path, content, join(resolveWriteTarget(dirname(path)), basename(path)), io, hooks);
}

export interface AtomicWriteAsyncIO {
  write: (path: string, content: string) => void | Promise<void>;
  harden: (path: string) => void | Promise<void>;
  rename: (source: string, destination: string) => void | Promise<void>;
  truncate: (path: string) => void | Promise<void>;
  unlink: (path: string) => void | Promise<void>;
}

export interface AtomicWriteAsyncTestSeam {
  afterTempWrite?: (tempPath: string) => void | Promise<void>;
}

export async function atomicWriteFileAsync(
  path: string,
  content: string,
  io?: AtomicWriteAsyncIO,
  testSeam?: AtomicWriteAsyncTestSeam,
): Promise<void> {
  let ownsTemp = false;
  const effective: AtomicWriteAsyncIO = io ?? {
    write: (tempPath, value) => writePrivateTempFileAsync(tempPath, value, path, () => { ownsTemp = true; }),
    harden: async tempPath => {
      // Same reasoning as the synchronous writer above.
      if (windowsHardeningApplies()) {
        await hardenSecretPathAsync(tempPath, { required: true, timeoutMemoKey: path });
        return;
      }
      try { chmodSync(tempPath, 0o600); } catch { /* platform may ignore chmod */ }
    },
    rename: renameAtomicFileAsync,
    truncate: target => truncateSync(target, 0),
    unlink: unlinkSync,
  };
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let hardened = false;
  let tempWasHardenedBeforeContent = false;
  try {
    if (io) ownsTemp = true;
    await effective.write(tmp, content);
    tempWasHardenedBeforeContent = io === undefined && windowsHardeningApplies();
    await testSeam?.afterTempWrite?.(tmp);
    await effective.harden(tmp);
    hardened = true;
    await effective.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
  } catch (cause) {
    if (!ownsTemp) throw cause;
    // The async ACL belt bounds the writer, but it is not evidence that icacls released this
    // path. Leave the temp in the existing residual state instead of racing an unlink against a
    // live Windows handle. The default Windows writer hardens before writing secret bytes; a
    // failure inside that initial harden leaves its still-empty temp behind.
    if (windowsSecretAclReapPendingForPath(tmp)) {
      throw new AtomicWriteResidualTempError(tmp, tempWasHardenedBeforeContent, { cause });
    }
    let scrubbed = false;
    try {
      await effective.truncate(tmp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { await effective.write(tmp, ""); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      await effective.unlink(tmp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) removed = true;
      else {
        try { await effective.unlink(tmp); removed = true; }
        catch (retryError) { if (isMissingPathError(retryError)) removed = true; }
      }
    }
    if (!removed && !scrubbed) throw new AtomicWriteSecretResidualError(tmp, { cause });
    if (!removed && !hardened) {
      try { await effective.harden(tmp); hardened = true; } catch { /* reported below */ }
    }
    if (removed) forgetEphemeralSecretPath(tmp);
    if (!removed) throw new AtomicWriteResidualTempError(tmp, hardened, { cause });
    throw cause;
  }
}
