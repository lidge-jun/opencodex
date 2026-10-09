import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, extname, join, posix, win32 } from "node:path";
import { durableBunRuntime, type DurableBunRuntime } from "../lib/bun-runtime";
import { assertSelectedRuntimeWritable, RuntimePreflightError, type RuntimePreflightDeps } from "../lib/bun-runtime-preflight";
import { getConfigDir } from "../config";
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
  isCurrentUnixShimProbe,
  isHealthyShimProbe,
  isVersionManagerOwnedCodexPath,
  restoreWithoutReplacing,
  sameFingerprint,
  sameFingerprintAfterRename,
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
  CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS,
  MAX_DIAGNOSTIC_VALUE_BYTES,
  probeUnixShimFiles,
  type UnixShimProbeResult,
} from "./shim-probe";
import { tryAcquireShimRestoreLock } from "./shim-restore-lock";
import {
  isWindowsInteropDir,
  isExecutableCodexCandidate,
  inspectShimFile,
  realIsDirectory,
  resolveStableFnmCodexPath,
  type CodexPathScanDeps,
} from "./shim-path-resolution";

export { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim } from "./shim-templates";
export { isVersionManagerOwnedCodexPath } from "./shim-fingerprint";
export { CODEX_SHIM_STATE_MAX_BYTES } from "./shim-state-file";
export { setCodexShimProbeHookForTests, setCodexShimProbeShellForTests, setCodexShimProbeObservationMsForTests } from "./shim-probe";
export type { CodexShimBackingForCommand } from "./shim-inspect";
export type { CodexPathScanDeps } from "./shim-path-resolution";
export { isWindowsInteropDir } from "./shim-path-resolution";
export { isLocalAbsoluteInspectionPath, inspectCodexShimBackingForCommand } from "./shim-inspect";

import { isShim, diagnoseCodexShim } from "./shim-diagnostics";
import { installUnixOverlay, autoRestoreUnixOverlay, uninstallUnixCodexShim, overlayPaths } from "./shim-overlay";
export { diagnoseCodexShim, codexShimStatus, type CodexShimDiagnostic } from "./shim-diagnostics";

export const CODEX_SHIM_REPLACEMENT_STABLE_MS = 100;

let lastShimDiscoveryError: string | null = null;
/** Last human-readable reason discovery returned null (exposed for doctor/tests). */
export function lastCodexDiscoveryError(): string | null {
  return lastShimDiscoveryError;
}

interface InstallCodexShimInternalOptions extends RuntimePreflightDeps {
  runtime?: DurableBunRuntime;
  runtimeAdmitted?: boolean;
  expectedReplacements?: ReadonlyMap<string, ShimPathFingerprint>;
  allowFreshInstall: boolean;
  beforeGuardedRefresh?: (wrapperPath: string, index: number) => void;
}

function discoveredCodexPath(path: string, posixPaths: boolean, realpath?: (path: string) => string): string | null {
  const resolved = resolveStableFnmCodexPath(path, posixPaths, realpath);
  if (resolved !== null) return resolved;
  lastShimDiscoveryError = truncateRetainedUtf8(
    `Found codex at ${path} inside fnm's temporary multishell path, but it did not resolve to a durable Node installation. `
    + "Refusing to install a shim; retry after fnm selects a stable installation.",
    MAX_DIAGNOSTIC_VALUE_BYTES,
  );
  return null;
}

export type CodexShimAutoRestoreResult =
  | { status: "not-installed" | "healthy" | "disabled" }
  | { status: "ineligible" | "deferred"; message?: string }
  | { status: "restored"; message: string };

function cliEntry(runtime: DurableBunRuntime = durableBunRuntime()): { bun: string; bunRuntimeSource: BunRuntimeSource; cli: string } {
  // Bundled Bun path (survives `ocx update`); all three shim builders
  // (Unix / Windows cmd / Windows PowerShell) receive it via this entry.
  // This module lives in src/codex/, the CLI entry in src/cli/index.ts.
  // Path and provenance resolve together so the marker always describes this binary.
  return { bun: runtime.path, bunRuntimeSource: runtime.source, cli: join(import.meta.dir, "..", "cli", "index.ts") };
}

function commandNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean);
  return [name, ...exts.flatMap(ext => [`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`])];
}

export function findCodexOnPath(deps: CodexPathScanDeps = {}): string | null {
  lastShimDiscoveryError = null;
  const exists = deps.exists ?? existsSync;
  const shimFile = deps.isShimFile ?? (process.platform === "win32" ? isShim : (path: string) => inspectShimFile(path) !== false);
  const isDir = deps.isDirectory ?? realIsDirectory;
  const eligible = deps.executableEligible ?? (deps.exists ? () => true : isExecutableCodexCandidate);
  const wsl = deps.wsl ?? (process.platform === "linux" && isWslRuntime());
  const usePosix = deps.posixPaths ?? (wsl || process.platform !== "win32");
  // The injected path flavour governs join and separator alike; host-native `join` and
  // `delimiter` made a Windows-flavoured scan split `C:\...` on a Linux host.
  const joinPath = usePosix ? posix.join : win32.join;
  const pathSep = usePosix ? ":" : win32.delimiter;
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
      if (!exists(path)) continue;
      if (usePosix && (path === overlayPaths().wrapper || !eligible(path))) continue;
      if (shimFile(path)) continue;
      if (!isDir(path)) {
        const resolved = discoveredCodexPath(path, usePosix, deps.realpath);
        if (resolved !== null) return resolved;
        return null;
      }
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
    const stableExe = existsSync(exe) && !isShim(exe) ? discoveredCodexPath(exe, false) : exe;
    if (stableExe === null) return null;
    if (existsSync(stableExe) && !isShim(stableExe)) {
      try {
        if (!lstatSync(stableExe).isDirectory()) {
          lastShimDiscoveryError = truncateRetainedUtf8(
            `Found codex.exe at ${stableExe}. Refusing to rename a real .exe because exact codex.exe invocations would break; ` +
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
      const stablePath = discoveredCodexPath(path, false);
      if (stablePath === null) return null;
      if (!existsSync(stablePath) || isShim(stablePath)) continue;
      try {
        if (!lstatSync(stablePath).isDirectory()) {
          targets.push({ wrapperPath: stablePath, originalPath: stablePath, backupPath: backupPathFor(stablePath) });
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
let codexShimFreshWriteHookForTests: (() => void) | null = null;
let codexShimRollbackRestoreHookForTests: ((target: ShimFileState) => void) | null = null;

/** Narrow deterministic seam for guarded partial-write rollback tests. */
export function setCodexShimGuardedWriteHookForTests(hook: (() => void) | null): void {
  codexShimGuardedWriteHookForTests = hook;
}

/** Narrow deterministic seam for fresh-install partial-write rollback tests. */
export function setCodexShimFreshWriteHookForTests(hook: (() => void) | null): void {
  codexShimFreshWriteHookForTests = hook;
}

/**
 * @internal Test-only seam for the rollback restore race.
 *
 * The window this closes opens after `sourceOccupied` is sampled and closes when
 * the backup is republished, so no earlier hook can reach it: publishing from
 * the fresh-write hook makes `sourceOccupied` true and skips the restore
 * entirely.
 */
export function setCodexShimRollbackRestoreHookForTests(
  hook: ((target: ShimFileState) => void) | null,
): void {
  codexShimRollbackRestoreHookForTests = hook;
}

interface FreshShimInstallJournalEntry {
  target: ShimFileState;
  movedOriginalFingerprint?: ShimPathFingerprint;
  originalMovedToBackup: boolean;
  writtenWrapperFingerprint?: ShimPathFingerprint;
  wrapperWriteStarted: boolean;
  /** dev/ino of the file our `writeShim()` created, recorded before anything can fail. */
  writtenWrapperInode?: { dev: number; ino: number };
}

function rollbackFreshShimInstall(journal: readonly FreshShimInstallJournalEntry[]): void {
  const errors: Error[] = [];
  for (const entry of [...journal].reverse()) {
    const target = entry.target;
    let sourceOccupied = false;
    let ownsWrapperNow = false;
    try {
      const wrapper = stableShimPathProbe(target.wrapperPath);
      // Ownership is the inode our own write created. There is no marker-text
      // fallback: the markers are public, so a concurrent updater's wrapper carries
      // them too, and treating that as proof is how we would delete a file we never
      // wrote. An in-place truncation of our file keeps the inode and is still ours
      // to clean up; a replacement renamed over it has a different inode and is not.
      const ownsWrapper = !target.preserveOnly
        && entry.wrapperWriteStarted
        && wrapper !== null
        && wrapperInodeIsOurs(wrapper, entry.writtenWrapperInode, entry.writtenWrapperFingerprint);
      ownsWrapperNow = ownsWrapper;
      if (ownsWrapper) unlinkSync(target.wrapperPath);
      else {
        try {
          lstatSync(target.originalPath);
          sourceOccupied = true;
        } catch (error) {
          if (fileErrorCode(error) !== "ENOENT") sourceOccupied = true;
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      if (entry.originalMovedToBackup && existsSync(target.backupPath)) {
        const movedOriginal = shimPathFingerprint(target.backupPath);
        if (!movedOriginal || !entry.movedOriginalFingerprint
          || !sameFingerprint(movedOriginal, entry.movedOriginalFingerprint)) {
          throw new Error("Codex shim fresh-install backup changed during rollback");
        }
        if (sourceOccupied) {
          // Something else occupies the source path. Dropping the backup is correct
          // only when that something is a file we own; when a concurrent updater
          // owns it, this backup is the user's real launcher and deleting it would
          // lose the command entirely. Keep it in that case — a stray
          // `codex.opencodex-real` is recoverable, a deleted launcher is not.
          if (ownsWrapperNow) unlinkSync(target.backupPath);
        } else {
          // No-replace: sourceOccupied was sampled earlier, so a concurrent
          // installer may have published a launcher at the original path since.
          codexShimRollbackRestoreHookForTests?.(target);
          restoreWithoutReplacing(target.backupPath, target.originalPath);
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Codex shim install validation rollback failed");
}

/**
 * Write the wrapper and return the identity of the inode this call created, or
 * `undefined` where the platform still writes the destination in place.
 *
 * Callers must derive ownership from the returned identity rather than from a
 * later `stat` of `wrapperPath`: the shim markers are public, so a concurrent
 * updater's wrapper can carry them, and a replacement landing between the write
 * and the observation is otherwise indistinguishable from our own file.
 */
function writeShim(wrapperPath: string, realCodexPath: string, runtime?: DurableBunRuntime): { dev: number; ino: number } | undefined {
  const { bun, bunRuntimeSource, cli } = cliEntry(runtime);
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
  } else {
    // Stage the wrapper as its own inode and rename it into place, so ownership
    // comes from the write itself rather than from observing the path afterwards.
    // Writing the destination directly leaves a window in which a concurrent
    // updater can replace the file between our write and our fingerprint; we would
    // then adopt that replacement as ours and unlink it during rollback, deleting
    // an executable we never wrote.
    // Hidden and non-executable while staged, so a crash between the write and the
    // rename cannot leave an executable `codex*` artifact that a glob or a shell
    // completion would surface.
    const staged = join(dirname(wrapperPath), `.${basename(wrapperPath)}.opencodex-staging.${process.pid}.${randomUUID()}`);
    let renamed = false;
    try {
      // "wx" fails if the staging path somehow exists, so we never inherit a file.
      writeFileSync(staged, buildUnixCodexShim(realCodexPath, bun, cli, bunRuntimeSource), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const stagedStat = lstatSync(staged);
      chmodSync(staged, 0o755);
      renameSync(staged, wrapperPath);
      renamed = true;
      // rename() preserves dev/ino and updates ctime, so identity is the inode
      // pair, captured from the file we created rather than from the destination.
      return { dev: stagedStat.dev, ino: stagedStat.ino };
    } finally {
      if (!renamed) {
        try { unlinkSync(staged); } catch { /* best-effort: nothing to clean up */ }
      }
    }
  }
}

/**
 * The fingerprint to record as "we wrote this", or `undefined` when the file at
 * `wrapperPath` is not the inode `writeShim()` created. Returning `undefined`
 * makes every rollback path treat the file as someone else's and leave it alone.
 */
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
function wrapperInodeIsOurs(
  wrapper: StableShimPathProbe,
  written: { dev: number; ino: number } | undefined,
  recorded: ShimPathFingerprint | undefined,
): boolean {
  // A different inode is conclusive: someone renamed their own file over ours.
  if (written && (wrapper.fingerprint.dev !== written.dev || wrapper.fingerprint.ino !== written.ino)) {
    return false;
  }
  // Same inode is not sufficient on its own — an in-place truncation (shell `>`,
  // writeFileSync) keeps it while replacing the contents. When we recorded a full
  // fingerprint, require it to still match; that covers our own partial write,
  // whose fingerprint we record before anything can fail.
  if (recorded !== undefined) return sameFingerprint(wrapper.fingerprint, recorded);
  // No recorded fingerprint: only the inode identity we captured at write time can
  // speak for us, and there is nothing else to distinguish this file.
  return written !== undefined;
}

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

function refreshShimFile(file: ShimFileState, runtime: DurableBunRuntime): boolean {
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
    }], undefined, undefined, runtime);
  }
  if (!existsSync(file.wrapperPath) && existsSync(file.backupPath)) {
    writeShim(file.wrapperPath, file.realPath ?? file.backupPath, runtime);
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
    writeShim(file.wrapperPath, file.realPath ?? file.backupPath, runtime);
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
  runtime?: DurableBunRuntime,
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
      const writtenInode = writeShim(operation.file.wrapperPath, operation.file.realPath ?? operation.file.backupPath, runtime);
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

interface ObsoleteUnixShimJournalEntry {
  file: ShimFileState;
  stagedWrapperPath: string;
  priorWrapperFingerprint: ShimPathFingerprint;
  backingFingerprint: ShimPathFingerprint;
  writtenWrapperFingerprint?: ShimPathFingerprint;
  wrapperWriteStarted: boolean;
}

function rollbackObsoleteUnixShimRefresh(journal: readonly ObsoleteUnixShimJournalEntry[]): Error[] {
  const errors: Error[] = [];
  const attempt = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  };
  for (const entry of [...journal].reverse()) {
    attempt(() => {
      const wrapper = stableShimPathProbe(entry.file.wrapperPath);
      const ownsWrapper = entry.wrapperWriteStarted
        && wrapper !== null
        && (entry.writtenWrapperFingerprint
          ? sameFingerprint(wrapper.fingerprint, entry.writtenWrapperFingerprint)
          : wrapper.prefix.includes(UNIX_SHIM_REVISION_MARKER));
      if (ownsWrapper) unlinkSync(entry.file.wrapperPath);
    });
    attempt(() => {
      if (!existsSync(entry.stagedWrapperPath)) return;
      if (existsSync(entry.file.wrapperPath)) unlinkSync(entry.stagedWrapperPath);
      else renameSync(entry.stagedWrapperPath, entry.file.wrapperPath);
    });
  }
  return errors;
}

type ObsoleteUnixShimRefreshResult =
  | { installed: true; message: string }
  | { installed: false; deferred: boolean; message: string };

function refreshObsoleteUnixShims(files: readonly ShimFileState[], runtime?: DurableBunRuntime): ObsoleteUnixShimRefreshResult {
  if (process.platform === "win32") {
    return { installed: false, deferred: false, message: "Codex autostart shim is already current." };
  }
  const candidates = files.filter(file => {
    if (file.preserveOnly || file.wrapperPath !== file.originalPath || !existsSync(file.wrapperPath)) return false;
    const probe = stableShimPathProbe(file.wrapperPath);
    return probe !== null && probe.prefix.includes(SHIM_MARKER) && !isCurrentUnixShimProbe(probe);
  });
  if (candidates.length === 0) {
    return { installed: false, deferred: true, message: "Codex autostart shim upgrade deferred because tracked launchers changed." };
  }

  const journal: ObsoleteUnixShimJournalEntry[] = [];
  const transactionId = `${process.pid}-${randomUUID()}`;
  let applyError: Error | null = null;
  for (const [index, file] of candidates.entries()) {
    const wrapper = stableShimPathProbe(file.wrapperPath);
    const backing = stableShimPathProbe(file.backupPath);
    if (!wrapper || !wrapper.prefix.includes(SHIM_MARKER) || isCurrentUnixShimProbe(wrapper) || !backing) {
      applyError = new Error("Codex autostart shim upgrade inputs changed before regeneration");
      break;
    }
    const entry: ObsoleteUnixShimJournalEntry = {
      file,
      stagedWrapperPath: `${file.wrapperPath}.upgrade-${transactionId}-${index}`,
      priorWrapperFingerprint: wrapper.fingerprint,
      backingFingerprint: backing.fingerprint,
      wrapperWriteStarted: false,
    };
    journal.push(entry);
    try {
      renameSync(file.wrapperPath, entry.stagedWrapperPath);
      const stagedWrapper = stableShimPathProbe(entry.stagedWrapperPath);
      if (!stagedWrapper
        || !sameFingerprintAfterRename(stagedWrapper.fingerprint, entry.priorWrapperFingerprint)) {
        throw new Error("Codex autostart shim upgrade could not fingerprint the staged wrapper");
      }
      entry.wrapperWriteStarted = true;
      const writtenInode = writeShim(file.wrapperPath, file.realPath ?? file.backupPath, runtime);
      const writtenWrapper = stableShimPathProbe(file.wrapperPath);
      if (!writtenWrapper || !isCurrentUnixShimProbe(writtenWrapper)) {
        throw new Error("Codex autostart shim upgrade could not fingerprint the regenerated wrapper");
      }
      // Identity is the inode we created; a replacement that landed since the
      // rename leaves this unset so rollback treats the file as someone else's.
      entry.writtenWrapperFingerprint = ownedWrapperFingerprint(file.wrapperPath, writtenInode);
    } catch (error) {
      applyError = error instanceof Error ? error : new Error(String(error));
      break;
    }
  }

  let unsafe: UnixShimProbeResult = null;
  let probeError: Error | null = null;
  if (!applyError) {
    try {
      unsafe = probeUnixShimFiles(candidates);
    } catch (error) {
      probeError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const changedDuringProbe = !applyError && !probeError && journal.some(entry => {
    const wrapper = stableShimPathProbe(entry.file.wrapperPath);
    const backing = stableShimPathProbe(entry.file.backupPath);
    return !wrapper || !entry.writtenWrapperFingerprint
      || !sameFingerprint(wrapper.fingerprint, entry.writtenWrapperFingerprint)
      || !backing || !sameFingerprint(backing.fingerprint, entry.backingFingerprint);
  });

  if (applyError || probeError || changedDuringProbe) {
    const rollbackErrors = rollbackObsoleteUnixShimRefresh(journal);
    if (applyError || probeError || rollbackErrors.length > 0) {
      throw new AggregateError(
        [...(applyError ? [applyError] : []), ...(probeError ? [probeError] : []), ...rollbackErrors],
        "Codex autostart shim upgrade failed",
      );
    }
    return { installed: false, deferred: true, message: "Codex autostart shim upgrade deferred because tracked launchers changed." };
  }

  if (unsafe) {
    const cleanupErrors: Error[] = [];
    for (const entry of [...journal].reverse()) {
      try {
        const wrapper = stableShimPathProbe(entry.file.wrapperPath);
        if (!wrapper || !entry.writtenWrapperFingerprint
          || !sameFingerprint(wrapper.fingerprint, entry.writtenWrapperFingerprint)) {
          throw new Error("Codex autostart shim upgrade lost wrapper ownership before removal");
        }
        const backing = stableShimPathProbe(entry.file.backupPath);
        if (!backing || !sameFingerprint(backing.fingerprint, entry.backingFingerprint)) {
          throw new Error("Codex autostart shim upgrade backing launcher changed before restoration");
        }
        unlinkSync(entry.file.wrapperPath);
        renameSync(entry.file.backupPath, entry.file.originalPath);
        if (existsSync(entry.stagedWrapperPath)) unlinkSync(entry.stagedWrapperPath);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Codex autostart shim upgrade safety removal failed");
    }
    if (existsSync(statePath())) unlinkSync(statePath());
    return {
      installed: false,
      deferred: false,
      message: "Removed an obsolete Codex autostart shim because its saved launcher failed current validation. The original launcher was restored; reinstall Codex as a concrete executable before enabling codexAutoStart.",
    };
  }

  const cleanupErrors: Error[] = [];
  for (const entry of journal) {
    try {
      if (existsSync(entry.stagedWrapperPath)) unlinkSync(entry.stagedWrapperPath);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Codex autostart shim upgrade cleanup failed");
  return {
    installed: true,
    message: `Upgraded Codex autostart shim at ${candidates.map(file => file.wrapperPath).join(", ")} and validated the saved launcher.`,
  };
}

function installCodexShimInternal(options: InstallCodexShimInternalOptions): { installed: boolean; message: string } {
  const existing = readState();
  const filesBefore = existing ? stateFiles(existing) : [];
  if (filesBefore.length > 0 && filesBefore.every(file => {
    if (file.preserveOnly) return existsSync(file.backupPath) && !existsSync(file.originalPath);
    const probe = stableShimPathProbe(file.wrapperPath);
    return hasUsableBackingPath(file) && probe !== null && isHealthyShimProbe(probe, process.platform);
  })) {
    return { installed: false, message: "Codex autostart shim is already installed." };
  }
  const runtime = options.runtime ?? Object.freeze({ ...(options.selectRuntime ?? durableBunRuntime)() });
  if (!options.runtimeAdmitted) {
    const configDir = (options.configDir ?? getConfigDir)();
    (options.assertRuntimeWritable ?? assertSelectedRuntimeWritable)(runtime, configDir, { rootWasAbsent: !existsSync(configDir) });
  }
  if (existing) {
    const files = stateFiles(existing);
    if (!options.expectedReplacements && process.platform !== "win32") {
      const hasObsoleteShim = files.some(file => {
        if (file.preserveOnly) return false;
        const probe = stableShimPathProbe(file.wrapperPath);
        return probe !== null && probe.prefix.includes(SHIM_MARKER) && !isCurrentUnixShimProbe(probe);
      });
      if (hasObsoleteShim) return refreshObsoleteUnixShims(files);
    }
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
      if (!applyGuardedRefreshTransaction(operations, options.beforeGuardedRefresh, commitState, runtime)) {
        return { installed: false, message: "Codex shim auto-restore deferred because tracked launchers changed." };
      }
      return {
        installed: true,
        message: `Codex update detected. Backed up new launcher and refreshed shim at ${files.map(f => f.wrapperPath).join(", ")}.`,
      };
    }
    let refreshed = false;
    for (const file of files) refreshed = refreshShimFile(file, runtime) || refreshed;
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

  const targets: ShimFileState[] | null = process.platform === "win32"
    ? findWindowsCodexTargets()
    : (() => {
      const originalPath = findCodexOnPath();
      return originalPath ? [{ wrapperPath: originalPath, originalPath, backupPath: backupPathFor(originalPath) }] : null;
    })();
  if (!targets) return { installed: false, message: lastShimDiscoveryError ?? "Could not find a codex executable on PATH." };

  for (const target of targets) {
    if (existsSync(target.backupPath)) return { installed: false, message: `Refusing to overwrite existing backup: ${target.backupPath}` };
  }
  const freshJournal: FreshShimInstallJournalEntry[] = [];
  let freshApplyError: Error | null = null;
  for (const target of targets) {
    const entry: FreshShimInstallJournalEntry = {
      target,
      originalMovedToBackup: false,
      wrapperWriteStarted: false,
    };
    freshJournal.push(entry);
    try {
      if (existsSync(target.originalPath)) {
        renameSync(target.originalPath, target.backupPath);
        entry.originalMovedToBackup = true;
        // Metadata-only, and before the content probe: an empty or otherwise
        // unprobeable launcher must still be restorable during rollback.
        //
        // Only Unix reaches the rollback path (Windows rethrows freshApplyError
        // without rolling back), so only Unix may treat a missing fingerprint as
        // fatal. Throwing here on Windows would abort AFTER the original moved,
        // stranding the launcher at its backup path with nothing to restore it.
        const movedOriginalFingerprint = shimPathFingerprint(target.backupPath);
        if (movedOriginalFingerprint) entry.movedOriginalFingerprint = movedOriginalFingerprint;
        if (process.platform !== "win32") {
          if (!movedOriginalFingerprint) {
            throw new Error("Codex shim fresh install could not fingerprint the staged launcher");
          }
          const movedOriginal = stableShimPathProbe(target.backupPath);
          // A content probe still runs where it can, purely as a consistency
          // check: disagreement means the file moved under us mid-install.
          if (movedOriginal && !sameFingerprint(movedOriginal.fingerprint, movedOriginalFingerprint)) {
            throw new Error("Codex shim fresh install staged launcher changed while being fingerprinted");
          }
        }
      }
      if (!target.preserveOnly) {
        entry.wrapperWriteStarted = true;
        const writtenInode = writeShim(target.wrapperPath, target.realPath ?? target.backupPath, runtime);
        entry.writtenWrapperInode = writtenInode;
        codexShimFreshWriteHookForTests?.();
        if (process.platform !== "win32") {
          if (!writtenInode) throw new Error("Codex shim fresh install could not fingerprint the generated wrapper");
          entry.writtenWrapperFingerprint = ownedWrapperFingerprint(target.wrapperPath, writtenInode);
        }
      }
    } catch (error) {
      freshApplyError = error instanceof Error ? error : new Error(String(error));
      break;
    }
  }
  if (process.platform !== "win32") {
    if (freshApplyError) {
      try {
        rollbackFreshShimInstall(freshJournal);
      } catch (rollbackError) {
        throw new AggregateError([freshApplyError, rollbackError], "Codex shim installation and rollback failed");
      }
      throw freshApplyError;
    }
    let unsafe: UnixShimProbeResult = null;
    let probeError: Error | null = null;
    try {
      unsafe = probeUnixShimFiles(targets);
    } catch (error) {
      probeError = error instanceof Error ? error : new Error(String(error));
    }
    if (probeError) {
      try {
        rollbackFreshShimInstall(freshJournal);
      } catch (rollbackError) {
        throw new AggregateError([probeError, rollbackError], "Codex shim probe and install rollback failed");
      }
      throw probeError;
    }
    const wrapperChangedDuringProbe = freshJournal.some(entry => {
      if (entry.target.preserveOnly) return false;
      const wrapper = stableShimPathProbe(entry.target.wrapperPath);
      return !wrapper || !entry.writtenWrapperFingerprint
        || !sameFingerprint(wrapper.fingerprint, entry.writtenWrapperFingerprint);
    });
    if (unsafe || wrapperChangedDuringProbe) {
      rollbackFreshShimInstall(freshJournal);
      const reason = wrapperChangedDuringProbe
        ? "the generated wrapper changed during its validation probe"
        : unsafe === "recursive"
        ? "the saved launcher resolved back to the generated shim"
        : unsafe === "timeout"
          ? `the saved launcher did not finish --version within ${CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS}ms`
          : unsafe === "descendants"
            ? "the saved launcher left background descendants running after --version"
            : unsafe !== null && typeof unsafe === "object"
              ? `the saved launcher's probe process group could not be terminated cleanly [phase=${unsafe.phase}; code=${unsafe.code}; status=${unsafe.status ?? "none"}; signal=${unsafe.signal}]`
              : "the saved launcher failed its --version probe";
      return {
        installed: false,
        message: wrapperChangedDuringProbe
          ? `Refusing Codex autostart shim because ${reason}. The concurrent launcher was preserved, and your previous launcher was kept alongside it as \`<codex>.opencodex-real\`; retry after the Codex update finishes, and remove that backup once you are satisfied the launcher on PATH is the one you want.`
          : `Refusing Codex autostart shim because ${reason}. The original launcher was restored; reinstall Codex as a concrete executable before enabling codexAutoStart.`,
      };
    }
  } else if (freshApplyError) {
    throw freshApplyError;
  }
  writeState(primaryState(targets));
  return {
    installed: true,
    message: `Codex autostart shim installed at ${targets.map(t => t.wrapperPath).join(", ")}. Original saved at ${targets.map(t => t.backupPath).join(", ")}.`,
  };
}

export function installCodexShim(deps: RuntimePreflightDeps = {}): { installed: boolean; message: string; refused?: boolean; runnable?: boolean } {
  if (process.platform !== "win32") return installUnixOverlay(findCodexOnPath);
  return installCodexShimInternal({ ...deps, allowFreshInstall: true });
}

export function autoRestoreCodexShim(options: RuntimePreflightDeps & {
  enabled: () => boolean;
  stabilitySleep?: (ms: number) => void;
  /** Narrow deterministic seam used to hold the interprocess lock in tests. */
  afterRestoreLockAcquired?: () => void;
  /** Narrow deterministic seam for stale-lock compare-and-delete tests. */
  beforeStaleRestoreLockDelete?: () => void;
  /** Narrow deterministic race seam for the guarded transaction tests. */
  beforeGuardedRefresh?: (wrapperPath: string, index: number) => void;
}): CodexShimAutoRestoreResult {
  if (process.platform !== "win32") return autoRestoreUnixOverlay(options);
  const stateRead = readStateResult();
  const state = stateRead.state;
  if (!state) {
    if (stateRead.warning) return { status: "ineligible", message: stateRead.warning };
    return { status: stateRead.present ? "ineligible" : "not-installed" };
  }
  if (state.platform !== process.platform) return { status: "ineligible" };

  const files = stateFiles(state);
  const replacementProbes = new Map<string, StableShimPathProbe>();
  const obsoleteShimProbes = new Map<string, StableShimPathProbe>();
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
      if (state.platform !== "win32" && !isCurrentUnixShimProbe(probe)) {
        obsoleteShimProbes.set(file.wrapperPath, probe);
        continue;
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

  if (replacementProbes.size === 0 && obsoleteShimProbes.size === 0) return { status: "healthy" };
  if (!options.enabled()) return { status: "disabled" };
  if (files.length > 1 && (healthyCount > 0 || (replacementProbes.size > 0 && obsoleteShimProbes.size > 0))) {
    return {
      status: "deferred",
      message: "Codex shim auto-restore deferred because tracked launcher siblings are in a mixed shim/replacement state.",
    };
  }

  const runtime = Object.freeze({ ...(options.selectRuntime ?? durableBunRuntime)() });
  try {
    const configDir = (options.configDir ?? getConfigDir)();
    (options.assertRuntimeWritable ?? assertSelectedRuntimeWritable)(runtime, configDir, { rootWasAbsent: !existsSync(configDir) });
  } catch (error) {
    if (error instanceof RuntimePreflightError) return { status: "deferred", message: error.message };
    throw error;
  }
  const lock = tryAcquireShimRestoreLock(options.beforeStaleRestoreLockDelete);
  if (!lock) return { status: "deferred" };
  try {
    options.afterRestoreLockAcquired?.();
    (options.stabilitySleep ?? Bun.sleepSync)(CODEX_SHIM_REPLACEMENT_STABLE_MS);
    if (obsoleteShimProbes.size > 0) {
      for (const [path, firstProbe] of obsoleteShimProbes) {
        const secondProbe = stableShimPathProbe(path);
        if (!secondProbe || isCurrentUnixShimProbe(secondProbe)
          || !sameStableShimPathProbe(firstProbe, secondProbe)) return { status: "deferred" };
      }
      const result = refreshObsoleteUnixShims(files);
      return result.installed
        ? { status: "restored", message: result.message }
        : result.deferred
          ? { status: "deferred", message: result.message }
          : { status: "ineligible", message: result.message };
    }
    const expectedReplacements = new Map<string, ShimPathFingerprint>();
    for (const [path, firstProbe] of replacementProbes) {
      const secondProbe = stableShimPathProbe(path);
      if (!secondProbe || secondProbe.prefix.includes(SHIM_MARKER)
        || !sameStableShimPathProbe(firstProbe, secondProbe)) return { status: "deferred" };
      expectedReplacements.set(path, secondProbe.fingerprint);
    }
    const result = installCodexShimInternal({
      runtime, runtimeAdmitted: true,
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
  if (process.platform !== "win32") return uninstallUnixCodexShim();
  const state = readState();
  if (!state) return { removed: false, message: "Codex autostart shim is not installed." };
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
