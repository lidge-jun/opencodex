import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  forgetEphemeralSecretPath,
  hardenSecretPath,
  hardenSecretPathAsync,
} from "../lib/windows-secret-acl";
import {
  renameAtomicFile,
  renameAtomicFileAsync,
} from "../lib/windows-atomic-replace";
import { getConfigDir } from "./paths";

let atomicSequence = 0;

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

function writePrivateTempFile(
  path: string,
  content: string,
  timeoutMemoKey: string,
  onCreated: () => void,
): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  onCreated();
  try {
    if (process.platform === "win32") {
      hardenSecretPath(path, { required: true, timeoutMemoKey });
    } else {
      fchmodSync(descriptor, 0o600);
    }
    assertPrivateTempDescriptor(path, descriptor);
    writeFileSync(descriptor, content, { encoding: "utf-8" });
  } finally {
    closeSync(descriptor);
  }
}

async function writePrivateTempFileAsync(
  path: string,
  content: string,
  timeoutMemoKey: string,
  onCreated: () => void,
): Promise<void> {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  onCreated();
  try {
    if (process.platform === "win32") {
      await hardenSecretPathAsync(path, { required: true, timeoutMemoKey });
    } else {
      fchmodSync(descriptor, 0o600);
    }
    assertPrivateTempDescriptor(path, descriptor);
    writeFileSync(descriptor, content, { encoding: "utf-8" });
  } finally {
    closeSync(descriptor);
  }
}

export function atomicWriteFile(
  path: string,
  content: string,
  io?: AtomicWriteIO,
  hooks: AtomicWriteHooks = {},
): void {
  recordOwnedConfigPath(getConfigDir(), path);
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let hardened = false;
  let ownsTemp = false;
  const effective: AtomicWriteIO = io ?? {
    write: (tempPath, value) => writePrivateTempFile(tempPath, value, path, () => { ownsTemp = true; }),
    harden: tempPath => {
      try { chmodSync(tempPath, 0o600); } catch { /* platform may ignore chmod */ }
      if (process.platform === "win32") {
        hardenSecretPath(tempPath, { required: true, timeoutMemoKey: path });
      }
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
      try { chmodSync(tempPath, 0o600); } catch { /* platform may ignore chmod */ }
      if (process.platform === "win32") {
        await hardenSecretPathAsync(tempPath, { required: true, timeoutMemoKey: path });
      }
    },
    rename: renameAtomicFileAsync,
    truncate: target => truncateSync(target, 0),
    unlink: unlinkSync,
  };
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let hardened = false;
  try {
    if (io) ownsTemp = true;
    await effective.write(tmp, content);
    await testSeam?.afterTempWrite?.(tmp);
    await effective.harden(tmp);
    hardened = true;
    await effective.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
  } catch (cause) {
    if (!ownsTemp) throw cause;
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
