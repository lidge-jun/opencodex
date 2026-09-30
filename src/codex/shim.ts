import { migrateLegacyUnixShim } from "./shim-migration";
import { installUnixOverlay, autoRestoreUnixOverlay, overlayDiagnostic, overlayPaths, usableNativeLauncher, uninstallUnixOverlay } from "./shim-overlay";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, extname, join, posix, resolve } from "node:path";
import { durableBunRuntime } from "../lib/bun-runtime";
import type { BunRuntimeSource } from "../lib/bun-runtime";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { isWslRuntime, wslAutomountRoot } from "./home";
import { truncateRetainedUtf8 } from "../lib/admission";
import {
  buildUnixCodexShim,
  buildWindowsCodexShim,
  buildWindowsPowerShellCodexShim,
  gitBashPath,
  SHIM_MARKER,
  UNIX_SHIM_REVISION_MARKER,
} from "./shim-templates";
import {
  hasUsableBackingPath,
  isHealthyShimProbe,
  isVersionManagerOwnedCodexPath,
  restoreWithoutReplacing,
  sameFingerprint,
  sameStableShimPathProbe,
  shimPathFingerprint,
  stableShimPathProbe,
  type ShimPathFingerprint,
  type StableShimPathProbe,
} from "./shim-fingerprint";
import {
  fileErrorCode,
  readState,
  readStateResult,
  stateFiles,
  statePath,
  writeState,
  type ShimFileState,
  type ShimState,
} from "./shim-state-file";
import {
  MAX_DIAGNOSTIC_VALUE_BYTES,
  probeUnixShimFiles,
  type UnixShimProbeResult,
} from "./shim-probe";
import { tryAcquireShimRestoreLock } from "./shim-restore-lock";

export { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim } from "./shim-templates";
export { isVersionManagerOwnedCodexPath } from "./shim-fingerprint";
export { CODEX_SHIM_STATE_MAX_BYTES } from "./shim-state-file";
export { setCodexShimProbeHookForTests, setCodexShimProbeShellForTests, setCodexShimProbeObservationMsForTests } from "./shim-probe";
export type { CodexShimBackingForCommand } from "./shim-inspect";
export { isLocalAbsoluteInspectionPath, inspectCodexShimBackingForCommand } from "./shim-inspect";

export const CODEX_SHIM_REPLACEMENT_STABLE_MS = 100;

let lastShimDiscoveryError: string | null = null;
/** Last human-readable reason discovery returned null (exposed for doctor/tests). */
export function lastCodexDiscoveryError(): string | null {
  return lastShimDiscoveryError;
}

interface InstallCodexShimInternalOptions {
  expectedReplacements?: ReadonlyMap<string, ShimPathFingerprint>;
  allowFreshInstall: boolean;
  beforeGuardedRefresh?: (wrapperPath: string, index: number) => void;
}

export type CodexShimAutoRestoreResult =
  | { status: "not-installed" | "healthy" | "disabled" }
  | { status: "ineligible" | "deferred"; message?: string }
  | { status: "restored"; message: string };

function cliEntry(): { bun: string; bunRuntimeSource: BunRuntimeSource; cli: string } {
  // Bundled Bun path (survives `ocx update`); all three shim builders
  // (Unix / Windows cmd / Windows PowerShell) receive it via this entry.
  // This module lives in src/codex/, the CLI entry in src/cli/index.ts.
  // Path and provenance resolve together so the marker always describes this binary.
  const runtime = durableBunRuntime();
  return { bun: runtime.path, bunRuntimeSource: runtime.source, cli: join(import.meta.dir, "..", "cli", "index.ts") };
}

function commandNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean);
  return [name, ...exts.flatMap(ext => [`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`])];
}

function isShim(path: string): boolean {
  return stableShimPathProbe(path)?.prefix.includes(SHIM_MARKER) ?? false;
}

function isHealthyShim(path: string, platform: NodeJS.Platform): boolean {
  try {
    const content = readFileSync(path, "utf8");
    if (content.length < 180 || !content.includes(SHIM_MARKER) || !content.includes("ensure")) return false;
    if (platform !== "win32" && !content.includes(UNIX_SHIM_REVISION_MARKER)) return false;
    if (platform !== "win32" && (lstatSync(path).mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * A PATH entry that reaches Windows through WSL drive interop
 * (`<automount-root>/<drive>/...`; root defaults to /mnt, configurable via
 * /etc/wsl.conf [automount] root).
 */
export function isWindowsInteropDir(dir: string, automountRoot = "/mnt"): boolean {
  const root = automountRoot.replace(/\/+$/, "");
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}/[a-z](/|$)`, "i").test(dir);
}

export type CodexPathScanDeps = {
  pathValue?: string;
  wsl?: boolean;
  /** Treat PATH entries as POSIX paths (WSL context). Defaults to wsl || non-win32. */
  posixPaths?: boolean;
  automountRoot?: string;
  exists?: (path: string) => boolean;
  isShimFile?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
};

function realIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return true; // unreadable -> treat as unusable
  }
}

export function findCodexOnPath(deps: CodexPathScanDeps = {}): string | null {
  lastShimDiscoveryError = null;
  const exists = deps.exists ?? existsSync;
  const shimFile = deps.isShimFile ?? isShim;
  const isDir = deps.isDirectory ?? realIsDirectory;
  const wsl = deps.wsl ?? (process.platform === "linux" && isWslRuntime());
  const usePosix = deps.posixPaths ?? (wsl || process.platform !== "win32");
  const joinPath = usePosix ? posix.join : join;
  const pathSep = usePosix ? ":" : delimiter;
  const automountRoot = deps.automountRoot ?? (wsl ? wslAutomountRoot() : "/mnt");
  // Windows npm prefixes ship codex.exe/codex.cmd next to the extensionless sh launcher.
  const interopNames = ["codex", "codex.exe", "codex.cmd", "codex.ps1"];
  let skippedInterop: string | null = null;

  for (const dir of (deps.pathValue ?? process.env.PATH ?? "").split(pathSep).filter(Boolean)) {
    if (wsl && isWindowsInteropDir(dir, automountRoot)) {
      // A Windows-side codex reached through WSL PATH interop: a Unix shim written
      // here would embed WSL-only paths and break every Windows-side invocation.
      if (!skippedInterop) {
        for (const name of interopNames) {
          const path = joinPath(dir, name);
          if (exists(path) && !shimFile(path) && !isDir(path)) { skippedInterop = path; break; }
        }
      }
      continue;
    }
    // Interop dirs carry Windows launcher names even when the scan is not skipping them.
    const names = isWindowsInteropDir(dir, automountRoot) ? interopNames : commandNames("codex");
    for (const name of names) {
      const path = joinPath(dir, name);
      if (!deps.exists && process.platform !== "win32" && resolve(path) === resolve(overlayPaths().wrapper)) continue;
      if (!exists(path) || shimFile(path)) continue;
      if (!deps.exists && process.platform !== "win32" && !usableNativeLauncher(path)) continue;
      if (!isDir(path)) return path;
    }
  }

  if (skippedInterop) {
    lastShimDiscoveryError = truncateRetainedUtf8(
      `Found a Windows codex at ${skippedInterop} via WSL PATH interop, but no Linux-side codex. ` +
      "Refusing to shim a Windows launcher from WSL (a WSL shim breaks Windows invocations). " +
      "Install codex inside WSL (npm i -g @openai/codex), or run 'ocx ensure' from Windows to shim the Windows side.",
      MAX_DIAGNOSTIC_VALUE_BYTES,
    );
  }
  return null;
}

function findWindowsCodexTargets(): ShimFileState[] | null {
  lastShimDiscoveryError = null;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const exe = join(dir, "codex.exe");
    if (existsSync(exe) && !isShim(exe)) {
      try {
        if (!lstatSync(exe).isDirectory()) {
          lastShimDiscoveryError = truncateRetainedUtf8(
            `Found codex.exe at ${exe}. Refusing to rename a real .exe because exact codex.exe invocations would break; ` +
            "install a codex.cmd/codex.ps1 launcher or use `ocx service install` for autostart.",
            MAX_DIAGNOSTIC_VALUE_BYTES,
          );
          return null;
        }
      } catch { /* keep scanning */ }
    }

    const cmd = join(dir, "codex.cmd");
    const ps1 = join(dir, "codex.ps1");
    // npm also installs an extensionless `codex` sh launcher for Git-Bash/MSYS shells;
    // leaving it unshimmed means Git-Bash users silently get no autostart.
    const gitBashLauncher = join(dir, "codex");
    const targets: ShimFileState[] = [];
    for (const path of [cmd, ps1, gitBashLauncher]) {
      if (!existsSync(path) || isShim(path)) continue;
      try {
        if (!lstatSync(path).isDirectory()) {
          targets.push({ wrapperPath: path, originalPath: path, backupPath: backupPathFor(path) });
        }
      } catch { /* keep scanning */ }
    }
    if (targets.length > 0) return targets;
  }
  return null;
}

function backupPathFor(path: string): string {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.opencodex-real${ext}` : `${path}.opencodex-real`;
}

/**
 * Why auto-restore refused, in the operator's own terms. Auto-restore used to
 * return a bare `{ status: "ineligible" }`, and the CLI warns only when a
 * message is present, so `ocx start`, `ocx ensure`, and `ocx service repair` all
 * reported success while routing quietly stayed native (#2412, the cause behind
 * the misleading green status in #2411).
 */
function destroyedShimMessage(file: ShimFileState): string {
  const wrapper = existsSync(file.wrapperPath)
    ? stableShimPathProbe(file.wrapperPath)?.prefix.includes(SHIM_MARKER) ? "present but unusable" : "present but not an opencodex shim"
    : "missing";
  const backup = existsSync(file.backupPath) ? "present" : "missing";
  const base = `Codex autostart shim not restored: wrapper ${wrapper} at ${file.wrapperPath}; original backup ${backup} at ${file.backupPath}.`;
  if (!isVersionManagerOwnedCodexPath(file.wrapperPath)) {
    return `${base} Re-run 'ocx codex-shim install' once the Codex binary is stable.`;
  }
  return `${base} This Codex binary is owned by a version manager (mise/asdf/volta), so opencodex will not wrap it as a new original — the next upgrade would overwrite the shim and its backup again. Route through Codex instead with 'ocx start', and use 'ocx service install' for autostart.`;
}

let codexShimGuardedWriteHookForTests: (() => void) | null = null;

/** Narrow deterministic seam for guarded partial-write rollback tests. */
export function setCodexShimGuardedWriteHookForTests(hook: (() => void) | null): void {
  codexShimGuardedWriteHookForTests = hook;
}

function writeShim(wrapperPath: string, realCodexPath: string): { dev: number; ino: number } | undefined {
  const { bun, bunRuntimeSource, cli } = cliEntry();
  if (process.platform === "win32") {
    const lower = wrapperPath.toLowerCase();
    if (lower.endsWith(".ps1")) {
      // UTF-8 BOM: Windows PowerShell 5.1 decodes BOM-less .ps1 files in the ANSI
      // codepage, which mangles non-ASCII paths embedded in the shim.
      writeFileSync(wrapperPath, `\uFEFF${buildWindowsPowerShellCodexShim(realCodexPath, bun, cli, bunRuntimeSource)}`, "utf8");
    } else if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      writeFileSync(wrapperPath, buildWindowsCodexShim(realCodexPath, bun, cli, bunRuntimeSource), "utf8");
    } else {
      // Extensionless Git-Bash sh launcher: sh shim with forward-slash paths.
      writeFileSync(
        wrapperPath,
        buildUnixCodexShim(gitBashPath(realCodexPath), gitBashPath(bun), gitBashPath(cli), bunRuntimeSource, gitBashPath(serviceApiTokenFilePath())),
        "utf8",
      );
    }
    return undefined;
  }
}

function ownedWrapperFingerprint(
  wrapperPath: string,
  written: { dev: number; ino: number } | undefined,
): ShimPathFingerprint | undefined {
  const probe = stableShimPathProbe(wrapperPath);
  if (!probe) return undefined;
  // Platforms that still write in place (Windows) have no staged identity; fall
  // back to the marker check they have always used.
  if (!written) return probe.prefix.includes(SHIM_MARKER) ? probe.fingerprint : undefined;
  if (probe.fingerprint.dev !== written.dev || probe.fingerprint.ino !== written.ino) return undefined;
  return probe.fingerprint;
}

/**
 * Whether the file now at the wrapper path is one this transaction may unlink.
 *
 * The inode our write created is the authority. It stays ours through an in-place
 * truncation — a partial write we must clean up — and stops being ours the moment
 * someone renames a different file over the path, which is exactly the concurrent
 * updater we must not delete. Where no inode was recorded (Windows writes the
 * destination directly), fall back to the exact fingerprint recorded at the time.
 */
function primaryState(files: ShimFileState[]): ShimState {
  const first = files[0]!;
  return { platform: process.platform, ...first, wrappers: files };
}

function replaceOwnedBackup(sourcePath: string, backupPath: string): void {
  const oldBackupPath = `${backupPath}.old-${process.pid}`;
  if (existsSync(oldBackupPath)) unlinkSync(oldBackupPath);
  if (existsSync(backupPath)) renameSync(backupPath, oldBackupPath);
  try {
    renameSync(sourcePath, backupPath);
    if (existsSync(oldBackupPath)) unlinkSync(oldBackupPath);
  } catch (error) {
    if (!existsSync(backupPath) && existsSync(oldBackupPath)) renameSync(oldBackupPath, backupPath);
    throw error;
  }
}

function refreshShimFile(file: ShimFileState): boolean {
  if (file.preserveOnly) {
    if (existsSync(file.originalPath) && !isShim(file.originalPath)) {
      replaceOwnedBackup(file.originalPath, file.backupPath);
      return true;
    }
    return false;
  }
  if (existsSync(file.wrapperPath) && !isShim(file.wrapperPath)) {
    if (file.wrapperPath !== file.originalPath) return false;
    const replacement = stableShimPathProbe(file.wrapperPath);
    if (!replacement) return false;
    return applyGuardedRefreshTransaction([{
      file,
      expectedReplacement: replacement.fingerprint,
      sourcePath: file.wrapperPath,
    }]);
  }
  if (!existsSync(file.wrapperPath) && existsSync(file.backupPath)) {
    writeShim(file.wrapperPath, file.realPath ?? file.backupPath);
    const writtenWrapper = stableShimPathProbe(file.wrapperPath);
    if (!writtenWrapper || !writtenWrapper.prefix.includes(SHIM_MARKER)) {
      return false;
    }
    let unsafe: UnixShimProbeResult = null;
    let probeError: Error | null = null;
    try {
      unsafe = probeUnixShimFiles([file]);
    } catch (error) {
      probeError = error instanceof Error ? error : new Error(String(error));
    }
    const currentWrapper = stableShimPathProbe(file.wrapperPath);
    const wrapperChangedDuringProbe = !currentWrapper
      || !sameFingerprint(currentWrapper.fingerprint, writtenWrapper.fingerprint);
    if (unsafe !== null || probeError || wrapperChangedDuringProbe) {
      if (currentWrapper && sameFingerprint(currentWrapper.fingerprint, writtenWrapper.fingerprint)) {
        unlinkSync(file.wrapperPath);
      }
      if (probeError) throw probeError;
      return false;
    }
    return true;
  }
  if (file.originalPath !== file.wrapperPath && existsSync(file.originalPath) && existsSync(file.wrapperPath) && isShim(file.wrapperPath)) {
    replaceOwnedBackup(file.originalPath, file.backupPath);
    writeShim(file.wrapperPath, file.realPath ?? file.backupPath);
    return true;
  }
  return false;
}

interface GuardedRefreshOperation {
  file: ShimFileState;
  expectedReplacement: ShimPathFingerprint;
  sourcePath: string;
}

interface GuardedRefreshJournalEntry {
  operation: GuardedRefreshOperation;
  stagedOldBackupPath?: string;
  movedReplacementFingerprint?: ShimPathFingerprint;
  replacementMovedToBackup: boolean;
  writtenWrapperFingerprint?: ShimPathFingerprint;
  wrapperWriteStarted: boolean;
}

let guardedRefreshTransactionId = 0;

function planGuardedRefreshTransaction(
  files: readonly ShimFileState[],
  expectedReplacements: ReadonlyMap<string, ShimPathFingerprint>,
): GuardedRefreshOperation[] | null {
  const operations: GuardedRefreshOperation[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.wrapperPath)) return null;
    seen.add(file.wrapperPath);
    if (file.preserveOnly) {
      if (!existsSync(file.backupPath) || existsSync(file.originalPath)) return null;
      continue;
    }
    if (!hasUsableBackingPath(file)) return null;
    const probe = stableShimPathProbe(file.wrapperPath);
    if (!probe) return null;
    const expectedReplacement = expectedReplacements.get(file.wrapperPath);
    if (!expectedReplacement) {
      if (!isHealthyShimProbe(probe, process.platform)) return null;
      continue;
    }
    if (file.wrapperPath !== file.originalPath
      || probe.prefix.includes(SHIM_MARKER)
      || !sameFingerprint(probe.fingerprint, expectedReplacement)) return null;
    operations.push({ file, expectedReplacement, sourcePath: file.wrapperPath });
  }
  if (operations.length !== expectedReplacements.size) return null;
  return operations;
}

function rollbackGuardedRefresh(journal: readonly GuardedRefreshJournalEntry[]): Error[] {
  const rollbackErrors: Error[] = [];
  const attempt = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  };
  for (const entry of [...journal].reverse()) {
    let sourceOccupied = false;
    attempt(() => {
      const wrapper = stableShimPathProbe(entry.operation.file.wrapperPath);
      // No marker-text fallback: the markers are public, so a concurrent updater's
      // wrapper carries them too. No recorded inode identity means not ours.
      const ownsWrapper = entry.wrapperWriteStarted
        && wrapper !== null
        && entry.writtenWrapperFingerprint !== undefined
        && sameFingerprint(wrapper.fingerprint, entry.writtenWrapperFingerprint);
      if (ownsWrapper) {
        unlinkSync(entry.operation.file.wrapperPath);
      } else {
        try {
          lstatSync(entry.operation.sourcePath);
          sourceOccupied = true;
        } catch (error) {
          if (fileErrorCode(error) !== "ENOENT") sourceOccupied = true;
        }
      }
    });
    attempt(() => {
      if (entry.replacementMovedToBackup && existsSync(entry.operation.file.backupPath)) {
        const movedReplacement = stableShimPathProbe(entry.operation.file.backupPath);
        if (!movedReplacement || !entry.movedReplacementFingerprint
          || !sameFingerprint(movedReplacement.fingerprint, entry.movedReplacementFingerprint)) {
          throw new Error("Codex shim guarded refresh backup changed during rollback");
        }
        if (sourceOccupied) unlinkSync(entry.operation.file.backupPath);
        else renameSync(entry.operation.file.backupPath, entry.operation.sourcePath);
      }
    });
    attempt(() => {
      if (entry.stagedOldBackupPath && existsSync(entry.stagedOldBackupPath)) {
        renameSync(entry.stagedOldBackupPath, entry.operation.file.backupPath);
      }
    });
  }
  return rollbackErrors;
}

function applyGuardedRefreshTransaction(
  operations: readonly GuardedRefreshOperation[],
  beforeGuardedRefresh?: (wrapperPath: string, index: number) => void,
  commitState?: () => void,
): boolean {
  const journal: GuardedRefreshJournalEntry[] = [];
  let applyError: Error | null = null;
  let fingerprintMismatch = false;
  let unsafeLauncher = false;
  let wrapperChangedDuringProbe = false;
  const transactionId = `${process.pid}-${++guardedRefreshTransactionId}`;

  for (const [index, operation] of operations.entries()) {
    beforeGuardedRefresh?.(operation.sourcePath, index);
    const probe = stableShimPathProbe(operation.sourcePath);
    if (!probe || !sameFingerprint(probe.fingerprint, operation.expectedReplacement)) {
      fingerprintMismatch = true;
      break;
    }
    const entry: GuardedRefreshJournalEntry = {
      operation,
      replacementMovedToBackup: false,
      wrapperWriteStarted: false,
    };
    journal.push(entry);
    try {
      if (existsSync(operation.file.backupPath)) {
        entry.stagedOldBackupPath = `${operation.file.backupPath}.autorestore-${transactionId}-${index}`;
        if (existsSync(entry.stagedOldBackupPath)) unlinkSync(entry.stagedOldBackupPath);
        renameSync(operation.file.backupPath, entry.stagedOldBackupPath);
      }
      renameSync(operation.sourcePath, operation.file.backupPath);
      entry.replacementMovedToBackup = true;
      const movedReplacement = stableShimPathProbe(operation.file.backupPath);
      if (!movedReplacement) throw new Error("Codex shim guarded refresh could not fingerprint the staged launcher");
      entry.movedReplacementFingerprint = movedReplacement.fingerprint;
      entry.wrapperWriteStarted = true;
      const writtenInode = writeShim(operation.file.wrapperPath, operation.file.realPath ?? operation.file.backupPath);
      // Claim our own partial write before the hook can fail (see fresh install).
      entry.writtenWrapperFingerprint = ownedWrapperFingerprint(operation.file.wrapperPath, writtenInode);
      codexShimGuardedWriteHookForTests?.();
      // Re-check: unset means a concurrent writer owns the path now, so rollback
      // must leave it alone.
      entry.writtenWrapperFingerprint = ownedWrapperFingerprint(operation.file.wrapperPath, writtenInode);
      if (!entry.writtenWrapperFingerprint && !writtenInode) {
        throw new Error("Codex shim guarded refresh could not fingerprint the generated wrapper");
      }
    } catch (error) {
      applyError = error instanceof Error ? error : new Error(String(error));
      break;
    }
  }

  if (!fingerprintMismatch && !applyError) {
    try {
      unsafeLauncher = probeUnixShimFiles(operations.map(operation => operation.file)) !== null;
    } catch (error) {
      applyError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!fingerprintMismatch && !applyError && !unsafeLauncher) {
    wrapperChangedDuringProbe = journal.some(entry => {
      const wrapper = stableShimPathProbe(entry.operation.file.wrapperPath);
      return !wrapper || !entry.writtenWrapperFingerprint
        || !sameFingerprint(wrapper.fingerprint, entry.writtenWrapperFingerprint);
    });
  }

  if (!fingerprintMismatch && !applyError && !unsafeLauncher && !wrapperChangedDuringProbe && commitState) {
    try {
      commitState();
    } catch (error) {
      applyError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (fingerprintMismatch || applyError || unsafeLauncher || wrapperChangedDuringProbe) {
    const rollbackErrors = rollbackGuardedRefresh(journal);
    if (applyError || rollbackErrors.length > 0) {
      throw new AggregateError(
        [...(applyError ? [applyError] : []), ...rollbackErrors],
        "Codex shim guarded refresh failed",
      );
    }
    return false;
  }

  const cleanupErrors: Error[] = [];
  for (const entry of journal) {
    try {
      if (entry.stagedOldBackupPath && existsSync(entry.stagedOldBackupPath)) unlinkSync(entry.stagedOldBackupPath);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex shim guarded refresh cleanup failed");
  return true;
}

function installCodexShimInternal(options: InstallCodexShimInternalOptions): { installed: boolean; message: string } {
  const existing = readState();
  if (existing) {
    const files = stateFiles(existing);
    if (options.expectedReplacements) {
      const operations = planGuardedRefreshTransaction(files, options.expectedReplacements);
      if (!operations || operations.length === 0) {
        return { installed: false, message: "Codex shim auto-restore deferred because tracked launchers changed." };
      }
      const originalStateBytes = readFileSync(statePath());
      const commitState = (): void => {
        try {
          writeState(primaryState(files));
        } catch (writeError) {
          try {
            writeFileSync(statePath(), originalStateBytes);
          } catch (restoreError) {
            throw new AggregateError(
              [writeError, restoreError],
              "Codex shim state commit and restoration failed",
            );
          }
          throw writeError;
        }
      };
      if (!applyGuardedRefreshTransaction(operations, options.beforeGuardedRefresh, commitState)) {
        return { installed: false, message: "Codex shim auto-restore deferred because tracked launchers changed." };
      }
      return {
        installed: true,
        message: `Codex update detected. Backed up new launcher and refreshed shim at ${files.map(f => f.wrapperPath).join(", ")}.`,
      };
    }
    let refreshed = false;
    for (const file of files) refreshed = refreshShimFile(file) || refreshed;
    const allInstalled = files.every(file => file.preserveOnly
      ? existsSync(file.backupPath) && !existsSync(file.originalPath)
      : existsSync(file.wrapperPath)
        && (existsSync(file.backupPath) || (file.realPath ? existsSync(file.realPath) : false))
        && isShim(file.wrapperPath));
    if (refreshed || allInstalled) {
      writeState(primaryState(files));
      if (refreshed) {
        return {
          installed: true,
          message: `Codex update detected. Backed up new launcher and refreshed shim at ${files.map(f => f.wrapperPath).join(", ")}.`,
        };
      }
      return {
        installed: false,
        message: `Codex autostart shim already installed at ${files.map(f => f.wrapperPath).join(", ")}.`,
      };
    }
  }

  if (!options.allowFreshInstall) {
    return { installed: false, message: "Codex shim auto-restore requires a valid prior installation." };
  }

  const targets = findWindowsCodexTargets();
  if (!targets) return { installed: false, message: lastShimDiscoveryError ?? "Could not find a codex executable on PATH." };

  for (const target of targets) {
    if (existsSync(target.backupPath)) return { installed: false, message: `Refusing to overwrite existing backup: ${target.backupPath}` };
  }
  // Unix installation uses shim-overlay.ts; only Windows script launchers reach here.
  for (const target of targets) {
    if (existsSync(target.originalPath)) renameSync(target.originalPath, target.backupPath);
    if (!target.preserveOnly) writeShim(target.wrapperPath, target.realPath ?? target.backupPath);
  }
  writeState(primaryState(targets));
  return {
    installed: true,
    message: `Codex autostart shim installed at ${targets.map(t => t.wrapperPath).join(", ")}. Original saved at ${targets.map(t => t.backupPath).join(", ")}.`,
  };
}

export function installCodexShim(): { installed: boolean; message: string } {
  if (process.platform !== "win32") return installUnixOverlay(findCodexOnPath);
  return installCodexShimInternal({ allowFreshInstall: true });
}

export function autoRestoreCodexShim(options: {
  enabled: () => boolean;
  stabilitySleep?: (ms: number) => void;
  /** Narrow deterministic seam used to hold the interprocess lock in tests. */
  afterRestoreLockAcquired?: () => void;
  /** Narrow deterministic seam for stale-lock compare-and-delete tests. */
  beforeStaleRestoreLockDelete?: () => void;
  /** Narrow deterministic race seam for the guarded transaction tests. */
  beforeGuardedRefresh?: (wrapperPath: string, index: number) => void;
}): CodexShimAutoRestoreResult {
  if (process.platform !== "win32") return autoRestoreUnixOverlay(options.enabled);
  const stateRead = readStateResult();
  const state = stateRead.state;
  if (!state) {
    if (stateRead.warning) return { status: "ineligible", message: stateRead.warning };
    return { status: stateRead.present ? "ineligible" : "not-installed" };
  }
  if (state.platform !== process.platform) return { status: "ineligible" };

  const files = stateFiles(state);
  const replacementProbes = new Map<string, StableShimPathProbe>();
  const seen = new Set<string>();
  let healthyCount = 0;
  for (const file of files) {
    if (seen.has(file.wrapperPath)) return { status: "ineligible" };
    seen.add(file.wrapperPath);
    if (file.preserveOnly) {
      if (!existsSync(file.backupPath) || existsSync(file.originalPath)) {
        return { status: "ineligible", message: destroyedShimMessage(file) };
      }
      continue;
    }
    if (!existsSync(file.wrapperPath) || !hasUsableBackingPath(file)) {
      return { status: "ineligible", message: destroyedShimMessage(file) };
    }
    const probe = stableShimPathProbe(file.wrapperPath);
    if (!probe) return { status: "deferred" };
    if (probe.prefix.includes(SHIM_MARKER)) {
      if (!isHealthyShimProbe(probe, state.platform)) {
        return { status: "ineligible", message: destroyedShimMessage(file) };
      }
      healthyCount += 1;
      continue;
    }
    // A surviving backup would otherwise let the replacement path below wrap the
    // version manager's NEW binary as a fresh original — the same adoption the
    // missing-backup case refuses, arriving through the back door.
    if (isVersionManagerOwnedCodexPath(file.wrapperPath)) {
      return { status: "ineligible", message: destroyedShimMessage(file) };
    }
    replacementProbes.set(file.wrapperPath, probe);
  }

  if (replacementProbes.size === 0) return { status: "healthy" };
  if (!options.enabled()) return { status: "disabled" };
  if (files.length > 1 && healthyCount > 0) {
    return {
      status: "deferred",
      message: "Codex shim auto-restore deferred because tracked launcher siblings are in a mixed shim/replacement state.",
    };
  }

  const lock = tryAcquireShimRestoreLock(options.beforeStaleRestoreLockDelete);
  if (!lock) return { status: "deferred" };
  try {
    options.afterRestoreLockAcquired?.();
    (options.stabilitySleep ?? Bun.sleepSync)(CODEX_SHIM_REPLACEMENT_STABLE_MS);
    const expectedReplacements = new Map<string, ShimPathFingerprint>();
    for (const [path, firstProbe] of replacementProbes) {
      const secondProbe = stableShimPathProbe(path);
      if (!secondProbe || secondProbe.prefix.includes(SHIM_MARKER)
        || !sameStableShimPathProbe(firstProbe, secondProbe)) return { status: "deferred" };
      expectedReplacements.set(path, secondProbe.fingerprint);
    }
    const result = installCodexShimInternal({
      allowFreshInstall: false,
      expectedReplacements,
      beforeGuardedRefresh: options.beforeGuardedRefresh,
    });
    return result.installed
      ? { status: "restored", message: result.message }
      : { status: "deferred" };
  } finally {
    lock.release();
  }
}

export function uninstallCodexShim(): { removed: boolean; message: string } {
  const state = readState();
  if (!state) return { removed: false, message: "Codex autostart shim is not installed." };
  if (state.mode === "path-overlay") return uninstallUnixOverlay(state);
  if (process.platform !== "win32") {
    const lock = tryAcquireShimRestoreLock();
    if (!lock) return { removed: false, message: "Codex shim operation is in progress." };
    try {
      const migrated = migrateLegacyUnixShim(state);
      if (!migrated.launcher) return { removed: false, message: migrated.message };
      unlinkSync(statePath());
      return { removed: true, message: migrated.message };
    } finally { lock.release(); }
  }
  const files = stateFiles(state);
  for (const file of files) {
    if (file.preserveOnly) continue;
    if (existsSync(file.wrapperPath) && isShim(file.wrapperPath)) unlinkSync(file.wrapperPath);
  }
  for (const file of files) {
    if (existsSync(file.backupPath) && !existsSync(file.originalPath)) renameSync(file.backupPath, file.originalPath);
  }
  if (existsSync(statePath())) unlinkSync(statePath());
  return { removed: true, message: `Codex autostart shim removed. Restored ${files.map(f => f.originalPath).join(", ")}.` };
}

/** True if a Codex autostart shim is currently installed (state file present). */
export function isCodexShimInstalled(): boolean {
  return diagnoseCodexShim().installed;
}

export interface CodexShimDiagnostic {
  installed: boolean;
  healthy: boolean;
  runnable?: boolean;
  active?: boolean;
  summary: string;
}

/** Structured, secret-free shim state for CLI/GUI lifecycle diagnostics. */
export function diagnoseCodexShim(): CodexShimDiagnostic {
  const state = readState();
  if (!state) {
    if (existsSync(statePath())) {
      return {
        installed: true,
        healthy: false,
        summary: `Codex autostart shim state is invalid or corrupt at ${statePath()}. Reinstall or remove the shim.`,
      };
    }
    return {
      installed: false,
      healthy: false,
      summary: "Codex autostart shim is not installed.",
    };
  }
  if (state.mode === "path-overlay") return overlayDiagnostic(state);
  const files = stateFiles(state);
  const healthy = files.length > 0 && files.every(file => file.preserveOnly
    ? existsSync(file.backupPath) && !existsSync(file.originalPath)
    : existsSync(file.wrapperPath)
      && (existsSync(file.backupPath) || (file.realPath ? existsSync(file.realPath) : false))
      && isHealthyShim(file.wrapperPath, state.platform));
  const summary = files.map(file => {
    const wrapper = existsSync(file.wrapperPath)
      ? isShim(file.wrapperPath)
        ? "shim present"
        : "present but not an opencodex shim"
      : "missing";
    const backup = existsSync(file.backupPath) ? "present" : "missing";
    return `Codex autostart shim: wrapper ${wrapper} at ${file.wrapperPath}; original backup ${backup} at ${file.backupPath}.`;
  }).join("\n");
  return { installed: true, healthy, summary };
}

export function codexShimStatus(): string {
  return diagnoseCodexShim().summary;
}
