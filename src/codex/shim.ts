import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, posix, win32 } from "node:path";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { getConfigDir } from "../config";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, durableBunRuntime } from "../lib/bun-runtime";
import type { BunRuntimeSource } from "../lib/bun-runtime";
import { isProcessAlive } from "../lib/process-control";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { windowsEnvIndirectBatchValue } from "../lib/win-paths";
import { isWslRuntime, wslAutomountRoot } from "./home";
import { truncateRetainedUtf8 } from "../lib/admission";

const SHIM_MARKER = "opencodex codex autostart shim";
const UNIX_SHIM_REVISION_MARKER = "opencodex unix codex shim revision 2";
const CODEX_SHIM_PROBE_BYTES = 16 * 1024;
export const CODEX_SHIM_REPLACEMENT_STABLE_MS = 100;
export const CODEX_SHIM_STATE_MAX_BYTES = 1024 * 1024;
const CODEX_SHIM_RESTORE_LOCK_STALE_MS = 30_000;
const CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS = 5_000;
const CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS = 1_000;
const CODEX_SHIM_REENTRY_EXIT_CODE = 126;
const CODEX_SHIM_REENTRY_DIAGNOSTIC = "opencodex: saved Codex launcher resolved back to the autostart shim; run ocx codex-shim uninstall and reinstall Codex before enabling codexAutoStart.";
const CODEX_SHIM_INSTALL_PROBE_SCRIPT = `
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const [markerPath, reentryPath, groupPath, stderrPath, launcherShellPath, wrapperPath, timeoutRaw, stderrLimitRaw, stderrDrainRaw, observationRaw] = process.argv.slice(1);
const timeoutMs = Number.parseInt(timeoutRaw, 10);
const stderrLimit = Number.parseInt(stderrLimitRaw, 10);
const stderrDrainMs = Number.parseInt(stderrDrainRaw, 10);
const observationMs = Number.parseInt(observationRaw, 10);
const probeStartedAt = Date.now();
const stderrChunks = [];
let stderrBytes = 0;
let launcher;
let probeLease;
let timer;
let stderrDrainTimer;
let observationTimer;
let reentryPollTimer;
let marker = "";
let finished = false;

function writeExclusive(path, value) {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

function appendStderr(value) {
  if (stderrBytes >= stderrLimit) return;
  const bytes = Buffer.from(value);
  const retained = bytes.subarray(0, stderrLimit - stderrBytes);
  stderrChunks.push(retained);
  stderrBytes += retained.byteLength;
}

function groupAlive() {
  if (!launcher || !launcher.pid) return false;
  try {
    process.kill(-launcher.pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== "ESRCH";
  }
}

function killGroup() {
  if (!launcher || !launcher.pid) return;
  try { process.kill(-launcher.pid, "SIGKILL"); } catch (error) {
    if (!error || error.code !== "ESRCH") appendStderr(String(error));
  }
}

function setMarker(value) {
  if (marker) return;
  marker = value;
  try { writeExclusive(markerPath, value + "\\n"); } catch (error) { appendStderr(String(error)); }
}

function reentryDetected() {
  try { return readFileSync(reentryPath, "utf8").trim() === "recursive"; } catch { return false; }
}

function checkReentry() {
  if (finished || !reentryDetected()) return;
  setMarker("recursive");
  killGroup();
  finish(126);
}

function finish(status) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  if (stderrDrainTimer) clearTimeout(stderrDrainTimer);
  if (observationTimer) clearTimeout(observationTimer);
  if (reentryPollTimer) clearInterval(reentryPollTimer);
  if (!marker && reentryDetected()) setMarker("recursive");
  if (!marker && groupAlive()) {
    setMarker("descendants");
    killGroup();
  }
  try { writeExclusive(stderrPath, Buffer.concat(stderrChunks)); } catch { /* parent fails closed */ }
  process.exit(marker === "timeout" ? 124 : marker === "descendants" ? 125 : marker === "recursive" ? 126 : status);
}

function finishAfterStderr(status) {
  if (finished) return;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (!launcher || !launcher.stderr || !probeLease) {
    finish(status);
    return;
  }
  let stderrEnded = launcher.stderr.readableEnded;
  let leaseEnded = probeLease.readableEnded;
  let observationElapsed = false;
  const finishWhenReady = () => {
    if (stderrEnded && leaseEnded && observationElapsed) finish(status);
  };
  launcher.stderr.once("end", () => {
    stderrEnded = true;
    finishWhenReady();
  });
  probeLease.once("end", () => {
    leaseEnded = true;
    finishWhenReady();
  });
  stderrDrainTimer = setTimeout(() => {
    stderrEnded = true;
    if (!marker && groupAlive()) {
      setMarker("descendants");
      killGroup();
      finish(125);
      return;
    }
    finishWhenReady();
  }, stderrDrainMs);
  const remainingObservationMs = Math.max(0, observationMs - (Date.now() - probeStartedAt));
  observationTimer = setTimeout(() => {
    observationElapsed = true;
    if (!leaseEnded) {
      setMarker(groupAlive() ? "descendants" : "timeout");
      killGroup();
      finish(marker === "descendants" ? 125 : 124);
      return;
    }
    finishWhenReady();
  }, remainingObservationMs);
  finishWhenReady();
}

try {
  launcher = spawn(launcherShellPath, [wrapperPath, "--version"], {
    detached: true,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  if (!launcher.pid) throw new Error("Codex shim probe launcher has no pid");
  probeLease = launcher.stdio[3];
  if (!probeLease) throw new Error("Codex shim probe launcher has no descendant lease pipe");
  writeExclusive(groupPath, String(launcher.pid) + "\\n");
  launcher.stderr.on("data", appendStderr);
  reentryPollTimer = setInterval(checkReentry, 10);
  launcher.once("error", error => {
    appendStderr(String(error));
    finishAfterStderr(127);
  });
  launcher.once("exit", code => finishAfterStderr(Number.isInteger(code) ? code : 127));
  timer = setTimeout(() => {
    setMarker("timeout");
    killGroup();
    finish(124);
  }, timeoutMs);
} catch (error) {
  appendStderr(String(error));
  killGroup();
  finish(127);
}
`;
const MAX_DIAGNOSTIC_VALUE_BYTES = 8 * 1024;
let lastShimDiscoveryError: string | null = null;
/** Last human-readable reason discovery returned null (exposed for doctor/tests). */
export function lastCodexDiscoveryError(): string | null {
  return lastShimDiscoveryError;
}
const CODEX_INTERNAL_COMMANDS = [
  "app-server",
  "archive",
  "apply",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "exec-server",
  "features",
  "fork",
  "help",
  "login",
  "logout",
  "mcp",
  "plugin",
  "sandbox",
  "unarchive",
  "update",
];

// Codex accepts global options before a subcommand. The shim must skip the value belonging to
// these options before it decides which first positional token is the real subcommand. Keep this
// list aligned with `codex --help`; `--option=value` and attached short forms stay one token.
const CODEX_GLOBAL_OPTIONS_WITH_VALUE = [
  "-c", "--config",
  "--enable", "--disable",
  "--remote", "--remote-auth-token-env",
  "-i", "--image",
  "-m", "--model",
  "--local-provider",
  "-p", "--profile",
  "-s", "--sandbox",
  "-C", "--cd",
  "--add-dir",
  "-a", "--ask-for-approval",
];

interface ShimState {
  platform: NodeJS.Platform;
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
  wrappers?: ShimFileState[];
}

interface ShimFileState {
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
  realPath?: string;
  preserveOnly?: boolean;
}

export type CodexShimBackingForCommand =
  | Readonly<{ status: "not-tracked" }>
  | Readonly<{
      status: "matched";
      selectedRole: "wrapper" | "backing";
      backingPath: string;
      backingKind: "backup" | "real";
    }>
  | Readonly<{
      status: "unknown";
      reason:
        | "state_invalid"
        | "platform_mismatch"
        | "ambiguous_match"
        | "preserve_only"
        | "backing_missing"
        | "backing_mismatch"
        | "binding_unavailable"
        | "wrapper_unhealthy"
        | "version_manager_refused";
    }>;

interface ShimPathFingerprint {
  dev: number;
  ino: number;
  kind: "file" | "symlink";
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  target?: Omit<ShimPathFingerprint, "target">;
}

interface StableShimPathProbe {
  fingerprint: ShimPathFingerprint;
  prefix: string;
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
  try {
    return readFileSync(path, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
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

function readShimProbePrefix(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(CODEX_SHIM_PROBE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function statFingerprint(path: string, follow: boolean): Omit<ShimPathFingerprint, "target"> | null {
  try {
    const stat = follow ? statSync(path) : lstatSync(path);
    if (follow ? !stat.isFile() : (!stat.isFile() && !stat.isSymbolicLink())) return null;
    return {
      dev: stat.dev,
      ino: stat.ino,
      kind: stat.isSymbolicLink() ? "symlink" : "file",
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch {
    return null;
  }
}

function sameFingerprint(
  left: ShimPathFingerprint | Omit<ShimPathFingerprint, "target">,
  right: ShimPathFingerprint | Omit<ShimPathFingerprint, "target">,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.kind === right.kind
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && (!("target" in left) || !("target" in right)
      ? true
      : left.target === undefined && right.target === undefined
        ? true
        : left.target !== undefined && right.target !== undefined
          ? sameFingerprint(left.target, right.target)
          : false);
}

function sameFingerprintAfterRename(left: ShimPathFingerprint, right: ShimPathFingerprint): boolean {
  // rename changes the outer directory entry ctime on macOS; every other field,
  // including a symlink target fingerprint, must remain identical.
  return sameFingerprint({ ...left, ctimeMs: 0 }, { ...right, ctimeMs: 0 });
}

function stableShimPathProbe(path: string): StableShimPathProbe | null {
  const before = statFingerprint(path, false);
  if (!before) return null;
  const targetBefore = before.kind === "symlink" ? statFingerprint(path, true) : undefined;
  if (before.kind === "symlink" && !targetBefore) return null;
  let prefix: string;
  try {
    prefix = readShimProbePrefix(path);
  } catch {
    return null;
  }
  const targetAfter = before.kind === "symlink" ? statFingerprint(path, true) : undefined;
  const after = statFingerprint(path, false);
  if (!after || !sameFingerprint(before, after)) return null;
  if (before.kind === "symlink") {
    if (!targetBefore || !targetAfter || !sameFingerprint(targetBefore, targetAfter)) return null;
  }
  const fingerprint: ShimPathFingerprint = {
    ...before,
    ...(targetBefore ? { target: targetBefore } : {}),
  };
  const contentSize = fingerprint.target?.size ?? fingerprint.size;
  return contentSize > 0 ? { fingerprint, prefix } : null;
}

function sameStableShimPathProbe(left: StableShimPathProbe, right: StableShimPathProbe): boolean {
  return left.prefix === right.prefix && sameFingerprint(left.fingerprint, right.fingerprint);
}

/**
 * Identity of whatever sits at `path`, read from metadata alone.
 *
 * `stableShimPathProbe` answers a different question: it reads content to decide
 * whether a launcher looks like a healthy shim, and it deliberately returns null
 * for a zero-byte file. That makes it the wrong instrument for rollback
 * bookkeeping. A user can legitimately own an empty `codex` launcher, and a fresh
 * install moves it aside before writing our wrapper; if the move is recorded
 * without a fingerprint, rollback cannot prove the backup is still the file it
 * set aside and refuses to restore it — the launcher stays lost (#1625).
 *
 * Content is irrelevant to that proof, so this reads dev/ino/mode/size/times and
 * re-reads them to reject a path that changed under us, following a symlink to
 * fingerprint its target as well.
 */
function shimPathFingerprint(path: string): ShimPathFingerprint | null {
  const before = statFingerprint(path, false);
  if (!before) return null;
  if (before.kind !== "symlink") {
    const after = statFingerprint(path, false);
    return after && sameFingerprint(before, after) ? before : null;
  }
  const targetBefore = statFingerprint(path, true);
  if (!targetBefore) return null;
  const targetAfter = statFingerprint(path, true);
  const after = statFingerprint(path, false);
  if (!targetAfter || !after
    || !sameFingerprint(targetBefore, targetAfter)
    || !sameFingerprint(before, after)) return null;
  return { ...before, target: targetBefore };
}

/**
 * Move `from` onto `to` without ever replacing an existing entry.
 *
 * `renameSync` silently clobbers the destination on POSIX, which is wrong for a
 * rollback restore: `sourceOccupied` is sampled before the fingerprint check, so
 * a concurrent installer can publish its own launcher at the original path in
 * between, and the restore would delete it. `link` fails EEXIST instead, which
 * is the no-replace primitive we need and needs no native helper.
 *
 * `link` follows a symlink to its target rather than preserving the link, so a
 * symlink launcher is republished with `symlink`, which is also no-replace: it
 * fails EEXIST on an occupied destination. Checking existence and then renaming
 * would reintroduce exactly the race this function exists to close.
 */
function restoreWithoutReplacing(from: string, to: string): void {
  const source = lstatSync(from);
  if (source.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
    unlinkSync(from);
    return;
  }
  linkSync(from, to);
  unlinkSync(from);
}

function isHealthyShimProbe(probe: StableShimPathProbe, platform: NodeJS.Platform): boolean {
  if (probe.prefix.length < 180 || !probe.prefix.includes(SHIM_MARKER) || !probe.prefix.includes("ensure")) return false;
  const mode = probe.fingerprint.target?.mode ?? probe.fingerprint.mode;
  return platform === "win32" || (mode & 0o111) !== 0;
}

function isCurrentUnixShimProbe(probe: StableShimPathProbe): boolean {
  return probe.prefix.includes(UNIX_SHIM_REVISION_MARKER);
}

function hasUsableBackingPath(file: ShimFileState): boolean {
  return [existsSync(file.backupPath) ? file.backupPath : undefined, file.realPath]
    .some(path => {
      if (!path) return false;
      const fingerprint = statFingerprint(path, true);
      return fingerprint !== null && fingerprint.size > 0;
    });
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
      if (!exists(path) || shimFile(path)) continue;
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
 * True when a Codex binary lives inside a version manager's install tree.
 *
 * These trees are rewritten in place on upgrade, which destroys both the shim
 * and the sibling .opencodex-real backup it restores from (#2412). The tempting
 * repair — adopt the newly installed binary as a fresh original — is wrong
 * twice: it records a provenance that never happened, and the next upgrade wipes
 * it again, so the repair silently un-repairs on the version manager's schedule.
 *
 * Scope is the three managers named in the report. nvm/fnm/npm-prefix are
 * deliberately excluded: a false positive here refuses a restore that would
 * otherwise be correct.
 */
export function isVersionManagerOwnedCodexPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = (platform === "win32"
    ? win32.normalize(path).replace(/\\/g, "/")
    : posix.normalize(path)).toLowerCase();
  return normalized.includes("/mise/installs/")
    || normalized.includes("/mise/shims/")
    || normalized.includes("/.asdf/installs/")
    || normalized.includes("/.asdf/shims/")
    || normalized.includes("/.volta/");
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
    ? isShim(file.wrapperPath) ? "present but unusable" : "present but not an opencodex shim"
    : "missing";
  const backup = existsSync(file.backupPath) ? "present" : "missing";
  const base = `Codex autostart shim not restored: wrapper ${wrapper} at ${file.wrapperPath}; original backup ${backup} at ${file.backupPath}.`;
  if (!isVersionManagerOwnedCodexPath(file.wrapperPath)) {
    return `${base} Re-run 'ocx codex-shim install' once the Codex binary is stable.`;
  }
  return `${base} This Codex binary is owned by a version manager (mise/asdf/volta), so opencodex will not wrap it as a new original — the next upgrade would overwrite the shim and its backup again. Route through Codex instead with 'ocx start', and use 'ocx service install' for autostart.`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Provenance is required rather than defaulted: a default would let a caller pass an
// override binary and silently label it something else, which is precisely the
// path/marker disagreement this feature exists to prevent.
//
// The marker is scoped to the `ensure` invocation in every flavor below and is never
// exported into the shim's own environment. A shim wraps the real `codex`, so an
// exported marker would be inherited by Codex and everything it spawns — a shell that
// then ran a *different* Bun directly would carry a provenance describing a binary it
// is not executing.
export function buildUnixCodexShim(realCodexPath: string, bunPath: string, cliPath: string, bunRuntimeSource: BunRuntimeSource, tokenFile = serviceApiTokenFilePath()): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.join("|");
  const valueOptions = CODEX_GLOBAL_OPTIONS_WITH_VALUE.join("|");
  return `#!/usr/bin/env sh
# ${SHIM_MARKER}
# ${UNIX_SHIM_REVISION_MARKER}
if [ "\${OCX_SHIM_PROBE:-}" = "1" ]; then
  if [ "\${OCX_SHIM_PROBE_ACTIVE:-}" = "1" ]; then
    if [ -n "\${OCX_SHIM_PROBE_REENTRY_PATH:-}" ]; then
      (umask 077; printf '%s\n' recursive > "$OCX_SHIM_PROBE_REENTRY_PATH") 2>/dev/null || true
    fi
    printf '%s\n' ${shQuote(CODEX_SHIM_REENTRY_DIAGNOSTIC)} >&2
    exit ${CODEX_SHIM_REENTRY_EXIT_CODE}
  fi
  OCX_SHIM_PROBE_ACTIVE=1
  export OCX_SHIM_PROBE_ACTIVE
fi
if [ "\${OCX_SHIM_ACTIVE_PID:-}" = "$$" ]; then
  printf '%s\n' ${shQuote(CODEX_SHIM_REENTRY_DIAGNOSTIC)} >&2
  exit ${CODEX_SHIM_REENTRY_EXIT_CODE}
fi
case "\${OCX_SHIM_ACTIVE_DEPTH:-0}" in
  0)
    OCX_SHIM_ACTIVE_DEPTH=1
    ;;
  1)
    OCX_SHIM_ACTIVE_DEPTH=2
    ;;
  *)
    printf '%s\n' ${shQuote(CODEX_SHIM_REENTRY_DIAGNOSTIC)} >&2
    exit ${CODEX_SHIM_REENTRY_EXIT_CODE}
    ;;
esac
# Dynamic launchers such as mise exec -- codex may resolve the command name
# back to this wrapper. An exec chain keeps the same PID. A legitimate nested
# Codex invocation may enter once with a new PID; repeated child-process
# redispatch reaches depth 2 and is rejected before it can form an infinite chain.
OCX_SHIM_ACTIVE_PID=$$
export OCX_SHIM_ACTIVE_PID OCX_SHIM_ACTIVE_DEPTH
if [ -z "$OPENCODEX_API_AUTH_TOKEN" ] && [ -f ${shQuote(tokenFile)} ]; then
  OPENCODEX_API_AUTH_TOKEN="$(cat ${shQuote(tokenFile)})"
  export OPENCODEX_API_AUTH_TOKEN
fi
ocx_subcommand=""
ocx_skip_next=0
for ocx_arg in "$@"; do
  if [ "$ocx_skip_next" -eq 1 ]; then
    ocx_skip_next=0
    continue
  fi
  case "$ocx_arg" in
    --)
      break
      ;;
    ${valueOptions})
      ocx_skip_next=1
      ;;
    --help|-h|--version|-V)
      ocx_subcommand="$ocx_arg"
      break
      ;;
    -*)
      ;;
    *)
      ocx_subcommand="$ocx_arg"
      break
      ;;
  esac
done
case "$ocx_subcommand" in
  ${internalCommands}|--help|-h|--version|-V)
    ;;
  *)
    if [ -z "$OCX_SHIM_BYPASS" ]; then
      ${BUN_RUNTIME_SOURCE_ENV}=${shQuote(bunRuntimeSource)} ${BUN_RUNTIME_PATH_ENV}=${shQuote(bunPath)} ${shQuote(bunPath)} ${shQuote(cliPath)} ensure >/dev/null 2>&1 || true
    fi
    ;;
esac
exec ${shQuote(realCodexPath)} "$@"
`;
}

type UnixShimProbeResult = "cleanup" | "descendants" | "failed" | "recursive" | "timeout" | null;

let codexShimProbeHookForTests: (() => void) | null = null;
let codexShimProbeShellForTests: string | null = null;
let codexShimGuardedWriteHookForTests: (() => void) | null = null;
let codexShimFreshWriteHookForTests: (() => void) | null = null;
let codexShimRollbackRestoreHookForTests: ((target: ShimFileState) => void) | null = null;
let codexShimProbeObservationMs = CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS;

/** Narrow deterministic seam for transaction rollback tests. */
export function setCodexShimProbeHookForTests(hook: (() => void) | null): void {
  codexShimProbeHookForTests = hook;
}

/** Selects a POSIX shell only for cross-shell probe regression tests. */
export function setCodexShimProbeShellForTests(path: string | null): void {
  codexShimProbeShellForTests = path;
}

/** Shortens the successful-launcher observation window only for focused tests. */
export function setCodexShimProbeObservationMsForTests(value: number | null): void {
  codexShimProbeObservationMs = value ?? CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS;
}

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

function readProbeMetadata(path: string, maxBytes: number): string | null {
  try {
    if (!existsSync(path)) return "";
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function probeUnixShimInstall(wrapperPath: string): UnixShimProbeResult {
  if (process.platform === "win32") return null;
  const probeDir = mkdtempSync(join(tmpdir(), "opencodex-shim-probe-"));
  const markerPath = join(probeDir, "result");
  const reentryPath = join(probeDir, "reentry");
  const groupPath = join(probeDir, "group");
  const stderrPath = join(probeDir, "stderr");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OCX_SHIM_BYPASS: "1",
    OCX_SHIM_PROBE: "1",
    OCX_SHIM_PROBE_REENTRY_PATH: reentryPath,
  };
  delete env.OCX_SHIM_ACTIVE_PID;
  delete env.OCX_SHIM_ACTIVE_DEPTH;
  delete env.OCX_SHIM_PROBE_ACTIVE;
  let groupId = 0;
  try {
    chmodSync(probeDir, 0o700);
    const result = spawnSync(process.execPath, [
      "-e",
      CODEX_SHIM_INSTALL_PROBE_SCRIPT,
      markerPath,
      reentryPath,
      groupPath,
      stderrPath,
      codexShimProbeShellForTests ?? "/bin/sh",
      wrapperPath,
      String(CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS),
      String(MAX_DIAGNOSTIC_VALUE_BYTES),
      String(CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS),
      String(codexShimProbeObservationMs),
    ], {
      encoding: "utf8",
      env,
      timeout: CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS + CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const marker = readProbeMetadata(markerPath, 64);
    const reentryMarker = readProbeMetadata(reentryPath, 64);
    const groupText = readProbeMetadata(groupPath, 64);
    const launcherStderr = readProbeMetadata(stderrPath, MAX_DIAGNOSTIC_VALUE_BYTES);
    groupId = groupText === null ? 0 : Number.parseInt(groupText, 10);
    if (marker === null || reentryMarker === null || groupText === null || launcherStderr === null
      || !Number.isInteger(groupId) || groupId <= 0) return "cleanup";
    const groupSurvived = unixProcessGroupAlive(groupId);
    if (timedOut || marker || reentryMarker || groupSurvived) {
      try {
        terminateUnixProcessGroup(groupId);
      } catch {
        return "cleanup";
      }
    }
    if (result.error && !timedOut) return "cleanup";
    if (timedOut || marker === "timeout") return "timeout";
    if (marker === "recursive" || reentryMarker === "recursive") return "recursive";
    if (reentryMarker !== "") return "cleanup";
    if (marker === "descendants") return "descendants";
    if (groupSurvived) return "descendants";
    if (result.status === CODEX_SHIM_REENTRY_EXIT_CODE && launcherStderr.includes(CODEX_SHIM_REENTRY_DIAGNOSTIC)) {
      return "recursive";
    }
    if (result.status !== 0) return "failed";
    return null;
  } catch {
    if (Number.isInteger(groupId) && groupId > 0) {
      try { terminateUnixProcessGroup(groupId); } catch { /* cleanup classification below */ }
    }
    return "cleanup";
  } finally {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

function probeUnixShimFiles(files: readonly ShimFileState[]): UnixShimProbeResult {
  if (process.platform === "win32") return null;
  codexShimProbeHookForTests?.();
  return files
    .filter(file => !file.preserveOnly)
    .map(file => probeUnixShimInstall(file.wrapperPath))
    .find(result => result !== null) ?? null;
}

function unixProcessGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function terminateUnixProcessGroup(groupId: number): void {
  try {
    process.kill(-groupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + CODEX_SHIM_INSTALL_PROBE_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline && unixProcessGroupAlive(groupId)) Bun.sleepSync(10);
  if (unixProcessGroupAlive(groupId)) {
    throw new Error(`Codex shim install probe process group ${groupId} did not terminate`);
  }
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

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

function windowsBatchSet(name: string, value: string): string {
  // Paths are rewritten to %USERPROFILE%-style env indirection: cmd.exe parses .cmd
  // files in the OEM codepage, so a literal non-ASCII profile prefix (Korean/Chinese
  // usernames) written as UTF-8 turns to mojibake. The env token expands natively in
  // the right codepage at parse time; no `chcp` here — this shim runs in the USER's
  // console and must not leak a codepage change into it.
  return `set "${name}=${windowsEnvIndirectBatchValue(value, windowsBatchValue)}"`;
}

export function buildWindowsCodexShim(realCodexPath: string, bunPath: string, cliPath: string, bunRuntimeSource: BunRuntimeSource): string {
  const internalCommandChecks = CODEX_INTERNAL_COMMANDS.map(command => `if /I "%~1"=="${command}" goto run_codex`).join("\r\n");
  const valueOptionChecks = CODEX_GLOBAL_OPTIONS_WITH_VALUE.map(option => `if /I "%~1"=="${option}" goto skip_option_value`).join("\r\n");
  return `@echo off\r
rem ${SHIM_MARKER}\r
${windowsBatchSet("OCX_REAL_CODEX", realCodexPath)}\r
${windowsBatchSet("OCX_BUN", bunPath)}\r
${windowsBatchSet("OCX_CLI", cliPath)}\r
${windowsBatchSet("OCX_API_TOKEN_FILE", serviceApiTokenFilePath())}\r
if "%OPENCODEX_API_AUTH_TOKEN%"=="" if exist "%OCX_API_TOKEN_FILE%" set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"\r
if not "%OCX_SHIM_BYPASS%"=="" goto run_codex\r
goto scan_codex_args\r
:scan_codex_args\r
if "%~1"=="" goto ensure_ocx\r
if "%~1"=="--" goto ensure_ocx\r
${valueOptionChecks}\r
${internalCommandChecks}\r
if /I "%~1"=="--help" goto run_codex\r
if /I "%~1"=="-h" goto run_codex\r
if /I "%~1"=="--version" goto run_codex\r
if /I "%~1"=="-V" goto run_codex\r
set "OCX_SCAN_ARG=%~1"\r
if "%OCX_SCAN_ARG:~0,1%"=="-" goto shift_codex_arg\r
goto ensure_ocx\r
:skip_option_value\r
shift\r
if "%~1"=="" goto ensure_ocx\r
:shift_codex_arg\r
shift\r
goto scan_codex_args\r
:ensure_ocx\r
setlocal\r
${windowsBatchSet(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource)}\r
${windowsBatchSet(BUN_RUNTIME_PATH_ENV, bunPath)}\r
"%OCX_BUN%" "%OCX_CLI%" ensure >nul 2>nul\r
endlocal\r
:run_codex\r
"%OCX_REAL_CODEX%" %*\r
`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsPowerShellCodexShim(realCodexPath: string, bunPath: string, cliPath: string, bunRuntimeSource: BunRuntimeSource): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.map(command => psString(command)).join(", ");
  const valueOptions = CODEX_GLOBAL_OPTIONS_WITH_VALUE.map(option => psString(option)).join(", ");
  const tokenFile = serviceApiTokenFilePath();
  return `#!/usr/bin/env pwsh
# ${SHIM_MARKER}
if (-not $env:OPENCODEX_API_AUTH_TOKEN -and (Test-Path -LiteralPath ${psString(tokenFile)})) {
  $env:OPENCODEX_API_AUTH_TOKEN = (Get-Content -Raw -LiteralPath ${psString(tokenFile)}).Trim()
}
$internalCommands = @(${internalCommands})
$valueOptions = @(${valueOptions})
$subcommand = ""
$skipNext = $false
foreach ($argValue in $args) {
  $argText = [string]$argValue
  if ($skipNext) { $skipNext = $false; continue }
  if ($argText -eq "--") { break }
  if ($valueOptions -contains $argText) { $skipNext = $true; continue }
  if (@("--help", "-h", "--version", "-V") -contains $argText) { $subcommand = $argText; break }
  if ($argText.StartsWith("-")) { continue }
  $subcommand = $argText
  break
}
$skipEnsure = $env:OCX_SHIM_BYPASS -or $internalCommands -contains $subcommand -or @("--help", "-h", "--version", "-V") -contains $subcommand
if (-not $skipEnsure) {
  $priorRuntimeSource = $env:${BUN_RUNTIME_SOURCE_ENV}
  $priorRuntimePath = $env:${BUN_RUNTIME_PATH_ENV}
  $env:${BUN_RUNTIME_SOURCE_ENV} = ${psString(bunRuntimeSource)}
  $env:${BUN_RUNTIME_PATH_ENV} = ${psString(bunPath)}
  try { & ${psString(bunPath)} ${psString(cliPath)} ensure *> $null }
  finally {
    if ($null -eq $priorRuntimeSource) { Remove-Item Env:\\${BUN_RUNTIME_SOURCE_ENV} -ErrorAction SilentlyContinue }
    else { $env:${BUN_RUNTIME_SOURCE_ENV} = $priorRuntimeSource }
    if ($null -eq $priorRuntimePath) { Remove-Item Env:\\${BUN_RUNTIME_PATH_ENV} -ErrorAction SilentlyContinue }
    else { $env:${BUN_RUNTIME_PATH_ENV} = $priorRuntimePath }
  }
}
& ${psString(realCodexPath)} @args
exit $LASTEXITCODE
`;
}

interface ShimStateReadResult {
  state: ShimState | null;
  present: boolean;
  warning?: string;
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function readBoundedRegularFile(path: string, maxBytes: number): { bytes: Buffer; content: string } | { warning: string } | null {
  let lexicalBefore: Stats;
  try {
    lexicalBefore = lstatSync(path);
    if (lexicalBefore.isSymbolicLink() || !lexicalBefore.isFile()) {
      return { warning: `Codex shim state is not a direct regular file at ${path}; auto-restore skipped.` };
    }
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    return { warning: `Codex shim state could not be inspected at ${path}.` };
  }
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    return { warning: `Codex shim state could not be opened as a regular file at ${path}.` };
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return { warning: `Codex shim state is not a regular file at ${path}; auto-restore skipped.` };
    if (before.size > maxBytes) {
      return { warning: `Codex shim state exceeds the 1 MiB startup limit at ${path}; auto-restore skipped.` };
    }
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return { warning: `Codex shim state changed while being read at ${path}; auto-restore skipped.` };
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(fd, extra, 0, 1, offset) !== 0) {
      return { warning: `Codex shim state exceeds the 1 MiB startup limit at ${path}; auto-restore skipped.` };
    }
    const after = fstatSync(fd);
    let lexicalAfter: Stats;
    try {
      lexicalAfter = lstatSync(path);
    } catch {
      return { warning: `Codex shim state changed while being read at ${path}; auto-restore skipped.` };
    }
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || lexicalBefore.dev !== before.dev || lexicalBefore.ino !== before.ino
      || lexicalAfter.isSymbolicLink() || lexicalAfter.dev !== after.dev || lexicalAfter.ino !== after.ino) {
      return { warning: `Codex shim state changed while being read at ${path}; auto-restore skipped.` };
    }
    return { bytes: buffer, content: buffer.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

function readStateResult(path = statePath()): ShimStateReadResult {
  const bounded = readBoundedRegularFile(path, CODEX_SHIM_STATE_MAX_BYTES);
  if (!bounded) return { state: null, present: false };
  if ("warning" in bounded) return { state: null, present: true, warning: bounded.warning };
  try {
    const value = JSON.parse(bounded.content) as unknown;
    if (!value || typeof value !== "object") return { state: null, present: true };
    const state = value as Record<string, unknown>;
    if (typeof state.platform !== "string") return { state: null, present: true };
    const validFile = (item: unknown): item is ShimFileState => {
      if (!item || typeof item !== "object") return false;
      const file = item as Record<string, unknown>;
      return typeof file.wrapperPath === "string"
        && typeof file.originalPath === "string"
        && typeof file.backupPath === "string"
        && (file.realPath === undefined || typeof file.realPath === "string")
        && (file.preserveOnly === undefined || typeof file.preserveOnly === "boolean");
    };
    if (state.wrappers !== undefined) {
      if (!Array.isArray(state.wrappers) || state.wrappers.length === 0 || !state.wrappers.every(validFile)) return { state: null, present: true };
    } else if (!validFile(state)) {
      return { state: null, present: true };
    }
    return { state: state as unknown as ShimState, present: true };
  } catch {
    return { state: null, present: true };
  }
}

function readState(): ShimState | null {
  return readStateResult().state;
}

export function isLocalAbsoluteInspectionPath(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return posix.isAbsolute(path);
  const normalized = path.replace(/\//g, "\\");
  // UNC and device namespaces can initiate remote I/O while a nominally local
  // inspection is resolving user-controlled paths. Root-relative paths are
  // drive-context dependent, so require an explicit local drive as well.
  return win32.isAbsolute(path)
    && /^[a-z]:\\/i.test(normalized)
    && !normalized.startsWith("\\\\");
}

function windowsShimInspectionIsDeferred(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/** Resolve one selected command through already-recorded shim state, without repair. */
export function inspectCodexShimBackingForCommand(
  selectedCommand: string,
  platform: NodeJS.Platform = process.platform,
  configDir: string = getConfigDir(),
): CodexShimBackingForCommand {
  // Pathname prechecks cannot prevent a writable Windows ancestor from being
  // replaced with a remote reparse point before the later state/fingerprint
  // reads. Keep the exported read-only helper fail-closed until those reads are
  // performed through a handle-bound Windows provenance layer.
  if (windowsShimInspectionIsDeferred(platform)) {
    return Object.freeze({ status: "unknown" as const, reason: "binding_unavailable" as const });
  }
  if (!isLocalAbsoluteInspectionPath(configDir, platform)) {
    return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
  }
  const stateFile = join(configDir, "codex-shim.json");
  try {
    const stateEntry = lstatSync(stateFile);
    if (stateEntry.isSymbolicLink()) {
      return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
    }
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") {
      return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
    }
  }
  const result = readStateResult(stateFile);
  if (!result.state) {
    return result.present
      ? Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const })
      : Object.freeze({ status: "not-tracked" as const });
  }
  const pathApi = platform === "win32" ? win32 : posix;
  const samePath = (left: string, right: string): boolean => {
    const normalizedLeft = pathApi.resolve(left);
    const normalizedRight = pathApi.resolve(right);
    return platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  };
  const files = stateFiles(result.state);
  if (files.some(file => !file.wrapperPath || !file.originalPath || !file.backupPath
    || ![file.wrapperPath, file.originalPath, file.backupPath, file.realPath]
      .filter((path): path is string => typeof path === "string")
      .every(path => isLocalAbsoluteInspectionPath(path, platform)))) {
    return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
  }
  const wrapperKeys = files.map(file => platform === "win32"
    ? pathApi.resolve(file.wrapperPath).toLowerCase()
    : pathApi.resolve(file.wrapperPath));
  if (new Set(wrapperKeys).size !== wrapperKeys.length) {
    return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
  }
  const selectedFingerprint = shimPathFingerprint(selectedCommand);
  if (!selectedFingerprint) {
    return Object.freeze({ status: "unknown" as const, reason: "binding_unavailable" as const });
  }
  const selectedIdentity = selectedFingerprint.target ?? selectedFingerprint;
  const sameEffectiveIdentity = (fingerprint: ShimPathFingerprint | null): boolean => {
    if (!fingerprint) return false;
    const identity = fingerprint.target ?? fingerprint;
    return identity.dev === selectedIdentity.dev && identity.ino === selectedIdentity.ino;
  };
  const matches = files.flatMap(file => {
    const backingPath = file.realPath ?? file.backupPath;
    const roles: Array<"wrapper" | "backing"> = [];
    if (samePath(file.wrapperPath, selectedCommand)
      || sameEffectiveIdentity(shimPathFingerprint(file.wrapperPath))) {
      roles.push("wrapper");
    }
    if (samePath(backingPath, selectedCommand)
      || sameEffectiveIdentity(shimPathFingerprint(backingPath))) {
      roles.push("backing");
    }
    return roles.map(selectedRole => ({ file, backingPath, selectedRole }));
  });
  if (matches.length === 0) return Object.freeze({ status: "not-tracked" as const });
  if (result.state.platform !== platform) {
    return Object.freeze({ status: "unknown" as const, reason: "platform_mismatch" as const });
  }
  if (matches.length !== 1) {
    return Object.freeze({ status: "unknown" as const, reason: "ambiguous_match" as const });
  }
  const { file, backingPath, selectedRole } = matches[0]!;
  if (file.preserveOnly === true) {
    return Object.freeze({ status: "unknown" as const, reason: "preserve_only" as const });
  }
  const backing = statFingerprint(backingPath, true);
  if (!backing || backing.size <= 0 || samePath(backingPath, file.wrapperPath)) {
    return Object.freeze({ status: "unknown" as const, reason: "backing_missing" as const });
  }
  const wrapperProbe = stableShimPathProbe(file.wrapperPath);
  if (!wrapperProbe || !isHealthyShimProbe(wrapperProbe, result.state.platform)) {
    return Object.freeze({
      status: "unknown" as const,
      reason: isVersionManagerOwnedCodexPath(file.wrapperPath)
        ? "version_manager_refused" as const
        : "wrapper_unhealthy" as const,
    });
  }
  const wrapperIdentity = wrapperProbe.fingerprint.target ?? wrapperProbe.fingerprint;
  if (backing.dev === wrapperIdentity.dev && backing.ino === wrapperIdentity.ino) {
    return Object.freeze({ status: "unknown" as const, reason: "backing_mismatch" as const });
  }
  const wrapperExt = extname(file.wrapperPath).toLowerCase();
  const invokesBacking = platform !== "win32"
    ? wrapperProbe.prefix.includes(`exec ${shQuote(backingPath)} "$@"`)
    : wrapperExt === ".cmd" || wrapperExt === ".bat"
      ? wrapperProbe.prefix.includes(windowsBatchSet("OCX_REAL_CODEX", backingPath))
        && wrapperProbe.prefix.includes('"%OCX_REAL_CODEX%" %*')
      : wrapperExt === ".ps1"
        ? wrapperProbe.prefix.includes(`& ${psString(backingPath)} @args`)
        : wrapperProbe.prefix.includes(`exec ${shQuote(gitBashPath(backingPath))} "$@"`);
  if (!invokesBacking) {
    return Object.freeze({ status: "unknown" as const, reason: "backing_mismatch" as const });
  }
  return Object.freeze({
    status: "matched" as const,
    selectedRole,
    backingPath,
    backingKind: file.realPath !== undefined ? "real" as const : "backup" as const,
  });
}

function statePath(): string {
  return join(getConfigDir(), "codex-shim.json");
}

function writeState(state: ShimState): void {
  const path = statePath();
  recordOwnedConfigPath(getConfigDir(), path);
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Git-Bash accepts `C:/...` but not backslashed paths inside sh scripts. */
function gitBashPath(path: string): string {
  return path.replace(/\\/g, "/");
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

function stateFiles(state: ShimState): ShimFileState[] {
  return state.wrappers?.length
    ? state.wrappers
    : [{ wrapperPath: state.wrapperPath, originalPath: state.originalPath, backupPath: state.backupPath }];
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

interface ShimRestoreLock {
  release(): void;
}

interface ShimRestoreLockRecord {
  version: 1;
  token: string;
  pid: number;
  createdAt: number;
}

interface ShimRestoreLockSnapshot {
  record: ShimRestoreLockRecord;
  ownerPath: string;
  lockIdentity: Pick<Stats, "dev" | "ino">;
  fingerprint: ShimPathFingerprint;
}

function restoreLockPath(): string {
  return join(getConfigDir(), "codex-shim.autorestore.lock");
}

function sameFileIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readShimRestoreLockSnapshot(path: string): ShimRestoreLockSnapshot | null {
  let lockIdentity: Stats;
  let entries: string[];
  try {
    lockIdentity = lstatSync(path);
    if (!lockIdentity.isDirectory()) return null;
    entries = readdirSync(path);
  } catch {
    return null;
  }
  if (entries.length !== 1 || !entries[0].endsWith(".json")) return null;
  const ownerPath = join(path, entries[0]);
  const probe = stableShimPathProbe(ownerPath);
  if (!probe || probe.fingerprint.kind !== "file" || probe.fingerprint.size > 4096) return null;
  try {
    const value = JSON.parse(probe.prefix) as Partial<ShimRestoreLockRecord>;
    if (value.version !== 1 || typeof value.token !== "string" || value.token.length === 0
      || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
    if (entries[0] !== `${value.token}.json`) return null;
    const currentLockIdentity = lstatSync(path);
    if (!currentLockIdentity.isDirectory() || !sameFileIdentity(lockIdentity, currentLockIdentity)) return null;
    return {
      record: value as ShimRestoreLockRecord,
      ownerPath,
      lockIdentity,
      fingerprint: probe.fingerprint,
    };
  } catch {
    return null;
  }
}

function sameShimRestoreLock(left: ShimRestoreLockSnapshot, right: ShimRestoreLockSnapshot): boolean {
  return left.record.token === right.record.token
    && sameFileIdentity(left.lockIdentity, right.lockIdentity)
    && sameFingerprint(left.fingerprint, right.fingerprint);
}

function reclaimStaleRestoreLock(path: string, beforeDelete?: () => void): boolean {
  const observed = readShimRestoreLockSnapshot(path);
  if (!observed) return false;
  const createdAt = Math.max(observed.record.createdAt, observed.fingerprint.mtimeMs);
  if (Date.now() - createdAt <= CODEX_SHIM_RESTORE_LOCK_STALE_MS) return false;
  if (isProcessAlive(observed.record.pid)) return false;
  const current = readShimRestoreLockSnapshot(path);
  if (!current || !sameShimRestoreLock(observed, current)) return false;
  beforeDelete?.();
  try {
    // The token is part of the owner filename. Even if the lock directory is
    // replaced after the comparison, this unlink cannot target a successor's
    // differently named owner record.
    unlinkSync(observed.ownerPath);
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireShimRestoreLock(beforeStaleDelete?: () => void): ShimRestoreLock | null {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = restoreLockPath();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | null = null;
    let identity: Stats | null = null;
    let createdDirectory = false;
    const record: ShimRestoreLockRecord = {
      version: 1,
      token: `${process.pid}-${Date.now()}-${randomUUID()}`,
      pid: process.pid,
      createdAt: Date.now(),
    };
    const ownerPath = join(path, `${record.token}.json`);
    try {
      mkdirSync(path, { mode: 0o700 });
      createdDirectory = true;
      fd = openSync(ownerPath, "wx", 0o600);
      identity = fstatSync(fd);
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      identity = fstatSync(fd);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try { closeSync(fd!); } catch { /* stale recovery handles an uncertain lock */ }
          try {
            const current = readShimRestoreLockSnapshot(path);
            if (identity && current && current.record.token === record.token
              && sameFileIdentity(identity, current.fingerprint)) {
              unlinkSync(ownerPath);
              rmdirSync(path);
            }
          } catch { /* stale recovery handles release failures */ }
        },
      };
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* best-effort close before ownership cleanup */ }
        try {
          const current = readShimRestoreLockSnapshot(path);
          if (identity && current && current.record.token === record.token
            && sameFileIdentity(identity, current.fingerprint)) {
            unlinkSync(ownerPath);
            rmdirSync(path);
          }
        } catch { /* leave an uncertain lock for stale recovery */ }
      } else if (createdDirectory) {
        try { rmdirSync(path); } catch { /* another owner exists or cleanup is uncertain */ }
      }
      if (fileErrorCode(error) !== "EEXIST") throw error;
      if (attempt === 0 && reclaimStaleRestoreLock(path, beforeStaleDelete)) continue;
      return null;
    }
  }
  return null;
}

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

function refreshObsoleteUnixShims(files: readonly ShimFileState[]): ObsoleteUnixShimRefreshResult {
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
      const writtenInode = writeShim(file.wrapperPath, file.realPath ?? file.backupPath);
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
        const writtenInode = writeShim(target.wrapperPath, target.realPath ?? target.backupPath);
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
            : unsafe === "cleanup"
              ? "the saved launcher's probe process group could not be terminated cleanly"
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

export function installCodexShim(): { installed: boolean; message: string } {
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
