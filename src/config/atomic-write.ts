import {
  chmodSync,
  lstatSync,
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
  beforeRename?: (tempPath: string, targetPath: string) => void;
  replace?: (tempPath: string, targetPath: string, rename: () => void) => void;
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

export function atomicWriteFile(path: string, content: string, io: AtomicWriteIO = {
  write: (target, value) => writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 }),
  harden: target => {
    try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
    if (process.platform === "win32") hardenSecretPath(target, { required: true, timeoutMemoKey: path });
  },
  rename: renameAtomicFile,
  truncate: target => truncateSync(target, 0),
  unlink: unlinkSync,
}, hooks: AtomicWriteHooks = {}): void {
  recordOwnedConfigPath(getConfigDir(), path);
  const target = resolveWriteTarget(path);
  assertResolvedTargetAllowed(path, target);
  const tmp = `${target}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let hardened = false;
  try {
    io.write(tmp, content);
    io.harden(tmp);
    hardened = true;
    if (hooks.replace) {
      hooks.replace(tmp, target, () => io.rename(tmp, target));
    } else {
      hooks.beforeRename?.(tmp, target);
      io.rename(tmp, target);
    }
    forgetEphemeralSecretPath(tmp);
  } catch (cause) {
    let scrubbed = false;
    try {
      io.truncate(tmp);
      scrubbed = true;
    } catch (error) {
      if (isMissingPathError(error)) scrubbed = true;
      else {
        try { io.write(tmp, ""); scrubbed = true; } catch { /* removal may still succeed */ }
      }
    }
    let removed = false;
    try {
      io.unlink(tmp);
      removed = true;
    } catch (error) {
      if (isMissingPathError(error)) removed = true;
      else {
        try { io.unlink(tmp); removed = true; }
        catch (retryError) { if (isMissingPathError(retryError)) removed = true; }
      }
    }
    if (!removed && !scrubbed) throw new AtomicWriteSecretResidualError(tmp, { cause });
    if (!removed && !hardened) {
      try { io.harden(tmp); hardened = true; } catch { /* reported below */ }
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
  const effective: AtomicWriteAsyncIO = io ?? {
    write: (target, value) => writeFileSync(target, value, { encoding: "utf-8", mode: 0o600 }),
    harden: async target => {
      try { chmodSync(target, 0o600); } catch { /* platform may ignore chmod */ }
      if (process.platform === "win32") {
        await hardenSecretPathAsync(target, { required: true, timeoutMemoKey: path });
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
    await effective.write(tmp, content);
    await testSeam?.afterTempWrite?.(tmp);
    await effective.harden(tmp);
    hardened = true;
    await effective.rename(tmp, target);
    forgetEphemeralSecretPath(tmp);
  } catch (cause) {
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
